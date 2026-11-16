export type ServiceRegionSource = "header" | "page" | "market" | "config" | "route" | "trace" | "redirect" | "snapshot" | ""
export type ServiceRegion = { regionCode: string; regionSource: ServiceRegionSource }
export const NO_SERVICE_REGION: ServiceRegion = { regionCode: "", regionSource: "" }

// ISO 3166-1 alpha-2；XK 为部分服务采用的扩展值。UK 统一为 GB。
const COUNTRY_CODES = new Set(("AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ "
  + "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR "
  + "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP "
  + "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ "
  + "NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW "
  + "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ "
  + "UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW").split(" "))

export function normalizeServiceRegionCode(value: unknown): string {
  if (typeof value !== "string") return ""
  const code = value.trim().toUpperCase()
  return code === "UK" ? "GB" : COUNTRY_CODES.has(code) ? code : ""
}
export function normalizeServiceRegionSource(value: unknown): ServiceRegionSource {
  return typeof value === "string" && ["header", "page", "market", "config", "route", "trace", "redirect", "snapshot"].includes(value)
    ? value as ServiceRegionSource : ""
}
export function serviceRegionSourceLabel(source?: ServiceRegionSource): string {
  return source ? { header: "响应地区", page: "页面地区", market: "页面区域", config: "匿名配置", route: "服务区域", trace: "同域观测",
    redirect: "站点地区", snapshot: "上游快照" }[source] : ""
}

function region(code: unknown, source: ServiceRegionSource): ServiceRegion {
  const regionCode = normalizeServiceRegionCode(code)
  return regionCode ? { regionCode, regionSource: source } : NO_SERVICE_REGION
}

/** 同一字段出现冲突值时不任选一个；跳过无效占位值，保留后续有效代码。 */
function matchCode(body: string, pattern: RegExp): string {
  const matcher = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g")
  const codes = new Set<string>()
  let match: RegExpExecArray | null
  while ((match = matcher.exec(body))) {
    const code = normalizeServiceRegionCode(match[1])
    if (code) codes.add(code)
    if (codes.size > 1) return ""
    if (!match[0]) matcher.lastIndex++
  }
  return [...codes][0] || ""
}
function field(body: string, name: string): string {
  return matchCode(body, new RegExp(`(?:^|[^\\w$])["']?(?:${name})["']?\\s*[:=]\\s*["']([A-Za-z]{2})["']`, "gi"))
}
function objectField(body: string, object: string, name: string): string {
  // 只在目标平面对象内读取，不能越过闭括号捡到后续内容/国家选项。
  const blocks = body.match(new RegExp(`(?:^|[^\\w$])["']?${object}["']?\\s*[:=]\\s*\\{[^{}]{0,4096}\\}`, "gi")) || []
  return field(blocks.join("\n"), name)
}
function decodePage(body: string): string {
  let sample = body
  for (let i = 0; i < 3; i++) {
    sample = sample.replace(/&amp;/gi, "&")
      .replace(/&quot;|&#0*34;|&#x0*22;|\\u0022|\\x22/gi, '"')
      .replace(/&apos;|&#0*39;|&#x0*27;/gi, "'")
      .replace(/\\u003a/gi, ":").replace(/\\(["'\\/])/g, "$1")
  }
  return sample
}
function geminiMarket(body: string): string {
  const marker = /(?:window\.)?WIZ_global_data\s*=\s*\{/i.exec(body)
  if (!marker) return ""
  const end = body.indexOf("</script", marker.index)
  const scoped = body.slice(marker.index, Math.min(marker.index + 300_000, end < 0 ? body.length : end))
  const literal = /["']vXmutd["']\s*:\s*("(?:\\.|[^"\\])*")/.exec(scoped)?.[1]
  try {
    const value: unknown = literal ? JSON.parse(literal) : null
    // 实测为页面区域参数，受 gl 影响；不能称为访问者 IP 国家。
    return typeof value === "string" ? normalizeServiceRegionCode(/^%\.@\."([A-Z]{2})","[A-Z]{2}"(?:,|\])/.exec(value)?.[1]) : ""
  } catch { return "" }
}

export function serviceConfigRegion(body: string, serviceID: string): ServiceRegion {
  if (serviceID !== "spotify") return NO_SERVICE_REGION
  try {
    const data = JSON.parse(body)
    return data && !Array.isArray(data) && data.status === 1 ? region(data.country, "config") : NO_SERVICE_REGION
  } catch { return NO_SERVICE_REGION }
}

/** 仅解析 trace 的完整 loc 行；HTTP 状态、类型、同域路径由请求层核对。 */
export function extractTraceRegionCode(body: string): string {
  if (/[<>]/.test(body)) return ""
  return matchCode(body, /^loc=([A-Za-z]{2})\r?$/gm)
}

export function serviceHeaderRegion(headers: { get: (name: string) => string | null }, serviceID: string): ServiceRegion {
  for (const name of ["x-country-code", "x-country", "x-geo-country", "cf-ipcountry", "x-vercel-ip-country", "x-appengine-country", "country-code"]) {
    const result = region(headers.get(name), "header")
    if (result.regionCode) return result
  }
  // Disney+ 的 region 是站点区域；physical-location 和 x-region-code 不用于国家判断。
  return serviceID === "disney" ? region(headers.get("region"), "page") : NO_SERVICE_REGION
}

export function netflixRedirectRegion(url: string): ServiceRegion {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "https:" || !/(^|\.)netflix\.com$/i.test(parsed.hostname)) return NO_SERVICE_REGION
    const code = /^\/([A-Za-z]{2})(?:-[A-Za-z]{2,4})?(?:\/|$)/.exec(parsed.pathname)?.[1]
    return region(code, "redirect")
  } catch { return NO_SERVICE_REGION }
}

export function servicePageRegion(body: string, serviceID = ""): ServiceRegion {
  if (!body) return NO_SERVICE_REGION
  const sample = decodePage(body)
  let code = ""
  switch (serviceID) {
    case "gemini":
      return region(geminiMarket(body), "market")
    case "netflix":
      code = objectField(sample, "requestCountry", "id") || objectField(sample, "iframeData", "country")
      break
    case "youtube":
      code = field(sample, "INNERTUBE_CONTEXT_GL") || field(sample, "contentRegion")
      break
    case "prime":
      code = field(sample, "currentTerritory") || field(sample, "recordTerritory")
      break
    case "tiktok":
      code = field(sample, "VRegion") || matchCode(sample, /\bdata-region\s*=\s*["']([A-Za-z]{2})["']/gi)
      return region(code, "route")
    case "deepseek": {
      const metas = (sample.match(/<meta\b[^>]*>/gi) || []).filter(tag => /\sname\s*=\s*["']region["']/i.test(tag))
      code = matchCode(metas.join("\n"), /\scontent\s*=\s*["']([A-Za-z]{2})["']/gi)
      break
    }
    case "":
      code = field(sample, "countryCode|country_code|countryIsoCode|country_iso_code|geoCountry|geo_country|INNERTUBE_CONTEXT_GL|cc")
        || matchCode(sample, /\bdata-(?:country|region)(?:-code)?\s*=\s*["']([A-Za-z]{2})["']/gi)
      break
    // 无对应字段不读取语言、页脚国家选项、账户示例或 CDN 部署点。
    default: break
  }
  return region(code, "page")
}

/** 兼容已有调用；真实请求必须由请求层验证 trace 的上下文。 */
export function extractServiceRegionCode(body: string, serviceID = "", allowTrace = serviceID === ""): string {
  return servicePageRegion(body, serviceID).regionCode || (allowTrace ? extractTraceRegionCode(body) : "")
}
