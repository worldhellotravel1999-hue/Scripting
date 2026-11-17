import { AbortSignal, fetch } from "scripting"
import type { Response } from "scripting"
import { canonicalAddress } from "./ip"
import { EMPTY_LOCAL, SERVICES, normalizeServiceRegionCode, pendingServices } from "./network_model"
import type { NetworkReport, ServiceResult, SurgeSummary } from "./network_model"
import { getSurgeKey, isNetworkSnapshotURL, isSurgeHost, normalizeNetworkSettings } from "./network_settings"
import type { NetworkSettings } from "./network_settings"

const value = (raw: unknown): Record<string, unknown> | null => raw !== null && typeof raw === "object"
  && !Array.isArray(raw) ? raw as Record<string, unknown> : null
const text = (raw: unknown, limit = 120): string => typeof raw === "string" ? raw.trim().slice(0, limit) : ""
const positiveMs = (raw: unknown): number | null => typeof raw === "number" && Number.isFinite(raw)
  && raw > 0 && raw <= 300_000 ? raw : null
// 显示字段不承载 URL 或鉴权片段，错误路径也不输出原始异常。
const label = (raw: unknown, limit = 120): string => typeof raw === "string" ? raw
  .replace(/[a-z][a-z\d+.-]*:\/\/[^\s]+/gi, "[地址已隐藏]")
  .replace(/\b(?:x-key|authorization|token|password)\s*[:=]\s*\S+/gi, "[凭据已隐藏]")
  .replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, limit) : ""
const fieldsAre = (data: Record<string, unknown>, names: string[], type: string): boolean =>
  names.every(name => data[name] === undefined || data[name] === null || typeof data[name] === type)
const validMs = (raw: unknown): boolean => raw === undefined || raw === null
  || typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 300_000

function validServices(raw: unknown): raw is Record<string, unknown>[] {
  if (!Array.isArray(raw) || raw.length > 64) return false
  const ids = new Set<string>()
  return raw.every(item => {
    const row = value(item)
    if (!row || typeof row.id !== "string" || !row.id || row.id.length > 80
      || typeof row.ok !== "boolean" || !fieldsAre(row, ["policy"], "string") || ids.has(row.id)) return false
    ids.add(row.id)
    return true
  })
}

/** 流式解析快照/API 响应；超过上限时停止读取并拒绝。 */
export async function readSurgeJSON(response: Response, key?: string): Promise<{ data: unknown; status: number }> {
  const status = response.status
  try {
    const reader = response.body.getReader()
    try {
      if (!response.ok) return { data: null, status }
      const decoder = new TextDecoder()
      let body = "", bytes = 0
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        if (!chunk.value) throw new Error("响应流不完整")
        bytes += chunk.value.length
        if (bytes > 1_048_576) return { data: null, status }
        body += decoder.decode(chunk.value, { stream: true })
      }
      body += decoder.decode()
      const data: unknown = JSON.parse(body, (_name, entry: unknown) => typeof entry === "string" && key
        ? entry.split(key).join("[凭据已隐藏]").split(encodeURIComponent(key)).join("[凭据已隐藏]") : entry)
      return { data, status }
    } finally { await reader.cancel().catch(() => {}) }
  } catch { return { data: null, status } }
}

async function requestJson(url: string, key?: string, signal?: AbortSignal): Promise<{ data: unknown; status: number }> {
  if (signal?.aborted) return { data: null, status: 0 }
  try {
    const timeout = AbortSignal.timeout(3000)
    const response = await fetch(url, { timeout: 3, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: key ? { "X-Key": key } : undefined, handleRedirect: async () => null })
    return await readSurgeJSON(response, key)
  } catch { return { data: null, status: 0 } }
}

function snapshotServices(data: Record<string, unknown>): ServiceResult[] {
  const media = data.media as unknown[], ai = data.ai as unknown[]
  return pendingServices().map(base => {
    const raw = (base.group === "media" ? media : ai).find(item => value(item)?.id === base.id)
    const item = value(raw)
    if (!item || typeof item.ok !== "boolean") return base
    const policy = /QUIC-BLOCK/i.test(text(item.policy, 500)) ? "" : label(item.policy, 80)
    const regionCode = normalizeServiceRegionCode(item.cc) || normalizeServiceRegionCode(item.regionCode)
    return { ...base, detail: item.ok ? "上游报告可达 · 未提供 HTTP 状态" : "上游未报告可达 · 未提供 HTTP 状态",
      regionCode, regionSource: regionCode ? "snapshot" : "", policy: policy ? `上游快照 · ${policy}` : "" }
  })
}

/** 只接收 Surge v1 诊断快照，不读取其评分、归属或地理字段。 */
export function parseSurgeSnapshot(raw: unknown, settings: NetworkSettings, contextIP: string | null,
  now = Date.now()): NetworkReport | null {
  const data = value(raw)
  if (!data || data.v !== 1 || data.src !== "surge" || typeof data.ts !== "number"
    || !Number.isFinite(now) || !Number.isSafeInteger(data.ts) || data.ts <= 0 || data.ts > now
    || now - data.ts >= normalizeNetworkSettings(settings).refreshMinutes * 60_000
    || data.exit != null && !value(data.exit)
    || !value(data.local) || !value(data.lat) || !value(data.quic)
    || !validServices(data.media) || !validServices(data.ai)
    || !fieldsAre(data, ["masked"], "boolean") || !validMs(data.cost)
    || data.surge != null && !value(data.surge)) return null

  const exit = value(data.exit) || {}, local = data.local as Record<string, unknown>
  const lat = data.lat as Record<string, unknown>, quic = data.quic as Record<string, unknown>
  const surge = value(data.surge)
  if (!fieldsAre(exit, ["ip"], "string")
    || !["net", "ip", "gw", "dns"].every(field => typeof local[field] === "string")
    || typeof local.vpn !== "boolean" || !fieldsAre(local, ["v6"], "boolean")
    || typeof lat.local !== "number" || typeof lat.proxy !== "number"
    || !validMs(lat.local) || !validMs(lat.proxy)
    || typeof quic.ok !== "boolean" || typeof quic.reachable !== "boolean"
    || quic.ok === true && quic.reachable !== true
    || surge && !["mode", "node", "policy", "protocol"].every(field => typeof surge[field] === "string")) return null

  const upstreamIP = canonicalAddress(text(exit.ip)), currentIP = contextIP ? canonicalAddress(contextIP) : null
  const bound = data.masked !== true && !!upstreamIP && !!currentIP && upstreamIP === currentIP
  const localIP = data.masked === true ? null : canonicalAddress(text(local.ip))
  const upstreamMode = modeLabel(surge?.mode) || label(surge?.mode)
  const upstreamDirect = upstreamMode === "全部直连"
  let note = "上游 Surge v1 快照 · 未绑定当前 IP"
  if (bound) note = "上游 Surge v1 快照 · 出口 IP 已匹配"
  else if (data.masked === true) note = "上游 Surge v1 快照 · 出口 IP 已打码，未绑定当前 IP"
  else if (upstreamIP && currentIP) note = "上游 Surge v1 快照 · 出口 IP 不匹配，未绑定当前 IP"
  else if (!upstreamIP) note = "上游 Surge v1 快照 · 无有效出口 IP，未绑定当前 IP"

  return {
    version: 1, measuredAt: data.ts, contextIP: bound ? currentIP : null, source: "surge",
    local: { ...EMPTY_LOCAL, interfaces: [], kind: label(local.net) || "未知", ipv4: localIP && !localIP.includes(":") ? localIP : "",
      ipv6: localIP?.includes(":") ? localIP : "", tunnel: typeof local.vpn === "boolean" ? local.vpn : null,
      gateway: label(local.gw), dns: label(local.dns) },
    latency: { domestic: positiveMs(lat.local), overseas: positiveMs(lat.proxy) },
    quic: quic.ok === true ? "h3" : quic.ok === false && quic.reachable === true ? "other" : "unknown",
    httpProtocol: quic.ok === true ? "HTTP/3" : "", services: snapshotServices(data),
    surge: surge ? { mode: upstreamMode, node: upstreamDirect ? "直连" : label(surge.node),
      policy: upstreamDirect ? "" : label(surge.policy), protocol: upstreamDirect ? "" : label(surge.protocol),
      note: "上游快照，非实时 API" } : null,
    note, durationMs: positiveMs(data.cost) ?? 0,
  }
}

export async function readRemoteNetwork(settings: NetworkSettings, contextIP: string | null, signal?: AbortSignal): Promise<NetworkReport | null> {
  if (!isNetworkSnapshotURL(settings.snapshotURL)) return null
  const result = await requestJson(settings.snapshotURL, undefined, signal)
  return result.data === null ? null : parseSurgeSnapshot(result.data, settings, contextIP)
}

function surgeBase(settings: NetworkSettings, key: string): string | null {
  if (!key || !isSurgeHost(settings.surgeHost) || !Number.isInteger(settings.surgePort)
    || settings.surgePort < 1 || settings.surgePort > 65535) return null
  const host = settings.surgeHost.replace(/^\[|\]$/g, "")
  return `http://${host.includes(":") ? `[${host}]` : host}:${settings.surgePort}/v1/`
}

function recentList(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data
  const wrapped = value(data)
  return wrapped && Array.isArray(wrapped.requests) ? wrapped.requests : null
}

function requestID(raw: unknown): number | null {
  const id = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw
  return typeof id === "number" && Number.isSafeInteger(id) && id >= 0 ? id : null
}

function requestHost(item: Record<string, unknown>): string {
  const remote = text(item.remoteHost, 300).toLowerCase().replace(/\.$/, "")
  // remoteHost 存在时不从 URL 兜底，防止两者不一致导致误匹配。
  if (remote) {
    const host = remote.replace(/:\d+$/, "").replace(/\.$/, "")
    return isSurgeHost(host) ? host.replace(/^www\./, "") : ""
  }
  try {
    const url = new URL(text(item.URL, 2000))
    return /^https?:$/.test(url.protocol) ? url.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "") : ""
  } catch { return "" }
}

const serviceHost = (url: string): string => new URL(url).hostname.replace(/^www\./, "")
const serviceHosts = SERVICES.map(service => ({ id: service.id, host: serviceHost(service.url) }))
const usablePolicy = (item: Record<string, unknown>): string => {
  const policy = typeof item.policyName === "string" ? item.policyName.trim() : ""
  const notes = Array.isArray(item.notes) ? item.notes.filter(note => typeof note === "string").join(" ") : text(item.notes, 20_000)
  if (!policy || policy.length > 256 || /QUIC-BLOCK/i.test(`${policy} ${text(item.originalPolicyName, 256)} ${notes}`)) return ""
  return policy
}

/** 匹配基线之后的同域请求；日志不能证明该请求一定来自本脚本。 */
export function policiesAfterBaseline(data: unknown, baseline: number | null): Map<string, string> {
  const result = new Map<string, string>(), list = recentList(data)
  if (baseline === null || !Number.isSafeInteger(baseline) || baseline < 0 || !list) return result
  const latest = new Map<string, number>()
  for (const raw of list) {
    const item = value(raw), id = requestID(item?.id)
    if (!item || id === null || id <= baseline) continue
    const policy = usablePolicy(item), host = requestHost(item)
    if (!policy || !host) continue
    for (const service of serviceHosts) {
      if (host !== service.host && !host.endsWith(`.${service.host}`)) continue
      if (id <= (latest.get(service.id) ?? baseline)) continue
      result.set(service.id, label(policy))
      latest.set(service.id, id)
    }
  }
  return result
}

function activeNode(data: unknown): { node: string; count: number; policy: string } | null {
  const list = recentList(data)
  if (!list) return null
  const counts = new Map<string, { count: number; last: number; policy: string }>()
  const recent = [...list].sort((a, b) => (requestID(value(b)?.id) ?? -1) - (requestID(value(a)?.id) ?? -1)).slice(0, 64)
  for (const raw of recent) {
    const item = value(raw), id = requestID(item?.id)
    if (!item || id === null) continue
    const name = usablePolicy(item)
    if (!name || /^(DIRECT|REJECT(?:-[\w-]+)?|OUTBOUND)$/i.test(name)) continue
    const current = counts.get(name) || { count: 0, last: 0, policy: "" }
    const group = text(item.originalPolicyName, 256)
    counts.set(name, { count: current.count + 1, last: Math.max(id, current.last),
      policy: id >= current.last && group && group !== name ? label(group) : current.policy })
  }
  const winner = [...counts.entries()].sort((a, b) => b[1].count - a[1].count || b[1].last - a[1].last)[0]
  return winner ? { node: winner[0], count: winner[1].count, policy: winner[1].policy } : null
}

function observedProtocol(data: unknown, node: string): string {
  const groups = value(data)
  if (!groups || !node) return ""
  const protocols = new Set<string>()
  for (const raw of Object.values(groups)) {
    // 数组只提供成员类型；成员位置和所属组均不证明已选中或经过该组。
    const entries = Array.isArray(raw) ? raw : [raw]
    for (const entry of entries) {
      const member = value(entry)
      if (!member || text(member.name, 257) !== node) continue
      const type = text(member.typeDescription) || text(member.type) || text(member.protocol)
      if (type && !/group|select|url-test|fallback|load.balance|smart|subnet/i.test(type)) protocols.add(label(type))
    }
  }
  // 同名节点类型冲突时不选择其中一个协议。
  return protocols.size === 1 ? [...protocols][0] : ""
}

const modeLabel = (raw: unknown): string => {
  switch (text(raw, 30).toLowerCase()) {
    case "rule": return "规则分流"
    case "proxy": case "global": return "全局代理"
    case "direct": return "全部直连"
    default: return ""
  }
}

function apiNote(report: NetworkReport, issues: string[]): string {
  return [label(report.note, 400), ...issues].filter(Boolean).join(" · ").slice(0, 600)
}

/** 空列表代表基线 0；任一 id 畸形时无法证明已覆盖所有旧请求，返回 null。 */
export function surgeBaselineFromRequests(data: unknown): number | null {
  const list = recentList(data)
  if (!list) return null
  let max = 0
  for (const raw of list) {
    const id = requestID(value(raw)?.id)
    if (id === null) return null
    max = Math.max(max, id)
  }
  return max
}

/** 无密钥不请求 API；基线获取失败返回 null，本轮服务策略随之保持未知。 */
export async function readSurgeBaseline(settings: NetworkSettings, signal?: AbortSignal): Promise<number | null> {
  const key = getSurgeKey(), base = surgeBase(settings, key)
  if (!base) return null
  const response = await requestJson(`${base}requests/recent`, key, signal)
  return surgeBaselineFromRequests(response.data)
}

export async function enrichWithSurge(report: NetworkReport, settings: NetworkSettings,
  baseline: number | null, signal?: AbortSignal): Promise<NetworkReport> {
  const key = getSurgeKey(), base = surgeBase(settings, key)
  if (!key) return report
  if (!base) return { ...report, note: apiNote(report, ["Surge API 地址无效"]) }
  const [outbound, groups, recent] = await Promise.all([
    requestJson(`${base}outbound`, key, signal), requestJson(`${base}policy_groups`, key, signal),
    requestJson(`${base}requests/recent`, key, signal),
  ])
  const result = applySurgeObservation(report, outbound.data, groups.data, recent.data, baseline)
  return [outbound, groups, recent].some(response => response.status === 401 || response.status === 403)
    ? { ...result, note: apiNote(result, ["Surge API 未授权"]) } : result
}

/** 纯函数：不读取存储或密钥，不发请求；便于验证模式切换与服务日志归属。 */
export function applySurgeObservation(report: NetworkReport, outbound: unknown, groups: unknown,
  recent: unknown, baseline: number | null): NetworkReport {
  const issues: string[] = []
  const mode = modeLabel(value(outbound)?.mode)
  if (!mode) issues.push("Surge 出站模式未取得")
  if (!recentList(recent)) issues.push("Surge 近期请求未取得")
  const direct = mode === "全部直连", active = direct ? null : activeNode(recent)
  const protocol = active ? observedProtocol(groups, active.node) : ""
  if (!direct && !value(groups)) issues.push("Surge 策略组信息未取得")
  if (active && !protocol) issues.push("Surge 节点协议未知")
  if (report.source === "surge") issues.push("上游快照探测时间独立，未绑定本轮服务日志")
  const validBaseline = baseline !== null && Number.isSafeInteger(baseline) && baseline >= 0
  if (!validBaseline) issues.push("缺少探测前日志基线，未绑定服务策略")
  const max = surgeBaselineFromRequests(recent)
  const reset = validBaseline && max !== null && max < baseline
  if (reset) issues.push("近期请求编号已回退，未绑定服务策略")
  const summary: SurgeSummary = {
    mode, node: direct ? "直连" : label(active?.node),
    policy: direct ? "" : active?.policy || "", protocol: direct ? "" : protocol,
    note: direct ? "Surge 出站模式显示直连" : active
      ? `近期请求日志活跃节点（${active.count} 条），不代表当前选中节点或所有服务出口`
      : "未观测到活跃节点；不会根据策略组成员顺序推断",
  }
  // 上游快照对应另一时刻，不能把本机这一轮日志绑定给上游旧探测。
  const policies = report.source === "device" && !reset ? policiesAfterBaseline(recent, baseline) : new Map<string, string>()
  const services = report.services.map(row => {
    const policy = policies.get(row.id)
    return report.source === "surge" ? row : { ...row, policy: policy ? `同期同域日志 · ${policy}` : "" }
  })
  return { ...report, surge: summary, services, note: apiNote(report, issues) }
}
