import { AbortSignal, fetch } from "scripting"
import { canonicalAddress, fetchIPInfo, IPInfo } from "./ip"
import { sameIP, withTimeout } from "./geo"

export interface LookupResult {
  info: IPInfo | null
  infoSource?: "ip-api.com" | "ipwho.is"
  connection: { asn: string; organization: string; domain: string } | null
  reputation: {
    risk: number | null
    range: string
    proxy: boolean | null
    vpn: boolean | null
    hosting: boolean | null
    networkType?: string | null
    hostname?: string | null
    tor?: boolean | null
    scraper?: boolean | null
    compromised?: boolean | null
    anonymous?: boolean | null
    confidence?: number | null
    devices?: { address: number | null; subnet: number | null } | null
    firstSeen?: string | null
    lastSeen?: string | null
  } | null
}

const IP_API_TIMEOUT_MS = 5000
const IPWHO_TIMEOUT_MS = 4500
const REPUTATION_TIMEOUT_MS = 6000

function requestSignal(signal: AbortSignal | undefined, timeout: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeout)
  return signal ? AbortSignal.any([signal, deadline]) : deadline
}

export function validIPAddress(value: string): boolean {
  return value.length <= 45 && value === value.trim() && canonicalAddress(value) !== null
}

type IPWhoData = {
  success?: boolean
  ip?: string
  country?: string
  country_code?: string
  region?: string
  city?: string
  connection?: { asn?: number; org?: string; isp?: string; domain?: string }
  latitude?: number
  longitude?: number
  continent?: string
  continent_code?: string
  postal?: string
  timezone?: { id?: string; offset?: number }
}

/** 将 HTTPS 归属数据转换为页面和小组件共用的结构。 */
function mapIPWhoToIPInfo(data: IPWhoData & { ip: string }): IPInfo {
  const connection = data.connection && typeof data.connection === "object" ? data.connection : {}
  const asn = typeof connection.asn === "number" && Number.isSafeInteger(connection.asn) && connection.asn > 0
    ? `AS${connection.asn}` : ""
  const organization = optionalText(connection.org) || optionalText(connection.isp) || ""
  return {
    query: data.ip,
    country: optionalText(data.country) || "",
    countryCode: (optionalText(data.country_code) || "").toUpperCase(),
    regionName: optionalText(data.region) || "",
    city: optionalText(data.city) || "",
    isp: optionalText(connection.isp) || organization,
    org: organization,
    as: asn,
    asname: organization,
    status: "success",
    lat: Number.isFinite(data.latitude) ? data.latitude! : NaN,
    lon: Number.isFinite(data.longitude) ? data.longitude! : NaN,
    continent: optionalText(data.continent) || undefined,
    continentCode: optionalText(data.continent_code) || undefined,
    timezone: optionalText(data.timezone?.id) || undefined,
    offset: typeof data.timezone?.offset === "number" && Number.isFinite(data.timezone.offset)
      ? data.timezone.offset : undefined,
    zip: optionalText(data.postal) || undefined,
  }
}

async function queryIPWho(ip: string, signal?: AbortSignal): Promise<IPWhoData | null> {
  try {
    return await withTimeout(async () => {
      const response = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, {
        timeout: Math.ceil(IPWHO_TIMEOUT_MS / 1000), signal: requestSignal(signal, IPWHO_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json() as IPWhoData
    }, IPWHO_TIMEOUT_MS, "ipwho.is 请求超时")
  } catch (error) {
    if (!signal?.aborted) console.log("[IP检测] ipwho.is 查询失败", error)
    return null
  }
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value.trim() !== "—" ? value.trim() : null
}

function percentage(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null
}

function deviceCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function detectionDate(value: unknown): string | null {
  const text = optionalText(value)
  return text && Number.isFinite(Date.parse(text)) ? text : null
}

/** v3 的 warning 也是成功查询；缺失保留 null，真实 false 和 0 原样保留。 */
export function parseProxyCheck(data: Record<string, any>, ip: string): LookupResult["reputation"] {
  const key = Object.keys(data).find(key => sameIP(key, ip))
  const success = data.status === "ok" || data.status === "warning"
  const match = success && key ? data[key] : null
  const detections = match?.detections
  if (!detections) return null

  // 风险分只接受 proxycheck 自己给出的真实数值，置信度不能拿来充风险。
  const risk = percentage(detections.risk)

  return {
    risk,
    range: optionalText(match.network?.range) || "—",
    proxy: typeof detections.proxy === "boolean" ? detections.proxy : null,
    vpn: typeof detections.vpn === "boolean" ? detections.vpn : null,
    hosting: typeof detections.hosting === "boolean" ? detections.hosting : null,
    networkType: optionalText(match.network?.type),
    hostname: optionalText(match.network?.hostname),
    tor: typeof detections.tor === "boolean" ? detections.tor : null,
    scraper: typeof detections.scraper === "boolean" ? detections.scraper : null,
    compromised: typeof detections.compromised === "boolean" ? detections.compromised : null,
    anonymous: typeof detections.anonymous === "boolean" ? detections.anonymous : null,
    confidence: percentage(detections.confidence),
    devices: match.device_estimate ? {
      address: deviceCount(match.device_estimate.address),
      subnet: deviceCount(match.device_estimate.subnet),
    } : null,
    firstSeen: detectionDate(detections.first_seen),
    lastSeen: detectionDate(detections.last_seen),
  }
}

async function queryReputation(ip: string, signal?: AbortSignal): Promise<LookupResult["reputation"]> {
  try {
    const data = await withTimeout(async () => {
      // v3 默认返回完整检测结果，不再使用 v2 的 asn/risk/vpn 参数。
      const response = await fetch(`https://proxycheck.io/v3/${encodeURIComponent(ip)}`, {
        timeout: Math.ceil(REPUTATION_TIMEOUT_MS / 1000), signal: requestSignal(signal, REPUTATION_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json() as Record<string, any>
    }, REPUTATION_TIMEOUT_MS, "proxycheck 请求超时")
    return parseProxyCheck(data, ip)
  } catch (error) {
    if (!signal?.aborted) console.log("[IP检测] proxycheck 查询失败", error)
    return null
  }
}

function matchingIPWho(data: IPWhoData | null, ip: string): data is IPWhoData & { success: true; ip: string } {
  return data?.success === true && typeof data.ip === "string" && sameIP(data.ip, ip)
}

export function assembleLookupResult(
  ip: string, fallback: IPInfo | null, whoData: IPWhoData | null,
  reputation: LookupResult["reputation"],
): LookupResult {
  const whoMatches = matchingIPWho(whoData, ip)
  const info = whoMatches ? mapIPWhoToIPInfo(whoData)
    : fallback && sameIP(fallback.query, ip) ? fallback : null
  if (!info && !reputation) throw new Error("IP 归属查询失败，稍后重试")

  let connection: LookupResult["connection"] = null
  if (whoMatches) {
    const whoConnection = whoData.connection && typeof whoData.connection === "object" ? whoData.connection : null
    connection = whoConnection ? {
      asn: typeof whoConnection.asn === "number" && Number.isSafeInteger(whoConnection.asn) && whoConnection.asn > 0
        ? `AS${whoConnection.asn}` : "—",
      organization: optionalText(whoConnection.org) || "—",
      domain: optionalText(whoConnection.domain) || "—",
    } : null
  }

  return { info, infoSource: info ? whoMatches ? "ipwho.is" : "ip-api.com" : undefined, connection, reputation }
}

export async function lookupAddress(address: string, withReputation = false, signal?: AbortSignal): Promise<LookupResult> {
  const ip = address.trim()
  if (!validIPAddress(ip)) throw new Error("请输入有效的 IPv4 或 IPv6 地址")

  const reputationTask = withReputation ? queryReputation(ip, signal) : Promise.resolve(null)
  const whoData = await queryIPWho(ip, signal)
  const fallback = matchingIPWho(whoData, ip) || signal?.aborted ? null
    : await withTimeout(() => fetchIPInfo(ip, requestSignal(signal, IP_API_TIMEOUT_MS)), IP_API_TIMEOUT_MS, "ip-api.com 请求超时")
      .catch(() => null)
  return assembleLookupResult(ip, fallback, whoData, await reputationTask)
}
