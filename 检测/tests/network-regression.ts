import { Script } from "scripting"
import {
  classifyService, extractServiceRegionCode, isFreshReport, parseNetworkReport, pendingServices,
  reportMatchesIP, serviceCounts, serviceStateLabel, serviceStateParts,
} from "../utils/network_model"
import type { NetworkReport, ServiceResult } from "../utils/network_model"
import { localAddressHint, localNetworkFromInterfaces, parseDomesticExit, parseHTTPProtocol } from "../utils/network"
import { buildWidgetSnapshot, parseWidgetSnapshot } from "../utils/widget_sync"
import { widgetNetworkState, widgetReloadDate } from "../network_widget"
import type { IPInfo } from "../utils/ip"

// 离线回归：仅调用纯函数，所有响应、接口、时间和快照均为内存夹具。
// 不调用 diagnoseNetwork、fetch、Device、Storage、Keychain 或快照读写函数。
const failures: string[] = []
let passed = 0
function check(name: string, assertion: () => boolean) {
  try {
    if (!assertion()) throw new Error("断言失败")
    passed++
  } catch (error) { failures.push(`${name}: ${String(error)}`) }
}
function equal(actual: unknown, expected: unknown): boolean {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`预期 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
  return true
}

const IP = "8.8.8.8"
const V6 = "2606:4700:4700::1111"
const V6_FULL = "2606:4700:4700:0000:0000:0000:0000:1111"
const INFO: IPInfo = {
  query: IP, status: "success", country: "美国", countryCode: "US",
  regionName: "California", city: "Mountain View", isp: "Fixture ISP", org: "Fixture Org",
  as: "AS15169", lat: 37.4, lon: -122.1,
}
function serviceFixture(patch: Partial<ServiceResult> = {}): ServiceResult {
  return { id: "netflix", name: "Netflix", group: "media", state: "reachable", status: 200,
    ms: 42, detail: "HTTP 200 · 页面可访问", regionCode: "", policy: "", ...patch }
}
function reportFixture(patch: Partial<NetworkReport> = {}): NetworkReport {
  return {
    version: 1, measuredAt: Date.now() - 1000, contextIP: IP, source: "device",
    local: { kind: "Wi-Fi 接口", ipv4: "192.168.1.2", ipv6: V6, tunnel: false,
      interfaces: ["en0"], gateway: "", dns: "" },
    latency: { domestic: 12, overseas: 86 }, quic: "other", httpProtocol: "HTTP/2",
    services: pendingServices().map(row => row.id === "netflix" ? serviceFixture() : row),
    surge: null, note: "离线构造数据", durationMs: 120, ...patch,
  }
}
function service(report: NetworkReport | null, id = "netflix"): ServiceResult {
  const row = report?.services.find(item => item.id === id)
  if (!row) throw new Error(`缺少服务结果 ${id}`)
  return row
}
function widgetInput(network: NetworkReport | null, manual = false, ip = IP) {
  return { ip, info: INFO, reputation: null, pure: null, network, manual }
}
function address(value: string, family: "IPv4" | "IPv6", isInternal = false) {
  return { address: value, family, isInternal }
}

async function run() {
  // 服务地区只能来自明确字段；普通 country 文案和非法值不进入显示。
  check("明确服务字段提取地区代码", () => extractServiceRegionCode('{"countryCode":"us","title":"Welcome"}') === "US"
    && extractServiceRegionCode('<div data-region-code="jp"></div>') === "JP"
    && extractServiceRegionCode('loc=gb\nhttp=http/2\n') === "GB")
  check("按服务优先提取地区代码", () => extractServiceRegionCode('{"requestCountry":{"id":"sg"}}', "netflix") === "SG"
    && extractServiceRegionCode('{"VRegion":"sg","VGeo":"row"}', "tiktok") === "SG"
    && extractServiceRegionCode('{"INNERTUBE_CONTEXT_GL":"hk","INNERTUBE_CONTEXT_HL":"zh-HK"}', "youtube") === "HK"
    && extractServiceRegionCode('{&amp;#34;currentTerritory&amp;#34;:&amp;#34;SG&amp;#34;}', "prime") === "SG")
  check("没有可靠服务字段时不猜地区", () => extractServiceRegionCode('{"locale":"zh-CN","market":"JP","region_jp":true}', "spotify") === ""
    && extractServiceRegionCode('{"countryCode":"US"}', "gemini") === ""
    && extractServiceRegionCode('{"countryCode":"SG"}', "deepseek") === ""
    && extractServiceRegionCode('<html>loc=us</html>', "chatgpt") === ""
     && extractServiceRegionCode("loc=us\n", "chatgpt", true) === "US"
     && extractServiceRegionCode('<meta name="region" content="cn">', "deepseek") === "CN")
  check("普通文案不伪造地区代码", () => extractServiceRegionCode("country: United States, locale: en-US") === ""
    && extractServiceRegionCode('{"regionCode":"VA"}') === "")
  check("所有有证据的状态都显示地区代码", () => serviceStateLabel("reachable", "us") === "可用 · US"
    && serviceStateLabel("restricted", "US") === "受限 · US"
    && serviceStateLabel("failed", "jp") === "失败 · JP"
    && serviceStateLabel("unknown", "gb") === "未知 · GB"
    && serviceStateLabel("reachable", "USA") === "可用"
    && serviceStateParts("restricted", "us").code === "US")

  // HTTP 状态与页面内容：限制、错误、未知不能混入“可访问”计数。
  for (const status of [401, 403, 407, 429, 451]) {
    check(`HTTP ${status} 即使正文正常也受限`, () => {
      const result = classifyService(status, "<html><title>Welcome</title></html>")
      return equal(result.state, "restricted") && result.detail.includes(String(status))
    })
  }
  const restrictedPages: [string, string][] = [
    ["Cloudflare 标题", "<title>Just a moment...</title>"],
    ["Cloudflare challenge", '<script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script>'],
    ["Cloudflare 标记", '<div id="cf-chl-widget">Loading</div>'],
    ["真人验证", "Please verify that you are human to continue"],
    ["异常流量", "Our systems have detected unusual traffic from your computer network"],
    ["国家限制", "This service is not available in your country"],
    ["区域限制", "This service is NOT AVAILABLE IN YOUR REGION"],
    ["接口地区错误", '{"error":{"code":"unsupported_country"}}'],
    ["拒绝访问", "<title>Access denied</title>"],
    ["普通验证码拦截页", "<title>Security verification</title><p>Please complete the CAPTCHA to continue.</p>"],
  ]
  for (const [name, body] of restrictedPages) {
    check(`HTTP 200 ${name}不能算可访问`, () => equal(classifyService(200, body).state, "restricted"))
  }
  for (const [name, status, body] of [
    ["正常主页", 200, "<html><title>Welcome</title><main>Browse content</main></html>"],
    ["普通 JSON", 200, '{"ok":true}'],
    ["204 空响应", 204, ""],
    ["仅讨论验证码的普通文章", 200, "<title>Documentation</title><article>How CAPTCHA works</article>"],
  ] as const) {
    check(`${name}可访问`, () => equal(classifyService(status, body).state, "reachable"))
  }
  for (const status of [500, 502, 503, 504, 599, 404, 408]) {
    check(`HTTP ${status}请求失败`, () => equal(classifyService(status, "<title>Welcome</title>").state, "failed"))
  }
  check("5xx 验证页面仍保留请求失败状态", () => equal(classifyService(503, "cf-chl-widget").state, "failed"))
  check("正文读取失败仍保留 403 受限状态", () => classifyService(403, "", false).state === "restricted")
  check("正文读取失败时 2xx 不误报可访问", () => classifyService(200, "", false).state === "unknown"
    && classifyService(200, "", true).state === "reachable")
  check("超时或连接失败保留未知，不借用旧正文", () => {
    const result = classifyService(null, "<title>Welcome</title>")
    return equal(result.state, "unknown") && /超时|连接失败/.test(result.detail)
  })
  for (const status of [301, 302, 303, 307, 308]) {
    check(`HTTP ${status}未完成跳转不算可访问`, () => {
      const result = classifyService(status, "<title>Welcome</title>")
      return equal(result.state, "unknown") && result.detail.includes("重定向未完成")
    })
  }
  check("服务计数分组且排除受限、失败和未知", () => {
    const rows = [
      serviceFixture(), serviceFixture({ id: "disney", state: "restricted", status: 403 }),
      serviceFixture({ id: "spotify", state: "failed", status: 503 }),
      serviceFixture({ id: "youtube", state: "unknown", status: null }),
      serviceFixture({ id: "chatgpt", group: "ai", state: "restricted", status: 429 }),
    ]
    return equal(serviceCounts(rows, "media"), { total: 6, reachable: 1, restricted: 1, failed: 1 })
      && equal(serviceCounts(rows, "ai"), { total: 6, reachable: 0, restricted: 1, failed: 0 })
  })

  // 接口存在不等于当前请求路径；IPv6-only 不能被误判成离线。
  check("IPv6-only en0 识别 Wi-Fi 且不虚构 IPv4", () => {
    const local = localNetworkFromInterfaces({ en0: [address(V6, "IPv6")] })
    return equal([local.kind, local.ipv4, local.ipv6, local.tunnel, local.interfaces],
      ["Wi-Fi 接口", "", V6, false, ["en0"]])
  })
  check("同接口优先全局 IPv6，移除 link-local zone", () => {
    const local = localNetworkFromInterfaces({ en0: [address("fe80::1%en0", "IPv6"), address(V6, "IPv6")] })
    const linkOnly = localNetworkFromInterfaces({ en0: [address("fe80::1%en0", "IPv6")] })
    return local.ipv6 === V6 && linkOnly.ipv6 === "fe80::1" && linkOnly.kind === "Wi-Fi 接口"
  })
  check("仅 IPv6 的 VPN 可识别但不冒充物理出口", () => {
    const local = localNetworkFromInterfaces({ utun4: [address("fd00::2", "IPv6")] })
    return local.tunnel === true && local.kind === "未知" && local.ipv4 === "" && local.ipv6 === ""
      && local.interfaces.length === 0
  })
  for (const name of ["ipsec0", "ppp0", "tun0", "tap0", "wg0"]) {
    check(`${name} 仅 IPv6 仍计为 tunnel`, () => localNetworkFromInterfaces({
      [name]: [address("fd00::2", "IPv6")],
    }).tunnel === true)
  }
  check("Wi-Fi IPv6 与 VPN IPv6 不混合", () => {
    const local = localNetworkFromInterfaces({ utun2: [address("fd00::2", "IPv6")], en0: [address(V6, "IPv6")] })
    return local.tunnel === true && local.ipv6 === V6 && equal(local.interfaces, ["en0"])
  })
  check("IPv6-only Wi-Fi 不借用蜂窝 IPv4", () => {
    const local = localNetworkFromInterfaces({ pdp_ip0: [address("10.0.0.2", "IPv4")], en0: [address(V6, "IPv6")] })
    return local.kind === "Wi-Fi 接口" && local.ipv4 === "" && local.ipv6 === V6
      && equal(local.interfaces, ["en0", "pdp_ip0"])
  })
  check("IPv6-only 蜂窝不误判未知", () => {
    const local = localNetworkFromInterfaces({ pdp_ip0: [address(V6, "IPv6")] })
    return local.kind === "蜂窝接口" && local.ipv4 === "" && local.ipv6 === V6
  })
  check("环回、内部地址与邻近通信接口不选为出口", () => {
    const local = localNetworkFromInterfaces({ lo0: [address("127.0.0.1", "IPv4", true)],
      awdl0: [address("fe80::1", "IPv6")], llw0: [address("fe80::2", "IPv6")],
      utun0: [address("::1", "IPv6", true)], en0: [address("not-an-ip", "IPv4")] })
    return local.kind === "未知" && local.interfaces.length === 0 && local.tunnel === false
  })
  check("空接口列表保留未知，不虚构网关 DNS", () => {
    const local = localNetworkFromInterfaces({})
    return local.kind === "未知" && !local.ipv4 && !local.ipv6 && !local.gateway && !local.dns
  })
  for (const ip of ["10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.1.2"]) {
    check(`${ip} 私网 hint 不宣称 Open NAT`, () => equal(localAddressHint(ip), "私网地址 · 未测试 NAT 类型"))
  }
  for (const ip of ["100.64.0.1", "100.127.255.254"]) {
    check(`${ip} CGNAT 段只作可能性提示`, () => equal(localAddressHint(ip), "共享地址段 · 可能经过运营商 NAT"))
  }
  for (const ip of ["100.63.255.254", "100.128.0.1", "172.15.0.1", "172.32.0.1", IP]) {
    check(`${ip} 不越界套用私网或 CGNAT hint`, () => equal(localAddressHint(ip), "公网接口地址 · 未测试 NAT 类型"))
  }
  check("全局 IPv6 hint", () => equal(localAddressHint(V6), "全局 IPv6 接口地址"))
  for (const ip of ["fe80::1", "fd00::2", "2001:db8::1"]) {
    check(`${ip} 不当作全局 IPv6`, () => equal(localAddressHint(ip), "本地 IPv6 接口地址"))
  }
  for (const ip of ["127.0.0.1", "169.254.1.1", "192.0.2.1"]) {
    check(`${ip} 特殊用途 hint`, () => equal(localAddressHint(ip), "特殊用途接口地址"))
  }
  check("非法地址 hint 不虚构网络状态", () => equal(localAddressHint("invalid"), "未取得地址"))

  for (const protocol of ["h3", "H3", "http/3", "h3-29"]) {
    check(`trace ${protocol} 识别 H3`, () => equal(parseHTTPProtocol(`fl=1\nip=${IP}\nhttp=${protocol}\nloc=US\n`),
      { quic: "h3", httpProtocol: "HTTP/3" }))
  }
  for (const [protocol, expected] of [["h2", "HTTP/2"], ["http/2", "HTTP/2"], ["http/1.1", "HTTP/1.1"], ["http/1.0", "HTTP/1.0"]]) {
    check(`trace ${protocol} 仅说明未观测 H3`, () => equal(parseHTTPProtocol(`ip=${IP}\r\nhttp=${protocol}\r\n`),
      { quic: "other", httpProtocol: expected }))
  }
  for (const trace of ["", "<html>HTTP/3 h3</html>", "http=", "http=h3evil", "http=not-h3", "http=ftp",
    "prefix http=h3", "http=h2h3", "http=h3 extra", "http=h3<script>"]) {
    check(`无效 trace ${JSON.stringify(trace)} 保留未知`, () => equal(parseHTTPProtocol(trace), { quic: "unknown", httpProtocol: "" }))
  }

  check("国内探针保留单段归属", () => equal(parseDomesticExit("当前 IP：8.8.8.8 来自于：美国"),
    { ip: IP, location: "美国", isp: "" }))
  check("国内探针识别公网 IPv6", () => equal(parseDomesticExit(`当前 IP：${V6} 来自于：美国 Cloudflare`),
    { ip: V6_FULL, location: "美国", isp: "Cloudflare" }))
  check("国内探针仍拒绝非法与私网地址", () => parseDomesticExit("当前 IP：999.999.999.999 来自于：中国") === null
    && parseDomesticExit("当前 IP：192.168.1.1 来自于：中国") === null)

  // 双层快照：设备诊断只能附着到同址、非手动查询；兼容此前没有 network 的 v1。
  const report = reportFixture()
  const snapshot = buildWidgetSnapshot(widgetInput(report))
  check("同址且非 manual 时 builder 保留网络结果", () => snapshot.manual === false
    && snapshot.network?.contextIP === IP && service(snapshot.network).status === 200)
  check("JSON 往返仍保留绑定、位置和观测结果", () => {
    const parsed = parseWidgetSnapshot(JSON.parse(JSON.stringify(snapshot)))
    return !!parsed && parsed.ip === IP && parsed.lat === 37.4 && parsed.lon === -122.1
      && parsed.network?.measuredAt === report.measuredAt && parsed.network.httpProtocol === "HTTP/2"
      && service(parsed.network).state === "reachable"
  })
  check("服务地区代码随共享快照保留", () => {
    const withRegion = reportFixture({ services: [serviceFixture({ regionCode: "US" })] })
    const parsed = parseWidgetSnapshot(buildWidgetSnapshot(widgetInput(withRegion)))
    return service(parsed?.network || null).regionCode === "US"
  })
  check("builder manual 即使同址也剔除设备网络", () => {
    const manual = buildWidgetSnapshot(widgetInput(report, true))
    return manual.manual === true && manual.network === null && manual.ip === IP
  })
  check("parser manual 即使同址也剔除设备网络", () => {
    const parsed = parseWidgetSnapshot({ ...snapshot, manual: true, network: report })
    return !!parsed && parsed.manual === true && parsed.network === null && parsed.ip === IP
  })
  check("builder 剔除其他 IP 的网络结果", () => buildWidgetSnapshot(widgetInput(reportFixture({ contextIP: "1.1.1.1" }))).network === null)
  check("parser 剔除其他 IP 的网络结果但保留主 IP", () => {
    const parsed = parseWidgetSnapshot({ ...snapshot, network: reportFixture({ contextIP: "1.1.1.1" }) })
    return !!parsed && parsed.network === null && parsed.ip === IP && parsed.lat === 37.4
  })
  for (const contextIP of [null, "", "invalid"]) {
    check(`未绑定 contextIP=${String(contextIP)} 不进入 widget`, () => {
      const unbound = reportFixture({ contextIP })
      return !reportMatchesIP(unbound, IP) && buildWidgetSnapshot(widgetInput(unbound)).network === null
        && parseWidgetSnapshot({ ...snapshot, network: unbound })?.network === null
    })
  }
  check("两个无效地址不能被误判同址", () => !reportMatchesIP(reportFixture({ contextIP: "invalid" }), "invalid"))
  check("mapped IPv6 与 IPv4 同址并正确进入快照", () => {
    const mapped = reportFixture({ contextIP: "::ffff:8.8.8.8" })
    return reportMatchesIP(mapped, IP) && buildWidgetSnapshot(widgetInput(mapped)).network?.contextIP === IP
  })
  check("压缩 IPv6 与完整 IPv6 同址", () => {
    const ipv6Report = reportFixture({ contextIP: V6 })
    const built = buildWidgetSnapshot(widgetInput(ipv6Report, false, V6_FULL))
    return reportMatchesIP(ipv6Report, V6_FULL) && built.network?.contextIP === V6_FULL
      && parseWidgetSnapshot(built)?.network?.contextIP === V6_FULL
  })
  const { network: omittedNetwork, manual: omittedManual, ...legacy } = snapshot
  check("旧版 v1 缺少 manual/network 可读取", () => {
    const parsed = parseWidgetSnapshot(legacy)
    return !!parsed && parsed.manual === false && parsed.network === null && parsed.ip === IP
      && parsed.lat === 37.4 && parsed.lon === -122.1 && parsed.risk === snapshot.risk
  })
  check("旧调用方不传新参数仍兼容", () => {
    const built = buildWidgetSnapshot({ ip: IP, info: INFO, reputation: null, pure: null })
    return built.manual === false && built.network === null
  })
  check("错误 network schema 不破坏原 IP 快照", () => {
    const parsed = parseWidgetSnapshot({ ...legacy, network: { v: 1, src: "surge", ts: Date.now() } })
    return !!parsed && parsed.ip === IP && parsed.lat === 37.4 && parsed.network === null
  })

  const now = Date.now()
  const manualRecent = { ...snapshot, manual: true, network: null, savedAt: now - 14 * 60_000 }
  const manualOld = { ...manualRecent, savedAt: now - 60 * 60_000 }
  const pendingOld = { ...snapshot, manual: false, network: null, savedAt: now - 60 * 60_000 }
  check("手动与无网络报告的旧快照显示过期", () => widgetNetworkState(manualOld, 15, now).stale
    && widgetNetworkState(pendingOld, 15, now).stale && !widgetNetworkState(manualRecent, 15, now).stale)
  check("新鲜快照按剩余有效期申请重绘", () => widgetReloadDate(manualRecent, 15, now).getTime() === now + 60_000)
  check("过期或缺失快照等待完整周期避免立即重绘循环", () =>
    widgetReloadDate(manualOld, 15, now).getTime() === now + 15 * 60_000
    && widgetReloadDate(null, 15, now).getTime() === now + 15 * 60_000)
  check("网络快照按照报告时间而不是 IP 保存时间过期", () => {
    const oldReport = { ...snapshot, savedAt: now, network: reportFixture({ measuredAt: now - 16 * 60_000 }) }
    return widgetNetworkState(oldReport, 15, now).stale
      && widgetReloadDate(oldReport, 15, now).getTime() === now + 15 * 60_000
  })
  const future = reportFixture({ measuredAt: now + 3_600_000 })
  check("未来一小时的 network 被 parser 拒绝", () => parseNetworkReport(future) === null)
  check("未来 network 不进入 builder", () => buildWidgetSnapshot(widgetInput(future)).network === null)
  check("未来 network 不污染 widget IP 与坐标", () => {
    const parsed = parseWidgetSnapshot({ ...snapshot, network: future })
    return !!parsed && parsed.network === null && parsed.ip === IP && parsed.lat === 37.4
  })
  check("未来 network 不被认为新鲜", () => !isFreshReport(future, 15, now))
  check("新鲜度允许一分钟内时钟偏差", () => isFreshReport(reportFixture({ measuredAt: now + 30_000 }), 15, now))
  check("超过一分钟的未来时间不新鲜", () => !isFreshReport(reportFixture({ measuredAt: now + 60_001 }), 15, now))
  check("缓存有效期边界不延长", () => isFreshReport(reportFixture({ measuredAt: now - 899_999 }), 15, now)
    && !isFreshReport(reportFixture({ measuredAt: now - 900_000 }), 15, now))
  check("外层未来 savedAt 不能把旧网络变成新鲜", () => {
    const parsed = parseWidgetSnapshot({ ...snapshot, savedAt: now + 3_600_000,
      network: reportFixture({ measuredAt: now - 1_800_000 }) })
    return !!parsed && !!parsed.network && !isFreshReport(parsed.network, 15, now)
  })
  for (const measuredAt of [0, -1, NaN, Infinity, -Infinity]) {
    check(`非法 measuredAt ${String(measuredAt)} 拒绝`, () => parseNetworkReport({ ...report, measuredAt }) === null)
  }
  for (const [name, patch] of [
    ["版本", { version: 2 }], ["来源", { source: "unknown" }],
    ["时间字符串", { measuredAt: String(now) }], ["服务不是数组", { services: {} }],
  ] as const) {
    check(`network 顶层非法${name}拒绝`, () => parseNetworkReport({ ...report, ...patch }) === null)
  }

  // 接受不可信快照时，字段白名单、类型和状态语义都不能把脏数据变成“可访问”。
  check("脏服务条目不抛异常、不加入未知 id", () => {
    const parsed = parseNetworkReport({ ...report, services: [null, 42, "bad", [],
      { id: "injected", group: "ai", state: "reachable", status: 200 },
      { id: "netflix", state: "bogus", status: 200 }] })
    return !!parsed && parsed.services.length === 12 && new Set(parsed.services.map(row => row.id)).size === 12
      && parsed.services.every(row => row.state === "unknown")
      && serviceCounts(parsed.services, "media").reachable === 0 && serviceCounts(parsed.services, "ai").reachable === 0
  })
  check("服务 name/group 不接受上游冒名篡改", () => {
    const parsed = parseNetworkReport({ ...report, services: [{ ...serviceFixture(), name: "Forged", group: "ai" }] })
    return equal([service(parsed).name, service(parsed).group], ["Netflix", "media"])
      && serviceCounts(parsed!.services, "ai").reachable === 0
  })
  check("重复 id 不膨胀可访问计数", () => {
    const parsed = parseNetworkReport({ ...report, services: [serviceFixture(), serviceFixture(), serviceFixture()] })
    return !!parsed && parsed.services.length === 12 && serviceCounts(parsed.services, "media").reachable === 1
  })
  check("坏服务保留未知，同时保留其他有效服务", () => {
    const parsed = parseNetworkReport({ ...report, services: [{ id: "netflix", state: { reachable: true } },
      serviceFixture({ id: "chatgpt", name: "ChatGPT", group: "ai", state: "restricted", status: 429 })] })
    return service(parsed).state === "unknown" && service(parsed, "chatgpt").state === "restricted"
      && serviceCounts(parsed!.services, "ai").reachable === 0
  })
  check("服务数字字符串、无穷值、对象文案不进入结果", () => {
    const parsed = parseNetworkReport({ ...report, services: [{ ...serviceFixture(), state: "unknown",
      status: "200", ms: Infinity, detail: { message: "reachable" }, policy: ["DIRECT"] }] })
    const row = service(parsed)
    return row.status === null && row.ms === null && row.detail === "" && row.policy === ""
  })
  check("有效服务的 0ms 不当作缺失", () => service(parseNetworkReport({ ...report,
    services: [serviceFixture({ ms: 0 })] })).ms === 0)
  for (const ms of [-1, 300_001, NaN, Infinity]) {
    check(`服务非法耗时 ${String(ms)} 归一为空`, () => service(parseNetworkReport({ ...report,
      services: [serviceFixture({ ms })] })).ms === null)
  }
  check("坏延迟和耗时不污染显示", () => {
    const parsed = parseNetworkReport({ ...report, latency: { domestic: -5, overseas: "12" }, durationMs: Infinity })
    return !!parsed && parsed.latency.domestic === null && parsed.latency.overseas === null && parsed.durationMs === 0
  })
  check("超长服务说明和策略名受到长度约束", () => {
    const parsed = parseNetworkReport({ ...report, services: [serviceFixture({ detail: "x".repeat(1000), policy: "y".repeat(1000) })] })
    return service(parsed).detail.length <= 250 && service(parsed).policy.length <= 250
  })
  check("脏地区代码被清空", () => service(parseNetworkReport({ ...report,
    services: [serviceFixture({ regionCode: "USA" })] })).regionCode === "")
  check("数组形式 state 不经字符串强转混入服务模型", () => {
    const parsed = parseNetworkReport({ ...report, services: [{ ...serviceFixture(), state: ["reachable"] }] })
    if (!parsed) return true
    return equal(service(parsed).state, "unknown") && serviceCounts(parsed.services, "media").reachable === 0
  })
  const impossibleStatuses: (number | null)[] = [401, 403, 429, 451, 302, 503, null, 0, 600, NaN]
  for (const status of impossibleStatuses) {
    check(`脏快照 reachable + ${String(status)} 不污染可访问计数`, () => {
      const parsed = parseNetworkReport({ ...report, services: [serviceFixture({ state: "reachable", status })] })
      if (!parsed) return true // 整体拒绝或降级均可；不能保留可访问。
      return equal(service(parsed).state === "reachable", false)
        && equal(serviceCounts(parsed.services, "media").reachable, 0)
    })
  }
  check("widget builder 同样拒绝矛盾服务状态", () => {
    const dirty = reportFixture({ services: [serviceFixture({ state: "reachable", status: 403 })] })
    const built = buildWidgetSnapshot(widgetInput(dirty))
    return equal(built.network?.services.some(row => row.state === "reachable") ?? false, false)
  })
  check("widget parser 同样拒绝矛盾服务状态", () => {
    const dirty = reportFixture({ services: [serviceFixture({ state: "reachable", status: 403 })] })
    const parsed = parseWidgetSnapshot({ ...snapshot, network: dirty })
    return equal(parsed?.network?.services.some(row => row.state === "reachable") ?? false, false)
  })
  check("解析不原地修改输入快照", () => {
    const input = reportFixture()
    const before = JSON.stringify(input)
    parseNetworkReport(input)
    buildWidgetSnapshot(widgetInput(input))
    parseWidgetSnapshot({ ...snapshot, network: input })
    return JSON.stringify(input) === before
  })

  Script.exit({ suite: "network-regression", offline: true, passed, failed: failures.length, failures })
}
void run().catch(error => Script.exit({ suite: "network-regression", offline: true,
  passed, failed: failures.length + 1, failures: [...failures, String(error)] }))
