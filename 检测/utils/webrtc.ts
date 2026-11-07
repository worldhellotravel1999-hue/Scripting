import { canonicalAddress, isPublicExitAddress } from "./ip"
import { sameIP, withTimeout } from "./geo"
import type { ExitObservation } from "./geo"

export type CandidateType = "host" | "srflx" | "prflx" | "relay"
export interface RTCCandidate {
  address: string
  type: CandidateType
  protocol: string
  scope: "public" | "local" | "mdns"
}
export interface WebRTCReport {
  status: "complete" | "timeout" | "unsupported" | "error" | "cancelled"
  candidates: RTCCandidate[]
  errors: number[]
  note: string
}
export interface WebRTCAssessment {
  label: string
  tone: "neutral" | "ok" | "warning"
  note: string
}

// 自有空白页面，无远程网页脚本；仅向公共 STUN 服务发送地址探测。
const PROBE_HTML = "<!doctype html><html><head><meta charset='utf-8'></head><body></body></html>"
const COLLECT_ICE = String.raw`
  const Peer = window.RTCPeerConnection || window.webkitRTCPeerConnection;
  if (!Peer) return JSON.stringify({ status: 'unsupported', candidates: [], errors: [], note: '当前 WebView 未提供 WebRTC 接口。' });
  if (!window.isSecureContext) return JSON.stringify({ status: 'error', candidates: [], errors: [], note: 'WebRTC 需要安全浏览器上下文。' });
  const candidates = [], errors = [];
  let pc, channel, timer, finish;
  let status = 'timeout';
  const finished = new Promise(resolve => { finish = resolve; });
  timer = setTimeout(() => finish(), 6500);
  function add(candidate) {
    if (candidate && typeof candidate.candidate === 'string') candidates.push(candidate.candidate);
  }
  try {
    pc = new Peer({
      iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }],
      iceTransportPolicy: 'all', iceCandidatePoolSize: 0,
    });
    pc.onicecandidate = event => {
      if (event.candidate) add(event.candidate);
      else { status = 'complete'; finish(); }
    };
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') { status = 'complete'; finish(); }
    };
    pc.onicecandidateerror = event => {
      if (Number.isFinite(event.errorCode)) errors.push(event.errorCode);
    };
    // 只创建数据通道，不请求麦克风或摄像头，也不连接远端 Peer。
    channel = pc.createDataChannel('ip-check');
    Promise.resolve().then(async () => {
      await pc.setLocalDescription(await pc.createOffer());
    }).catch(() => { status = 'error'; finish(); });
    await finished;
    // 某些 WebKit 版本只在 SDP 中提供部分候选；不把 c= 或 raddr 当候选。
    for (const line of (pc.localDescription?.sdp || '').split(/\r?\n/)) {
      if (line.startsWith('a=candidate:')) candidates.push(line.slice(2));
    }
    return JSON.stringify({ status, candidates, errors });
  } catch (_) {
    return JSON.stringify({ status: 'error', candidates, errors });
  } finally {
    clearTimeout(timer);
    if (pc) {
      pc.onicecandidate = null;
      pc.onicegatheringstatechange = null;
      pc.onicecandidateerror = null;
    }
    try { if (channel) channel.close(); } catch (_) {}
    try { if (pc) pc.close(); } catch (_) {}
  }
`

/** 候选地址归一化；IPv4-mapped IPv6 与其 IPv4 表示视为同一地址。 */
export function normalizeRTCAddress(value: string): string | null {
  let ip = value.trim().toLowerCase()
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1)
  return canonicalAddress(ip)
}

export function rtcAddressScope(address: string): RTCCandidate["scope"] | null {
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.local$/i.test(address)) return "mdns"
  const ip = normalizeRTCAddress(address)
  if (!ip) return null
  return isPublicExitAddress(ip) ? "public" : "local"
}

export function parseWebRTC(raw: unknown): WebRTCReport {
  const data = raw as { status?: unknown; candidates?: unknown; errors?: unknown; note?: unknown } | null
  const status = data?.status
  const valid = status === "complete" || status === "timeout" || status === "unsupported" || status === "error"
  const result: WebRTCReport = {
    status: valid ? status : "error", candidates: [], errors: [],
    note: typeof data?.note === "string" ? data.note : "",
  }
  if (Array.isArray(data?.errors)) result.errors = [...new Set<number>(data.errors.filter(
    (code): code is number => typeof code === "number" && Number.isFinite(code)))].slice(0, 8)
  if (!Array.isArray(data?.candidates)) return result
  for (const line of data.candidates) {
    if (typeof line !== "string") continue
    const fields = line.trim().replace(/^a=/, "").split(/\s+/)
    const typeIndex = fields.indexOf("typ", 6)
    // RFC 8445: fields[4] 是主 connection-address；raddr 只代表关联地址，不能混入主候选。
    if (!fields[0]?.startsWith("candidate:") || typeIndex < 6) continue
    const type = fields[typeIndex + 1]
    if (type !== "host" && type !== "srflx" && type !== "prflx" && type !== "relay") continue
    const original = fields[4]?.toLowerCase() || ""
    const scope = rtcAddressScope(original)
    if (!scope) continue
    const address = scope === "mdns" ? original : normalizeRTCAddress(original)!
    const protocol = fields[2]?.toLowerCase()
    if (protocol !== "udp" && protocol !== "tcp") continue
    if (!result.candidates.some(c => c.address === address && c.type === type && c.protocol === protocol)) {
      result.candidates.push({ address, type, protocol, scope })
    }
  }
  return result
}

export async function fetchWebRTC(isCurrent = () => true): Promise<WebRTCReport> {
  const empty = (status: WebRTCReport["status"], note = ""): WebRTCReport => ({ status, candidates: [], errors: [], note })
  if (!isCurrent()) return empty("cancelled")
  let web: WebViewController | null = null
  let cancellation: ReturnType<typeof setInterval> | undefined
  try {
    web = new WebViewController({ ephemeral: true, settings: { inactiveSchedulingPolicy: "none" } })
    const controller = web
    cancellation = setInterval(() => {
      try { if (!isCurrent() && !controller.isDisposed) controller.dispose() } catch { /* 请求已结束 */ }
    }, 150)
    const loaded = await withTimeout(web.loadHTML(PROBE_HTML, "https://webrtc.scripting.invalid/"), 3000)
    if (!isCurrent()) return empty("cancelled")
    if (!loaded) return empty("error", "浏览器检测页面加载失败，请重新检测。")
    const raw = await withTimeout(web.callAsyncJavaScript<string>(COLLECT_ICE), 8000)
    return isCurrent() ? parseWebRTC(JSON.parse(raw)) : empty("cancelled")
  } catch (error) {
    if (!isCurrent()) return empty("cancelled")
    const timedOut = /超时|timeout/i.test(String(error))
    return empty(timedOut ? "timeout" : "error", timedOut ? "WebRTC 检测超时，请重试。" : "浏览器检测失败，请重新检测。")
  } finally {
    if (cancellation !== undefined) clearInterval(cancellation)
    try { web?.dispose() } catch { /* 已释放 */ }
  }
}

export function assessWebRTC(report: WebRTCReport | null, exits: ExitObservation[], loading = false, manual = false): WebRTCAssessment {
  const result = (label: string, tone: WebRTCAssessment["tone"], note: string) => ({ label, tone, note })
  if (manual) return result("不适用", "neutral", "WebRTC 检测本设备的网络；手动 IP 查询不执行设备检测。")
  if (loading) return result("检测中", "neutral", "正在通过浏览器采集 WebRTC 地址…")
  if (!report || report.status === "error") return result("检测失败", "warning", report?.note || "WebRTC 本次未能完成，请重新检测。")
  if (report.status === "unsupported") return result("环境不支持", "neutral", "当前浏览器未提供 WebRTC 接口，无法判断是否泄露。")
  if (report.status === "cancelled") return result("已取消", "neutral", "本次检测已取消。")
  const publicCandidates = report.candidates.filter(c => c.scope === "public" && c.type !== "relay")
  const partial = report.status === "timeout" ? "采集超时，结果不完整。" : report.errors.length ? "部分 STUN 请求失败。" : ""
  if (!publicCandidates.length) {
    const hidden = report.candidates.some(c => c.scope === "mdns")
    const local = report.candidates.some(c => c.scope === "local")
    if (report.status === "timeout") return result("检测超时", "warning", report.note || "未取得公网候选，不能据此判定无泄露。")
    return result("未获得公网候选", "neutral", (hidden ? "本地地址已由 mDNS 隐藏。" : local ? "仅取得本地或保留地址。" : "浏览器未返回可用公网地址。")
      + "可能受浏览器策略或 STUN 连通性影响，不能据此判定无泄露。")
  }
  const normalized = exits.map(e => ({ ...e, address: normalizeRTCAddress(e.ip) })).filter(e => e.address)
  const withoutReference = publicCandidates.filter(c => !normalized.some(e => e.address!.includes(":") === c.address.includes(":")))
  const different = publicCandidates.filter(c => !withoutReference.includes(c)
    && !normalized.some(e => sameIP(e.address!, c.address)))
  if (different.length) return result("存在不同公网地址", "warning", partial + "WebRTC 出现 HTTP 出口之外的同协议公网地址，存在泄露可能；也可能与分流或多出口有关。")
  const primary = normalized[0]
  const differsFromPrimary = primary && publicCandidates.some(c => c.address.includes(":") === primary.address!.includes(":")
    && !sameIP(c.address, primary.address!))
  if (differsFromPrimary) return result("与主出口不同", "warning", partial + `WebRTC 地址与 ${primary.source} 不同，但与其他 HTTP 出口一致；请结合分流规则核对。`)
  if (withoutReference.length) return result("缺少同协议对照", "neutral", partial + "已获得公网候选，但缺少对应 IPv4 / IPv6 的 HTTP 出口，暂无法判断。")
  if (report.status === "timeout" || report.errors.length) return result("已采集·结果不完整", "neutral", partial + "已取得的公网候选与 HTTP 出口一致；未覆盖的路径仍无法判断。")
  return result("与已观测出口一致", "ok", "本次 WebRTC 公网地址与已观测 HTTP 出口一致，未发现额外公网地址。结果仅代表当前内嵌浏览器和网络。")
}
