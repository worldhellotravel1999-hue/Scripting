import type { TranslationRequest, TranslationResult } from "./types"

type SystemRequestWaiter = {
  wake: () => void
  priority: number
  order: number
}
const SYSTEM_REQUEST_WAITERS: SystemRequestWaiter[] = []
const SYSTEM_REQUEST_CONCURRENCY = 1
const SYSTEM_WAIT_TIMEOUT_MS = 120_000
let systemRequestActiveCount = 0
let systemRequestOrder = 0

function wakeNextSystemRequest() {
  if (systemRequestActiveCount >= SYSTEM_REQUEST_CONCURRENCY || SYSTEM_REQUEST_WAITERS.length === 0) return
  let nextIndex = 0
  for (let index = 1; index < SYSTEM_REQUEST_WAITERS.length; index += 1) {
    const current = SYSTEM_REQUEST_WAITERS[index]
    const next = SYSTEM_REQUEST_WAITERS[nextIndex]
    if (current.priority > next.priority
      || (current.priority === next.priority && current.order < next.order)) {
      nextIndex = index
    }
  }
  const next = SYSTEM_REQUEST_WAITERS.splice(nextIndex, 1)[0]
  next?.wake()
}

/** Terminal for this attempt: retrying would queue behind the same native call. */
export class SystemTranslationWaitError extends Error {}

function observeSystemRequest<T>(task: Promise<T>, isCancelled?: () => boolean): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const deadline = Date.now() + SYSTEM_WAIT_TIMEOUT_MS
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error: unknown, value?: T) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (error !== undefined) reject(error)
      else resolve(value as T)
    }
    const check = () => {
      if (isCancelled?.()) {
        finish(new SystemTranslationWaitError("翻译任务已取消。"))
      } else if (Date.now() >= deadline) {
        finish(new SystemTranslationWaitError("系统翻译等待超时。请确认语言提示或下载已完成，再点重试；仍无响应时请关闭并重新打开翻译页面。"))
      } else {
        timer = setTimeout(check, 200)
      }
    }
    task.then((value) => {
      if (isCancelled?.()) finish(new SystemTranslationWaitError("翻译任务已取消。"))
      else finish(undefined, value)
    }, (error) => finish(error ?? new Error("系统翻译失败。")))
    check()
  })
}

function resolveSystemLanguageCode(code: string | undefined) {
  if (!code || code === "auto") return undefined
  if (code === "zh-Hans") return "zh"
  if (code === "zh-Hant") return "zh-Hant"
  return code
}

async function withSystemRequestSlot<T>(work: () => Promise<T>, isCancelled?: () => boolean, priority = 0): Promise<T> {
  while (systemRequestActiveCount >= SYSTEM_REQUEST_CONCURRENCY) {
    if (isCancelled?.()) throw new Error("翻译任务已取消。")
    let wake: () => void = () => {}
    const waiter: SystemRequestWaiter = {
      wake: () => wake(),
      priority: Number.isFinite(priority) ? priority : 0,
      order: systemRequestOrder++,
    }
    const waiting = new Promise<void>((resolve) => {
      wake = resolve
      SYSTEM_REQUEST_WAITERS.push(waiter)
    })
    let waitFailed = false
    try {
      await observeSystemRequest(waiting, isCancelled)
    } catch (error) {
      waitFailed = true
      throw error
    } finally {
      const index = SYSTEM_REQUEST_WAITERS.indexOf(waiter)
      if (index >= 0) SYSTEM_REQUEST_WAITERS.splice(index, 1)
      if (waitFailed && systemRequestActiveCount < SYSTEM_REQUEST_CONCURRENCY) {
        wakeNextSystemRequest()
      }
    }
  }
  if (isCancelled?.()) {
    // This waiter consumed a wake-up without taking the free slot. Pass it on.
    wakeNextSystemRequest()
    throw new Error("翻译任务已取消。")
  }
  systemRequestActiveCount += 1
  // Keep ownership until the native Promise actually settles. A UI timeout or
  // cancellation cannot cancel Translation and must not allow overlapping calls.
  const nativeTask = (async () => {
    try {
      return await work()
    } finally {
      systemRequestActiveCount = Math.max(0, systemRequestActiveCount - 1)
      wakeNextSystemRequest()
    }
  })()
  return await observeSystemRequest(nativeTask, isCancelled)
}

export function createSystemTranslationEngine(translationHost?: Translation) {
  const translator = translationHost || Translation.shared
  const languageOptions = (request: TranslationRequest) => {
    const target = resolveSystemLanguageCode(request.targetLanguageCode)
    const source = resolveSystemLanguageCode(request.sourceLanguageCode)
    // When source is automatic, omit it exactly as required by Translation.
    // The bound translationHost can then present native disambiguation or
    // language-download UI instead of receiving a guessed language code.
    return source ? { source, target } : { target }
  }

  return {
    async translate(request: TranslationRequest): Promise<TranslationResult> {
      const sourceText = String(request.sourceText || "").trim()
      if (!sourceText) throw new Error("请提供需要翻译的原文。")

      return await withSystemRequestSlot(async () => {
        const options = languageOptions(request)
        if (options.source && options.target && options.source === options.target) {
          return { translatedText: sourceText }
        }
        const translatedText = await translator.translate({
          text: sourceText,
          ...options,
        })
        const value = String(translatedText || "").trim()
        if (!value) throw new Error("系统翻译没有返回可用译文。")
        return { translatedText: value }
      }, request.isCancelled, request.priority)
    },

    async translateBatch(request: TranslationRequest, texts: string[]): Promise<TranslationResult> {
      const sourceTexts = texts.map((item) => String(item || "")).filter((item) => item.length > 0)
      if (!sourceTexts.length) throw new Error("请提供需要翻译的原文。")

      return await withSystemRequestSlot(async () => {
        const options = languageOptions(request)
        if (options.source && options.target && options.source === options.target) {
          return { translatedText: sourceTexts.join("") }
        }
        const translated = await translator.translateBatch({
          texts: sourceTexts,
          ...options,
        })
        if (!Array.isArray(translated) || translated.length !== sourceTexts.length) {
          throw new Error("系统批量翻译没有返回完整译文。")
        }
        const values = translated.map((item) => String(item || "").trim())
        if (values.some((item) => !item)) {
          throw new Error("系统批量翻译返回了空译文。")
        }
        const translatedText = values.join("").trim()
        if (!translatedText) throw new Error("系统翻译没有返回可用译文。")
        return { translatedText }
      }, request.isCancelled, request.priority)
    },
  }
}
