import { Response, Script } from "scripting"
import type { Response as ResponseType } from "scripting"
import { extractServiceRegionCode, normalizeServiceRegionCode, netflixRedirectRegion, serviceHeaderRegion } from "../utils/network_region"
import { readProbeResponse } from "../utils/network_probe"
import { classifyService, parseNetworkReport, pendingServices } from "../utils/network_model"
import { parseSurgeSnapshot } from "../utils/network_surge"
import { normalizeNetworkSettings } from "../utils/network_settings"
import { buildWidgetSnapshot, parseWidgetSnapshot } from "../utils/widget_sync"

async function run() {
  const failures: string[] = []
  let passed = 0
  const check = (name: string, condition: boolean) => condition ? passed++ : failures.push(name)
  const headers = (values: Record<string, string>) => ({ get: (name: string) => values[name] || null })
  check("州级头不能当国家", !serviceHeaderRegion(headers({ "x-region-code": "VA", "x-region": "CA" }), "grok").regionCode)
  check("Grok 国家头优先", serviceHeaderRegion(headers({ "x-country-code": "us", "x-region-code": "VA" }), "grok").regionCode === "US")
  check("Disney 站点地区与物理位置分离", serviceHeaderRegion(headers({ region: "sg", "physical-location": "TW" }), "disney").regionCode === "SG")
  check("非Disney不采信region头", !serviceHeaderRegion(headers({ region: "US" }), "spotify").regionCode)
  check("非法两位值拒绝及UK别名", !normalizeServiceRegionCode("FE") && !normalizeServiceRegionCode("EN") && normalizeServiceRegionCode("UK") === "GB")
  check("跨服务字段不混入", !extractServiceRegionCode('{"currentTerritory":"JP"}', "gemini"))
  check("Netflix不越过目标对象", !extractServiceRegionCode('{"requestCountry":{},"choices":[{"id":"US"}]}', "netflix"))
  check("转义JSON可读", extractServiceRegionCode(String.raw`{\"VRegion\":\"sg\"}`, "tiktok") === "SG")
  check("HTML多层实体可读", extractServiceRegionCode('{&amp;#34;currentTerritory&amp;#34;:&amp;#34;SG&amp;#34;}', "prime") === "SG")
  check("同字段先无效后有效", extractServiceRegionCode('{"VRegion":"XX","other":{"VRegion":"sg"}}', "tiktok") === "SG")
  check("同字段国家冲突不任选", !extractServiceRegionCode('{"VRegion":"US","other":{"VRegion":"sg"}}', "tiktok"))
  check("不匹配字段后缀", !extractServiceRegionCode('{"notVRegion":"sg"}', "tiktok"))
  check("Netflix国家语言路径", netflixRedirectRegion("https://www.netflix.com/sg-zh/title/81215567").regionCode === "SG")
  check("伪造Netflix域拒绝", !netflixRedirectRegion("https://netflix.com.evil.test/us/").regionCode)
  check("DeepSeek元标签支持空格和顺序", extractServiceRegionCode('<meta content = "CN" name = "region">', "deepseek") === "CN")
  check("不读其他元标签内容", !extractServiceRegionCode('<meta name="region"><meta content="CN">', "deepseek"))
  check("Prime评级国家不作为地区", !extractServiceRegionCode('{"ratings":{"countryCode":"US"},"homeRegion":"FE"}', "prime"))
  check("YouTube语言不作为国家", !extractServiceRegionCode('{"INNERTUBE_CONTEXT_HL":"zh-HK"}', "youtube"))
  const wiz = (code: string) => 'window.WIZ_global_data={"vXmutd":' + JSON.stringify('%.@."' + code + '","ZZ","fixture"]') + '};'
  check("Gemini页面区域参数可观测", extractServiceRegionCode(wiz("US"), "gemini") === "US" && extractServiceRegionCode(wiz("SG"), "gemini") === "SG")
  check("Gemini未知或无WIZ不能补猜", !extractServiceRegionCode(wiz("ZZ"), "gemini") && !extractServiceRegionCode('{"vXmutd":"US"}', "gemini"))
  const mobile = await readProbeResponse(new Response('{"INNERTUBE_CONTEXT_GL":"HK"}', { status: 200 }),
    { url: "https://m.youtube.com/", serviceID: "youtube", readBody: true, ms: 1 })
  check("YouTube官方移动站地区不丢失", mobile.regionCode === "HK")
  const config = (body: string, url = "https://spclient.wg.spotify.com/signup/public/v1/account?validate=1") =>
    readProbeResponse(new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
      { url, serviceID: "spotify", config: true, readBody: true, ms: 1 })
  const spotify = await config('{"status":1,"country":"JP","allowed_calling_codes":[{"country_code":"US"}]}')
  check("Spotify只读顶层国家及来源", spotify.regionCode === "JP" && spotify.regionSource === "config")
  check("Spotify国家列表不伪造结果", !(await config('{"status":1,"allowed_calling_codes":[{"country_code":"US"}]}')).regionCode)
  check("Spotify错误状态不采信", !(await config('{"status":0,"country":"JP"}')).regionCode)
  check("Spotify跨域配置拒绝", !(await config('{"status":1,"country":"JP"}', "https://other.test/signup/public/v1/account")).regionCode)
  check("trace不接受查询串或HTML", !extractServiceRegionCode("?loc=US", "chatgpt", true)
    && !extractServiceRegionCode("<p>\nloc=US\n</p>", "chatgpt", true))
  const late = await readProbeResponse(new Response(" ".repeat(220_000) + '{"currentTerritory":"SG"}', { status: 200 }),
    { url: "https://www.primevideo.com/", serviceID: "prime", readBody: true, ms: 1 })
  check("160KB之后的地区仍可读", late.regionCode === "SG" && late.regionSource === "page" && late.text.length === 200_000)
  const oversized = await readProbeResponse(new Response(" ".repeat(1_048_576) + '{"currentTerritory":"SG"}', { status: 200 }),
    { url: "https://www.primevideo.com/", serviceID: "prime", readBody: true, ms: 1 })
  check("采样存在硬上限", !oversized.regionCode && oversized.text.length === 200_000)
  let reads = 0, cancelled = false
  const broken = { status: 403, headers: headers({ "x-country-code": "US" }), body: { getReader: () => ({
    read: async () => { if (reads++ === 0) return { done: false, value: new TextEncoder().encode("partial") }; throw new Error("fixture") },
    cancel: async () => { cancelled = true },
  }) } } as unknown as ResponseType
  const partial = await readProbeResponse(broken, { url: "https://grok.com/", serviceID: "grok", readBody: true, ms: 1 })
  check("正文失败保留响应头地区且取消流", partial.regionCode === "US" && partial.text === "partial" && !partial.bodyReadOK && cancelled)
  check("正文失败403状态仍受限", classifyService(partial.status, partial.text, partial.bodyReadOK).state === "restricted")
  const trace = (status: number, contentType: string, url = "https://claude.ai/cdn-cgi/trace") =>
    readProbeResponse(new Response("fl=1\nh=claude.ai\nloc=US\ncolo=LAX\n", { status, headers: { "content-type": contentType } }),
      { url, serviceID: "claude", trace: true, readBody: true, ms: 1 })
  check("同域200纯文本trace有效", (await trace(200, "text/plain; charset=utf-8")).regionSource === "trace")
  check("403trace不采信", !(await trace(403, "text/plain")).regionCode)
  check("200HTMLtrace不采信", !(await trace(200, "text/html")).regionCode)
  check("跨域trace不采信", !(await trace(200, "text/plain", "https://other.test/cdn-cgi/trace")).regionCode)
  check("错误路径trace不采信", !(await trace(200, "text/plain", "https://claude.ai/error")).regionCode)
  const services = pendingServices().map(row => ({ ...row, state: "restricted" as const, status: 403, regionCode: "US", regionSource: "trace" as const }))
  const report = parseNetworkReport({ version: 1, measuredAt: Date.now(), source: "device", contextIP: "8.8.8.8", services })!
  const snapshot = parseWidgetSnapshot(buildWidgetSnapshot({ ip: "8.8.8.8", info: null, reputation: null, pure: null, network: report }))
  check("全部受限地区和来源共享快照往返", snapshot?.network?.services.length === 12 && snapshot.network.services.every(row => row.regionCode === "US" && row.regionSource === "trace" && row.state === "restricted"))
  const now = Date.now()
  const upstream = parseSurgeSnapshot({ v: 1, ts: now - 1, src: "surge", exit: { ip: "8.8.8.8" },
    local: { net: "Wi-Fi", ip: "192.168.1.2", gw: "", dns: "", vpn: false }, lat: { local: 0, proxy: 0 },
    quic: { ok: false, reachable: false }, media: [{ id: "netflix", ok: false, cc: "", regionCode: "JP" }], ai: [],
  }, normalizeNetworkSettings({}), "8.8.8.8", now)
  check("空cc回退有效regionCode", upstream?.services[0].regionCode === "JP" && upstream.services[0].regionSource === "snapshot")
  Script.exit({ suite: "service-region-regression", offline: true, passed, failed: failures.length, failures })
}
void run().catch(error => Script.exit({ failed: 1, failures: [String(error)] }))
