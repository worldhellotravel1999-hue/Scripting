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
/** 谷歌快路径整体限时：多分片长文本弱网下不再逐片叠加等待，超时直接回退系统。 */
const GOOGLE_FAST_PATH_TIMEOUT_MS = 5000

const cache = new Map<string, { value: string; timestamp: number; engine: "google" | "system" }>()
const inFlight = new Map<string, Promise<string>>()

type EngineKind = "google" | "system"

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
  const paragraph = text.lastIndexOf("\n\n", limit)
  if (paragraph >= Math.floor(limit * 0.55)) return paragraph + 2

  const line = text.lastIndexOf("\n", limit)
  if (line >= Math.floor(limit * 0.55)) return line + 1

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
  const boundary = candidates.find((index) => index >= Math.floor(limit * 0.55))
  return boundary && boundary > 0 ? boundary + 1 : limit
}

export function splitTranslationText(text: string, maxLength = SYSTEM_CHUNK_LENGTH) {
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > maxLength) {
    const boundary = chunkBoundary(remaining, maxLength)
    chunks.push(remaining.slice(0, boundary))
    remaining = remaining.slice(boundary)
  }
  if (remaining) chunks.push(remaining)
  return chunks.filter((item) => item.length > 0)
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
): Promise<string> {
  // 谷歌免费网页接口（移植自 App Store工具）：网络请求可并发，速度远快于系统原生串行翻译。
  // 任何失败直接抛出，由调用方回退系统引擎。
  const sourceLanguage = request.sourceLanguageCode === "auto"
    ? undefined
    : request.sourceLanguageCode
  const parts = splitTranslationText(request.sourceText, GOOGLE_CHUNK_LENGTH)
  const partsCount = parts.length
  const results: string[] = new Array(partsCount).fill("")
  const failures: unknown[] = []
  let nextIndex = 0
  const worker = async () => {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= partsCount) return
      try {
        results[index] = await translateGoogleChunk(parts[index], sourceLanguage, request.targetLanguageCode)
        throwIfCancelled(request)
        // 以「第一个连续完成前缀」汇报进度，乱序完成的片段不重复渲染。
        let done = 0
        while (done < partsCount && results[done]) done += 1
        const partial = results.slice(0, done).join("")
        if (partial) onProgress?.(partial)
      } catch (error) {
        if (request.isCancelled?.()) throw error
        failures.push(error)
        return
      }
    }
  }
  let fastPathTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.all(Array.from({ length: Math.min(GOOGLE_CONCURRENCY, partsCount) }, worker)),
      // 弱网下多分片会逐片叠加等待：整体限时一到直接按失败处理，调用方回退系统引擎。
      new Promise<never>((_, reject) => {
        fastPathTimer = setTimeout(
          () => reject(new Error("Google 翻译请求超时。")),
          GOOGLE_FAST_PATH_TIMEOUT_MS,
        )
      }),
    ])
  } catch (error) {
    // 整体限时/传输失败同样进入冷却：弱网下下一篇直接走系统，不再白等。
    // 用户取消不算引擎故障，不标记。注意：race 失败后仍在跑的 worker 会把
    // 后续成功/失败写入 results/failures，但 results 已无人读取、failures 的
    // markGoogleEngineBlocked 与此处重复标记等价，无副作用。
    if (!request.isCancelled?.()) markGoogleEngineBlocked()
    throw error
  } finally {
    if (fastPathTimer !== undefined) clearTimeout(fastPathTimer)
  }
  throwIfCancelled(request)
  if (failures.length > 0) {
    markGoogleEngineBlocked()
    throw failures[0] instanceof Error ? failures[0] : new Error("Google 翻译失败。")
  }
  const combined = results.join("").trim()
  if (!combined) throw new Error("Google 翻译没有返回可用译文。")
  return combined
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

async function translateSystemBatch(
  request: TranslationRequest,
  translationHost?: Translation,
  onProgress?: (value: string) => void,
) {
  throwIfCancelled(request)
  const key = cacheKey(request)
  const cached = cache.get(key)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    onProgress?.(cached.value)
    return cached.value
  }

  // Cancellable owners must not share pending work: one card's cancellation
  // would otherwise reject another card's live request. Completed cache is safe.
  const shareInFlight = !request.isCancelled
  const pending = shareInFlight ? inFlight.get(key) : undefined
  if (pending) {
    const value = await pending
    throwIfCancelled(request)
    onProgress?.(value)
    return value
  }

  const parts = splitTranslationText(request.sourceText)
  const useSequential = parts.length > 1 && (
    request.preferSequential === true || parts.length > MAX_BATCH_PARTS
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
          storeCache(key, value, "system")
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

    // Long App Store pages are translated in groups: each native translateBatch
    // carries up to MAX_BATCH_PARTS chunks (same size as the short-text whole
    // batch path), cutting native call count to ceil(N/4). A failed group falls
    // back to per-chunk translation (with halving retry) so completed chunks
    // are kept and progress is only reported by the outer loops.
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

      const groups: string[][] = []
      for (let index = 0; index < parts.length; index += MAX_BATCH_PARTS) {
        groups.push(parts.slice(index, index + MAX_BATCH_PARTS))
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
      storeCache(key, combined, "system")
      return combined
    } catch (fallbackError) {
      throwIfCancelled(request)
      lastError = fallbackError
    }

    throw lastError instanceof Error ? lastError : new Error("系统翻译失败。")
  })()

  if (shareInFlight) inFlight.set(key, task)
  try {
    const value = await task
    throwIfCancelled(request)
    return value
  } finally {
    if (shareInFlight && inFlight.get(key) === task) inFlight.delete(key)
  }
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
    preferSequential: options.preferSequential,
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

  // 谷歌免费网页翻译优先（快），失败回退系统原生翻译（稳）。
  // 冷却期（网络不通/被墙）内直接走系统引擎，不浪费时间。
  if (isGoogleEngineAvailable()) {
    // 在途任务只可能由不可取消的调用方（系统翻译界面预热）登记，因此可取消的
    // 调用方也可以安全等待共享结果；共享任务失败时同样回退系统引擎。
    const pending = inFlight.get(key)
    if (pending) {
      try {
        const value = await pending
        throwIfCancelled(request)
        options.onProgress?.(value)
        reportEngine(options, startedAt, "google")
        return value
      } catch (error) {
        throwIfCancelled(request)
        // 共享任务失败：与自身请求失败一致，继续走系统引擎。
      }
    } else {
      const shareInFlight = !request.isCancelled
      const task = runGoogleFastPath(request, options.onProgress)
        .then((value) => { storeCache(key, value, "google"); return value })
      if (shareInFlight) inFlight.set(key, task)
      try {
        const value = await task
        throwIfCancelled(request)
        reportEngine(options, startedAt, "google")
        return value
      } catch {
        // 谷歌失败（含共享任务失败）落到系统引擎重试。
      } finally {
        if (shareInFlight && inFlight.get(key) === task) inFlight.delete(key)
      }
    }
  }

  const translated = await translateSystemBatch(request, options.translationHost, options.onProgress)
  reportEngine(options, startedAt, "system")
  return translated
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
      .then((value) => { storeCache(key, value, "google"); return value })
    inFlight.set(key, task)
    const cleanup = () => {
      if (inFlight.get(key) === task) inFlight.delete(key)
    }
    task.then(cleanup, cleanup)
    task.catch(() => {})
  } catch {}
}
