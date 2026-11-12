import { canonicalAddress } from "./ip"

export type ServiceState = "reachable" | "restricted" | "failed" | "unknown"
export type ServiceGroup = "media" | "ai"
export interface ServiceDefinition { id: string; name: string; group: ServiceGroup; url: string }
export interface ServiceResult {
  id: string
  name: string
  group: ServiceGroup
  state: ServiceState
  status: number | null
  ms: number | null
  detail: string
  /** 仅来自本轮请求日志或上游快照，不根据节点名猜地区。 */
  policy: string
}
export interface LocalNetwork {
  kind: string
  ipv4: string
  ipv6: string
  tunnel: boolean | null
  /** 地址只表示接口存在，不证明它是当前出站路径。 */
  interfaces: string[]
  gateway: string
  dns: string
}
export interface SurgeSummary {
  mode: string
  node: string
  policy: string
  protocol: string
  note: string
}
export interface NetworkReport {
  version: 1
  measuredAt: number
  contextIP: string | null
  source: "device" | "surge"
  local: LocalNetwork
  domesticExit?: { ip: string; location: string; isp: string } | null
  latency: { domestic: number | null; overseas: number | null }
  quic: "h3" | "other" | "unknown"
  httpProtocol: string
  services: ServiceResult[]
  surge: SurgeSummary | null
  note: string
  durationMs: number
}

export const SERVICES: ServiceDefinition[] = [
  { id: "netflix", name: "Netflix", group: "media", url: "https://www.netflix.com/title/81215567" },
  { id: "disney", name: "Disney+", group: "media", url: "https://www.disneyplus.com/" },
  { id: "spotify", name: "Spotify", group: "media", url: "https://open.spotify.com/" },
  { id: "tiktok", name: "TikTok", group: "media", url: "https://www.tiktok.com/" },
  { id: "youtube", name: "YouTube", group: "media", url: "https://www.youtube.com/" },
  { id: "prime", name: "Prime Video", group: "media", url: "https://www.primevideo.com/" },
  { id: "chatgpt", name: "ChatGPT", group: "ai", url: "https://chatgpt.com/" },
  { id: "claude", name: "Claude", group: "ai", url: "https://claude.ai/" },
  { id: "gemini", name: "Gemini", group: "ai", url: "https://gemini.google.com/" },
  { id: "deepseek", name: "DeepSeek", group: "ai", url: "https://chat.deepseek.com/" },
  { id: "grok", name: "Grok", group: "ai", url: "https://grok.com/" },
  { id: "perplexity", name: "Perplexity", group: "ai", url: "https://www.perplexity.ai/" },
]
export const EMPTY_LOCAL: LocalNetwork = {
  kind: "未知", ipv4: "", ipv6: "", tunnel: null, interfaces: [], gateway: "", dns: "",
}
export function pendingServices(): ServiceResult[] {
  return SERVICES.map(({ id, name, group }) => ({ id, name, group, state: "unknown", status: null, ms: null, detail: "未检测", policy: "" }))
}
export function classifyService(status: number | null, body = ""): { state: ServiceState; detail: string } {
  if (status == null) return { state: "unknown", detail: "连接失败或超时" }
  if ([401, 403, 407, 429, 451].includes(status)) return { state: "restricted", detail: `HTTP ${status} · 认证、限流或访问限制` }
  if (status >= 200 && status < 300) {
    const sample = body.slice(0, 200_000)
    if (/cf-chl-|challenge-platform|<title>\s*(just a moment|attention required)|unusual traffic|verify (that )?you are human|(?:complete|solve|enter|verify) (?:the |this |a )?captcha|not available in your (country|region)|unsupported_country|access denied/i.test(sample)) {
      return { state: "restricted", detail: `HTTP ${status} · 验证或区域限制页面` }
    }
    return { state: "reachable", detail: `HTTP ${status} · 页面可访问` }
  }
  if (status >= 300 && status < 400) return { state: "unknown", detail: `HTTP ${status} · 重定向未完成` }
  return { state: "failed", detail: `HTTP ${status} · 请求未成功` }
}
export function serviceStateLabel(state: ServiceState): string {
  return { reachable: "可访问", restricted: "受限", failed: "失败", unknown: "未知" }[state]
}
export function latencyLabel(value: number | null | undefined): string {
  return value == null ? "—" : `${Math.round(value)} ms`
}
export function quicLabel(report: Pick<NetworkReport, "quic" | "httpProtocol"> | null): string {
  return !report || report.quic === "unknown" ? "未取得结果"
    : report.quic === "h3" ? "已观测 HTTP/3" : `${report.httpProtocol || "HTTP/2 或更早"} · 未观测 H3`
}
export function serviceCounts(services: ServiceResult[], group: ServiceGroup) {
  const rows = services.filter(row => row.group === group)
  return { total: 6, reachable: rows.filter(row => row.state === "reachable").length,
    restricted: rows.filter(row => row.state === "restricted").length,
    failed: rows.filter(row => row.state === "failed").length }
}
export function isFreshReport(report: NetworkReport | null, minutes: number, now = Date.now()): boolean {
  return !!report && report.measuredAt <= now + 60_000 && now - report.measuredAt < minutes * 60_000
}
export function reportMatchesIP(report: NetworkReport | null, ip: string, manual = false): boolean {
  return !manual && !!report?.contextIP && canonicalAddress(report.contextIP) !== null
    && canonicalAddress(report.contextIP) === canonicalAddress(ip)
}
const text = (value: unknown, length = 250): string => typeof value === "string" ? value.trim().slice(0, length) : ""
const ms = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 300_000 ? value : null
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** 只接收本项目的诊断 schema；旧 IP 快照没有此字段仍可正常读取。 */
export function parseNetworkReport(raw: unknown): NetworkReport | null {
  const value = record(raw)
  if (value.version !== 1 || typeof value.measuredAt !== "number" || !Number.isFinite(value.measuredAt)
    || value.measuredAt <= 0 || value.measuredAt > Date.now() + 60_000 || !Array.isArray(value.services)
    || (value.source !== "device" && value.source !== "surge")) return null
  const local = record(value.local), latency = record(value.latency), surge = record(value.surge)
  const domestic = record(value.domesticExit), domesticIP = canonicalAddress(text(domestic.ip))
  const services = pendingServices().map(base => {
    const row = record((value.services as unknown[]).find(item => record(item).id === base.id))
    if (typeof row.state !== "string" || !["reachable", "restricted", "failed", "unknown"].includes(row.state)) return base
    const status = typeof row.status === "number" && Number.isInteger(row.status)
      && row.status >= 100 && row.status <= 599 ? row.status : null
    // 可访问必须有 2xx 证据；验证码仍允许保留“200 + 受限”。
    const contradicted = row.state === "reachable" && (status == null || status < 200 || status >= 300)
    const state = contradicted ? classifyService(status).state : row.state as ServiceState
    return { ...base, state, status, ms: ms(row.ms),
      detail: contradicted ? classifyService(status).detail : text(row.detail), policy: text(row.policy) }
  })
  return {
    version: 1, measuredAt: value.measuredAt, contextIP: canonicalAddress(text(value.contextIP)), source: value.source,
    local: { kind: text(local.kind) || "未知", ipv4: canonicalAddress(text(local.ipv4)) || "",
      ipv6: canonicalAddress(text(local.ipv6)) || "", tunnel: typeof local.tunnel === "boolean" ? local.tunnel : null,
      interfaces: Array.isArray(local.interfaces) ? local.interfaces.filter(item => typeof item === "string").slice(0, 12) as string[] : [],
      gateway: text(local.gateway), dns: text(local.dns) },
    domesticExit: domesticIP ? { ip: domesticIP, location: text(domestic.location), isp: text(domestic.isp) } : null,
    latency: { domestic: ms(latency.domestic), overseas: ms(latency.overseas) },
    quic: value.quic === "h3" ? "h3" : value.quic === "other" ? "other" : "unknown", httpProtocol: text(value.httpProtocol, 30),
    services, surge: typeof surge.mode === "string" ? { mode: text(surge.mode), node: text(surge.node),
      policy: text(surge.policy), protocol: text(surge.protocol), note: text(surge.note) } : null,
    note: text(value.note, 600), durationMs: ms(value.durationMs) ?? 0,
  }
}
