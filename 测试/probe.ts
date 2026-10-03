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
export type StructuredRequest = (prompt: string, schema: unknown, options: { provider: Provider; modelId?: string }) => Promise<unknown>

// 宿主方法需要在调用点保留 Assistant 接收者；直接把方法引用传入探针会触发
// "self type check failed for Objective-C instance method"。
const boundRequest: RequestStream = options => Assistant.requestStreaming(options)
const boundStructuredRequest: StructuredRequest = (prompt, schema, options) =>
  Assistant.requestStructuredData(prompt, schema as any, options)

const HEALTH_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean", description: "Whether the model responded successfully." },
  },
  required: true,
  description: "A model connection health check result.",
} as const

// hy4-preview 的 Workbuddy SSE 响应始终无法被宿主的流式解析器消费；
// 直接走已验证可用的结构化接口，避免先浪费一轮流式请求再触发 30 秒总超时。
function prefersStructuredProbe(provider: Provider, modelId: string): boolean {
  return typeof provider === "object" && provider.custom === "Workbuddy" && modelId === "global:hy4-preview"
}

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

function errorText(error: unknown): string {
  return String((error as Error)?.message ?? error ?? "").trim()
}

function canUseStructuredFallback(message: string): boolean {
  // 部分 OpenAI 兼容模型的 SSE 形态无法被 Scripting 的流式解析器读取。
  // 网络、额度和鉴权错误不重复请求，避免掩盖真实配置问题或增加用量。
  return /无法解析响应数据|正确的 API 类型|parse(?:d|ing)?\s+(?:the\s+)?response|response\s+(?:data\s+)?(?:could not be parsed|parse)/i.test(message)
}

async function structuredProbe(provider: Provider, modelId: string, content: string, request: StructuredRequest): Promise<ProbeOutcome> {
  try {
    // 结构化接口要求模型输出 JSON；不能同时附带流式探针的“只回复 OK”指令，
    // 否则部分模型会在 OK 文本和 JSON 之间等待或返回无法解析的结果。
    // 小探针和额度探针都复用这里，因此剥离它们共同的尾部指令。
    const cleanContent = content.replace(/\s*Reply with exactly:\s*OK\s*$/i, "").trim()
    const prompt = [
      "This is an API health check.",
      "Read the input below and return a JSON object with exactly one field: ok. Set ok to true.",
      cleanContent,
    ].filter(Boolean).join("\n\n")
    const value = await request(prompt, HEALTH_SCHEMA, { provider, modelId })
    if (value !== null && typeof value === "object" && (value as { ok?: unknown }).ok === true) {
      return { ok: true }
    }
    return { ok: false, error: "结构化请求未返回 ok=true" }
  } catch (error) {
    return { ok: false, error: errorText(error) || "结构化请求失败" }
  }
}

async function probe(provider: Provider, modelId: string, content: string, token: RunToken, request: RequestStream, structuredRequest: StructuredRequest): Promise<ProbeOutcome> {
  let reader: ReturnType<Awaited<ReturnType<RequestStream>>["getReader"]> | undefined
  let removeListener = () => {}
  try {
    if (token.cancelled) return { ok: false }
    if (prefersStructuredProbe(provider, modelId)) {
      return await structuredProbe(provider, modelId, content, structuredRequest)
    }
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
    // 建立请求或读取流阶段抛出的错误需要带到页面提示诊断原因。
    const message = errorText(error)
    if (!token.cancelled && canUseStructuredFallback(message)) {
      // 同一模型的结构化接口走另一条兼容解析路径，成功即证明模型可用。
      const fallback = await structuredProbe(provider, modelId, content, structuredRequest)
      return fallback.ok ? fallback : { ok: false, error: fallback.error || message }
    }
    return { ok: false, error: message || "请求失败" }
  } finally {
    removeListener()
    // 仅取消本请求，防止超时/停止后继续消费输出。
    if (reader) void reader.cancel().catch(() => {})
  }
}

export async function pingModel(provider: Provider, modelId: string, run: RunToken, request: RequestStream = boundRequest, timeoutMs = TIMEOUT_MS, structuredRequest: StructuredRequest = boundStructuredRequest): Promise<Result | null> {
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
      probe(provider, modelId, "Reply with exactly: OK", token, request, structuredRequest),
      probe(provider, modelId, QUOTA_PROBE + "\n\nReply with exactly: OK", token, request, structuredRequest),
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
