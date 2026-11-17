import { Circle, HStack, Image, Link, Path, Rectangle, Script, Spacer, Text, VStack, Widget, ZStack, modifiers } from "scripting"
import type { Color, VirtualNode } from "scripting"
import { formatIPAddress, formatIPLocation } from "./utils/ip"
import { isFreshReport, latencyLabel, reportMatchesIP, SERVICES, serviceStateParts } from "./utils/network_model"
import type { NetworkReport, ServiceGroup, ServiceState } from "./utils/network_model"
import type { WidgetSnapshot } from "./utils/widget_sync"

export type WidgetMapImage = UIImage | { light: UIImage; dark: UIImage }
type WidgetSize = { width: number; height: number }
type NetworkSnapshot = Omit<WidgetSnapshot, "manual" | "network"> & { manual?: boolean; network?: NetworkReport | null }
interface NetworkWidgetProps {
  snapshot: NetworkSnapshot | null
  size: WidgetSize
  family?: string
  refreshMinutes?: number
  privacyMode?: boolean
  mapImage?: WidgetMapImage
  now?: number
}
interface WidgetNetworkState {
  report: NetworkReport | null
  status: "empty" | "manual" | "pending" | "ready"
  stale: boolean
  updatedAt: number
}

const C = {
  bg: { light: "#F3F7F7", dark: "#111A1E" },
  surface: { light: "#FFFFFF", dark: "#1C292D" },
  line: { light: "#DFE8E8", dark: "#354449" },
  text: { light: "#17262B", dark: "#F2F6F5" },
  sub: { light: "#5F7074", dark: "#ACC0BF" },
  teal: { light: "#087C73", dark: "#65D6C3" },
  blue: { light: "#357CB0", dark: "#80BCE3" },
  green: { light: "#277F56", dark: "#80D6A4" },
  amber: { light: "#AE6B22", dark: "#F0BE76" },
  red: { light: "#C64F58", dark: "#F49BA3" },
} as const

export function widgetNetworkState(snapshot: NetworkSnapshot | null, refreshMinutes = 15, now = Date.now()): WidgetNetworkState {
  if (!snapshot) return { report: null, status: "empty", stale: false, updatedAt: 0 }
  const ipStale = !Number.isFinite(snapshot.savedAt) || snapshot.savedAt <= 0 || snapshot.savedAt > now + 60_000
    || now - snapshot.savedAt >= refreshMinutes * 60_000
  if (snapshot.manual) return { report: null, status: "manual", stale: ipStale, updatedAt: snapshot.savedAt }
  const candidate = snapshot.network ?? null
  const report = reportMatchesIP(candidate, snapshot.ip) ? candidate : null
  return { report, status: report ? "ready" : "pending", stale: report ? !isFreshReport(report, refreshMinutes, now) : ipStale,
    updatedAt: report?.measuredAt ?? snapshot.savedAt }
}

/** 新鲜数据在过期时申请重绘，过期或无数据则按完整周期避免反复立即刷新。 */
export function widgetReloadDate(snapshot: NetworkSnapshot | null, refreshMinutes = 15, now = Date.now()): Date {
  const period = refreshMinutes * 60_000
  const state = widgetNetworkState(snapshot, refreshMinutes, now)
  const expiresAt = state.updatedAt + period
  return new Date(snapshot && !state.stale && expiresAt > now ? expiresAt : now + period)
}
function timestamp(value: number, now: number): string {
  if (!Number.isFinite(value) || value <= 0) return "时间未知"
  const date = new Date(value), current = new Date(now)
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
  return date.toDateString() === current.toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`
}
function pendingLabel(state: WidgetNetworkState): string {
  const label = state.status === "manual" ? "手动查询 · 诊断未运行" : state.status === "empty" ? "打开脚本检测" : "诊断待检测"
  return label + (state.stale ? " · 已过期" : "")
}
function widgetAddress(snapshot: NetworkSnapshot, privacy = true): string {
  const address = formatIPAddress(snapshot.ip, privacy)
  if (privacy || !address.includes(":")) return address
  const parts = address.split(":").map(part => part ? parseInt(part, 16).toString(16) : "")
  if (parts.length !== 8) return address
  let start = -1, length = 0
  for (let i = 0; i < parts.length;) {
    if (parts[i] !== "0") { i++; continue }
    const begin = i
    while (parts[i] === "0") i++
    if (i - begin > length) { start = begin; length = i - begin }
  }
  const compact = length > 1 ? `${parts.slice(0, start).join(":")}::${parts.slice(start + length).join(":")}` : parts.join(":")
  if (compact.length <= 24) return compact
  const midpoint = compact.length / 2
  const boundaries = [...compact].map((char, index) => char === ":" && compact[index + 1] !== ":" ? index : -1).filter(index => index >= 0)
  const split = boundaries.sort((a, b) => Math.abs(a - midpoint) - Math.abs(b - midpoint))[0]
  return split == null ? compact : compact.slice(0, split + 1) + "\n" + compact.slice(split + 1)
}
function identityLabel(snapshot: NetworkSnapshot): string {
  const asn = snapshot.as.trim()
  const organization = (snapshot.org || snapshot.isp).trim()
  if (!asn) return organization || "ASN 未知"
  if (!organization || asn.toLowerCase().includes(organization.toLowerCase())) return asn
  return `${asn} · ${organization}`
}
function flagLabel(snapshot: NetworkSnapshot): string {
  return snapshot.vpnStatus && !["未知", "未标记"].includes(snapshot.vpnStatus) ? snapshot.vpnStatus : ""
}
function riskTint(snapshot: NetworkSnapshot) {
  return snapshot.risk == null ? C.sub : snapshot.risk >= 70 ? C.red : snapshot.risk >= 40 ? C.amber : C.teal
}
function riskLabel(snapshot: NetworkSnapshot): string {
  const risk = snapshot.riskSource === "heuristic" ? null : snapshot.risk
  return risk == null ? "风险未知" : `${snapshot.riskSource === "IPPure" ? "IPPure " : ""}风险 ${risk}%`
}
function groupStates(report: NetworkReport | null, group: ServiceGroup) {
  return SERVICES.filter(service => service.group === group).map(service => {
    const result = report?.services.find(row => row.id === service.id && row.group === group)
    return { ...service, state: result?.state ?? "unknown" as ServiceState, regionCode: result?.regionCode ?? "" }
  })
}
function countLabel(report: NetworkReport, group: ServiceGroup): string {
  const total = SERVICES.filter(service => service.group === group).length
  return `${groupStates(report, group).filter(row => row.state === "reachable").length}/${total}`
}
function h3Label(report: NetworkReport | null): string {
  return !report || report.quic === "unknown" ? "H3 未知" : report.quic === "h3" ? "H3 已观测" : "未观测 H3"
}
function timeAndStatus(state: WidgetNetworkState, now: number): string {
  if (!state.report) return pendingLabel(state)
  return `${timestamp(state.updatedAt, now)}${state.stale ? " · 已过期" : " · 已检测"}`
}

export function NetworkWidgetSummary({ snapshot, refreshMinutes = 15, width, now = Date.now(), compact = false }: {
  snapshot: NetworkSnapshot | null; refreshMinutes?: number; width: number; now?: number; compact?: boolean
}): VirtualNode {
  const state = widgetNetworkState(snapshot, refreshMinutes, now)
  const report = state.report
  return <VStack alignment="leading" spacing={compact ? 1 : 2} frame={{ width, alignment: "leading" }}>
    <Text font={compact ? 8 : 9} foregroundStyle={C.teal} lineLimit={1} minScaleFactor={0.75}>
      {report ? `可用  媒体 ${countLabel(report, "media")}  ·  AI ${countLabel(report, "ai")}` : pendingLabel(state)}
    </Text>
    {report ? <Text font={compact ? 8 : 9} foregroundStyle={C.sub} lineLimit={1} minScaleFactor={0.7}>
      {`国内 ${latencyLabel(report.latency.domestic)}  ·  国际 ${latencyLabel(report.latency.overseas)}`}
    </Text> : null}
    <Text font={compact ? 7.5 : 8} foregroundStyle={state.stale ? C.amber : C.sub} lineLimit={1} minScaleFactor={0.75}>
      {report ? timeAndStatus(state, now) + (state.stale ? " · 打开更新" : "") : state.updatedAt ? `IP 更新 ${timestamp(state.updatedAt, now)}${state.stale ? " · 已过期" : ""}` : ""}
    </Text>
  </VStack>
}

const SYMBOLS: Record<string, string> = {
  netflix: "play.tv.fill", disney: "sparkles.tv", spotify: "waveform", tiktok: "music.note",
  youtube: "play.rectangle.fill", prime: "play.circle.fill", chatgpt: "circle.hexagongrid.fill",
  claude: "sun.max.fill", gemini: "sparkles", deepseek: "water.waves", grok: "xmark", perplexity: "magnifyingglass",
}
const logos: Record<string, UIImage | null> = {}
function BrandIcon({ id, size }: { id: string; size: number }): VirtualNode {
  if (!(id in logos)) {
    try { logos[id] = UIImage.fromFile(Path.join(Script.directory, "assets", "logos", `${id}.png`)) }
    catch { logos[id] = null }
  }
  return logos[id]
    ? <Image image={logos[id]!} resizable scaleToFit frame={{ width: size, height: size }} widgetAccentedRenderingMode="fullColor" />
    : <Image systemName={SYMBOLS[id] || "network"} font={size * 0.8} foregroundStyle={C.blue}
      frame={{ width: size, height: size }} widgetAccentedRenderingMode="fullColor" />
}
function stateAppearance(state: ServiceState) {
  switch (state) {
    case "reachable": return { color: C.green, icon: "checkmark.circle.fill" }
    case "restricted": return { color: C.amber, icon: "exclamationmark.circle.fill" }
    case "failed": return { color: C.red, icon: "xmark.circle.fill" }
    default: return { color: C.sub, icon: "questionmark.circle" }
  }
}
function MapTile({ image, width, height }: { image?: WidgetMapImage; width: number; height: number }): VirtualNode {
  const translucent = Widget.isTransparentMode || Widget.isBlurMode || Widget.isTransparentBackground
  return <ZStack frame={{ width, height }} clipShape={{ type: "rect", cornerRadius: 5 }}>
    {image ? <Image image={image} resizable scaleToFill frame={{ width, height }}
      opacity={translucent ? 0.55 : 1} widgetAccentedRenderingMode="fullColor" />
      : <Rectangle fill={C.bg} frame={{ width, height }} />}
    <Image systemName={image ? "mappin.circle.fill" : "map"} font={image ? 16 : 22}
      foregroundStyle={image ? C.red : C.blue} widgetAccentedRenderingMode="fullColor" />
  </ZStack>
}
function Divider({ height }: { height: number }) {
  return <Rectangle fill={C.line} frame={{ width: 1, height }} />
}
function Header({ state, now, width, compact = false }: { state: WidgetNetworkState; now: number; width: number; compact?: boolean }): VirtualNode {
  const local = state.report?.local
  const kind = local?.kind.replace(/\s*接口$/, "") || "未知接口"
  const families = local?.ipv4 && local.ipv6 ? "v4/v6" : local?.ipv4 ? "v4" : local?.ipv6 ? "v6" : ""
  const observed = [kind, families, local?.tunnel ? "隧道" : ""].filter(Boolean).join(" · ")
  const status = state.stale ? "上次检测 · 已过期" : state.report
    ? compact ? `${timestamp(state.updatedAt, now)} · ${kind}` : observed : pendingLabel(state)
  return <HStack spacing={5} frame={{ width, height: 23 }}>
    <Image systemName="waveform.path.ecg" font={16} foregroundStyle={C.teal} widgetAccentedRenderingMode="fullColor" />
    <Text font={14} fontWeight="bold" foregroundStyle={C.text}>Report ip</Text>
    <Spacer />
    <Circle fill={state.stale ? C.amber : state.report ? C.green : C.sub} frame={{ width: 5, height: 5 }} />
    <Text font={9} foregroundStyle={state.stale ? C.amber : C.sub} lineLimit={1} minScaleFactor={0.8}>
      {status}
    </Text>
  </HStack>
}
function IPPanel({ snapshot, image, width, height, privacyMode }: {
  snapshot: NetworkSnapshot; image?: WidgetMapImage; width: number; height: number; privacyMode: boolean
}): VirtualNode {
  const mapWidth = Math.min(108, Math.round(width * 0.33))
  const left = width - mapWidth - 24
  return <HStack spacing={8} padding={8} frame={{ width, height }}
    widgetBackground={{ style: C.surface, shape: { type: "rect", cornerRadius: 7 } }}>
    <VStack alignment="leading" spacing={3} frame={{ width: left, alignment: "leading" }}>
      <Text font={snapshot.ip.includes(":") ? 13 : 16} fontWeight="bold" fontDesign="monospaced" foregroundStyle={C.text} multilineTextAlignment="leading"
        lineLimit={snapshot.ip.includes(":") ? 2 : 1} minScaleFactor={0.57}>{widgetAddress(snapshot, privacyMode)}</Text>
      <Text font={10} foregroundStyle={C.text} lineLimit={1} minScaleFactor={0.75}>{formatIPLocation(snapshot)}</Text>
      <Text font={8.5} foregroundStyle={C.sub} lineLimit={1} minScaleFactor={0.7}>
        {identityLabel(snapshot)}</Text>
      <Text font={9} foregroundStyle={riskTint(snapshot)} lineLimit={1} minScaleFactor={0.7}>
        {[riskLabel(snapshot), snapshot.accessType, flagLabel(snapshot)].filter(Boolean).join(" · ")}</Text>
    </VStack>
    <MapTile image={image} width={mapWidth} height={height - 16} />
  </HStack>
}
function Metric({ label, value, tint, width }: { label: string; value: string; tint: Color | { light: Color; dark: Color }; width: number }): VirtualNode {
  return <VStack alignment="leading" spacing={2} frame={{ width, alignment: "leading" }}>
    <Text font={9} foregroundStyle={C.sub}>{label}</Text>
    <Text font={13} fontWeight="semibold" foregroundStyle={tint} lineLimit={1} minScaleFactor={0.75}>{value}</Text>
  </VStack>
}
function Metrics({ report, width }: { report: NetworkReport | null; width: number }): VirtualNode {
  const track = (width - 38) / 3
  return <HStack spacing={6} padding={{ horizontal: 6 }} frame={{ width, height: 44 }}>
    <Metric width={track} label="国内响应" value={latencyLabel(report?.latency.domestic)} tint={C.teal} />
    <Divider height={29} />
    <Metric width={track} label="国际响应" value={latencyLabel(report?.latency.overseas)} tint={C.blue} />
    <Divider height={29} />
    <Metric width={track} label="HTTP/3" value={report?.quic === "h3" ? "已观测" : report?.quic === "other" ? "未观测" : "未知"}
      tint={report?.quic === "h3" ? C.green : C.sub} />
  </HStack>
}
function ServiceColumn({ report, group, width, height }: { report: NetworkReport | null; group: ServiceGroup; width: number; height: number }): VirtualNode {
  const items = groupStates(report, group)
  const headerHeight = 19
  const rowHeight = Math.max(14, (height - headerHeight) / Math.max(1, SERVICES.filter(service => service.group === group).length))
  const iconSize = width > 190 ? 18 : 14
  return <VStack alignment="leading" spacing={0} frame={{ width, height, alignment: "topLeading" }}>
    <HStack spacing={3} frame={{ width, height: headerHeight }}>
      <Text font={10.5} fontWeight="semibold" foregroundStyle={C.text}>{group === "media" ? "流媒体" : "AI 服务"}</Text>
      <Spacer />
      <Text font={8.5} foregroundStyle={C.teal}>{report ? `${countLabel(report, group)} 可用` : "待检测"}</Text>
    </HStack>
    {items.map(item => {
      const appearance = stateAppearance(item.state)
      const state = serviceStateParts(item.state, item.regionCode)
      return <HStack key={item.id} spacing={5} frame={{ width, height: rowHeight, alignment: "leading" }}>
        <BrandIcon id={item.id} size={iconSize} />
        <Text font={width > 190 ? 11 : 9.5} fontWeight="medium" foregroundStyle={C.text}
          frame={{ maxWidth: "infinity", alignment: "leading" }} lineLimit={1} minScaleFactor={0.65}>{item.name}</Text>
        <Image systemName={appearance.icon} font={8} foregroundStyle={appearance.color} widgetAccentedRenderingMode="fullColor" />
        <HStack spacing={2}>
          <Text font={7.5} foregroundStyle={appearance.color} lineLimit={1} minScaleFactor={0.55}>{state.label}</Text>
          <Text font={7.5} fontDesign="monospaced" foregroundStyle={state.code ? C.blue : C.sub}
            frame={{ width: 16 }} lineLimit={1} minScaleFactor={0.8}>{state.code || "—"}</Text>
        </HStack>
      </HStack>
    })}
  </VStack>
}
function Services({ report, width, height }: { report: NetworkReport | null; width: number; height: number }): VirtualNode {
  const half = (width - 19) / 2
  return <HStack spacing={9} frame={{ width, height }}>
    <ServiceColumn report={report} group="media" width={half} height={height} />
    <Divider height={height - 4} />
    <ServiceColumn report={report} group="ai" width={half} height={height} />
  </HStack>
}
function Footer({ state, now, width }: { state: WidgetNetworkState; now: number; width: number }): VirtualNode {
  const surge = state.report?.surge
  const source = surge?.node ? `Surge · ${surge.node}${surge.protocol ? ` · ${surge.protocol}` : ""}`
    : state.report?.domesticExit?.isp ? `国内探针 · ${state.report.domesticExit.isp}`
    : state.report?.local.kind || ""
  return <HStack spacing={4} frame={{ width, height: 20 }}>
    <Text font={8} foregroundStyle={C.sub} lineLimit={1} minScaleFactor={0.7}
      frame={{ width: width * 0.58, alignment: "leading" }}>{source}</Text>
    <Spacer />
    <Text font={8} foregroundStyle={state.stale ? C.amber : C.sub} lineLimit={1} minScaleFactor={0.75}>
      {state.report ? `${timeAndStatus(state, now)} · 打开更新` : pendingLabel(state)}
    </Text>
  </HStack>
}
function LargeWidget(props: NetworkWidgetProps & { snapshot: NetworkSnapshot; state: WidgetNetworkState; now: number }): VirtualNode {
  const width = props.size.width - 24
  const contentHeight = props.size.height - 24
  const ipHeight = props.snapshot.ip.includes(":") ? 88 : 79
  const gap = props.size.height < 340 ? 4 : 6
  const servicesHeight = Math.max(85, contentHeight - 23 - ipHeight - 44 - 1 - 20 - gap * 5)
  return <VStack alignment="leading" spacing={gap} padding={12} frame={props.size}>
    <Header state={props.state} now={props.now} width={width} />
    <IPPanel snapshot={props.snapshot} image={props.mapImage} width={width} height={ipHeight} privacyMode={props.privacyMode ?? true} />
    <Metrics report={props.state.report} width={width} />
    <Rectangle fill={C.line} frame={{ width, height: 1 }} />
    <Services report={props.state.report} width={width} height={servicesHeight} />
    <Footer state={props.state} now={props.now} width={width} />
  </VStack>
}
function MediumWidget(props: NetworkWidgetProps & { snapshot: NetworkSnapshot; state: WidgetNetworkState; now: number }): VirtualNode {
  const width = props.size.width - 20, height = props.size.height - 20
  const infoWidth = Math.round(width * 0.57)
  const mapWidth = width - infoWidth - 8
  const report = props.state.report
  return <VStack alignment="leading" spacing={4} padding={10} frame={props.size}>
    <Header state={props.state} now={props.now} width={width} compact />
    <HStack spacing={8} frame={{ width, height: height - 56 }}>
      <VStack alignment="leading" spacing={2} frame={{ width: infoWidth, alignment: "leading" }}>
        <Text font={props.snapshot.ip.includes(":") ? 12 : 15} fontWeight="bold" fontDesign="monospaced" foregroundStyle={C.text} multilineTextAlignment="leading"
          lineLimit={props.snapshot.ip.includes(":") ? 2 : 1} minScaleFactor={0.55}>{widgetAddress(props.snapshot, props.privacyMode ?? true)}</Text>
        <Text font={9.5} foregroundStyle={C.sub} lineLimit={1} minScaleFactor={0.65}>{formatIPLocation(props.snapshot)}</Text>
        <Text font={8} foregroundStyle={C.sub} lineLimit={1} minScaleFactor={0.7}>
          {identityLabel(props.snapshot)}</Text>
        <Text font={9} foregroundStyle={riskTint(props.snapshot)} lineLimit={1} minScaleFactor={0.65}>
          {[riskLabel(props.snapshot), props.snapshot.accessType, flagLabel(props.snapshot)].filter(Boolean).join(" · ")}</Text>
        <Text font={8.5} foregroundStyle={C.sub} lineLimit={1} minScaleFactor={0.7}>
          {report ? `媒体 ${countLabel(report, "media")}  ·  AI ${countLabel(report, "ai")} 可用` : pendingLabel(props.state)}</Text>
      </VStack>
      <MapTile image={props.mapImage} width={mapWidth} height={height - 56} />
    </HStack>
    <Rectangle fill={C.line} frame={{ width, height: 1 }} />
    <HStack spacing={4} frame={{ width, height: 20 }}>
      <Text font={8.5} foregroundStyle={C.sub} lineLimit={1} minScaleFactor={0.65}>
        {report ? `国内 ${latencyLabel(report.latency.domestic)} · 国际 ${latencyLabel(report.latency.overseas)}` : "国内 — · 国际 —"}</Text>
      <Spacer />
      <Text font={8.5} foregroundStyle={props.state.stale ? C.amber : C.sub} lineLimit={1} minScaleFactor={0.65}>
        {props.state.stale ? "已过期 · 打开更新" : report ? h3Label(report) : "打开检测"}</Text>
    </HStack>
  </VStack>
}
function SmallWidget(props: NetworkWidgetProps & { snapshot: NetworkSnapshot; state: WidgetNetworkState; now: number }): VirtualNode {
  const width = props.size.width - 20
  const report = props.state.report
  const ipv6 = props.snapshot.ip.includes(":")
  return <VStack alignment="leading" spacing={3} padding={10} frame={props.size}>
    <HStack spacing={4} frame={{ width, height: 16 }}>
      <Image systemName="waveform.path.ecg" font={11} foregroundStyle={C.teal} widgetAccentedRenderingMode="fullColor" />
      <Text font={11} fontWeight="bold" foregroundStyle={C.text}>Report ip</Text>
      <Spacer />
      <Circle fill={props.state.stale ? C.amber : report ? C.green : C.sub} frame={{ width: 5, height: 5 }} />
    </HStack>
    <Text font={ipv6 ? 10.5 : 13} fontWeight="bold" fontDesign="monospaced" foregroundStyle={C.text} multilineTextAlignment="leading"
      lineLimit={ipv6 ? 2 : 1} minScaleFactor={0.56}>{widgetAddress(props.snapshot, props.privacyMode ?? true)}</Text>
    <HStack spacing={5} frame={{ width, height: ipv6 ? 40 : 48 }}>
      <VStack alignment="leading" spacing={3} frame={{ width: width - 55, alignment: "leading" }}>
        <Text font={9} foregroundStyle={C.sub} lineLimit={ipv6 ? 1 : 2} minScaleFactor={0.72}>
          {formatIPLocation(props.snapshot)}</Text>
        <Text font={8} foregroundStyle={riskTint(props.snapshot)} lineLimit={2} minScaleFactor={0.65}>
          {[riskLabel(props.snapshot), props.snapshot.accessType, flagLabel(props.snapshot)].filter(Boolean).join(" · ")}</Text>
      </VStack>
      <MapTile image={props.mapImage} width={50} height={ipv6 ? 40 : 46} />
    </HStack>
    <Rectangle fill={C.line} frame={{ width, height: 1 }} />
    <Text font={8.5} foregroundStyle={C.text} lineLimit={1} minScaleFactor={0.75}>
      {report ? `可用  媒体 ${countLabel(report, "media")} · AI ${countLabel(report, "ai")}` : pendingLabel(props.state)}</Text>
    <Text font={8} foregroundStyle={C.sub} lineLimit={1} minScaleFactor={0.7}>
      {report ? `国内 ${latencyLabel(report.latency.domestic)} · 国际 ${latencyLabel(report.latency.overseas)}` : "国内 — · 国际 —"}</Text>
    <Text font={7.5} foregroundStyle={props.state.stale ? C.amber : C.sub} lineLimit={1} minScaleFactor={0.7}>
      {report ? `${timeAndStatus(props.state, props.now)} · 打开更新` : props.state.stale ? "已过期 · 打开更新" : "打开更新"}</Text>
  </VStack>
}

export function NetworkWidget(props: NetworkWidgetProps): VirtualNode {
  const now = props.now ?? Date.now()
  const family = props.family ?? "systemLarge"
  const state = widgetNetworkState(props.snapshot, props.refreshMinutes, now)
  return <Link url={Script.createRunURLScheme(Script.name)} multilineTextAlignment="leading"
    modifiers={modifiers().widgetBackground(C.bg).ignoresSafeArea().frame({ maxWidth: "infinity", maxHeight: "infinity" })}>
    {!props.snapshot ? <VStack alignment="center" spacing={7} frame={props.size}>
      <Image systemName="network" font={24} foregroundStyle={C.teal} widgetAccentedRenderingMode="fullColor" />
      <Text font={13} fontWeight="semibold" foregroundStyle={C.text}>暂无 IP 检测结果</Text>
      <Text font={10} foregroundStyle={C.sub}>点击运行 Report ip</Text>
    </VStack> : family === "systemLarge" || family === "systemExtraLarge"
      ? <LargeWidget {...props} snapshot={props.snapshot} state={state} now={now} />
      : family === "systemMedium" ? <MediumWidget {...props} snapshot={props.snapshot} state={state} now={now} />
      : <SmallWidget {...props} snapshot={props.snapshot} state={state} now={now} />}
  </Link>
}
export default NetworkWidget
