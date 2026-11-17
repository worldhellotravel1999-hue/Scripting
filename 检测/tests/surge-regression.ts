import { Script } from "scripting"
import { parseSurgeSnapshot, policiesAfterBaseline, surgeBaselineFromRequests, applySurgeObservation } from "../utils/network_surge"
import { normalizeNetworkSettings, isSurgeHost, isNetworkSnapshotURL, networkSettingsError } from "../utils/network_settings"
import type { NetworkReport } from "../utils/network_model"

const results: Record<string, { passed: number; failures: string[] }> = {}
function check(group: string, name: string, test: () => boolean) {
  const result = results[group] ||= { passed: 0, failures: [] }
  try {
    if (test()) result.passed++
    else result.failures.push(name)
  } catch { result.failures.push(`${name}（抛出异常）`) }
}
const settings = normalizeNetworkSettings({})
const now = 1_800_000_000_000
const raw = {
  v: 1, ts: now - 1000, src: "surge", masked: false,
  exit: { ip: "8.8.8.8", country: "不得导入", risk: 99, purity: 1 },
  local: { net: "Wi-Fi", ip: "192.168.1.2", gw: "192.168.1.1", dns: "1.1.1.1", vpn: true, v6: true, area: "不得导入" },
  lat: { local: 30, proxy: 90 }, quic: { ok: true, reachable: true },
  media: [{ id: "netflix", ok: true, name: "不采信上游名称", cc: "US", policy: "媒体组" }, { id: "disney", ok: false }],
  ai: [{ id: "chatgpt", ok: true, policy: "AI 组" }],
  surge: { mode: "规则分流", node: "JP-AnyTLS", policy: "选择", protocol: "AnyTLS" }, cost: 1200,
}
const parsed = parseSurgeSnapshot(raw, settings, "8.8.8.8", now)!
const parse = (patch: Record<string, unknown>, ip: string | null = "8.8.8.8") => parseSurgeSnapshot({ ...raw, ...patch }, settings, ip, now)
const s = (name: string, test: () => boolean) => check("settings", name, test)
s("defaults", () => settings.refreshMinutes === 15 && settings.surgeHost === "127.0.0.1" && settings.surgePort === 6171 && settings.snapshotURL === "")
s("interval clamped", () => normalizeNetworkSettings({ refreshMinutes: 1 }).refreshMinutes === 5 && normalizeNetworkSettings({ refreshMinutes: 999 }).refreshMinutes === 240)
s("finite interval", () => normalizeNetworkSettings({ refreshMinutes: NaN }).refreshMinutes === 15 && normalizeNetworkSettings({ refreshMinutes: Infinity }).refreshMinutes === 15)
s("port boundary", () => normalizeNetworkSettings({ surgePort: 0 }).surgePort === 6171 && normalizeNetworkSettings({ surgePort: 65535 }).surgePort === 65535)
s("strip extra and secret fields", () => Object.keys(normalizeNetworkSettings({ surgeKey: "dummy", maskIP: true, extra: true })).sort().join() === "refreshMinutes,snapshotURL,surgeHost,surgePort")
s("host valid", () => ["localhost", "127.0.0.1", "surge.local", "::1", "[::1]", "2606:4700:4700::1111"].every(isSurgeHost))
s("host reject credentials and routes", () => ["x@y", "http://localhost", "a/b", "a?key=dummy", "a#b", "a:6171", "999.999.1.1", "-a", "a..b"].every(v => !isSurgeHost(v)))
s("snapshot URL allowed", () => isNetworkSnapshotURL("https://example.com/snapshot?version=1") && isNetworkSnapshotURL("http://127.0.0.1/snapshot"))
s("snapshot URL rejected", () => ["file:///x", "data:application/json,{}", "https://user:password@example.com/", "https://example.com/#frag", "https://ex ample.com/"].every(v => !isNetworkSnapshotURL(v)))
s("UI validation", () => !!networkSettingsError({ ...settings, refreshMinutes: 4 }) && !!networkSettingsError({ ...settings, surgePort: 65536 }))
const p = (name: string, test: () => boolean) => check("snapshot", name, test)
p("valid mapping", () => !!parsed && parsed.source === "surge" && parsed.latency.domestic === 30 && parsed.latency.overseas === 90 && parsed.quic === "h3")
p("matched binding", () => parsed.contextIP === "8.8.8.8")
p("mismatch unbound", () => parse({}, "1.1.1.1")?.contextIP === null && parse({}, "1.1.1.1")!.note.includes("不匹配"))
p("null context unbound", () => parse({}, null)?.contextIP === null)
p("masked unbound", () => parse({ masked: true })?.contextIP === null && parse({ masked: true })?.local.ipv4 === "")
p("masked literal unbound", () => parse({ exit: { ip: "8.8.x.x" } })?.contextIP === null)
p("no IP unbound", () => parse({ exit: {} })?.contextIP === null && parse({ exit: undefined })?.contextIP === null)
p("canonical IPv6 binding", () => parse({ exit: { ip: "2606:4700:4700:0:0:0:0:1111" } }, "2606:4700:4700::1111")?.contextIP === "2606:4700:4700:0000:0000:0000:0000:1111")
p("IPv4 mapped binding", () => parse({ exit: { ip: "::ffff:8.8.8.8" } })?.contextIP === "8.8.8.8")
p("future 1ms rejected", () => parse({ ts: now + 1 }) === null)
p("expired rejected", () => parse({ ts: now - 15 * 60_000 }) === null)
p("fresh boundary", () => parse({ ts: now - 15 * 60_000 + 1 }) !== null)
p("invalid timestamps", () => [NaN, Infinity, 0, -1, "1800000000000", now - 0.5].every(ts => parse({ ts }) === null))
p("wrong version/source", () => parse({ v: 2 }) === null && parse({ src: "self" }) === null)
p("bad roots", () => [null, [], "{", 42, true].every(v => parseSurgeSnapshot(v, settings, null, now) === null))
p("bad nested structure", () => parse({ local: [] }) === null && parse({ lat: "bad" }) === null && parse({ quic: null }) === null && parse({ surge: [] }) === null)
p("bad scalar types", () => parse({ local: { vpn: "true" } }) === null && parse({ masked: "false" }) === null && parse({ lat: { local: "30" } }) === null)
p("invalid ms rejected", () => parse({ lat: { local: -1 } }) === null && parse({ lat: { proxy: NaN } }) === null)
p("zero latency unknown", () => parse({ lat: { local: 0, proxy: 0 } })?.latency.domestic === null)
p("old success stays unknown", () => parsed.services[0].state === "unknown" && parsed.services[0].status === null && parsed.services[0].detail.includes("上游报告可达"))
p("old failure unknown", () => parsed.services[1].state === "unknown" && parsed.services[1].status === null)
p("fixed catalogue", () => parsed.services.length === 12 && parsed.services[0].name === "Netflix")
p("service upstream label", () => parsed.services[0].policy === "上游快照 · 媒体组")
p("service region code", () => parsed.services[0].regionCode === "US" && parsed.services[1].regionCode === "")
p("no geography risk imports", () => !JSON.stringify(parsed).includes("不得导入") && !("risk" in parsed) && !("cc" in parsed.services[0]) && !("domesticExit" in parsed))
p("bad services reject", () => parse({ media: [null] }) === null && parse({ ai: [{ id: "chatgpt", ok: "true" }] }) === null)
p("duplicate services reject", () => parse({ media: [{ id: "netflix", ok: true }, { id: "netflix", ok: false }] }) === null)
p("QUIC other", () => parse({ quic: { ok: false, reachable: true } })?.quic === "other")
p("QUIC unknown", () => parse({ quic: { ok: false, reachable: false } })?.quic === "unknown")
p("missing QUIC fields rejected", () => parse({ quic: {} }) === null && parse({ quic: { reachable: true } }) === null)
p("missing local or latency fields rejected", () => parse({ local: {} }) === null && parse({ lat: {} }) === null)
p("partial Surge summary rejected", () => parse({ surge: { node: "only" } }) === null)
p("snapshot direct clears stale details", () => { const r = parse({ surge: { ...raw.surge, mode: "direct" } }); return !!r && r.surge?.node === "直连" && r.surge.policy === "" && r.surge.protocol === "" })
p("QUIC contradictory rejected", () => parse({ quic: { ok: true, reachable: false } }) === null)
p("do not invent IPv6 from flag", () => parsed.local.ipv6 === "")
p("snapshot label strips URL", () => { const r = parse({ surge: { ...raw.surge, node: "https://example.com/?x-key=dummy", protocol: "token=secret" } }); return !!r && !JSON.stringify(r).includes("example.com") && !JSON.stringify(r).includes("token=secret") })
p("snapshot no QUIC block policy", () => parse({ media: [{ id: "netflix", ok: true, policy: "QUIC-BLOCK" }] })?.services[0].policy === "")
const b = (name: string, test: () => boolean) => check("baseline", name, test)
b("max unsorted", () => surgeBaselineFromRequests([{ id: 1 }, { id: 17 }, { id: 4 }]) === 17)
b("wrapped string id", () => surgeBaselineFromRequests({ requests: [{ id: "22" }, { id: 21 }] }) === 22)
b("empty is zero", () => surgeBaselineFromRequests([]) === 0)
b("bad envelope", () => surgeBaselineFromRequests({ error: "unavailable" }) === null)
b("malformed id fails closed", () => surgeBaselineFromRequests([{ id: 1 }, {}]) === null)
b("unsafe ids rejected", () => [NaN, -1, 3.5, Number.MAX_SAFE_INTEGER + 1, "1e3", "-1", ""].every(id => surgeBaselineFromRequests([{ id }]) === null))
const logs = [
  { id: 9, remoteHost: "www.netflix.com:443", policyName: "旧节点" },
  { id: 10, remoteHost: "www.netflix.com:443", policyName: "边界旧节点" },
  { id: 11, remoteHost: "www.netflix.com:443", policyName: "本轮节点", originalPolicyName: "媒体组" },
  { id: 12, remoteHost: "www.netflix.com:443", policyName: "QUIC-BLOCK" },
  { id: 13, remoteHost: "chatgpt.com:443", policyName: "AI 节点" },
]
const m = (name: string, test: () => boolean) => check("policy", name, test)
m("new requests only", () => policiesAfterBaseline(logs, 10).get("netflix") === "本轮节点")
m("baseline excludes equal", () => policiesAfterBaseline(logs.slice(0, 2), 10).size === 0)
m("null baseline disables", () => policiesAfterBaseline(logs, null).size === 0)
m("bad baseline disables", () => policiesAfterBaseline(logs, NaN).size === 0 && policiesAfterBaseline(logs, -1).size === 0)
m("wrapped requests", () => policiesAfterBaseline({ requests: logs }, 10).get("chatgpt") === "AI 节点")
m("QUIC notes filtered", () => policiesAfterBaseline([{ id: 11, remoteHost: "netflix.com", policyName: "REJECT", notes: ["policy: QUIC-BLOCK"] }], 10).size === 0)
m("QUIC original policy filtered", () => policiesAfterBaseline([{ id: 11, remoteHost: "netflix.com", policyName: "REJECT", originalPolicyName: "QUIC-BLOCK" }], 10).size === 0)
m("suffix spoof rejected", () => policiesAfterBaseline([{ id: 11, remoteHost: "netflix.com.evil.test", policyName: "伪造" }, { id: 12, remoteHost: "evilnetflix.com", policyName: "伪造" }], 10).size === 0)
m("real subdomain accepted", () => policiesAfterBaseline([{ id: 11, remoteHost: "api.netflix.com.", policyName: "子域" }], 10).get("netflix") === "子域")
m("uppercase port and trailing dot", () => policiesAfterBaseline([{ id: 11, remoteHost: "WWW.NETFLIX.COM.:443", policyName: "规范化" }], 10).get("netflix") === "规范化")
m("URL fallback accepted", () => policiesAfterBaseline([{ id: 11, URL: "https://chatgpt.com/?a=b", policyName: "AI" }], 10).get("chatgpt") === "AI")
m("URL hostname not substring", () => policiesAfterBaseline([{ id: 11, URL: "https://evil.test/chatgpt.com", policyName: "伪造" }], 10).size === 0)
m("remoteHost authoritative", () => policiesAfterBaseline([{ id: 11, remoteHost: "evil.test", URL: "https://chatgpt.com/", policyName: "伪造" }], 10).size === 0)
m("reject invalid remote host", () => policiesAfterBaseline([{ id: 11, remoteHost: "u@netflix.com", URL: "https://netflix.com/", policyName: "伪造" }], 10).size === 0)
m("latest independent of order", () => policiesAfterBaseline([{ id: 20, remoteHost: "netflix.com", policyName: "最新" }, ...logs], 10).get("netflix") === "最新")
m("DIRECT service observed", () => policiesAfterBaseline([{ id: 14, remoteHost: "chatgpt.com", policyName: "DIRECT" }], 10).get("chatgpt") === "DIRECT")
m("request reset cannot bind", () => policiesAfterBaseline(logs, 1000).size === 0)
m("unsafe id not bound", () => policiesAfterBaseline([{ id: Number.MAX_SAFE_INTEGER + 1, remoteHost: "netflix.com", policyName: "bad" }], 10).size === 0)
const report: NetworkReport = { ...parsed, source: "device", domesticExit: { ip: "1.1.1.1", location: "保留", isp: "保留" },
  services: parsed.services.map(row => ({ ...row, policy: "旧服务策略" })),
  surge: { mode: "旧模式", node: "旧代理", policy: "旧组", protocol: "旧协议", note: "旧说明" } }
const groups = { "媒体组": [{ name: "未选首成员", typeDescription: "VMess" }, { name: "本轮节点", typeDescription: "Trojan" }], "AI 组": [{ name: "AI 节点", typeDescription: "AnyTLS" }] }
const merge = (outbound: unknown, recent: unknown = logs, baseline: number | null = 10, gs: unknown = groups) => applySurgeObservation(report, outbound, gs, recent, baseline)
const o = (name: string, test: () => boolean) => check("observation", name, test)
o("direct clears prior policy and protocol", () => { const r = merge({ mode: "direct" }); return r.surge?.node === "直连" && r.surge.policy === "" && r.surge.protocol === "" && !r.surge.note.includes("活跃节点") })
o("no members-first inference", () => merge({ mode: "rule" }, []).surge?.node === "")
o("no stale fallback", () => { const r = merge(null, null); return r.surge?.mode === "" && r.surge.node === "" && r.surge.policy === "" && r.surge.protocol === "" })
o("node from recent observed not list order", () => merge({ mode: "rule" }, logs.slice(0, 3)).surge?.node !== "未选首成员")
o("metadata protocol", () => { const r = merge({ mode: "rule" }, [logs[2]]); return r.surge?.node === "本轮节点" && r.surge.protocol === "Trojan" && r.surge.policy === "媒体组" })
o("node ties prefer latest ID", () => merge({ mode: "rule" }, [logs[2], logs[4]]).surge?.node === "AI 节点")
o("QUIC block not active node", () => merge({ mode: "rule" }, [logs[3]]).surge?.node === "")
o("membership alone not policy path", () => merge({ mode: "rule" }, [{ id: 11, policyName: "本轮节点" }]).surge?.policy === "")
o("no protocol from name", () => merge({ mode: "proxy" }, [{ id: 11, policyName: "JP-Trojan" }], 10, {}).surge?.protocol === "")
o("metadata conflicts unknown", () => merge({ mode: "rule" }, [logs[2]], 10, { a: [{ name: "本轮节点", type: "Trojan" }], b: [{ name: "本轮节点", type: "VMess" }] }).surge?.protocol === "")
o("new policy label", () => merge({ mode: "rule" }).services[0].policy === "同期同域日志 · 本轮节点")
o("no baseline clears old policy", () => merge({ mode: "rule" }, logs, null).services.every(row => row.policy === ""))
o("no matching request clears old policy", () => merge({ mode: "rule" }).services[1].policy === "")
o("remote report not bound to device logs", () => applySurgeObservation(parsed, { mode: "rule" }, groups, logs, 10).services[0].policy === "上游快照 · 媒体组")
o("reset explained", () => merge({ mode: "rule" }, logs, 1000).note.includes("编号已回退"))
o("errors explained", () => merge(null, null, null).note.includes("出站模式未取得") && merge(null, null, null).note.includes("缺少探测前"))
o("domesticExit preserved", () => merge({ mode: "direct" }).domesticExit?.location === "保留")
o("enrichment does not change probe state", () => merge({ mode: "direct" }).services[0].state === report.services[0].state && merge({ mode: "direct" }).services[0].status === report.services[0].status)
o("input immutable", () => report.surge?.policy === "旧组" && report.services[0].policy === "旧服务策略")
o("mode prototype keys unknown", () => merge({ mode: "constructor" }).surge?.mode === "")
o("raw URL omitted from displayed policy", () => !JSON.stringify(merge({ mode: "rule" }, [{ id: 11, remoteHost: "netflix.com", policyName: "https://secret.example/?x-key=testing" }])).includes("secret.example"))
const passed = Object.values(results).reduce((sum, group) => sum + group.passed, 0)
const failed = Object.values(results).reduce((sum, group) => sum + group.failures.length, 0)
console.log(JSON.stringify({ passed, failed, results, access: "pure only: no Storage, Keychain, fetch, or Surge API calls" }, null, 2))
Script.exit()
