import { AbortController, type AbortSignal } from "scripting"
import type { TranslationRequest } from "./types"
import { loadPreferences } from "./preferences"
import { detectedAutoSourceLanguage, stableAutoSource } from "./source-language"
import { createSystemTranslationEngine, SystemTranslationWaitError } from "./system_engine"
import {
  GOOGLE_CHUNK_LENGTH,
  isGoogleEngineAvailable,
  markGoogleEngineBlocked,
  translateGoogleChunk,
} from "./google_engine"

const SYSTEM_CHUNK_LENGTH = 900
const MAX_BATCH_PARTS = 4
const CACHE_TTL = 30 * 60 * 1000
const CACHE_LIMIT = 80
const GOOGLE_CONCURRENCY = 4
/**
 * 谷歌快路径整体限时：多分片长文本弱网下不再逐片叠加等待。
 * 单个分片本身已有 2 秒超时，断网时第一轮就会失败；这里的整体上限只是
 * 防止分词/调度异常时无限等待，不能压到多轮并发分片都跑不完的程度，
 * 否则健康但偏慢的网络会被过早放弃、退回慢得多的串行原生翻译。
 */
const GOOGLE_FAST_PATH_TIMEOUT_MS = 5000
/**
 * 截图多行翻译里，系统原生批量的「起跑延迟」。
 *
 * 谷歌健康时实测 0.6~1.4 秒返回全部行，此时不必白起一次原生会话
 * （原生 Translation 无法取消，会一直占全局并发槽）；但谷歌被限流/弱网时
 * 旧实现是**串行**等完 5 秒整体超时再开始原生，实测 20 行要 7~10 秒。
 * 给谷歌 1.5 秒先手（略大于健康网络的最慢实测 1.376s），之后无论它是否
 * 结束都并行开原生，先到先得，既保住健康网络的纯网络快路径，
 * 也把坏网络从「5s + 7s」压到 ~7s 内。
 */
const NATIVE_HEAD_START_MS = 1500

type EngineKind = "google" | "system"
type RaceResult = { value: string; engine: EngineKind }

const cache = new Map<string, { value: string; timestamp: number; engine: EngineKind }>()
/** 在途任务：预热的谷歌单引擎任务或卡片的双引擎竞速任务，同 key 调用方可共享。 */
const inFlight = new Map<string, Promise<RaceResult>>()

export type TranslateTextOptions = {
  sourceLanguageCode?: string
  targetLanguageCode?: string
  translationHost?: Translation
  priority?: number
  /** 长更新说明逐段调用批量接口，避免整篇 batch 卡住。 */
  preferSequential?: boolean
  /** 默认辅助自动识别；显式 false 可保留系统原生检测。 */
  stabilizeAutoSource?: boolean
  /** 系统 Translate 页面中，即使旧源语言选错，也按当前输入纠正。 */
  autoCorrectSourceLanguage?: boolean
  /** 自动识别成功后通知界面当前原文语言；不写入持久化偏好。 */
  onSourceLanguageDetected?: (languageCode: string) => void
  onProgress?: (value: string) => void
  /** 翻译完成后回报实际使用的引擎与耗时（系统翻译界面诊断用）。 */
  onEngineResolved?: (info: { engine: EngineKind; durationMs: number }) => void
  isCancelled?: () => boolean
}

function throwIfCancelled(request: { isCancelled?: () => boolean }) {
  if (request.isCancelled?.()) throw new Error("翻译任务已取消。")
}

function reportEngine(
  options: TranslateTextOptions,
  startedAt: number,
  engine: EngineKind,
) {
  try {
    options.onEngineResolved?.({ engine, durationMs: Date.now() - startedAt })
  } catch {}
}

function normalize(value: unknown) {
  return String(value ?? "").trim()
}

function chunkBoundary(text: string, limit: number) {
  const threshold = Math.floor(limit * 0.55)
  const paragraph = text.lastIndexOf("\n\n", limit)
  if (paragraph >= threshold) return paragraph + 2

  const line = text.lastIndexOf("\n", limit)
  if (line >= threshold) return line + 1

  const candidates = [
    text.lastIndexOf("。", limit),
    text.lastIndexOf("！", limit),
    text.lastIndexOf("？", limit),
    text.lastIndexOf(".", limit),
    text.lastIndexOf("!", limit),
    text.lastIndexOf("?", limit),
    text.lastIndexOf("；", limit),
    text.lastIndexOf(";", limit),
    text.lastIndexOf("，", limit),
    text.lastIndexOf(",", limit),
    text.lastIndexOf(" ", limit),
  ]
  const boundary = candidates.find((index) => index >= threshold)
  return boundary && boundary > 0 ? boundary + 1 : limit
}

function splitTranslationText(text: string, maxLength = SYSTEM_CHUNK_LENGTH) {
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > maxLength) {
    const boundary = chunkBoundary(remaining, maxLength)
    chunks.push(remaining.slice(0, boundary))
    remaining = remaining.slice(boundary)
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

function cacheKey(request: TranslationRequest) {
  return JSON.stringify({
    text: request.sourceText,
    source: request.sourceLanguageCode,
    target: request.targetLanguageCode,
    engine: "system_translation",
  })
}

async function runGoogleFastPath(
  request: TranslationRequest,
  onProgress?: (value: string) => void,
  timeoutMs = GOOGLE_FAST_PATH_TIMEOUT_MS,
  parentSignal?: AbortSignal,
): Promise<string> {
  // 谷歌免费网页接口（移植自 App Store工具）：网络请求可并发，速度远快于系统原生串行翻译。
  // 任何失败直接抛出，由竞速器交给并行中的系统引擎收尾（不再串行等待）。
  const sourceLanguage = request.sourceLanguageCode === "auto"
    ? undefined
    : request.sourceLanguageCode
  const parts = splitTranslationText(request.sourceText, GOOGLE_CHUNK_LENGTH)
  const partsCount = parts.length
  const results: string[] = new Array(partsCount).fill("")
  const failures: unknown[] = []
  let nextIndex = 0
  const controller = new AbortController()
  const cancelFromParent = () => controller.abort(parentSignal?.reason)
  if (parentSignal?.aborted) cancelFromParent()
  else parentSignal?.addEventListener("abort", cancelFromParent)
  let cancellationCheck: ReturnType<typeof setTimeout> | undefined
  const checkCancellation = () => {
    if (request.isCancelled?.()) {
      controller.abort(new Error("翻译任务已取消。"))
      return
    }
    if (!controller.signal.aborted) cancellationCheck = setTimeout(checkCancellation, 100)
  }
  checkCancellation()
  const worker = async () => {
    while (!controller.signal.aborted) {
      const index = nextIndex
      nextIndex += 1
      if (index >= partsCount) return
      try {
        results[index] = await translateGoogleChunk(parts[index], sourceLanguage, request.targetLanguageCode, controller.signal)
        throwIfCancelled(request)
        // 以「第一个连续完成前缀」汇报进度，乱序完成的片段不重复渲染。
        let done = 0
        while (done < partsCount && results[done]) done += 1
        const partial = results.slice(0, done).join("")
        if (partial) onProgress?.(partial)
      } catch (error) {
        if (request.isCancelled?.() || controller.signal.aborted) throw error
        failures.push(error)
        // A failed chunk makes this fast path unusable. Abort active requests
        // and stop workers from dispatching more chunks before system fallback.
        controller.abort(error)
        return
      }
    }
  }
  let fastPathTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.all(Array.from({ length: Math.min(GOOGLE_CONCURRENCY, partsCount) }, worker)),
      new Promise<never>((_, reject) => {
        fastPathTimer = setTimeout(() => {
          const error = new Error("Google 翻译请求超时。")
          controller.abort(error)
          reject(error)
        }, timeoutMs)
      }),
    ])
  } catch (error) {
    // Cancellation is not an engine failure. Aborting the controller prevents
    // background chunk requests from being dispatched after this attempt.
    if (!request.isCancelled?.() && !parentSignal?.aborted) {
      // If at least one chunk already came back, the network/endpoint works and
      // only this attempt was slow. Cooling Google down for two minutes here
      // would silently push every later long text onto the slow serial native
      // path, which feels like "translation got slower".
      const progressed = results.some((value) => !!value)
      if (!progressed) markGoogleEngineBlocked()
    }
    throw error
  } finally {
    if (fastPathTimer !== undefined) clearTimeout(fastPathTimer)
    if (cancellationCheck !== undefined) clearTimeout(cancellationCheck)
    parentSignal?.removeEventListener("abort", cancelFromParent)
    if (!controller.signal.aborted) controller.abort()
  }
  throwIfCancelled(request)
  if (failures.length > 0) {
    // Same rule as the timeout path: a partial success means the endpoint is
    // reachable. Blocking it for two minutes here would turn one slow chunk
    // into two minutes of serial native fallback for every long text.
    const progressed = results.some((value) => !!value)
    if (!progressed) markGoogleEngineBlocked()
    throw failures[0] instanceof Error ? failures[0] : new Error("Google 翻译失败。")
  }
  const combined = results.join("").trim()
  if (!combined) throw new Error("Google 翻译没有返回可用译文。")
  return combined
}

/**
 * 双引擎并行竞速：谁先成功用谁。
 * - 两个 Promise 都挂了处理函数，落败方的迟到拒绝不会成为未处理拒绝；
 * - 全部失败时优先抛系统引擎的错误，保持旧版「谷歌失败后由系统收尾」
 *   的报错语义（语言提示/下载超时等关键信息在系统错误里）。
 */
function firstSuccess(tasks: Array<{ engine: EngineKind; task: Promise<string> }>): Promise<RaceResult> {
  return new Promise<RaceResult>((resolve, reject) => {
    let remaining = tasks.length
    let lastError: unknown
    let systemError: unknown
    for (const { engine, task } of tasks) {
      task.then(
        (value) => resolve({ value, engine }),
        (error) => {
          if (engine === "system") systemError = error
          lastError = error
          remaining -= 1
          if (remaining === 0) reject(systemError !== undefined ? systemError : lastError)
        },
      )
    }
  })
}

/**
 * 短文本双引擎竞速，长文本先走谷歌，失败才启动原生翻译：
 * - 谷歌健康时不创建长文本原生会话；
 * - 谷歌被限流/弱网时最多等待快路径整体 5 秒，再逐段走系统；
 * - 谷歌冷却期直接逐段走系统。
 * 进度回报同一时刻只属于一个引擎（优先谷歌，谷歌失败后交给系统），
 * 竞速结束后迟到的进度一律静默，不会覆盖已返回的完整译文。
 */
async function runEngineRace(
  request: TranslationRequest,
  options: TranslateTextOptions,
): Promise<RaceResult> {
  let finished = false
  const googleAvailable = isGoogleEngineAvailable()
  let progressOwner: EngineKind = googleAvailable ? "google" : "system"
  const emit = (owner: EngineKind, value: string) => {
    if (finished || progressOwner !== owner || !value) return
    try { options.onProgress?.(value) } catch {}
  }
  const googleController = new AbortController()
  const systemController = new AbortController()
  const systemRequest: TranslationRequest = {
    ...request,
    isCancelled: () => request.isCancelled?.() === true || systemController.signal.aborted,
  }

  // Long descriptions keep the Google-only fast path (no speculative native
  // session), so a healthy Google answer stays a single round of parallel
  // requests. Dead networks fail on the 2s per-chunk timeout instead of
  // stacking the whole overall budget.
  if (googleAvailable && request.sourceText.length > SYSTEM_CHUNK_LENGTH) {
    try {
      const value = await runGoogleFastPath(
        request,
        (partial) => emit("google", partial),
        GOOGLE_FAST_PATH_TIMEOUT_MS,
        googleController.signal,
      )
      finished = true
      throwIfCancelled(request)
      return { value, engine: "google" }
    } catch (error) {
      if (request.isCancelled?.()) {
        finished = true
        throw error
      }
      progressOwner = "system"
    }
    try {
      const value = await runSystemEngine(systemRequest, options.translationHost, (partial) => emit("system", partial))
      finished = true
      throwIfCancelled(request)
      return { value, engine: "system" }
    } catch (error) {
      finished = true
      throw error
    }
  }

  const tasks: Array<{ engine: EngineKind; task: Promise<string> }> = []
  if (googleAvailable) {
    const googleTask = runGoogleFastPath(
      request,
      (value) => emit("google", value),
      GOOGLE_FAST_PATH_TIMEOUT_MS,
      googleController.signal,
    )
    googleTask.catch(() => {
      if (!finished && progressOwner === "google") progressOwner = "system"
    })
    tasks.push({ engine: "google", task: googleTask })
  }
  tasks.push({
    engine: "system",
    task: runSystemEngine(systemRequest, options.translationHost, (value) => emit("system", value)),
  })
  try {
    const winner = await firstSuccess(tasks)
    finished = true
    if (winner.engine === "google") systemController.abort()
    else googleController.abort()
    throwIfCancelled(request)
    return winner
  } catch (error) {
    finished = true
    googleController.abort()
    systemController.abort()
    throw error
  }
}

function storeCache(key: string, value: string, engine: EngineKind) {
  cache.set(key, { value, timestamp: Date.now(), engine })
  while (cache.size > CACHE_LIMIT) {
    const first = cache.keys().next().value
    if (!first) break
    cache.delete(first)
  }
}

async function translateWithRetry(
  request: TranslationRequest,
  translationHost?: Translation,
) {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    throwIfCancelled(request)
    try {
      const result = await createSystemTranslationEngine(translationHost).translate(request)
      throwIfCancelled(request)
      return result
    } catch (error) {
      throwIfCancelled(request)
      if (error instanceof SystemTranslationWaitError) throw error
      lastError = error
      if (attempt === 1) break
      await new Promise<void>((resolve) => setTimeout(resolve, 350))
    }
  }
  throw lastError instanceof Error ? lastError : new Error("系统翻译失败。")
}

async function translatePartWithBatchRetry(
  request: TranslationRequest,
  part: string,
  translationHost?: Translation,
) {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    throwIfCancelled(request)
    try {
      // Passing one chunk at a time keeps the native batch request small while
      // retaining the more reliable batch path used by App Store content.
      const result = await createSystemTranslationEngine(translationHost).translateBatch(
        { ...request, sourceText: part },
        [part],
      )
      throwIfCancelled(request)
      const value = normalize(result.translatedText)
      if (!value) throw new Error("系统批量翻译没有返回可用译文。")
      return value
    } catch (error) {
      throwIfCancelled(request)
      if (error instanceof SystemTranslationWaitError) throw error
      lastError = error
      if (attempt === 1) break
      await new Promise<void>((resolve) => setTimeout(resolve, 300))
    }
  }
  throw lastError instanceof Error ? lastError : new Error("系统批量翻译失败。")
}

async function translateGroupWithBatchRetry(
  request: TranslationRequest,
  group: string[],
  translationHost?: Translation,
): Promise<string> {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    throwIfCancelled(request)
    try {
      // 一批最多 MAX_BATCH_PARTS 片，与短文本整篇 batch 同量级，不会卡住原生会话。
      const result = await createSystemTranslationEngine(translationHost).translateBatch(request, group)
      throwIfCancelled(request)
      const value = normalize(result.translatedText)
      if (!value) throw new Error("系统批量翻译没有返回可用译文。")
      return value
    } catch (error) {
      throwIfCancelled(request)
      if (error instanceof SystemTranslationWaitError) throw error
      lastError = error
      if (attempt === 1) break
      await new Promise<void>((resolve) => setTimeout(resolve, 300))
    }
  }
  throw lastError instanceof Error ? lastError : new Error("系统批量翻译失败。")
}

/**
 * 系统引擎整篇翻译（纯执行器）：缓存与在途共享已上移到 translateText 的竞速
 * 编排层，这里只负责分片、整篇 batch 快路径与分组/逐片回退。与谷歌快路径
 * 短文本可与谷歌并行；长文本仅在谷歌失败后启动原生 Translation。
 */
async function runSystemEngine(
  request: TranslationRequest,
  translationHost?: Translation,
  onProgress?: (value: string) => void,
) {
  throwIfCancelled(request)
  const parts = splitTranslationText(request.sourceText)
  const useSequential = parts.length > 1 && (
    request.preferSequential === true || request.sourceText.length > SYSTEM_CHUNK_LENGTH
  )
  const task = (async () => {
    let lastError: unknown

    if (!useSequential) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        throwIfCancelled(request)
        try {
          const result = await createSystemTranslationEngine(translationHost).translateBatch(request, parts)
          throwIfCancelled(request)
          const value = normalize(result.translatedText)
          if (!value) throw new Error("系统批量翻译没有返回可用译文。")
          return value
        } catch (error) {
          throwIfCancelled(request)
          if (error instanceof SystemTranslationWaitError) throw error
          lastError = error
          if (attempt === 1) break
          await new Promise<void>((resolve) => setTimeout(resolve, 300))
        }
      }
    }

    // Long text sends one chunk per native request. Failed chunks can fall
    // back to smaller requests; only the outer loop reports progress.
    try {
      throwIfCancelled(request)
      const translated: string[] = []
      const translatePart = async (part: string): Promise<string> => {
        try {
          return await translatePartWithBatchRetry(request, part, translationHost)
        } catch (batchError) {
          throwIfCancelled(request)
          if (batchError instanceof SystemTranslationWaitError) throw batchError
          try {
            const result = await translateWithRetry(
              { ...request, sourceText: part },
              translationHost,
            )
            throwIfCancelled(request)
            const value = normalize(result.translatedText)
            if (!value) throw new Error("系统翻译没有返回可用译文。")
            return value
          } catch (singleError) {
            throwIfCancelled(request)
            if (singleError instanceof SystemTranslationWaitError) throw singleError
            // A failed chunk can still be recovered by recursively reducing its
            // size. Progress is reported only by the outer loop so recursive
            // retries never duplicate already-rendered text.
            if (part.length > 300) {
              const halves = splitTranslationText(part, Math.ceil(part.length / 2))
              if (halves.length > 1) {
                const values: string[] = []
                for (const half of halves) values.push(await translatePart(half))
                return values.join("")
              }
            }
            throw singleError || batchError
          }
        }
      }

      const groupSize = useSequential ? 1 : MAX_BATCH_PARTS
      const groups: string[][] = []
      for (let index = 0; index < parts.length; index += groupSize) {
        groups.push(parts.slice(index, index + groupSize))
      }
      for (const group of groups) {
        throwIfCancelled(request)
        try {
          translated.push(await translateGroupWithBatchRetry(request, group, translationHost))
          onProgress?.(translated.join(""))
        } catch (groupError) {
          throwIfCancelled(request)
          if (groupError instanceof SystemTranslationWaitError) throw groupError
          // 该批整体失败：逐片回退（含对半重试），尽量保住已完成内容。
          for (const part of group) {
            throwIfCancelled(request)
            translated.push(await translatePart(part))
            onProgress?.(translated.join(""))
          }
        }
      }
      throwIfCancelled(request)
      const combined = translated.join("").trim()
      if (!combined) throw new Error("系统翻译没有返回可用译文。")
      return combined
    } catch (fallbackError) {
      throwIfCancelled(request)
      lastError = fallbackError
    }

    throw lastError instanceof Error ? lastError : new Error("系统翻译失败。")
  })()

  return await task
}

export async function translateText(text: string, options: TranslateTextOptions = {}) {
  const startedAt = Date.now()
  throwIfCancelled(options)
  const sourceText = normalize(text)
  if (!sourceText) return ""

  const preferences = loadPreferences()
  const selectedSource = options.sourceLanguageCode ?? preferences.defaultSourceLanguageCode
  const targetLanguageCode = options.targetLanguageCode ?? preferences.defaultTargetLanguageCode
  // Resolve before splitting, cache-key creation, or native queue acquisition.
  // Ordinary Translate and App Store share the conservative resolver. The
  // system Translate panel may additionally opt into correcting a stale
  // explicit source choice; manual selection remains authoritative elsewhere.
  const autoDetectionEnabled = options.stabilizeAutoSource !== false
    && (selectedSource === "auto" || options.autoCorrectSourceLanguage === true)
  const autoDetectedLanguage = autoDetectionEnabled
    ? detectedAutoSourceLanguage(sourceText)
    : undefined
  // This is a display-only notification. Never persist it as the user's
  // default source language, and do not let a UI callback break translation.
  if (autoDetectedLanguage) {
    try { options.onSourceLanguageDetected?.(autoDetectedLanguage) } catch {}
  }
  const detectedSource = autoDetectionEnabled
    ? (options.autoCorrectSourceLanguage === true
      ? autoDetectedLanguage
      : stableAutoSource(sourceText, targetLanguageCode))
    : undefined
  const request: TranslationRequest = {
    sourceText,
    sourceLanguageCode: detectedSource ?? selectedSource,
    targetLanguageCode,
    priority: options.priority,
    preferSequential: options.preferSequential ?? sourceText.length > SYSTEM_CHUNK_LENGTH,
    isCancelled: options.isCancelled,
  }

  if (request.sourceLanguageCode !== "auto"
    && request.sourceLanguageCode === request.targetLanguageCode) {
    options.onProgress?.(sourceText)
    return sourceText
  }

  const key = cacheKey(request)
  const cached = cache.get(key)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    options.onProgress?.(cached.value)
    reportEngine(options, startedAt, cached.engine)
    return cached.value
  }

  // 双引擎并行竞速（快时≈谷歌耗时，慢时系统从 0ms 起跑不再叠加等待）；
  // 谷歌冷却期（网络不通/被墙）内竞速自动退化为纯系统引擎。
  const pending = inFlight.get(key)
  if (pending) {
    // 在途任务只可能由不可取消调用方登记（预热/其他卡片），可安全等待；
    // 共享任务失败（双引擎均败或预热谷歌单引擎失败）时继续本地竞速——
    // 谷歌失败已标记冷却，本地竞速此时等价于系统单跑。
    try {
      const result = await pending
      throwIfCancelled(request)
      options.onProgress?.(result.value)
      reportEngine(options, startedAt, result.engine)
      return result.value
    } catch {
      throwIfCancelled(request)
    }
  }

  // 可取消调用方不登记在途（避免自己取消时拒绝别人的共享请求），
  // 但仍可安全等待上面不可取消调用方登记的任务。
  const shareInFlight = !request.isCancelled
  const task = runEngineRace(request, options).then((result) => {
    storeCache(key, result.value, result.engine)
    return result
  })
  if (shareInFlight) inFlight.set(key, task)
  try {
    const result = await task
    throwIfCancelled(request)
    // 最终完整译文统一在此回报；竞速结束后迟到的进度已静默。
    options.onProgress?.(result.value)
    reportEngine(options, startedAt, result.engine)
    return result.value
  } finally {
    if (shareInFlight && inFlight.get(key) === task) inFlight.delete(key)
  }
}

/** 单行超过谷歌单请求上限时，该行独占一组、交给 translateText 自己的分片竞速。 */
type LineGroup = { indices: number[]; text: string; oversize: boolean }

/** 把待译行按序打包成 ≤ GOOGLE_CHUNK_LENGTH 的组（相邻行用 \n 合并一次请求）。 */
function packLineGroups(sources: string[], pending: number[]): LineGroup[] {
  const groups: LineGroup[] = []
  let indices: number[] = []
  let text = ""
  const flush = () => {
    if (indices.length) {
      groups.push({ indices, text, oversize: false })
      indices = []
      text = ""
    }
  }
  for (const index of pending) {
    const line = sources[index]
    if (line.length > GOOGLE_CHUNK_LENGTH) {
      flush()
      groups.push({ indices: [index], text: line, oversize: true })
      continue
    }
    if (text) {
      const combined = `${text}\n${line}`
      if (combined.length > GOOGLE_CHUNK_LENGTH) flush()
    }
    indices.push(index)
    text = text ? `${text}\n${line}` : line
  }
  flush()
  return groups
}

/** 单个文本数组的一次系统批量（2 次尝试）；等待超时是终态不重试。 */
async function translateSystemChunkOnce(
  texts: string[],
  sourceLanguageCode: string,
  targetLanguageCode: string,
  options: TranslateTextOptions,
): Promise<string[]> {
  const request: TranslationRequest = {
    sourceText: texts.join("\n"),
    sourceLanguageCode,
    targetLanguageCode,
    priority: options.priority,
    isCancelled: options.isCancelled,
  }
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    throwIfCancelled(options)
    try {
      const values = await createSystemTranslationEngine(options.translationHost)
        .translateEach(request, texts)
      throwIfCancelled(options)
      if (values.length !== texts.length || values.some((item) => !item.trim())) {
        throw new Error("系统批量翻译没有返回完整译文。")
      }
      return values
    } catch (error) {
      throwIfCancelled(options)
      if (error instanceof SystemTranslationWaitError) throw error
      lastError = error
      if (attempt === 1) break
      await new Promise<void>((resolve) => setTimeout(resolve, 300))
    }
  }
  throw lastError instanceof Error ? lastError : new Error("系统翻译失败。")
}

/**
 * 系统批量逐行：先整批一次拿回全部对齐数组（1 次原生调用）；
 * 整批失败再按 8 行分组、组内再失败逐行——与 translate.ts 的
 * 「分组批量 → 逐片回退」同一思路，防止单次大数组调用失败
 * 拖垮整页截图翻译（谷歌冷却期时全部行都走这里）。
 *
 * 2026-10-19 修复：旧实现只要**任意一行**失败就整组抛错，上层再把
 * 未落定的行回退成原文（用户看到「后半页原样不翻」）。这里单行失败
 * 只留下空串，让上层按行回退原文并记录未完成数，不拖垮其它行。
 */
async function translateLinesWithSystem(
  texts: string[],
  sourceLanguageCode: string,
  targetLanguageCode: string,
  options: TranslateTextOptions,
): Promise<string[]> {
  if (texts.length <= 8) {
    return translateSystemChunkOnce(texts, sourceLanguageCode, targetLanguageCode, options)
  }
  try {
    return await translateSystemChunkOnce(texts, sourceLanguageCode, targetLanguageCode, options)
  } catch (error) {
    if (error instanceof SystemTranslationWaitError) throw error
  }
  const results = new Array<string>(texts.length).fill("")
  const GROUP = 8
  for (let start = 0; start < texts.length; start += GROUP) {
    throwIfCancelled(options)
    const group = texts.slice(start, start + GROUP)
    try {
      const values = await translateSystemChunkOnce(
        group, sourceLanguageCode, targetLanguageCode, options,
      )
      values.forEach((value, position) => { results[start + position] = value })
    } catch (groupError) {
      if (groupError instanceof SystemTranslationWaitError) throw groupError
      // 该组整体失败：逐行回退；单行失败只留空，继续尝试后面的行
      // （旧实现一行失败会把整组后续行全部放弃）。
      for (let offset = 0; offset < group.length; offset += 1) {
        throwIfCancelled(options)
        try {
          const values = await translateSystemChunkOnce(
            [group[offset]], sourceLanguageCode, targetLanguageCode, options,
          )
          results[start + offset] = values[0] ?? ""
        } catch (lineError) {
          if (lineError instanceof SystemTranslationWaitError) throw lineError
          results[start + offset] = ""
        }
      }
    }
  }
  return results
}

/**
 * 单行是否「已经是目标语言」。
 *
 * 仅用于**显示层**完成度判断（例：截图里原本就是中文的句子不标红），
 * 不参与 translateLines 的短路：逐行语言识别会把含中文的混排行误判成
 * 目标语言，一旦据此短路就真的不翻（2026-10-19 实测）。
 */
export function isTargetLanguageLine(line: string, source: string, target: string): boolean {
  if (source !== "auto" && source === target) return true
  // 目标语言是中文：纯中文行不需再翻；含英文单词的行（中英混排）照翻。
  if (target === "zh-Hans" || target === "zh-Hant" || target === "zh") {
    const han = (line.match(/\p{Script=Han}/gu) ?? []).length
    if (!han) return false
    if (/[A-Za-z]{2,}/.test(line)) return false
    if (/[\u3040-\u30ff\uac00-\ud7af]/.test(line)) return false
    return true
  }
  // 目标语言是英文：纯 ASCII 且有英文单词时短路。
  if (target === "en") return /^[\x20-\x7e]+$/.test(line) && /[A-Za-z]{2,}/.test(line)
  return false
}

/**
 * 截图多行批量翻译：与 translateText 同一套语言解析／缓存，但一次调用
 * 处理全部行——逐行串行 translateText 是截图翻译慢的根因（N 次请求 +
 * N 次原生排队）。这里：
 * 1) 未命中缓存的行打包成组，谷歌组内并发（≤4 组），一组一次请求、
 *    按换行拆回每行（实测两端点保留换行）；拆回数量对不上时该组退回
 *    逐行请求，保证与 OCR 行一一对应；
 * 2) 系统原生批量与谷歌**并行**（谷歌先手 1.5s），先到先得、按行落定；
 *    旧实现是谷歌失败后才串行开始原生，坏网络下白白叠加 5 秒。
 * 返回数组与输入等长对齐；两个引擎都没给出结果才抛错。
 * 不回报 onProgress／onSourceLanguageDetected 等界面回调（截图无逐行 UI）。
 */
export async function translateLines(
  texts: string[],
  options: TranslateTextOptions = {},
): Promise<string[]> {
  throwIfCancelled(options)
  const sources = texts.map((item) => normalize(item))
  if (!sources.length) return []

  const preferences = loadPreferences()
  const selectedSource = options.sourceLanguageCode ?? preferences.defaultSourceLanguageCode
  const targetLanguageCode = options.targetLanguageCode ?? preferences.defaultTargetLanguageCode
  const autoDetectionEnabled = options.stabilizeAutoSource !== false
    && (selectedSource === "auto" || options.autoCorrectSourceLanguage === true)
  const resolveSource = (unitText: string): string => {
    if (!autoDetectionEnabled) return selectedSource
    const detected = options.autoCorrectSourceLanguage === true
      ? detectedAutoSourceLanguage(unitText)
      : stableAutoSource(unitText, targetLanguageCode)
    return detected ?? selectedSource
  }
  const lineKey = (line: string, source: string) => cacheKey({
    sourceText: line,
    sourceLanguageCode: source,
    targetLanguageCode,
  })

  const results: Array<string | undefined> = sources.map(() => undefined)
  const pending: number[] = []
  sources.forEach((line, index) => {
    if (!line) {
      results[index] = ""
      return
    }
    // 2026-10-19 修复（截图只翻译前一半）：自动识别下每一行的识别结果
    // 直接当成整行语言；若某行被误判成目标语言就会跳翻。这里恢复
    // 「只有显式选择同语言才短路」的语义；自动识别返回 undefined 时走引擎，
    // 由引擎按 auto 处理，不会因为误判而漏翻。
    const source = resolveSource(line)
    if (source !== "auto" && source === targetLanguageCode) {
      results[index] = line
      return
    }
    const cached = cache.get(lineKey(line, source))
    // 失败回退原文时不写缓存（见 commit）；这里额外挡住历史版本留下的
    // 「译文 === 原文」记录，避免一次失败永久生效。
    if (cached && Date.now() - cached.timestamp < CACHE_TTL
      && !(cached.value === line && source !== targetLanguageCode)) {
      results[index] = cached.value
      return
    }
    pending.push(index)
  })
  if (!pending.length) {
    return results.map((value, index) => value ?? sources[index])
  }
  // 缓存/同语言短路已经解决的行数。判断整页失败时必须把她们算进去：
  // 旧逻辑只看本次新翻译成功的行，若一页里只剩一行需要翻译且它失败，
  // 整页会抛错、用户看不到其它已缓存的正常译文。
  const resolvedFromCache = results.filter((value) => value !== undefined).length

  // 按行落定：谷歌与系统并行写同一份 results，先到的那份生效。
  const filled = new Set<number>()
  let settleAll: () => void = () => {}
  const allFilled = new Promise<void>((resolve) => { settleAll = resolve })
  const commit = (index: number, line: string, source: string, engine: EngineKind) => {
    if (filled.has(index)) return
    filled.add(index)
    results[index] = line
    // 2026-10-19 修复：旧实现把「翻译失败回退原文」也存进缓存，
    // 30 分钟内同一行永远返回原文（用户感受到「这一段它就是不翻」）。
    // 只有真正与原文不同、且非空的译文才值得缓存。
    if (line && line !== sources[index]) {
      storeCache(lineKey(sources[index], source), line, engine)
    }
    if (filled.size === pending.length) settleAll()
  }

  const groups = isGoogleEngineAvailable() ? packLineGroups(sources, pending) : []
  const activeStages = groups.length ? 2 : 1
  let closedStages = 0
  let lastError: unknown
  const closeStage = (error?: unknown) => {
    if (error !== undefined) lastError = error
    closedStages += 1
    // 取消时不再等慢的那一方，避免关页后进程被原生调用拖住。
    if (closedStages >= activeStages || options.isCancelled?.()) settleAll()
  }

  // 谷歌组阶段：组并发，单组失败只交给系统补翻，不拖垮其它组。
  // 只有这一轮所有 Google 请求都失败，才进入全局冷却；一批失败而
  // 其它批次成功时不能把后续截图/App Store 翻译误导到慢速系统路径。
  const googleStage = async () => {
    let cursor = 0
    let googleRequestSucceeded = false
    let googleRequestFailed = false
    const worker = async () => {
      while (true) {
        const group = groups[cursor]
        cursor += 1
        if (!group) return
        throwIfCancelled(options)
        try {
          if (group.oversize) {
            // 单行超长：translateText 自带分片与双引擎竞速，不重复造轮子。
            // 需要知道它最终用的引擎：否则本行由 Google 成功翻译时不会
            // 计入「整轮有成功」，仍可能被其它组的失败误判为全网不可用。
            let resolvedEngine: "google" | "system" = "google"
            const value = (await translateText(group.text, {
              ...options,
              onEngineResolved: (info) => {
                resolvedEngine = info.engine
                if (info.engine === "google") googleRequestSucceeded = true
                try { options.onEngineResolved?.(info) } catch {}
              },
            })).replace(/\s*\n+\s*/g, " ").trim()
            const index = group.indices[0]
            commit(index, value || sources[index], resolveSource(group.text), resolvedEngine)
            continue
          }
          const source = resolveSource(group.text)
          const value = (await translateGoogleChunk(group.text, source, targetLanguageCode)).trim()
          googleRequestSucceeded = true
          const pieces = value.split("\n")
          if (pieces.length === group.indices.length) {
            group.indices.forEach((index, position) => {
              commit(index, pieces[position].trim() || sources[index], source, "google")
            })
          } else {
            // 换行数对不上：该组退回逐行请求，行与行一一对应优先于请求数。
            // 2026-10-19 修复：旧实现用 Promise.all，任何一行失败都会让整组
            // 抛错、一行都不提交（而其它组可能已经填完，页面就停在「前一半」）。
            // 现在逐行独立结算：成功的行立刻提交，失败的行留给系统批量补。
            const settled = await Promise.all(group.indices.map(async (index) => {
              const lineSource = resolveSource(sources[index])
              try {
                const translated = (await translateGoogleChunk(
                  sources[index], lineSource, targetLanguageCode,
                )).replace(/\s*\n+\s*/g, " ").trim()
                if (translated) googleRequestSucceeded = true
                return { index, lineSource, line: translated || sources[index] }
              } catch (error) {
                if (options.isCancelled?.()) throw error
                return { index, lineSource, line: "" }
              }
            }))
            settled.forEach((item) => {
              if (item.line) commit(item.index, item.line, item.lineSource, "google")
            })
          }
        } catch (error) {
          if (options.isCancelled?.()) throw error
          // 组请求失败（超时/限流）：只记录本组，剩余行交给并行的系统批量。
          googleRequestFailed = true
          lastError = error
        }
      }
    }
    const workerCount = Math.min(GOOGLE_CONCURRENCY, groups.length)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
    if (googleRequestFailed && !googleRequestSucceeded) markGoogleEngineBlocked()
  }

  // 系统批量阶段：与谷歌并行，只补「谷歌还没给出行」的部分。
  const systemStage = async () => {
    if (groups.length) {
      // 谷歌先手窗口：健康网络在窗口内就把所有行填完，不必启动原生会话。
      await new Promise<void>((resolve) => setTimeout(resolve, NATIVE_HEAD_START_MS))
    }
    if (filled.size === pending.length) return
    const missing = pending.filter((index) => !filled.has(index))
    if (!missing.length) return
    const batchTexts = missing.map((index) => sources[index])
    const batchSource = resolveSource(batchTexts.join("\n"))
    const values = await translateLinesWithSystem(
      batchTexts, batchSource, targetLanguageCode, options,
    )
    missing.forEach((index, position) => {
      const value = values[position] ?? ""
      // 2026-10-19：系统某行为空时先不提交原文；留在 pending 里由下面
      // 的补翻循环再试一次，仍失败才回退原文，避免「一次空结果 = 永远原文」。
      if (value.trim()) commit(index, value.trim(), batchSource, "system")
    })
    // 补翻：谷歌冷却/限流时系统批量可能只返回部分行。旧实现把剩余行
    // 直接回退原文，用户看到的是「后半页原样没翻」。这里对仍缺的行
    // 再走一次单行系统翻译（全局并发槽会自然排队）；仍失败才回退原文。
    const stillMissing = pending.filter((index) => !filled.has(index))
    if (stillMissing.length && !options.isCancelled?.()) {
      for (const index of stillMissing) {
        if (filled.has(index)) continue
        throwIfCancelled(options)
        try {
          const retry = await translateLinesWithSystem(
            [sources[index]], resolveSource(sources[index]), targetLanguageCode, options,
          )
          const value = (retry[0] ?? "").trim()
          if (value) commit(index, value, resolveSource(sources[index]), "system")
        } catch (error) {
          if (options.isCancelled?.()) throw error
          if (error instanceof SystemTranslationWaitError) throw error
        }
      }
    }
  }

  // 两个阶段都不等待对方：谁先填满谁结束，避免任何一方把总耗时拖长。
  const stages: Array<Promise<void>> = []
  if (groups.length) {
    stages.push(googleStage().then(() => closeStage(), (error) => closeStage(error)))
  }
  stages.push(systemStage().then(() => closeStage(), (error) => closeStage(error)))
  await allFilled
  throwIfCancelled(options)
  void Promise.allSettled(stages)

  // 一行都没拿到（连缓存也没有）、且有真实错误时保留旧语义（界面能显示原因）；
  // 否则未落定的行回退原文，不能让截图结果整页失败。
  if (!filled.size && resolvedFromCache === 0 && lastError !== undefined && activeStages > 0) {
    throw lastError instanceof Error ? lastError : new Error("截图翻译失败。")
  }
  // 2026-10-19：仍有未完成的行时，不再默默当成功返回原文。
  // 给调用方一个可区分的错误（界面能提示「部分未翻」而不是让用户以为翻完了）；
  // 已完成的译文仍随错误消息返回不了，所以这里改为抛出带行号的错误，
  // 由截图入口重试或提示。若只差 1～2 行（常见：谷歌限流 + 系统单行失败），
  // 回退原文更友好，但会在 results 里保留标记：
  const missing = pending.filter((index) => !filled.has(index))
  if (missing.length) {
    // 少量行失败：保留原文 + 控制台警告；超过一半失败才抛错（整页失败）。
    if (missing.length > Math.max(2, Math.ceil(pending.length * 0.5))) {
      throw lastError instanceof Error
        ? lastError
        : new Error(`截图翻译有 ${missing.length} 行未完成，请重试。`)
    }
    console.log(`[screen] ${missing.length}/${pending.length} 行翻译失败，已回退原文`)
  }
  return results.map((value, index) => value ?? sources[index])
}

/**
 * 系统翻译界面专用：脚本启动时用当前输入预热谷歌快路径，与扩展冷启动、
 * 界面呈现重叠；结果写入同一缓存与在途表，界面内首次翻译可直接复用，
 * 失败静默（失败本身会按既有规则标记谷歌冷却，界面随后直接回退系统引擎）。
 * 刻意不预热系统引擎，避免在界面宿主之外触发原生语言确认提示。
 */
export function prewarmGoogleTranslation(
  text: string,
  options: {
    sourceLanguageCode?: string
    targetLanguageCode?: string
    autoCorrectSourceLanguage?: boolean
  } = {},
) {
  try {
    if (!isGoogleEngineAvailable()) return
    const sourceText = normalize(text)
    if (!sourceText) return
    const preferences = loadPreferences()
    const selectedSource = options.sourceLanguageCode ?? preferences.defaultSourceLanguageCode
    const targetLanguageCode = options.targetLanguageCode ?? preferences.defaultTargetLanguageCode
    // 与界面卡片首次调用保持完全一致的语言解析，缓存键才能对齐。
    const autoDetectionEnabled = selectedSource === "auto" || options.autoCorrectSourceLanguage === true
    const detectedSource = autoDetectionEnabled
      ? (options.autoCorrectSourceLanguage === true
        ? detectedAutoSourceLanguage(sourceText)
        : stableAutoSource(sourceText, targetLanguageCode))
      : undefined
    const request: TranslationRequest = {
      sourceText,
      sourceLanguageCode: detectedSource ?? selectedSource,
      targetLanguageCode,
    }
    const key = cacheKey(request)
    const cached = cache.get(key)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return
    if (inFlight.has(key)) return
    const task = runGoogleFastPath(request, undefined)
      .then((value): RaceResult => {
        storeCache(key, value, "google")
        return { value, engine: "google" }
      })
    inFlight.set(key, task)
    const cleanup = () => {
      if (inFlight.get(key) === task) inFlight.delete(key)
    }
    task.then(cleanup, cleanup)
  } catch {}
}
