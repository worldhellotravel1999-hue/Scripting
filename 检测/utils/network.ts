import { AbortSignal, Device } from "scripting"
import { probe } from "./network_probe"
import { canonicalAddress, isPublicExitAddress } from "./ip"
import { EMPTY_LOCAL, SERVICES, classifyService, pendingServices, reportMatchesIP } from "./network_model"
import type { LocalNetwork, NetworkReport } from "./network_model"
import { getNetworkSettings } from "./network_settings"
import { enrichWithSurge, readRemoteNetwork, readSurgeBaseline } from "./network_surge"

type Address = { address: string; family: string; isInternal: boolean }
/** 只检查接口，不把 tunnel 存在等同于目标请求走代理。 */
export function localNetworkFromInterfaces(interfaces: Record<string, Address[]>): LocalNetwork {
  const result: LocalNetwork = { ...EMPTY_LOCAL, interfaces: [], tunnel: false }
  const candidates: { name: string; ipv4: string; ipv6: string; priority: number }[] = []
  for (const [name, addresses] of Object.entries(interfaces)) {
    const rows = addresses.filter(item => !item.isInternal && !!canonicalAddress(item.address.split("%")[0]))
    if (!rows.length) continue
    if (/^(utun|ipsec|ppp|tun|tap|wg)/i.test(name)) { result.tunnel = true; continue }
    if (/^(lo|awdl|llw)/i.test(name)) continue
    const ipv4 = rows.find(item => item.family === "IPv4")?.address || ""
    const ipv6 = rows.filter(item => item.family === "IPv6").sort((a, b) =>
      Number(isPublicExitAddress(b.address.split("%")[0])) - Number(isPublicExitAddress(a.address.split("%")[0])))[0]?.address.split("%")[0] || ""
    if (!ipv4 && !ipv6) continue
    candidates.push({ name, ipv4, ipv6, priority: name === "en0" ? 0 : /^pdp_ip/.test(name) ? 1 : 2 })
  }
  candidates.sort((a, b) => a.priority - b.priority)
  const first = candidates[0]
  if (first) {
    result.kind = first.name === "en0" ? "Wi-Fi 接口" : /^pdp_ip/.test(first.name) ? "蜂窝接口" : "其他接口"
    result.ipv4 = first.ipv4
    result.ipv6 = first.ipv6
    result.interfaces = candidates.map(item => item.name)
  }
  return result
}
export function localAddressHint(ip: string): string {
  const value = canonicalAddress(ip)
  if (!value) return "未取得地址"
  if (value.includes(":")) return isPublicExitAddress(value) ? "全局 IPv6 接口地址" : "本地 IPv6 接口地址"
  const [a, b] = value.split(".").map(Number)
  if (a === 100 && b >= 64 && b <= 127) return "共享地址段 · 可能经过运营商 NAT"
  if (a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168) return "私网地址 · 未测试 NAT 类型"
  return isPublicExitAddress(value) ? "公网接口地址 · 未测试 NAT 类型" : "特殊用途接口地址"
}

export function parseDomesticExit(text: string): NetworkReport["domesticExit"] {
  const match = /IP[：:\s]*([0-9a-f:.]+)(?=\s|，|,|$).*?来自于[：:\s]*(.+)/i.exec(text)
  const ip = match ? canonicalAddress(match[1]) : null
  if (!ip || !isPublicExitAddress(ip)) return null
  const parts = match![2].trim().split(/\s+/).filter(Boolean)
  return { ip, location: (parts.length > 1 ? parts.slice(0, -1) : parts).join(" · "),
    isp: parts.length > 1 ? parts[parts.length - 1] : "" }
}

export function parseHTTPProtocol(text: string): { quic: NetworkReport["quic"]; httpProtocol: string } {
  const protocol = /^http=([^\r\n]+)$/m.exec(text)?.[1].trim().toLowerCase() || ""
  if (/^(h3|http\/3)(?:[-.].*)?$/.test(protocol)) return { quic: "h3", httpProtocol: "HTTP/3" }
  if (/^(h2|http\/2|http\/1\.[01])$/.test(protocol)) return { quic: "other", httpProtocol: protocol === "h2" ? "HTTP/2" : protocol.toUpperCase() }
  return { quic: "unknown", httpProtocol: "" }
}

async function latency(urls: string[], signal: AbortSignal): Promise<number | null> {
  const results = await Promise.all(urls.map(url => probe(url, signal)))
  const times = results.filter(item => item.status != null && item.status >= 200 && item.status < 300 && item.ms != null).map(item => item.ms!)
  return times.length ? Math.min(...times) : null
}

/** 网络结果不另查出口、位置、评分；由页面当前轮次统一绑定并保存。 */
export async function diagnoseNetwork(contextIP: string | null, signal: AbortSignal,
  onUpdate?: (report: NetworkReport) => void): Promise<NetworkReport> {
  const started = Date.now()
  const settings = getNetworkSettings()
  let report: NetworkReport = { version: 1, measuredAt: started, contextIP, source: "device",
    local: { ...EMPTY_LOCAL, interfaces: [] }, latency: { domestic: null, overseas: null },
    quic: "unknown", httpProtocol: "", services: pendingServices(), surge: null, note: "", durationMs: 0 }
  const publish = (patch: Partial<NetworkReport>) => {
    report = { ...report, ...patch }
    if (!signal.aborted) onUpdate?.(report)
  }
  try { publish({ local: localNetworkFromInterfaces(Device.networkInterfaces()) }) } catch {}

  if (settings.snapshotURL && !signal.aborted) {
    const remote = await readRemoteNetwork(settings, contextIP, signal).catch(() => null)
    if (remote && reportMatchesIP(remote, contextIP || "")) {
      publish(remote)
      return remote
    }
    publish({ note: "Surge 快照不可用、已过期或出口不一致，已改用本机检测。" })
  }
  if (signal.aborted) return report
  // 基线必须先于本轮服务请求，才可给新结果附加请求日志中的策略。
  const baseline = await readSurgeBaseline(settings, signal).catch(() => null)
  if (signal.aborted) return report
  const pathTask = Promise.all([
    probe("https://myip.ipip.net", signal, true).then(result => {
      if (result.status === 200) publish({ domesticExit: parseDomesticExit(result.text) })
    }),
    latency(["https://www.baidu.com/favicon.ico", "https://www.qq.com/favicon.ico"], signal)
      .then(domestic => publish({ latency: { ...report.latency, domestic } })),
    latency(["https://cp.cloudflare.com/generate_204", "https://www.gstatic.com/generate_204"], signal)
      .then(overseas => publish({ latency: { ...report.latency, overseas } })),
    probe("https://cloudflare-quic.com/cdn-cgi/trace", signal, true).then(result => {
      if (result.status != null && result.status >= 200 && result.status < 300) publish(parseHTTPProtocol(result.text))
    }),
  ])
  let cursor = 0
  const worker = async () => {
    while (!signal.aborted && cursor < SERVICES.length) {
      const index = cursor++
      const definition = SERVICES[index]
      const result = await probe(definition.url, signal, true, definition.id)
      if (signal.aborted) return
      const services = report.services.slice()
      services[index] = { id: definition.id, name: definition.name, group: definition.group,
        ...classifyService(result.status, result.text, result.bodyReadOK), status: result.status, ms: result.ms,
        regionCode: result.regionCode, regionSource: result.regionSource, policy: "" }
      publish({ services })
      if (!result.regionCode && definition.regionURL) {
        const regionProbe = await probe(definition.regionURL, signal, true, definition.id, definition.regionKind || "trace")
        if (signal.aborted) return
        if (regionProbe.regionCode) {
          // 只补地区；trace 的 200 不能覆盖首页 403/429 的受限状态。
          const updated = report.services.slice()
          updated[index] = { ...updated[index], regionCode: regionProbe.regionCode, regionSource: regionProbe.regionSource }
          publish({ services: updated })
        }
      }
    }
  }
  await Promise.all([pathTask, ...Array.from({ length: 6 }, worker)])
  if (signal.aborted) return report
  const enriched = await enrichWithSurge(report, settings, baseline, signal).catch(() => report)
  if (signal.aborted) return report
  publish(enriched)
  publish({ measuredAt: Date.now(), durationMs: Date.now() - started })
  return report
}
