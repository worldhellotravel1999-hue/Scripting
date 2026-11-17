import { AbortController, AbortSignal, fetch } from "scripting"
import type { Response } from "scripting"
import { SERVICES } from "./network_model"
import { NO_SERVICE_REGION, extractTraceRegionCode, netflixRedirectRegion, serviceHeaderRegion, servicePageRegion, serviceConfigRegion } from "./network_region"
import type { ServiceRegion } from "./network_region"

type Probe = ServiceRegion & {
  status: number | null
  ms: number | null
  text: string
  bodyReadOK: boolean
}
const emptyProbe = (): Probe => ({ status: null, ms: null, text: "", bodyReadOK: false, ...NO_SERVICE_REGION })

function serviceHostMatches(serviceID: string, url: string): boolean {
  try {
    const definition = SERVICES.find(item => item.id === serviceID)
    if (!definition) return false
    const expected = new URL(definition.url), actual = new URL(url)
    if (actual.protocol !== "https:") return false
    if (serviceID === "spotify" && actual.hostname === "spclient.wg.spotify.com") return true
    if (serviceID === "youtube") return ["youtube.com", "www.youtube.com", "m.youtube.com"].includes(actual.hostname)
    return actual.hostname.replace(/^www\./, "") === expected.hostname.replace(/^www\./, "")
  } catch { return false }
}

/** 不把重定向到登录/验证供应商的国家、错误 HTML 或 colo 机房码当服务地区。 */
function validServiceTrace(response: Pick<Response, "status" | "headers">, url: string, serviceID: string): boolean {
  if (response.status < 200 || response.status >= 300 || !serviceHostMatches(serviceID, url)) return false
  try {
    return new URL(url).pathname === "/cdn-cgi/trace"
      && /^text\/plain(?:\s*;|$)/i.test(response.headers.get("content-type") || "")
  } catch { return false }
}

/** 保留读到的响应头/部分正文；正文失败只影响可达性，不清空已经观测到的地区。 */
export async function readProbeResponse(response: Response, options: {
  url: string; serviceID?: string; trace?: boolean; config?: boolean; readBody?: boolean; ms: number
}): Promise<Probe> {
  const { serviceID = "", trace = false, config = false, readBody = false } = options
  const trusted = serviceHostMatches(serviceID, options.url)
  let observed = trusted && !trace && !config ? serviceHeaderRegion(response.headers, serviceID) : NO_SERVICE_REGION
  let text = "", bodyReadOK = true
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  try {
    if (readBody) {
      // 服务页面配置常位于 CSS/JS 之后，扩大至 1 MiB；trace 不需要大页面。
      const limit = trace ? 16_384 : config ? 65_536 : serviceID ? 1_048_576 : 160_000
      let bytes = 0
      while (bytes < limit) {
        const chunk = await reader.read()
        if (chunk.done) break
        if (!chunk.value) { bodyReadOK = false; break }
        const slice = chunk.value.subarray(0, limit - bytes)
        text += decoder.decode(slice, { stream: true })
        bytes += slice.length
      }
    }
  } catch { bodyReadOK = false }
  finally {
    text += decoder.decode()
    await reader.cancel().catch(() => {})
  }
  if (trusted && trace && validServiceTrace(response, options.url, serviceID)) {
    const code = extractTraceRegionCode(text)
    if (code) observed = { regionCode: code, regionSource: "trace" }
  } else if (trusted && config && bodyReadOK && response.status >= 200 && response.status < 300
    && /^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || "")
    && serviceID === "spotify" && new URL(options.url).hostname === "spclient.wg.spotify.com"
    && new URL(options.url).pathname === "/signup/public/v1/account") {
    observed = serviceConfigRegion(text, serviceID)
  } else if (trusted && !trace && !config && !observed.regionCode) {
    observed = servicePageRegion(text, serviceID)
    if (!observed.regionCode && serviceID === "netflix") observed = netflixRedirectRegion(options.url)
  }
  return { status: response.status, ms: options.ms, text: text.slice(0, 200_000), bodyReadOK, ...observed }
}

export async function probe(url: string, signal: AbortSignal, readBody = false, serviceID = "", kind: "page" | "trace" | "config" = "page"): Promise<Probe> {
  if (signal.aborted) return emptyProbe()
  const trace = kind === "trace", config = kind === "config"
  const controller = new AbortController()
  const timer = setTimeout(() => { try { controller.abort() } catch {} }, 6500)
  const started = Date.now()
  let status: number | null = null, ms: number | null = null
  let observed = NO_SERVICE_REGION
  let finalURL = url
  try {
    const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}_=${started}`, {
      timeout: 6.5, signal: AbortSignal.any([signal, controller.signal]), headers: { "Cache-Control": "no-cache" },
      handleRedirect: async request => { finalURL = request.url; return request },
    })
    status = response.status
    ms = Date.now() - started
    finalURL = response.url || finalURL
    if (!trace && !config && serviceHostMatches(serviceID, finalURL)) observed = serviceHeaderRegion(response.headers, serviceID)
    return await readProbeResponse(response, { url: finalURL, serviceID, trace, config, readBody, ms })
  } catch {
    return { status, ms, text: "", bodyReadOK: false, ...observed }
  } finally { clearTimeout(timer) }
}
