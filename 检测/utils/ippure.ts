import { fetch } from "scripting"
import type { AbortSignal } from "scripting"
import { canonicalAddress, formatIPLocation } from "./ip"
import { countryName, sameIP, withTimeout } from "./geo"
import type { ExitObservation, GeoRow } from "./geo"

export interface IPPureReport {
  source: "网页" | "API" | null
  asn: string | null
  organization: string | null
  domain: string | null
  range: string | null
  isBroadcast: boolean | null
  isResidential: boolean | null
  networkType: string | null
  risk: number | null
  cloudflareRisk: number | null
  traffic: { human: number; bot: number } | null
  locations: GeoRow[]
  exit: ExitObservation | null
  note: string
}

type ObjectData = Record<string, any>
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null
const flag = (value: unknown): boolean | null => typeof value === "boolean" ? value : null
const percent = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null
const asn = (value: unknown): string | null => typeof value === "number" && Number.isSafeInteger(value)
  && value > 0 && value <= 4294967295 ? `AS${value}` : null

function ipPureURL(ip: string): string {
  return `https://ippure.com/?ip=${encodeURIComponent(ip)}`
}

// 使用网站自己的查询动作；资源名从当前页面发现，不固定带 hash 的脚本文件名。
// 仅返回查询数据，不读取浏览器指纹、Cookie 或身份信息。
const PAGE_QUERY = `
  const started = Date.now();
  let store = null;
  while (!store && Date.now() - started < 2500) {
    store = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia?._s?.get('ipinfo');
    if (!store) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!store || typeof store.getBasicIpInfo !== 'function') return null;
  let cf = null, finished = false;
  const tasks = [
    Promise.resolve().then(() => store.getBasicIpInfo(target, false)).then(() => {
      const asn = store.basicInfo?.data?.asn?.number;
      if (asn && typeof store.getAsnBotClass === 'function') return store.getAsnBotClass(asn);
    }),
    Promise.resolve().then(() => target.includes(':') || typeof store.getIpQuality !== 'function'
      ? null : store.getIpQuality(target, false)),
    Promise.resolve().then(() => store.getBilibili(target)),
  ];
  const asset = [...document.querySelectorAll('link[href]')].map(e => e.href)
    .find(url => /getCfEntSummary\\.[^/]+\\.js/.test(url));
  if (asset) tasks.push(import(asset).then(module => module.g(target, true)).then(value => {
    if (value) cf = {ip:value.ip, risk_score:value.risk_score, geo:value.geo};
  }));
  Promise.allSettled(tasks).then(() => { finished = true; });
  while (!finished && Date.now() - started < 10000) await new Promise(resolve => setTimeout(resolve, 150));
  return JSON.stringify({
    queriedIP: target,
    basic: store.basicInfo?.data,
    risk: store.ipQuality?.data?.risk_score,
    riskIP: store.ipQuality?.data?.ip,
    traffic: store.asnFigure?.botClass,
    bilibili: store.bilibili?.rawData,
    cf,
  });
`

async function pageData(ip: string, isCurrent: () => boolean): Promise<ObjectData | null> {
  if (!isCurrent()) return null
  let web: WebViewController | null = null
  let cancellation: ReturnType<typeof setInterval> | undefined
  try {
    web = new WebViewController({ ephemeral: true, settings: { inactiveSchedulingPolicy: "none" } })
    const controller = web
    cancellation = setInterval(() => {
      try { if (!isCurrent() && !controller.isDisposed) controller.dispose() } catch { /* 旧请求已释放 */ }
    }, 250)
    const loaded = await withTimeout(web.loadRequest({ url: ipPureURL(ip), timeoutInterval: 7 }), 7500)
    if (!loaded || !isCurrent()) return null
    const raw = await withTimeout(web.callAsyncJavaScript<string | null>(PAGE_QUERY, { target: ip }), 11000)
    return raw ? JSON.parse(raw) : null
  } catch (error) {
    console.log("[IP检测] IPPure 网页暂不可用", String(error))
    return null
  } finally {
    if (cancellation !== undefined) clearInterval(cancellation)
    try { if (web && !web.isDisposed) web.dispose() } catch { /* 取消轮询可能已释放 */ }
  }
}

async function officialData(signal?: AbortSignal): Promise<ObjectData | null> {
  if (signal?.aborted) return null
  try {
    return await withTimeout(async () => {
      const response = await fetch("https://my.ippure.com/v1/info", { timeout: 5, signal })
      return response.ok ? await response.json() as ObjectData : null
    }, 5500)
  } catch { return null }
}

function locationRow(source: string, ip: string, data: ObjectData | null | undefined): GeoRow | null {
  if (!data) return null
  const rawCode = text(data.country_code) || ""
  const code = /^[A-Z]{2}$/i.test(rawCode) ? rawCode.toUpperCase() : ""
  const location = formatIPLocation({
    country: countryName(code) || rawCode, countryCode: code,
    regionName: text(data.subdivisions) || "", city: text(data.city) || "",
  }, "")
  return location ? { source, ip, location, status: "ok" } : null
}

/** 无法取得的数据保留 null；API 只代表自身出口，必须与查询地址相同才能补分。 */
export function parseIPPure(ip: string, page: ObjectData | null, official: ObjectData | null): IPPureReport {
  const result: IPPureReport = {
    source: null, asn: null, organization: null, domain: null, range: null,
    isBroadcast: null, isResidential: null, networkType: null,
    risk: null, cloudflareRisk: null, traffic: null, locations: [], exit: null, note: "",
  }
  const basic = page?.basic
  const queryMatches = sameIP(text(page?.queriedIP) || "", ip)
  const pageMatches = queryMatches && sameIP(text(basic?.ip) || "", ip)
  if (pageMatches) {
    const network = basic.asn || {}
    const range = network.network?.range
    result.source = "网页"
    result.asn = asn(network.number)
    result.organization = text(network.organization)
    result.domain = text(network.domain)
    result.range = text(range?.start) && text(range?.end) ? `${range.start} - ${range.end}` : text(network.network?.cidr)
    result.isBroadcast = flag(basic.traits?.is_broadcast)
    result.isResidential = flag(network.is_residential)
    result.networkType = text(network.type)
    const human = percent(page?.traffic?.human)
    const bot = percent(page?.traffic?.bot)
    if (human !== null && bot !== null && Math.abs(human + bot - 100) < 0.1) result.traffic = { human, bot }
    for (const source of ["IP2Location", "DB-IP", "MaxMind"]) {
      const row = locationRow(source, ip, basic.geo?.[source])
      if (row) result.locations.push(row)
    }
  }
  // 评分请求与归属请求独立；只接受评分自己带有的同址证据。
  if (queryMatches && sameIP(text(page?.riskIP) || "", ip)) {
    result.risk = percent(page?.risk)
    if (result.risk !== null) result.source ??= "网页"
  }
  if (queryMatches && sameIP(text(page?.bilibili?.addr) || "", ip)) {
    const data = page!.bilibili
    const row = locationRow("Bilibili", ip, { country_code: data.country, subdivisions: data.province, city: data.city })
    if (row) result.locations.push(row)
  }
  if (queryMatches && sameIP(text(page?.cf?.ip) || "", ip)) {
    result.cloudflareRisk = percent(page?.cf?.risk_score)
    const row = locationRow("Cloudflare", ip, page?.cf?.geo)
    if (row) result.locations.push(row)
  }
  const officialIP = text(official?.ip)
  if (officialIP && canonicalAddress(officialIP)) {
    const location = formatIPLocation({
      country: text(official?.country) || "", countryCode: text(official?.countryCode) || "",
      regionName: text(official?.region) || "", city: text(official?.city) || "",
    }, "")
    result.exit = { source: "IPPure", ip: officialIP, location }
    if (sameIP(officialIP, ip)) {
      result.source ??= "API"
      result.risk ??= percent(official?.fraudScore)
      result.isBroadcast ??= flag(official?.isBroadcast)
      result.isResidential ??= flag(official?.isResidential)
      result.asn ??= asn(official?.asn)
      result.organization ??= text(official?.asOrganization)
    }
  }
  if (!result.source) result.note = "IPPure 暂未返回此 IP 的数据，可打开原网页核对。"
  else if (result.risk === null) result.note = ip.includes(":") ? "IPPure 暂未提供此 IPv6 的风险分。" : "IPPure 本次未返回风险分。"
  return result
}

export async function fetchIPPure(ip: string, isCurrent = () => true, signal?: AbortSignal): Promise<IPPureReport> {
  const active = () => !signal?.aborted && isCurrent()
  const [page, official] = await Promise.all([pageData(ip, active), officialData(signal)])
  return parseIPPure(ip, page, official)
}
