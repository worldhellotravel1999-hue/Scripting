import { canonicalAddress } from "./ip"
import type { IPInfo } from "./ip"
import { activeRiskFlags, hasKnownRiskFlags } from "./flags"
import { accessTypeLabel } from "./details"
import type { IPPureReport } from "./ippure"
import type { LookupResult } from "./lookup"

export const WIDGET_SNAPSHOT_KEY = "ip-detection.widget-snapshot.v1"

export type WidgetRiskSource = "proxycheck" | "IPPure" | "heuristic" | null

/** 页面当前显示的数据快照；小组件优先读它，避免自己另查一份出口 IP。 */
export interface WidgetSnapshot {
  version: 1
  savedAt: number
  ip: string
  country: string
  countryCode: string
  regionName: string
  city: string
  isp: string
  org: string
  as: string
  lat: number | null
  lon: number | null
  risk: number | null
  riskSource: WidgetRiskSource
  accessType: string
  vpnStatus: string
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function coordinate(value: unknown, limit: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit ? value : null
}

function percentage(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null
}

function riskSource(value: unknown): WidgetRiskSource {
  return value === "proxycheck" || value === "IPPure" ? value : null
}

export function buildWidgetSnapshot(input: {
  ip: string
  info: IPInfo | null | undefined
  reputation: LookupResult["reputation"]
  pure: IPPureReport | null | undefined
}): WidgetSnapshot {
  const info = input.info
  const reputation = input.reputation
  const pure = input.pure
  const proxy = reputation?.proxy ?? info?.proxy ?? null
  const flags = activeRiskFlags(reputation, proxy)
  const known = hasKnownRiskFlags(reputation, proxy)
  const risk = reputation?.risk ?? pure?.risk ?? null
  const source: WidgetRiskSource = reputation?.risk != null ? "proxycheck" : pure?.risk != null ? "IPPure" : null
  const rawLat = coordinate(info?.lat, 90)
  const rawLon = coordinate(info?.lon, 180)
  const hasPoint = rawLat != null && rawLon != null

  return {
    version: 1,
    savedAt: Date.now(),
    ip: canonicalAddress(input.ip) || input.ip.trim(),
    country: text(info?.country),
    countryCode: text(info?.countryCode),
    regionName: text(info?.regionName),
    city: text(info?.city),
    isp: text(info?.isp),
    org: text(info?.org),
    as: text(info?.as),
    lat: hasPoint ? rawLat : null,
    lon: hasPoint ? rawLon : null,
    risk,
    riskSource: risk == null ? null : source,
    accessType: accessTypeLabel(info, reputation, pure),
    vpnStatus: flags.length
      ? `${flags[0].short}${flags.length > 1 ? ` +${flags.length - 1}` : ""}`
      : known ? "未标记" : "未知",
  }
}

/** 兼容旧版本或被外部改坏的值；任何关键字段异常都整体拒绝。 */
export function parseWidgetSnapshot(raw: unknown): WidgetSnapshot | null {
  if (!raw || typeof raw !== "object") return null
  const data = raw as Record<string, unknown>
  if (data.version !== 1) return null
  const ip = canonicalAddress(text(data.ip))
  if (!ip) return null

  const risk = percentage(data.risk)
  const rawLat = coordinate(data.lat, 90)
  const rawLon = coordinate(data.lon, 180)
  const hasPoint = rawLat != null && rawLon != null
  return {
    version: 1,
    savedAt: typeof data.savedAt === "number" && Number.isFinite(data.savedAt) ? data.savedAt : 0,
    ip,
    country: text(data.country),
    countryCode: text(data.countryCode),
    regionName: text(data.regionName),
    city: text(data.city),
    isp: text(data.isp),
    org: text(data.org),
    as: text(data.as),
    lat: hasPoint ? rawLat : null,
    lon: hasPoint ? rawLon : null,
    risk,
    riskSource: risk == null ? null : riskSource(data.riskSource),
    accessType: text(data.accessType),
    vpnStatus: text(data.vpnStatus) || "未知",
  }
}

export function saveWidgetSnapshot(snapshot: WidgetSnapshot): boolean {
  return Storage.set(WIDGET_SNAPSHOT_KEY, snapshot, { shared: true })
}

export function readWidgetSnapshot(): WidgetSnapshot | null {
  return parseWidgetSnapshot(Storage.get<unknown>(WIDGET_SNAPSHOT_KEY, { shared: true }))
}
