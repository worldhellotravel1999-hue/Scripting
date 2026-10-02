import { TIMEOUT_MS } from "./types"
export { TIMEOUT_MS } from "./types"
import type { Provider, Result } from "./types"

// 保留原工具的小请求 + 额度探针；请求内容公开，无凭据硬编码。
const QUOTA_PROBE = "The quick brown fox jumps over the lazy dog. ".repeat(1800)

export class RunToken {
  cancelled = false
  private listeners = new Set<() => void>()
  onCancel(listener: () => void): () => void {
    this.listeners.add(listener)
    if (this.cancelled) listener()
    return () => this.listeners.delete(listener)
  }
  cancel(): void {
    if (this.cancelled) return
    this.cancelled = true
    for (const listener of this.listeners) listener()
    this.listeners.clear()
  }
}

export type RequestStream = typeof Assistant.requestStreaming

// Assistant.requestStreaming 是宿主暴露的实例方法：作为未绑定引用传给 pingModel 后，
// 真正调用时会抛 "self type check failed for Objective-C instance method"，
// 两个探针因此立刻失败，所有模型都会是 0 分。必须用箭头函数包一层保住接收者。
const boundRequest: RequestStream = options => Assistant.requestStreaming(options)

const WRAP = "\\s`*_~\\\"'“”‘’.,;:!?…\\-–—"
const LEADING = new RegExp(`^[${WRAP}]*`)
const TRAILING = new RegExp(`[${WRAP}]*$`)
const ACCEPTED = ["ok", "okay"]

// 收到完整回复后才确认成功，避免 OK 或 OKAY 后接错误正文被误判。
// 允许大小写、首尾装饰符与句点；流式阶段只有仍是 OK 前缀时才继续等待。
// 不依赖网络分片边界；等待期间由统一的 30 秒超时保护。
export function replyVerdict(text: string, ended = false): boolean | null {
  const value = text.replace(LEADING, "").replace(TRAILING, "").trim().toLowerCase()
  if (ended) return ACCEPTED.includes(value)
  return ACCEPTED.some(word => word.startsWith(value)) ? null : false
}

type ProbeOutcome = { ok: boolean; error?: string }

async function probe(provider: Provider, modelId: string, content: string, token: RunToken, request: RequestStream): Promise<ProbeOutcome> {
  let reader: ReturnType<Awaited<ReturnType<RequestStream>>["getReader"]> | undefined
  let removeListener = () => {}
  try {
    if (token.cancelled) return { ok: false }
    const stream = await request({
      provider, modelId,
      systemPrompt: "This is an API health check. Reply with exactly OK and nothing else.",
      messages: [{ role: "user", content }],
    })
    reader = stream.getReader()
    removeListener = token.onCancel(() => { void reader?.cancel().catch(() => {}) })
    let text = ""
    while (!token.cancelled) {
      const chunk = await reader.read()
      if (chunk.done) return { ok: replyVerdict(text, true) === true }
      if (chunk.value?.type !== "text") continue
      text += chunk.value.content
      const verdict = replyVerdict(text)
      if (verdict !== null) return { ok: verdict }
      if (text.length > 256) return { ok: false }
    }
    return { ok: false }
  } catch (error) {
    // 建立请求阶段抛出的错误（应用配置问题、网络错误）需要带到页面提示。
    const message = String((error as Error)?.message ?? error ?? "").trim()
    return { ok: false, error: message || "请求失败" }
  } finally {
    removeListener()
    // 仅取消本请求，防止超时/停止后继续消费输出。
    if (reader) void reader.cancel().catch(() => {})
  }
}

export async function pingModel(provider: Provider, modelId: string, run: RunToken, request: RequestStream = boundRequest, timeoutMs = TIMEOUT_MS): Promise<Result | null> {
  const startedAt = Date.now()
  const token = new RunToken()
  let settleCancellation: (value: null) => void = () => {}
  const cancelled = new Promise<null>(resolve => { settleCancellation = resolve })
  const removeListener = run.onCancel(() => { token.cancel(); settleCancellation(null) })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    if (run.cancelled) return null
    const timeout = new Promise<ProbeOutcome>(resolve => {
      timer = setTimeout(() => { token.cancel(); resolve({ ok: false, error: `超过 ${Math.round(timeoutMs / 1000)} 秒未响应` }) }, timeoutMs)
    })
    const checks = Promise.all([
      probe(provider, modelId, "Reply with exactly: OK", token, request),
      probe(provider, modelId, QUOTA_PROBE + "\n\nReply with exactly: OK", token, request),
    ]).then(values => ({ ok: values.every(value => value.ok), error: values.map(value => value.error).find(Boolean) }))
    const outcome = await Promise.race([checks, timeout, cancelled])
    if (outcome === null || run.cancelled) return null
    const at = Date.now()
    const ms = Math.max(1, at - startedAt)
    return { ok: outcome.ok && ms <= timeoutMs, ms, at, error: outcome.ok ? undefined : outcome.error }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    removeListener()
    token.cancel()
  }
}
