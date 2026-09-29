import { fetch } from "scripting"
import { REGION_CATALOG, fetchCnyRates, convertToCny } from "./pricing"
import { fetchAppVersions, type AppVersionEntry } from "./versions"

export type PriceHistoryRecord = {
  id: string
  timestamp: string
  version?: string
  versionId?: string
  from: number
  to: number
  cny?: string | null
  kind: "rise" | "free" | "paid"
}
export type PriceHistoryOptions = {
  regionCode?: string
  /** 首屏只拿价格链：先出结果，版本 ID / 人民币换算后台补齐（2.4.29 起）。 */
  fastFirst?: boolean
}
export type PriceHistoryFastHandle = {
  /** 首屏价格链（无版本 ID / 人民币时为 undefined）。 */
  records: PriceHistoryRecord[]
  /** 后台补齐全部增强字段后的完整结果；失败则回退首屏结果。 */
  completed: Promise<PriceHistoryRecord[]>
}
export function regionDefinition(code: string) {
  return REGION_CATALOG.find(region => region.code === code.toLowerCase())
}
export function historyPrice(value: number, currencyCode = "USD", locale = "en-US") {
  if (value === 0) return "免费"
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: currencyCode, currencyDisplay: "narrowSymbol" }).format(value)
  } catch { return `${value.toFixed(2)} ${currencyCode}` }
}

type Activity = {
  id?: string
  __typename?: string
  timestamp?: string
  versionFrom?: string
  versionTo?: string
  priceTierFrom?: number
  priceTierTo?: number
}

/** Version is inferred from the activity timeline, never from today's version. */
export function parsePriceHistory(list: Activity[], points: number[]): PriceHistoryRecord[] {
  const events = list.filter(e => typeof e.timestamp === "string" && Number.isFinite(Date.parse(e.timestamp)))
    .slice().sort((a, b) => Date.parse(a.timestamp!) - Date.parse(b.timestamp!) ||
      Number(b.__typename === "AppActivityUpdate") - Number(a.__typename === "AppActivityUpdate"))
  let version: string | undefined
  const result: PriceHistoryRecord[] = []
  const seen = new Set<string>()
  for (const event of events) {
    if (event.__typename === "AppActivityUpdate") {
      version = event.versionTo?.trim() || undefined
      continue
    }
    if (event.__typename !== "AppActivityPriceChange") continue
    const fromTier = event.priceTierFrom, toTier = event.priceTierTo
    if (typeof fromTier !== "number" || typeof toTier !== "number" ||
        !Number.isInteger(fromTier) || !Number.isInteger(toTier) || fromTier < 0 || toTier < 0) continue
    const from = points[fromTier], to = points[toTier]
    if (typeof from !== "number" || typeof to !== "number" || !Number.isFinite(from) ||
        !Number.isFinite(to) || from < 0 || to < 0 || from === to) continue
    if (to !== 0 && to <= from) continue
    const key = `${event.timestamp}-${fromTier}-${toTier}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ id: event.id || key, timestamp: event.timestamp!, version,
      from, to, kind: to === 0 ? "free" : from === 0 ? "paid" : "rise" })
  }
  return result.reverse()
}

/** A repeated version number with different build IDs cannot identify one historical build. */
export function matchVersionIds(entries: AppVersionEntry[]) {
  const groups = new Map<string, Set<string>>()
  for (const entry of entries) {
    const version = entry.version.trim(), id = entry.versionId.trim()
    if (!version || !/^\d+$/.test(id)) continue
    const ids = groups.get(version) || new Set<string>()
    ids.add(id)
    groups.set(version, ids)
  }
  const result = new Map<string, string>()
  for (const [version, ids] of groups) if (ids.size === 1) result.set(version, [...ids][0])
  return result
}

const QUERY = `query PriceHistory($id: Long!, $iso: String!) {
  territory(isoCode: $iso) { currencyCode pricePoints }
  appByITunesId(iTunesId: $id) {
    ITunesId
    activityList {
      id __typename timestamp
      ... on AppActivityPriceChange { priceTierFrom priceTierTo }
      ... on AppActivityUpdate { versionFrom versionTo }
    }
  }
}`
const cache = new Map<string, { at: number; records: PriceHistoryRecord[] }>()
const pending = new Map<string, Promise<PriceHistoryRecord[]>>()
const versionCache = new Map<string, { at: number; ids: Map<string, string> }>()
async function versionIds(appid: string) {
  const saved = versionCache.get(appid)
  if (saved && Date.now() - saved.at < 600000) return saved.ids
  const ids = matchVersionIds(await fetchAppVersions(appid))
  versionCache.set(appid, { at: Date.now(), ids })
  return ids
}

export async function fetchPriceHistory(appid: string, options: PriceHistoryOptions = {}): Promise<PriceHistoryRecord[]> {
  return (await fetchPriceHistoryFast(appid, options)).completed
}

/**
 * 两段式价格历史：先解析 AppRaven 价格链立即返回首屏结果，再后台并行补齐
 * 版本 ID（Timbrd/Bilin）与人民币换算。UI 可先渲染首屏、完成后再替换，
 * 弱网下不再被增强接口拖住整列。缓存只存完整增强结果，与旧版一致。
 */
const pendingFast = new Map<string, Promise<PriceHistoryFastHandle>>()
export async function fetchPriceHistoryFast(appid: string, options: PriceHistoryOptions = {}): Promise<PriceHistoryFastHandle> {
  if (!/^\d+$/.test(appid) || !Number.isSafeInteger(Number(appid))) throw new Error("无效的应用 ID")
  const region = regionDefinition(options.regionCode || "US")
  if (!region) return { records: [], completed: Promise.resolve([]) }
  const iso = region.code.toUpperCase(), key = `${appid}:${iso}`
  const saved = cache.get(key)
  if (saved && Date.now() - saved.at < 300000) return { records: saved.records, completed: Promise.resolve(saved.records) }
  const existing = pendingFast.get(key)
  if (existing) return existing
  const handlePromise = (async (): Promise<PriceHistoryFastHandle> => {
    // 增强接口与 AppRaven 主请求并行启动（分发）：主响应一到先出首屏，
    // 不再等版本 ID / 汇率；失败只影响补齐，不丢价格链。
    const idsPromise = versionIds(appid).catch(() => null)
    const ratesPromise = fetchCnyRates().catch(() => null)
    const response = await fetch("https://appraven.net/appraven/graphql", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationName: "PriceHistory", query: QUERY, variables: { id: Number(appid), iso } }),
      timeout: 12, debugLabel: "AppRaven Price History",
    })
    if (!response.ok) throw new Error(`价格历史读取失败（HTTP ${response.status}）`)
    const payload = await response.json()
    const app = payload.data?.appByITunesId, territory = payload.data?.territory
    // 没有地区价格表时不展示历史；网络和其他接口错误仍允许重试。
    if (payload.data && territory === null &&
        (!payload.errors?.length || payload.errors.every((error: { path?: unknown[] }) => error.path?.[0] === "territory"))) {
      return { records: [], completed: Promise.resolve([]) }
    }
    if (payload.errors?.length) throw new Error("价格历史暂不可用")
    if (!app) return { records: [], completed: Promise.resolve([]) }
    if (territory && Array.isArray(territory.pricePoints) && territory.pricePoints.length === 0) {
      return { records: [], completed: Promise.resolve([]) }
    }
    if (String(app.ITunesId) !== appid || !Array.isArray(app.activityList) ||
        territory?.currencyCode !== region.currency || !Array.isArray(territory.pricePoints)) {
      throw new Error("价格历史数据不完整")
    }
    // AppRaven supplies a shared tier timeline; regional prices use its territory price-point table.
    const base = parsePriceHistory(app.activityList, territory.pricePoints)
    const completed = (async () => {
      const [ids, rates] = await Promise.all([idsPromise, ratesPromise])
      const records = base.map(record => ({
        ...record,
        versionId: record.version ? ids?.get(record.version) : undefined,
        cny: convertToCny(record.to, region.currency, rates || {}),
      }))
      // Allow retrying incomplete enhancement data instead of caching missing IDs/rates.
      if (ids && rates) cache.set(key, { at: Date.now(), records })
      return records
    })()
    return { records: base, completed }
  })()
  pendingFast.set(key, handlePromise)
  try { return await handlePromise } finally { pendingFast.delete(key) }
}

/**
 * 后台预热：在价格列表加载时就分发启动各地区历史请求，
 * PriceHistorySection 挂载时直接复用 pending / 缓存，不再等价格行渲染完才起步。
 */
export function prewarmPriceHistory(appid: string, regionCode: string) {
  try {
    void fetchPriceHistoryFast(appid, { regionCode }).then(
      handle => { void handle.completed.catch(() => {}) },
      () => {},
    )
  } catch {}
}
