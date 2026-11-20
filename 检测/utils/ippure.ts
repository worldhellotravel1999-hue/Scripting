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

/** 页面只提供安全客户端与资源；具体地址由脚本入参 target 决定，不依赖 URL 参数。 */
const PAGE_URL = "https://ippure.com/"

// 使用网站自己的安全客户端；资源名从当前页面发现，不固定带 hash 的脚本文件名。
// 直接从脚本 fetch 会得到 {ok:false}，因为安全客户端负责 x-k/x-t 签名和失败重试。
// 仅返回查询数据，不读取浏览器指纹、Cookie 或身份信息。
const PAGE_QUERY = `
  const started = Date.now();
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const assets = [...document.querySelectorAll('link[href]')].map(e => e.href);
  const securityURL = assets.find(url => /security\\.[^/]+\\.js/.test(url));
  const summaryURL = assets.find(url => /getCfEntSummary\\.[^/]+\\.js/.test(url));
  const result = { queriedIP: target, basic: null, risk: null, riskIP: null, traffic: null, bilibili: null, cf: null };

  let client = null;
  try { client = securityURL ? (await import(securityURL)).s : null; } catch { /* 页面资源变更时走 Pinia 兜底 */ }
  if (client) {
    const readJSON = async (promise) => {
      try {
        const response = await promise;
        if (!response?.ok) return null;
        return await response.json();
      } catch { return null; }
    };
    const basicURL = '/api/info/ip-basic/' + encodeURIComponent(target);
    const riskURL = target.includes(':') ? null : '/api/info/ip-risk/' + encodeURIComponent(target);
    const bilibiliURL = '/api/gateway/bilibili?ip=' + encodeURIComponent(target);
    // 风险、B 站归属和 Cloudflare 风险彼此无关，一次并发；它们都不阻塞主体。
    const summaryTask = summaryURL ? (async () => {
      try {
        const value = await (await import(summaryURL)).g(target, true);
        if (value) result.cf = { ip: value.ip, risk_score: value.risk_score, geo: value.geo };
      } catch { /* Cloudflare 风险是可选项 */ }
    })() : Promise.resolve();
    const [basic, risk, bilibili] = await Promise.all([
      readJSON(client.get(basicURL)),
      riskURL ? readJSON(client.get(riskURL)) : Promise.resolve(null),
      readJSON(client.get(bilibiliURL)),
    ]);
    result.basic = basic?.data ?? null;
    result.risk = risk?.data?.risk_score ?? null;
    result.riskIP = risk?.my_ip ?? null;
    result.bilibili = bilibili?.data ?? null;
    const asn = result.basic?.asn?.number;
    if (asn) {
      // ASN 级流量统计是第二跳，个别 ASN 会慢到 3s；给个上限，超时就算本次未取得。
      result.traffic = await Promise.race([
        readJSON(client.get('/api/info/asn/botclass/' + asn)).then(bot => bot?.data ?? null),
        wait(2500).then(() => null),
      ]);
    }
    // Cloudflare 风险属于补充项；这里只等到极短预算，等不到就不显示，不把整块拖死。
    await Promise.race([summaryTask, wait(1200)]);
    if (result.basic || result.risk !== null || result.traffic || result.bilibili) return JSON.stringify(result);
  }

  // 安全客户端暂不可用时保留原有 Pinia 路径，避免站点升级导致整项失灵。
  let store = null;
  while (!store && Date.now() - started < 2500) {
    store = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia?._s?.get('ipinfo');
    if (!store) await wait(100);
  }
  if (!store || typeof store.getBasicIpInfo !== 'function') return null;
  let cf = result.cf, finished = false;
  const tasks = [
    Promise.resolve().then(() => store.getBasicIpInfo(target, false)).then(() => {
      const asn = store.basicInfo?.data?.asn?.number;
      if (asn && typeof store.getAsnBotClass === 'function') return store.getAsnBotClass(asn);
    }),
    Promise.resolve().then(() => target.includes(':') || typeof store.getIpQuality !== 'function'
      ? null : store.getIpQuality(target, false)),
    Promise.resolve().then(() => store.getBilibili(target)),
  ];
  if (summaryURL) tasks.push(import(summaryURL).then(module => module.g(target, true)).then(value => {
    if (value) cf = {ip:value.ip, risk_score:value.risk_score, geo:value.geo};
  }));
  Promise.allSettled(tasks).then(() => { finished = true; });
  while (!finished && Date.now() - started < 10000) await wait(100);
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

type PageLease = { web: WebViewController; ready: Promise<boolean> }
let warmPage: PageLease | null = null

function disposePage(web: WebViewController) {
  try { if (!web.isDisposed) web.dispose() } catch { /* 已释放 */ }
}

/**
 * 出口探测期间就开始加载页面：加载只需一次，查询换地址不必重新导航。
 * 顺序执行时这段加载完全落在关键路径上，预热后与出口探测重叠。
 */
export function prewarmIPPurePage(): void {
  if (warmPage) return
  try {
    const web = new WebViewController({ ephemeral: true, settings: { inactiveSchedulingPolicy: "none" } })
    const ready = withTimeout(web.loadRequest({ url: PAGE_URL, timeoutInterval: 6 }), 6500)
      .then(loaded => loaded === true)
      .catch(() => false)
    warmPage = { web, ready }
    // 本轮若没走到页面查询（例如出口获取失败），释放这个隐藏页面。
    setTimeout(() => {
      if (warmPage?.web !== web) return
      warmPage = null
      disposePage(web)
    }, 12_000)
  } catch { warmPage = null }
}

function takeWarmPage(): PageLease | null {
  const lease = warmPage
  warmPage = null
  return lease
}

async function pageData(ip: string, isCurrent: () => boolean): Promise<ObjectData | null> {
  if (!isCurrent()) return null
  let web: WebViewController | null = null
  let cancellation: ReturnType<typeof setInterval> | undefined
  try {
    const lease = takeWarmPage()
    if (lease) web = await lease.ready && isCurrent() ? lease.web : null
    if (!web && lease) disposePage(lease.web)
    if (!web) {
      if (!isCurrent()) return null
      const created = new WebViewController({ ephemeral: true, settings: { inactiveSchedulingPolicy: "none" } })
      web = created
      const loaded = await withTimeout(created.loadRequest({ url: PAGE_URL, timeoutInterval: 6 }), 6500)
      if (!loaded || !isCurrent()) return null
    }
    const controller = web
    cancellation = setInterval(() => {
      try { if (!isCurrent() && !controller.isDisposed) controller.dispose() } catch { /* 旧请求已释放 */ }
    }, 250)
    const raw = await withTimeout(web.callAsyncJavaScript<string | null>(PAGE_QUERY, { target: ip }), 7000)
    return raw ? JSON.parse(raw) : null
  } catch (error) {
    console.log("[IP检测] IPPure 网页暂不可用", String(error))
    return null
  } finally {
    if (cancellation !== undefined) clearInterval(cancellation)
    if (web) disposePage(web)
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
