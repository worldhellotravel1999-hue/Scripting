export const TIMEOUT_MS = 30000

export type Provider = "openai" | "gemini" | "anthropic" | "deepseek" | "openrouter" | { custom: string }

export type Model = {
  key: string
  id: string
  group: string
  builtin: boolean
  provider: Provider
}

export type Sample = { ok: boolean; ms: number; at: number; rank?: number }
export type History = Record<string, Sample[]>
// error 只在请求本身失败时填写（应用配置问题、网络错误），用于页面提示诊断原因；
// 回复内容不符合预期不算 error，避免正常失败刷屏。
export type Result = { ok: boolean; ms: number; at: number; error?: string }
export type Results = Record<string, Result>
export type Phase = "idle" | "queued" | "checking" | "ok" | "fail"

export function modelKey(builtin: boolean, group: string, model: string): string {
  // 保留旧版标识，历史评分可以直接继续使用。
  return `${builtin ? "b" : "c"}/${group}/${model}`
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}
