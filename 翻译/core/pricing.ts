import { fetch } from "scripting"
import { parseHTML } from "./linkedom"

export type InAppPrice = {
  name: string
  formatted: string
  price: number | null
  currency: string
  cny: string | null
}

export type RegionPrice = {
  region: string
  name: string
  currency: string
  price: number | null
  formatted: string
  cny: string | null
  unavailable: boolean
  inAppPurchases: InAppPrice[]
  /** 内购查询失败的原因（成功或无内购时为空），用于 UI 明示而非静默留白。 */
  inAppError?: string
  loading?: boolean
  inAppLoading?: boolean
}

export type RegionDefinition = {
  code: string
  name: string
  locale: string
  currency: string
}

export const DEFAULT_REGION_CODES = ["us", "kr", "jp"]

export const REGION_CATALOG: RegionDefinition[] = [
  { code: "us", name: "美国", locale: "en-US", currency: "USD" },
  { code: "hk", name: "香港", locale: "zh-HK", currency: "HKD" },
  { code: "jp", name: "日本", locale: "ja-JP", currency: "JPY" },
  { code: "cn", name: "中国大陆", locale: "zh-CN", currency: "CNY" },
  { code: "tw", name: "中国台湾", locale: "zh-TW", currency: "TWD" },
  { code: "kr", name: "韩国", locale: "ko-KR", currency: "KRW" },
  { code: "au", name: "澳大利亚", locale: "en-AU", currency: "AUD" },
  { code: "nz", name: "新西兰", locale: "en-NZ", currency: "NZD" },
  { code: "ca", name: "加拿大", locale: "en-CA", currency: "CAD" },
  { code: "gb", name: "英国", locale: "en-GB", currency: "GBP" },
  { code: "ie", name: "爱尔兰", locale: "en-IE", currency: "EUR" },
  { code: "de", name: "德国", locale: "de-DE", currency: "EUR" },
  { code: "fr", name: "法国", locale: "fr-FR", currency: "EUR" },
  { code: "it", name: "意大利", locale: "it-IT", currency: "EUR" },
  { code: "es", name: "西班牙", locale: "es-ES", currency: "EUR" },
  { code: "nl", name: "荷兰", locale: "nl-NL", currency: "EUR" },
  { code: "ch", name: "瑞士", locale: "de-CH", currency: "CHF" },
  { code: "se", name: "瑞典", locale: "sv-SE", currency: "SEK" },
  { code: "no", name: "挪威", locale: "nb-NO", currency: "NOK" },
  { code: "dk", name: "丹麦", locale: "da-DK", currency: "DKK" },
  { code: "fi", name: "芬兰", locale: "fi-FI", currency: "EUR" },
  { code: "in", name: "印度", locale: "en-IN", currency: "INR" },
  { code: "my", name: "马来西亚", locale: "ms-MY", currency: "MYR" },
  { code: "th", name: "泰国", locale: "th-TH", currency: "THB" },
  { code: "ph", name: "菲律宾", locale: "en-PH", currency: "PHP" },
  { code: "id", name: "印度尼西亚", locale: "id-ID", currency: "IDR" },
  { code: "vn", name: "越南", locale: "vi-VN", currency: "VND" },
  { code: "br", name: "巴西", locale: "pt-BR", currency: "BRL" },
  { code: "mx", name: "墨西哥", locale: "es-MX", currency: "MXN" },
  { code: "tr", name: "土耳其", locale: "tr-TR", currency: "TRY" },
  { code: "ae", name: "阿联酋", locale: "ar-AE", currency: "AED" },
  { code: "sa", name: "沙特阿拉伯", locale: "ar-SA", currency: "SAR" },
  { code: "il", name: "以色列", locale: "he-IL", currency: "ILS" },
  { code: "pl", name: "波兰", locale: "pl-PL", currency: "PLN" },
]

const FALLBACK_CURRENCY: Record<string, string> = Object.fromEntries(
  REGION_CATALOG.map((region) => [region.code, region.currency]),
)

const WEB_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
}

const STORE_FRONTS: Record<string, string> = {
  us: "143441",
  hk: "143463",
  jp: "143462",
  cn: "143465",
  tw: "143470",
  kr: "143466",
  au: "143460",
  nz: "143461",
  ca: "143455",
  gb: "143444",
  ie: "143449",
  de: "143443",
  fr: "143442",
  it: "143450",
  es: "143454",
  nl: "143452",
  ch: "143459",
  se: "143456",
  no: "143457",
  dk: "143458",
  fi: "143447",
  in: "143467",
  my: "143473",
  th: "143475",
  ph: "143474",
  id: "143476",
  vn: "143471",
  br: "143503",
  mx: "143468",
  tr: "143480",
  ae: "143481",
  sa: "143479",
  il: "143491",
  pl: "143478",
}

type RateCache = {
  rates: Record<string, number>
  time: number
}

let rateCache: RateCache | null = null
let rateInFlight: Promise<Record<string, number>> | null = null
const RATE_TTL = 60 * 60 * 1000

// 同一个 app 的多区价格在短时间内不会变化，可以按 appid 缓存查询结果。
// 这样切换地区时只需查询新增地区，避免对 iTunes Lookup 的高频重复请求。
type RegionPriceCacheEntry = { at: number; price: RegionPrice }
const regionPriceCache = new Map<string, RegionPriceCacheEntry>()
const regionPriceInFlight = new Map<string, Promise<RegionPrice>>()
const regionPriceProgress = new Map<string, RegionPrice>()
const priceListeners = new Map<string, Set<(price: RegionPrice) => void>>()

function publishPrice(appid: string, price: RegionPrice) {
  const key = cacheKey(appid, { code: price.region })
  regionPriceProgress.set(key, price)
  for (const listener of priceListeners.get(key) ?? []) listener(price)
}
const REGION_PRICE_TTL = 10 * 60 * 1000

// iTunes Lookup 对短时间高频请求会静默限流（HTTP 200 但 resultCount 为 0，
// 且不返回错误）。检测到空结果时延时重试一次，避免被误判为“不可用”。
const LOOKUP_EMPTY_RETRY_DELAY_MS = 1200

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function cacheKey(appid: string, region: { code: string }) {
  return `${appid}:${region.code.toLowerCase()}`
}

function cachedRegionPrice(
  appid: string,
  region: { code: string },
): RegionPrice | null {
  const entry = regionPriceCache.get(cacheKey(appid, region))
  if (!entry) return null
  if (Date.now() - entry.at > REGION_PRICE_TTL) {
    regionPriceCache.delete(cacheKey(appid, region))
    return null
  }
  return entry.price
}

function storeRegionPrice(appid: string, price: RegionPrice) {
  regionPriceCache.set(cacheKey(appid, { code: price.region }), {
    at: Date.now(),
    price,
  })
}

export async function fetchCnyRates(): Promise<Record<string, number>> {
  if (rateCache && Date.now() - rateCache.time < RATE_TTL) return rateCache.rates
  if (rateInFlight) return rateInFlight
  const request = loadCnyRates().finally(() => {
    if (rateInFlight === request) rateInFlight = null
  })
  rateInFlight = request
  return request
}

async function loadCnyRates(): Promise<Record<string, number>> {
  if (rateCache && Date.now() - rateCache.time < RATE_TTL) {
    return rateCache.rates
  }
  // 主源不可达时依次回退备用源，保证人民币换算尽量可用。
  const endpoints = [
    "https://open.er-api.com/v6/latest/CNY",
    "https://api.exchangerate-api.com/v4/latest/CNY",
    "https://api.frankfurter.app/latest?from=CNY",
  ]
  let lastError: unknown = null
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: "GET",
        timeout: 10,
        debugLabel: "Lingo Exchange Rates",
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      const rates = payload?.rates
      if (!rates || typeof rates !== "object") {
        throw new Error("汇率服务返回数据无效。")
      }
      rateCache = { rates, time: Date.now() }
      return rates
    } catch (reason) {
      lastError = reason
    }
  }
  throw lastError instanceof Error ? lastError : new Error("无法获取汇率。")
}

function formatLocalPrice(price: number, currency: string, locale: string) {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
    }).format(price)
  } catch {
    return `${price} ${currency}`
  }
}

function formatCny(price: number) {
  try {
    return new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: "CNY",
      currencyDisplay: "narrowSymbol",
    }).format(price)
  } catch {
    return `¥${price.toFixed(2)}`
  }
}

function numericPrice(value: string) {
  const raw = String(value || "")
    .replace(/[\s\u00a0\u202f']/g, "")
    .replace(/[^\d.,]/g, "")
  if (!raw) return null

  const lastComma = raw.lastIndexOf(",")
  const lastDot = raw.lastIndexOf(".")
  let normalized = raw
  if (lastComma >= 0 && lastDot >= 0) {
    const decimal = lastComma > lastDot ? "," : "."
    const grouping = decimal === "," ? /\./g : /,/g
    normalized = raw.replace(grouping, "").replace(decimal, ".")
  } else {
    const separator = lastComma >= 0 ? "," : lastDot >= 0 ? "." : ""
    if (separator) {
      const parts = raw.split(separator)
      const tail = parts[parts.length - 1]
      normalized = tail.length === 1 || tail.length === 2
        ? `${parts.slice(0, -1).join("")}.${tail}`
        : parts.join("")
    }
  }

  const price = Number(normalized)
  return Number.isFinite(price) && price >= 0 ? price : null
}

export function convertToCny(price: number | null, currency: string, rates: Record<string, number>) {
  if (price === null) return null
  if (currency === "CNY") return `≈ ${formatCny(price)}`
  const rate = Number(rates[currency])
  return Number.isFinite(rate) && rate > 0 ? `≈ ${formatCny(price / rate)}` : null
}

function expectedCurrency(code: string) {
  return FALLBACK_CURRENCY[code.toLowerCase()] || ""
}
async function fetchLookupResult(
  appid: string,
  region: { code: string; locale: string }
) {
  const value = encodeURIComponent(appid)
  const country = encodeURIComponent(region.code.toLowerCase())
  const endpoints = [
    `https://itunes.apple.com/${country}/lookup?id=${value}&country=${country}`,
    `https://itunes.apple.com/lookup?id=${value}&country=${country}`,
  ]

  for (const endpoint of endpoints) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) {
          // iTunes Lookup 在限流时返回 200 + resultCount 0，等待后重试一次。
          await sleep(LOOKUP_EMPTY_RETRY_DELAY_MS)
        }
        const response = await fetch(endpoint, {
          method: "GET",
          headers: {
            "Accept": "application/json",
            "Accept-Language": region.locale,
          },
          timeout: 12,
          debugLabel: "Lingo Region Price Lookup",
        })
        if (!response.ok) break
        const payload = await response.json()
        const result = Array.isArray(payload?.results) ? payload.results[0] : null
        const currency = String(result?.currency || "").toUpperCase()
        const expected = expectedCurrency(region.code)
        if (result && (!expected || currency === expected)) return result
        // resultCount 为 0 通常是限流而非下架，重试一次再尝试下一个端点。
      } catch {
        // Try the global Lookup endpoint when the storefront endpoint fails.
        break
      }
    }
  }
  return null
}

function parseInAppPurchasesWithDOM(
  html: string,
  region: { code: string; locale: string },
  rates: Record<string, number>,
) {
  const { document } = parseHTML(html)
  const currency = FALLBACK_CURRENCY[region.code] || "USD"
  const seen = new Set<string>()
  const result: InAppPrice[] = []
  const pairs = Array.from(document.querySelectorAll(".text-pair.svelte-1gyt6l2")) as any[]

  for (const pair of pairs) {
    const spans = pair.querySelectorAll("span")
    if (spans.length !== 2) continue
    appendInAppPrice(result, seen, String(spans[0]?.textContent || ""), String(spans[1]?.textContent || ""), currency, rates)
  }

  // Apple changed the markup from text-pair to InAppPurchaseLockup.
  if (!result.length) {
    const lockups = Array.from(document.querySelectorAll("li.shelf-grid__list-item")) as any[]
    for (const lockup of lockups) {
      const name = String(lockup.querySelector("h3")?.textContent || "").trim()
      const priceNodes = Array.from(lockup.querySelectorAll("p")) as any[]
      const formatted = String(priceNodes[priceNodes.length - 1]?.textContent || "").trim()
      if (name && formatted && numericPrice(formatted) !== null) {
        appendInAppPrice(result, seen, name, formatted, currency, rates)
      }
    }
  }
  // Some storefronts still return Apple's legacy server-rendered markup.
  if (!result.length) {
    const rows = Array.from(document.querySelectorAll(".extra-list.in-app-purchases li")) as any[]
    for (const row of rows) {
      appendInAppPrice(
        result,
        seen,
        String(row.querySelector(".in-app-title")?.textContent || ""),
        String(row.querySelector(".in-app-price")?.textContent || ""),
        currency,
        rates,
      )
    }
  }

  return result
}

/**
 * 正则回退解析：linkedom 加载失败或 DOM 解析无结果时使用。
 * 匹配 legacy 服务端渲染的 in-app-purchases 列表项。
 */
function parseInAppPurchasesWithRegex(
  html: string,
  region: { code: string; locale: string },
  rates: Record<string, number>,
) {
  const currency = FALLBACK_CURRENCY[region.code] || "USD"
  const seen = new Set<string>()
  const result: InAppPrice[] = []
  const itemPattern = /<li[^>]*>[\s\S]*?class="[^"]*in-app-title[^"]*"[^>]*>([\s\S]*?)<\/[a-z]+>[\s\S]*?class="[^"]*in-app-price[^"]*"[^>]*>([\s\S]*?)<\/[a-z]+>[\s\S]*?<\/li>/g
  let match: RegExpExecArray | null
  while ((match = itemPattern.exec(html)) !== null) {
    const name = match[1].replace(/<[^>]+>/g, "")
    const formatted = match[2].replace(/<[^>]+>/g, "")
    appendInAppPrice(result, seen, name, formatted, currency, rates)
  }
  return result
}

function parseInAppPurchases(
  html: string,
  region: { code: string; locale: string },
  rates: Record<string, number>,
) {
  try {
    const viaDOM = parseInAppPurchasesWithDOM(html, region, rates)
    if (viaDOM.length) return viaDOM
  } catch {
    // linkedom 不可用时落入正则回退。
  }
  return parseInAppPurchasesWithRegex(html, region, rates)
}

function appendInAppPrice(
  result: InAppPrice[],
  seen: Set<string>,
  rawName: string,
  rawFormatted: string,
  currency: string,
  rates: Record<string, number>,
) {
  const name = rawName.trim()
  const formatted = rawFormatted.trim()
  if (!name || !formatted || numericPrice(formatted) === null || seen.has(`${name}\u0000${formatted}`)) return
  seen.add(`${name}\u0000${formatted}`)
  const price = numericPrice(formatted)
  result.push({
    name,
    formatted,
    price,
    currency,
    cny: convertToCny(price, currency, rates),
  })
}

/**
 * Apple 商店页的「Top In-App Purchases」只是各地区的销量排名，同一 App 在
 * 不同国家页面上的顺序并不一致（例如 Surge 5：美区便宜在前、韩区贵在前），
 * 切换国家时列表会上下跳动。这里统一为：本地区价格从高到低排列，同价按
 * 名称（忽略大小写）排列——同一 App 在任何国家都会得到相同的相对顺序，
 * 且价格列表由高到低、主购买项始终在最上面。
 */
function sortInAppPurchases(items: InAppPrice[]): InAppPrice[] {
  return [...items].sort((a, b) => {
    if (a.price !== null && b.price !== null && a.price !== b.price) return b.price - a.price
    if (a.price !== null && b.price === null) return -1
    if (a.price === null && b.price !== null) return 1
    const nameA = a.name.toLowerCase()
    const nameB = b.name.toLowerCase()
    return nameA === nameB ? 0 : nameA < nameB ? -1 : 1
  })
}

function describeRedirectFailure(finalURL: string, regionCode: string) {
  const target = finalURL.toLowerCase()
  if (target.includes("/today") || !target.includes(`apps.apple.com/${regionCode}`)) {
    return `Apple 将请求重定向到 ${finalURL}（非 ${regionCode.toUpperCase()} 区页面），已放弃解析以免显示错误地区价格。`
  }
  return `请求被重定向到 ${finalURL}。`
}

async function fetchInAppPurchases(
  appid: string,
  region: { code: string; locale: string },
  rates: Record<string, number>,
  trackViewURL?: string,
): Promise<{ purchases: InAppPrice[]; error: string }> {
  const fail = (error: string) => ({ purchases: [] as InAppPrice[], error })
  try {
    // 优先使用 Lookup 返回的官方地区链接（带完整 slug）；短链 /app/id{appid}
    // 在缺少 X-Apple-Store-Front 头时会被 Apple 按 IP 重定向到用户所在区的 Today 页。
    const endpoint = trackViewURL && trackViewURL.includes(`/${region.code}/`)
      ? trackViewURL
      : `https://apps.apple.com/${region.code}/app/id${encodeURIComponent(appid)}`
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        ...WEB_HEADERS,
        "X-Apple-Store-Front": `${STORE_FRONTS[region.code] || STORE_FRONTS.us},12`,
      },
      timeout: 18,
      debugLabel: "Lingo App Store In-App Purchases",
      // 同地区内的 slug 规范化重定向照常跟随；跨地区（如被 302 到 /cn）
      // 一律取消，防止静默解析到错误地区的页面。
      handleRedirect: async (newRequest) => {
        const target = String(newRequest.url || "").toLowerCase()
        return target.includes(`apps.apple.com/${region.code}/`) ? newRequest : null
      },
    })
    if (!response.ok) {
      const location = String(response.headers.get("Location") || response.url || "")
      if (response.status >= 300 && response.status < 400) {
        return fail(describeRedirectFailure(location || "重定向响应", region.code))
      }
      return fail(`Apple 商店页面请求失败（HTTP ${response.status}）。`)
    }
    const finalURL = String((response as any).url || "").toLowerCase()
    if (finalURL && !finalURL.includes(`apps.apple.com/${region.code}/`)) {
      return fail(describeRedirectFailure(finalURL, region.code))
    }
    return { purchases: sortInAppPurchases(parseInAppPurchases(await response.text(), region, rates)), error: "" }
  } catch (reason) {
    return fail(reason instanceof Error ? reason.message : String(reason))
  }
}

async function lookupRegion(
  appid: string,
  region: { code: string; name: string; locale: string },
  ratesPromise: Promise<Record<string, number>>,
): Promise<RegionPrice> {
  const base: RegionPrice = {
    region: region.code.toUpperCase(),
    name: region.name,
    currency: FALLBACK_CURRENCY[region.code] || "USD",
    price: null,
    formatted: "",
    cny: null,
    unavailable: true,
    inAppPurchases: [],
    inAppError: "",
  }
  try {
    const result = await fetchLookupResult(appid, region)
    const trackViewURL = String(result?.trackViewUrl || "")
    let current = { ...base, inAppLoading: true }
    if (result) {
      const currency = String(result.currency || "").toUpperCase()
      const expected = expectedCurrency(region.code)
      const price = Number(result.price)
      if (currency && (!expected || currency === expected) && Number.isFinite(price) && price >= 0) {
        current = {
          ...current,
          currency,
          price,
          formatted: price === 0 ? "免费" : String(result.formattedPrice || "").trim() || formatLocalPrice(price, currency, region.locale),
          unavailable: false,
        }
      }
    }
    // 本体价先发布；内购和汇率各自完成时更新，不相互等待。
    publishPrice(appid, current)
    let rates: Record<string, number> = {}
    const applyRates = () => {
      current = {
        ...current,
        cny: current.price !== null && current.price > 0 ? convertToCny(current.price, current.currency, rates) : null,
        inAppPurchases: current.inAppPurchases.map((item) => ({
          ...item, cny: convertToCny(item.price, item.currency, rates),
        })),
      }
      publishPrice(appid, current)
    }
    await Promise.all([
      ratesPromise.then((value) => { rates = value; applyRates() }),
      fetchInAppPurchases(appid, region, {}, trackViewURL).then((inApp) => {
        current = { ...current, inAppPurchases: inApp.purchases, inAppError: inApp.error, inAppLoading: false }
        applyRates()
      }),
    ])
    return current
  } catch {
    return base
  }
}

export async function getRegionPrices(
  appid: string,
  regionCodes: string[] = DEFAULT_REGION_CODES,
  onUpdate?: (prices: RegionPrice[]) => void,
): Promise<RegionPrice[]> {
  const selected: RegionDefinition[] = []
  for (const value of regionCodes) {
    const region = REGION_CATALOG.find((item) => item.code === String(value).toLowerCase())
    if (region && !selected.some((item) => item.code === region.code)) selected.push(region)
  }

  const values = new Map<string, RegionPrice>()
  const snapshot = () => selected.map((region) => values.get(region.code)!)
  const cleanups: (() => void)[] = []
  for (const region of selected) {
    const key = cacheKey(appid, region)
    values.set(region.code, cachedRegionPrice(appid, region) ?? regionPriceProgress.get(key) ?? {
      region: region.code.toUpperCase(), name: region.name, currency: region.currency,
      price: null, formatted: "", cny: null, unavailable: false,
      inAppPurchases: [], loading: true, inAppLoading: true,
    })
    if (onUpdate) {
      const listeners = priceListeners.get(key) ?? new Set<(price: RegionPrice) => void>()
      const listener = (price: RegionPrice) => {
        values.set(region.code, price)
        onUpdate(snapshot())
      }
      listeners.add(listener)
      priceListeners.set(key, listeners)
      cleanups.push(() => {
        listeners.delete(listener)
        if (!listeners.size) priceListeners.delete(key)
      })
    }
  }
  try {
    onUpdate?.(snapshot())
    // 汇率并行启动；失败只影响人民币换算。
    const needsRates = selected.some((region) => !cachedRegionPrice(appid, region))
    const rates = needsRates ? fetchCnyRates().catch(() => ({})) : Promise.resolve({})
    return await Promise.all(selected.map((region) => {
      const hit = cachedRegionPrice(appid, region)
      if (hit) return Promise.resolve(hit)
      const key = cacheKey(appid, region)
      const existing = regionPriceInFlight.get(key)
      if (existing) return existing
      const request = lookupRegion(appid, region, rates).then((price) => {
        const conversionComplete = (price.price === 0 || price.cny !== null)
          && price.inAppPurchases.every((item) => item.price === null || item.cny !== null)
        if (!price.unavailable && !price.inAppError && conversionComplete) storeRegionPrice(appid, price)
        publishPrice(appid, price)
        return price
      }).finally(() => {
        if (regionPriceInFlight.get(key) === request) {
          regionPriceInFlight.delete(key)
          regionPriceProgress.delete(key)
        }
      })
      regionPriceInFlight.set(key, request)
      return request
    }))
  } finally {
    for (const cleanup of cleanups) cleanup()
  }
}
