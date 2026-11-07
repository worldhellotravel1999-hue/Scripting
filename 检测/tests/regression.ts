import { Script } from "scripting"
import { canonicalAddress, expandIPv6, formatIPAddress, isPublicExitAddress, parseIPInfo, calculateRiskValue } from "../utils/ip"
import { collectGeoRow, sameIP, withTimeout } from "../utils/geo"
import { validIPAddress, parseProxyCheck, assembleLookupResult } from "../utils/lookup"
import { parseIPPure } from "../utils/ippure"
import { normalizeRTCAddress, rtcAddressScope, parseWebRTC, assessWebRTC } from "../utils/webrtc"
import { detectionTime, locationDetails, networkDetails } from "../utils/details"
import { activeRiskFlags, hasKnownRiskFlags, shouldShowRiskScale } from "../utils/flags"
import { buildWidgetSnapshot, parseWidgetSnapshot } from "../utils/widget_sync"
import { hasCoordinates } from "../utils/map"
import type { IPInfo } from "../utils/ip"

const failures: string[] = []
let passed = 0
function check(name: string, assertion: () => boolean) {
  try {
    if (!assertion()) throw new Error("断言失败")
    passed++
  } catch (error) { failures.push(`${name}: ${String(error)}`) }
}

async function run() {
  for (const ip of ["1:2:3:4:5:6:7::8", "::1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7:8::", "1:::2", "2001::db8::1", "256.0.0.1"]) {
    check(`拒绝非法地址 ${ip}`, () => !validIPAddress(ip) && canonicalAddress(ip) === null && normalizeRTCAddress(ip) === null)
  }
  for (const ip of ["::", "::1", "2001:db8::1", "1:2:3:4:5:6:7:8", "::ffff:192.0.2.1", "192.0.2.1"]) {
    check(`接受有效地址 ${ip}`, () => validIPAddress(ip) && canonicalAddress(ip) !== null)
  }
  check("IPv6 压缩必须代表至少一段", () => expandIPv6("1:2:3:4:5:6:7::8") === null)
  check("等价 IPv6", () => sameIP("2001:db8::1", "2001:0db8:0:0:0:0:0:1"))
  check("IPv4 mapped 同址", () => sameIP("::ffff:192.0.2.1", "192.0.2.1"))
  check("IPv4 mapped 隐私", () => formatIPAddress("::ffff:192.0.2.1", true) === "192.0.x.x")
  check("IPv6 隐私", () => formatIPAddress("2001:db8::1234", true) === "2001:0db8:0000:0000::/64")
  check("IPv4 空白不绕过隐私", () => formatIPAddress(" 192.0.2.1 ", true) === "192.0.x.x")
  check("非法地址不能同址", () => !sameIP("invalid", "invalid"))
  for (const ip of ["127.0.0.1", "10.1.2.3", "100.64.1.1", "169.254.1.2", "192.0.2.1", "198.51.100.2", "203.0.113.1", "::1", "fe80::1", "fc00::1", "2001:db8::1", "::ffff:127.0.0.1"]) {
    check(`出口不采信非公网 ${ip}`, () => !isPublicExitAddress(ip))
  }
  check("出口采信公网 IPv4", () => isPublicExitAddress("8.8.8.8"))
  check("出口采信公网 IPv6", () => isPublicExitAddress("2606:4700:4700::1111"))
  check("ip-api 拒绝无效目标地址", () => parseIPInfo({ status: "success", query: "invalid" }) === null)
  check("ip-api 拒绝错址响应", () => parseIPInfo({ status: "success", query: "1.1.1.1" }, "8.8.8.8") === null)
  check("ip-api 字段缺失不使小组件崩溃", () => {
    const info = parseIPInfo({ status: "success", query: "8.8.8.8", isp: 88, offset: 0 })
    return !!info && info.isp === "" && info.offset === 0 && calculateRiskValue(info).riskValue >= 0
  })
  check("ip-api 忽略异常布尔值与坐标", () => {
    const info = parseIPInfo({ status: "success", query: "8.8.8.8", hosting: "false", lat: 999, lon: 999 })
    return !!info && info.hosting === undefined && !hasCoordinates(info)
  })
  check("ip-api 单侧坐标缺失不会画到赤道", () => {
    const info = parseIPInfo({ status: "success", query: "8.8.8.8", lon: 120.1 })
    return !!info && !hasCoordinates(info)
  })
  check("ip-api 真实零纬度保留", () => {
    const info = parseIPInfo({ status: "success", query: "8.8.8.8", lat: 0, lon: 120.1 })
    return !!info && hasCoordinates(info)
  })

  const ip = "8.8.8.8"
  const pc = parseProxyCheck({ status: "warning", [ip]: { detections: { risk: 0, proxy: false, vpn: false, confidence: 0 }, device_estimate: { address: 0, subnet: 0 } } }, ip)
  check("proxycheck 保留真实零值与 false", () => pc?.risk === 0 && pc.proxy === false && pc.confidence === 0 && pc.devices?.address === 0)
  check("proxycheck 缺失仍未知", () => pc?.tor === null && pc?.hosting === null)
  check("未标记与未知标记均不占位", () => activeRiskFlags(pc, false).length === 0 && activeRiskFlags(pc, null).length === 0)
  check("空信誉不占位", () => activeRiskFlags(null, null).length === 0)
  const mixedFlags = parseProxyCheck({ status: "ok", [ip]: { detections: {
    proxy: false, vpn: true, tor: false, anonymous: null, scraper: true, compromised: false,
  } } }, ip)
  check("只渲染明确阳性的标记", () => activeRiskFlags(mixedFlags, false).map(flag => flag.id).join(",") === "vpn,scraper")
  check("代理兜底为真时排在首位", () => activeRiskFlags(mixedFlags, true).map(flag => flag.id).join(",") === "proxy,vpn,scraper")
  const allFlags = parseProxyCheck({ status: "ok", [ip]: { detections: {
    proxy: true, vpn: true, tor: true, anonymous: true, scraper: true, compromised: true,
  } } }, ip)
  check("全部命中保持固定顺序", () => activeRiskFlags(allFlags, true).map(flag => flag.id).join(",") === "proxy,vpn,tor,anonymous,scraper,compromised")
  check("零分与缺失不显示刻度条", () => !shouldShowRiskScale(0) && !shouldShowRiskScale(null)
    && !shouldShowRiskScale(undefined) && !shouldShowRiskScale(Number.NaN))
  check("正分显示刻度条", () => shouldShowRiskScale(0.5) && shouldShowRiskScale(1) && shouldShowRiskScale(100))

  const widgetInfo: IPInfo = { query: ip, status: "success", country: "美国", countryCode: "US",
    regionName: "California", city: "Mountain View", isp: "Google", org: "Google LLC",
    as: "AS15169 Google LLC", lat: 37.4, lon: -122.1, timezone: "America/Los_Angeles", offset: -28800 }
  const widgetRep = parseProxyCheck({ status: "ok", [ip]: { detections: {
    risk: 42, proxy: false, vpn: true, tor: false, anonymous: false, scraper: false, compromised: false, hosting: false,
  } } }, ip)
  const snapshot = buildWidgetSnapshot({ ip, info: widgetInfo, reputation: widgetRep, pure: null })
  check("小组件快照同步 IP 与地图坐标", () => snapshot.ip === ip && snapshot.lat === 37.4 && snapshot.lon === -122.1)
  check("小组件快照使用 proxycheck 风险", () => snapshot.risk === 42 && snapshot.riskSource === "proxycheck")
  check("小组件快照同步风险标记与属性", () => snapshot.vpnStatus === "VPN" && snapshot.accessType === "非机房标记")
  check("未标记与未知可区分", () => snapshot.vpnStatus === "VPN"
    && buildWidgetSnapshot({ ip, info: widgetInfo, reputation: pc, pure: null }).vpnStatus === "未标记"
    && buildWidgetSnapshot({ ip, info: widgetInfo, reputation: null, pure: null }).vpnStatus === "未知"
    && hasKnownRiskFlags(pc) && !hasKnownRiskFlags(null))

  const pureStub: import("../utils/ippure").IPPureReport = {
    source: null, asn: null, organization: null, domain: null, range: null, isBroadcast: null,
    isResidential: null, networkType: null, risk: 77, cloudflareRisk: null, traffic: null,
    locations: [], exit: null, note: "",
  }
  const zeroRep = parseProxyCheck({ status: "ok", [ip]: { detections: {
    risk: 0, proxy: false, vpn: false, confidence: 0,
  } } }, ip)
  const zeroSnapshot = buildWidgetSnapshot({ ip, info: widgetInfo, reputation: zeroRep, pure: pureStub })
  check("proxycheck 0 分不被 IPPure 覆盖", () => zeroSnapshot.risk === 0 && zeroSnapshot.riskSource === "proxycheck")
  const pureSnapshot = buildWidgetSnapshot({ ip, info: widgetInfo, reputation: null, pure: pureStub })
  check("proxycheck 缺失时回退 IPPure", () => pureSnapshot.risk === 77 && pureSnapshot.riskSource === "IPPure")
  check("快照往返保留关键字段", () => {
    const parsed = parseWidgetSnapshot(snapshot)
    return !!parsed && parsed.ip === snapshot.ip && parsed.risk === 42 && parsed.riskSource === "proxycheck"
      && parsed.accessType === snapshot.accessType && parsed.vpnStatus === "VPN"
  })
  check("快照拒绝非法版本与地址", () => parseWidgetSnapshot({ ...snapshot, version: 2 }) === null
    && parseWidgetSnapshot({ ...snapshot, ip: "999.1.1.1" }) === null)
  check("快照剔除越界或单边坐标", () => {
    const parsed = parseWidgetSnapshot({ ...snapshot, lat: 999, lon: 10 })
    return !!parsed && parsed.lat === null && parsed.lon === null
  })
  check("proxycheck 不采信异址数据", () => parseProxyCheck({ status: "ok", "1.1.1.1": { detections: { risk: 90 } } }, ip) === null)
  check("归属缺失保留同址信誉结果", () => {
    const result = assembleLookupResult(ip, null, null, pc)
    return result.info === null && result.reputation?.risk === 0 && result.reputation.proxy === false
  })
  check("归属与信誉均缺失则明确失败", () => {
    try { assembleLookupResult(ip, null, null, null); return false }
    catch (error) { return String(error).includes("归属查询失败") }
  })
  check("补充源畸形国家码不损害主源", () => {
    const info = parseIPInfo({ status: "success", query: ip, country: "美国" })!
    const result = assembleLookupResult(ip, info, { success: true, ip, country_code: 42 as never,
      connection: { org: 88 as never, asn: 15169 } }, pc)
    return result.info === info && result.alternateLocation?.countryCode === "" && result.connection?.organization === "—"
  })
  check("备选源单侧坐标缺失不画错地图", () => {
    const result = assembleLookupResult(ip, null, { success: true, ip, latitude: 0, country: "美国" }, null)
    return result.info !== null && !hasCoordinates(result.info)
  })

  const base = { queriedIP: ip, basic: { ip, asn: { number: 15169 } } }
  check("IPPure 异址评分拒绝", () => parseIPPure(ip, { ...base, risk: 87, riskIP: "1.1.1.1" }, null).risk === null)
  check("IPPure 无来源评分拒绝", () => parseIPPure(ip, { ...base, risk: 87 }, null).risk === null)
  check("IPPure 同址零分保留", () => parseIPPure(ip, { ...base, risk: 0, riskIP: ip }, null).risk === 0)
  check("IPPure 官方异址仅作出口", () => {
    const report = parseIPPure(ip, null, { ip: "1.1.1.1", fraudScore: 99 })
    return report.risk === null && report.exit?.ip === "1.1.1.1"
  })
  check("IPPure 官方同址补零分", () => parseIPPure(ip, null, { ip, fraudScore: 0 }).risk === 0)
  check("IPPure IPv6 不借用残留 IPv4 评分", () => parseIPPure("2001:db8::1", { queriedIP: "2001:db8::1", basic: { ip: "2001:db8::1" }, risk: 88, riskIP: ip }, null).risk === null)
  check("Cloudflare 独立校验地址", () => parseIPPure(ip, { ...base, cf: { ip: "1.1.1.1", risk_score: 99 } }, null).cloudflareRisk === null)
  check("人机比异常值拒绝", () => parseIPPure(ip, { ...base, traffic: { human: 80, bot: 80 } }, null).traffic === null)

  const info: IPInfo = { query: ip, status: "success", country: "美国", countryCode: "US", regionName: "", city: "", isp: "Example", org: "example", as: "", lat: 37, lon: -122, timezone: "Etc/UTC", offset: 0 }
  check("地理详情保留 UTC 0 偏移", () => locationDetails(info).some(row => row.value === "Etc/UTC · UTC+00:00"))
  check("运营商机构去重", () => networkDetails(info, "EXAMPLE").length === 0)
  check("异常时间不显示", () => detectionTime("invalid") === null)
  check("地图拒绝缺失坐标", () => !hasCoordinates({ ...info, lat: NaN }))
  check("地图拒绝越界坐标", () => !hasCoordinates({ ...info, lon: 181 }))
  check("地图接受赤道有效坐标", () => hasCoordinates({ ...info, lat: 0 }))
  check("地图区分真实零坐标与缺失", () => hasCoordinates({ ...info, lat: 0, lon: 0 }))
  check("NAT64 全球转换前缀参与公网对照", () => rtcAddressScope("64:ff9b::808:808") === "public")
  check("NAT64 内嵌环回地址不算公网", () => rtcAddressScope("64:ff9b::7f00:1") === "local")
  check("NAT64 内嵌私网地址不算公网", () => rtcAddressScope("64:ff9b::c0a8:101") === "local")
  check("IPv6 新文档前缀不参与公网对照", () => rtcAddressScope("3fff::1") === "local")
  check("IPv4 公网特殊用途例外保留", () => rtcAddressScope("192.0.0.9") === "public")
  check("IPv6 ORCHID 非公网", () => rtcAddressScope("2001:20::1") === "local")
  const exitWithoutLocation = await collectGeoRow("Cloudflare", ip, true, async () =>
    ({ ip: "1.1.1.1", country: "", code: "", region: "", city: "" }))
  check("位置未知时保留已观测出口", () => exitWithoutLocation.ip === "1.1.1.1"
    && exitWithoutLocation.status === "unavailable" && exitWithoutLocation.note === "位置暂不可用")
  const wrongAddress = await collectGeoRow("DB-IP", ip, false, async () =>
    ({ ip: "1.1.1.1", country: "美国", code: "US", region: "", city: "" }))
  check("地址库错址不采信", () => wrongAddress.ip === null && wrongAddress.status === "unavailable")

  const rtc = parseWebRTC({ status: "complete", candidates: [
    "candidate:1 1 UDP 123 8.8.8.8 6000 typ srflx raddr 192.168.0.1 rport 5000",
    "candidate:1 1 UDP 123 8.8.8.8 6000 typ srflx raddr 192.168.0.1 rport 5000",
    "candidate:2 1 UDP 123 secret.local 5000 typ host",
  ] })
  check("WebRTC 去重且不混入 raddr", () => rtc.candidates.length === 2 && !rtc.candidates.some(candidate => candidate.address === "192.168.0.1"))
  check("WebRTC 同址出口", () => assessWebRTC(rtc, [{ source: "测试", ip, location: "" }]).tone === "ok")
  check("WebRTC 异址警示", () => assessWebRTC(rtc, [{ source: "测试", ip: "1.1.1.1", location: "" }]).tone === "warning")
  check("WebRTC 无对照不判定安全", () => assessWebRTC(rtc, []).tone === "neutral")
  check("手动查询不做 WebRTC", () => assessWebRTC(rtc, [], false, true).label === "不适用")

  try {
    await withTimeout(new Promise<never>(() => {}), 15, "测试超时")
    failures.push("未触发超时")
  } catch (error) { check("超时按期拒绝", () => String(error).includes("测试超时")) }
  const fast = await withTimeout(Promise.resolve(42), 100)
  check("成功返回原值", () => fast === 42)
  Script.exit({ passed, failed: failures.length, failures })
}
void run().catch(error => Script.exit({ passed, failed: failures.length + 1, failures: [...failures, String(error)] }))
