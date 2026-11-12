import {
  Link,
  Script,
  Capsule,
  Circle,
  HStack,
  Image,
  Rectangle,
  Spacer,
  Text,
  VStack,
  VirtualNode,
  Widget,
  ZStack,
  modifiers,
} from "scripting"
import {
  formatIPAddress,
  formatIPLocation,
  getPrivacyMode,
  IPInfo,
} from "./utils/ip"
import { hasCoordinates, takeIPMapSnapshot } from "./utils/map"
import { withTimeout } from "./utils/geo"
import { readWidgetSnapshot } from "./utils/widget_sync"
import type { WidgetRiskSource, WidgetSnapshot } from "./utils/widget_sync"
import { getNetworkSettings } from "./utils/network_settings"
import { NetworkWidget, NetworkWidgetSummary } from "./network_widget"
import type { WidgetMapImage } from "./network_widget"

export interface WidgetProps {
  snapshot: WidgetSnapshot | null
  refreshMinutes: number
  privacyMode: boolean
  ipInfo: IPInfo | null
  riskValue: number | null
  riskSource: WidgetRiskSource
  accessType: string
  vpnStatus: string
  widgetSize: { width: number; height: number }
  mapImage?: WidgetMapImage
  mapSize?: { width: number; height: number }
}

function riskText(value: number | null, source: WidgetRiskSource): string {
  if (value == null || source === "heuristic") return "风险 —"
  const prefix = source === "IPPure" ? "IPPure 风险" : "风险"
  return `${prefix} ${value}%`
}

type Layout = {
  dashboard: boolean
  medium: boolean
  large: boolean
  padding: number
  contentWidth: number
  leftWidth: number
  gaugeWidth: number
}

const COLORS = {
  green: { light: "#248A3D", dark: "#30D158" },
  green2: { light: "#34C759", dark: "#63D471" },
  lime: { light: "#7CB342", dark: "#B7E36D" },
  yellow: { light: "#C99A00", dark: "#FFD60A" },
  orange: { light: "#C93400", dark: "#FF9F0A" },
  red: { light: "#D70015", dark: "#FF453A" },
  white: { light: "#000000", dark: "#FFFFFF" },
  secondary: { light: "#3A3A3C", dark: "#D1D1D6" },
  background: { light: "#FFFFFF", dark: "#000000" },
  status: { light: "#8E1645", dark: "#FF9FC1" },
  title: { light: "#0B5D1E", dark: "#7CFF8A" },
  marker: { light: "#000000", dark: "#FFFFFF" },
} as const

function layoutMetrics(family: string | undefined, size: { width: number; height: number }): Layout {
  const medium = family === "systemMedium"
  const large = family === "systemLarge" || family === "systemExtraLarge"
  const dashboard = medium || large
  const padding = large ? 16 : 12
  const contentWidth = Math.max(130, size.width - padding * 2)
  const leftWidth = medium
    ? Math.round(contentWidth * 0.62)
    : large
      ? Math.round(contentWidth * 0.64)
      : contentWidth

  return {
    dashboard,
    medium,
    large,
    padding,
    contentWidth,
    leftWidth,
    gaugeWidth: Math.max(116, leftWidth - 2),
  }
}
function DataRow({
  icon,
  label,
  value,
  width,
  compact = false,
  valueColor = COLORS.white,
}: {
  icon: string
  label?: string
  value: string
  width: number
  compact?: boolean
  valueColor?: (typeof COLORS)[keyof typeof COLORS]
}) {
  return (
    <HStack spacing={compact ? 5 : 6} alignment="center" frame={{ width }}>
      <Image
        systemName={icon}
        font={compact ? 10 : 12}
        foregroundStyle={COLORS.secondary}
        frame={{ width: compact ? 13 : 16 }}
      />
      {label ? <Text font={compact ? 9 : 10} foregroundStyle={COLORS.secondary}>{label}</Text> : null}
      <Text
        font={compact ? 11 : 12}
        fontWeight="semibold"
        foregroundStyle={valueColor}
        lineLimit={1}
        minScaleFactor={0.64}
        frame={{ maxWidth: "infinity", alignment: "leading" }}
      >
        {value}
      </Text>
    </HStack>
  )
}

function RiskGauge({
  value,
  width,
  compact = false,
  showScale = false,
}: {
  value: number
  width: number
  compact?: boolean
  showScale?: boolean
}) {
  const barHeight = compact ? 5 : 6
  const markerSize = compact ? 8 : 9
  const markerX = Math.max(markerSize / 2, Math.min(width - markerSize / 2, width * value / 100))
  const colors = [COLORS.green, COLORS.green2, COLORS.lime, COLORS.yellow, COLORS.orange, COLORS.red]

  return (
    <VStack alignment="leading" spacing={1} frame={{ width }} offset={{ x: 0, y: 6 }}>
      <ZStack alignment="topLeading" frame={{ width, height: compact ? 15 : 17 }}>
        <Capsule
          fill={{
            light: {
              gradient: [
                { color: "#248A3D", location: 0.00 },
                { color: "#34C759", location: 0.18 },
                { color: "#7CB342", location: 0.34 },
                { color: "#C99A00", location: 0.50 },
                { color: "#C93400", location: 0.68 },
                { color: "#D70015", location: 1.00 },
              ],
              startPoint: { x: 0, y: 0.5 },
              endPoint: { x: 1, y: 0.5 },
            },
            dark: {
              gradient: [
                { color: "#30D158", location: 0.00 },
                { color: "#63D471", location: 0.18 },
                { color: "#B7E36D", location: 0.34 },
                { color: "#FFD60A", location: 0.50 },
                { color: "#FF9F0A", location: 0.68 },
                { color: "#FF453A", location: 1.00 },
              ],
              startPoint: { x: 0, y: 0.5 },
              endPoint: { x: 1, y: 0.5 },
            },
          }}
          frame={{ width, height: barHeight }}
          position={{ x: width / 2, y: barHeight / 2 }}
        />
        <Circle
          fill={COLORS.marker}
          frame={{ width: markerSize, height: markerSize }}
          position={{ x: markerX, y: barHeight / 2 }}
        />
      </ZStack>
      {showScale ? (
        <HStack frame={{ width }}>
          {[0, 15, 25, 40, 50, 70, 100].map((n, index) => (
            <HStack key={n}>
              <Text font={7} foregroundStyle={colors[Math.min(index, colors.length - 1)]}>{n}</Text>
              {index < 6 ? <Spacer /> : null}
            </HStack>
          ))}
        </HStack>
      ) : null}
    </VStack>
  )
}

function widgetRootModifiers() {
  // widgetBackground automatically respects transparent, blur and tinted modes.
  return modifiers().widgetBackground(COLORS.background)
    .ignoresSafeArea()
    .frame({ maxWidth: "infinity", maxHeight: "infinity" })
}

function usesRadarLayout(): boolean {
  const parameter = (Widget.parameter ?? "").trim().toLowerCase()
  return parameter !== "map"
}

function FullMapBackground(props: WidgetProps) {
  const size = props.widgetSize
  const isLarge = Widget.family === "systemLarge" || Widget.family === "systemExtraLarge"
  const isSmall = Widget.family === "systemSmall"
  const hasMap = !!props.mapImage && !!props.mapSize
  // 定位图标始终固定在地图中心；地图中心与组件坐标 (3/4, 1/2) 重合。
  const mapCenter = {
    x: size.width * 0.75,
    y: size.height * 0.50,
  }
  const pin = hasMap ? mapCenter : null
  const revealStart = isLarge ? 0.48 : isSmall ? 0.62 : 0.43
  const revealMid = isLarge ? 0.61 : isSmall ? 0.77 : 0.58
  const revealEnd = isLarge ? 0.80 : isSmall ? 0.92 : 0.76

  return (
    <ZStack alignment="topLeading" frame={size}>
      {hasMap ? (
        <ZStack frame={size} modifiers={modifiers().mask(
          <Rectangle fill={{
            gradient: [
              { color: "rgba(255,255,255,0.00)", location: 0 },
              { color: "rgba(255,255,255,0.01)", location: Math.max(0, revealStart - 0.14) },
              { color: "rgba(255,255,255,0.08)", location: revealStart },
              { color: "rgba(255,255,255,0.38)", location: revealMid },
              { color: "rgba(255,255,255,0.82)", location: revealEnd },
              { color: "rgba(255,255,255,1.00)", location: 1 },
            ],
            startPoint: { x: 0, y: 0.5 },
            endPoint: { x: 1, y: 0.5 },
          }} frame={size} />
        )}>
          <Image
            image={props.mapImage!}
            widgetAccentedRenderingMode="fullColor"
            resizable
            scaleToFill
            frame={size}
            position={mapCenter}
          />
        </ZStack>
      ) : null}

      {pin ? (
        <Image
          systemName="mappin.circle.fill"
          font={isSmall ? 14 : size.height < 200 ? 17 : 20}
          foregroundStyle={COLORS.red}
          widgetAccentedRenderingMode="fullColor"
          position={{ x: pin.x, y: pin.y }}
        />
      ) : null}
    </ZStack>
  )
}
function DashboardWidget(props: WidgetProps & { layout: Layout }): VirtualNode {
  const info = props.ipInfo!
  const layout = props.layout
  const location = formatIPLocation(info)
  const displayIP = formatIPAddress(info.query, props.privacyMode)
  const asn = info.as || info.org || info.isp || "未知 ASN"
  const accessType = props.accessType || "暂无分类"
  const risk = riskText(props.riskValue, props.riskSource)
  const status = layout.medium
    ? `${accessType} · ${risk}`
    : `${props.vpnStatus} · ${accessType} · ${risk}`

  if (layout.large) {
    const contentHeight = Math.max(210, props.widgetSize.height - layout.padding * 2)
    return (
      <Link
        url={Script.createRunURLScheme(Script.name)}
        buttonStyle="plain"
        modifiers={widgetRootModifiers()}
      >
        <ZStack alignment="topLeading" frame={props.widgetSize}>
          <FullMapBackground {...props} />
          <VStack
            alignment="leading"
            spacing={0}
            frame={{ width: layout.leftWidth, height: contentHeight }}
            position={{
              x: layout.padding + layout.leftWidth / 2,
              y: props.widgetSize.height / 2,
            }}
          >
            <Text font={16} fontWeight="semibold" foregroundStyle={COLORS.title}>
              IP信息概览
            </Text>
            <Spacer />
            <VStack alignment="leading" spacing={10}>
              <DataRow icon="mappin.and.ellipse" label="位置" value={location} width={layout.leftWidth} />
              <DataRow icon="network" label="IP" value={displayIP} width={layout.leftWidth} />
              <DataRow icon="building.2" label="ASN" value={asn} width={layout.leftWidth} />
              <DataRow icon="antenna.radiowaves.left.and.right" label="ISP" value={info.isp || "未知网络"} width={layout.leftWidth} />
            </VStack>
            <Spacer />
            {props.riskValue != null && props.riskValue > 0
              ? <RiskGauge showScale value={props.riskValue} width={layout.gaugeWidth} /> : null}
            <Spacer />
            <DataRow
              icon="shield.lefthalf.filled"
              value={status}
              valueColor={COLORS.status}
              width={layout.leftWidth}
            />
            <Spacer />
            <NetworkWidgetSummary snapshot={props.snapshot} refreshMinutes={props.refreshMinutes} width={layout.leftWidth} />
          </VStack>
        </ZStack>
      </Link>
    )
  }

  return (
    <Link
      url={Script.createRunURLScheme(Script.name)}
      buttonStyle="plain"
      modifiers={widgetRootModifiers()}
    >
      <ZStack alignment="topLeading" frame={props.widgetSize}>
        <FullMapBackground {...props} />

        <VStack
          alignment="leading"
          spacing={3}
          frame={{ width: layout.leftWidth }}
          position={{
            x: layout.padding + layout.leftWidth / 2,
            y: props.widgetSize.height / 2,
          }}
        >
          <Text
            font={14}
            fontWeight="semibold"
            foregroundStyle={COLORS.title}
            offset={{ x: 0, y: -2 }}
          >
            IP信息概览
          </Text>
          <DataRow compact icon="mappin.and.ellipse" label="位置" value={location} width={layout.leftWidth} />
          <DataRow compact icon="network" label="IP" value={displayIP} width={layout.leftWidth} />
          <DataRow compact icon="building.2" label="ASN" value={asn} width={layout.leftWidth} />
          {props.riskValue != null && props.riskValue > 0
            ? <RiskGauge compact value={props.riskValue} width={layout.gaugeWidth} /> : null}
          <DataRow
            compact
            icon="shield.lefthalf.filled"
            value={status}
            valueColor={COLORS.status}
            width={layout.leftWidth}
          />
          <NetworkWidgetSummary snapshot={props.snapshot} refreshMinutes={props.refreshMinutes} width={layout.leftWidth} compact />
        </VStack>
      </ZStack>
    </Link>
  )
}

function CompactWidget(props: WidgetProps & { layout: Layout }): VirtualNode {
  const info = props.ipInfo!
  const location = formatIPLocation(info)
  const displayIP = formatIPAddress(info.query, props.privacyMode)
  const accessType = props.accessType || "暂无分类"
  const risk = riskText(props.riskValue, props.riskSource)
  const height = Math.max(118, props.widgetSize.height - 24)

  return (
    <Link
      url={Script.createRunURLScheme(Script.name)}
      buttonStyle="plain"
      modifiers={widgetRootModifiers()}
    >
      <ZStack alignment="topLeading" frame={props.widgetSize}>
        <FullMapBackground {...props} />
        <VStack
          alignment="leading"
          spacing={0}
          frame={{ width: props.layout.contentWidth, height }}
          position={{ x: props.widgetSize.width / 2, y: props.widgetSize.height / 2 }}
        >
        <Text font={14} fontWeight="semibold" foregroundStyle={COLORS.title}>IP信息概览</Text>
        <Spacer />
        <DataRow compact icon="mappin.and.ellipse" value={location} width={props.layout.leftWidth} />
        <Spacer />
        <DataRow compact icon="network" value={displayIP} width={props.layout.leftWidth} />
        <Spacer />
        {props.riskValue != null && props.riskValue > 0
          ? <RiskGauge compact value={props.riskValue} width={props.layout.gaugeWidth} /> : null}
        <Spacer />
          <DataRow
            compact
            icon="shield.lefthalf.filled"
            value={`${accessType} · ${risk}`}
            valueColor={COLORS.status}
            width={props.layout.leftWidth}
          />
          <Spacer minLength={2} />
          <NetworkWidgetSummary snapshot={props.snapshot} refreshMinutes={props.refreshMinutes} width={props.layout.leftWidth} compact />
        </VStack>
      </ZStack>
    </Link>
  )
}

function EmptyWidget({ message }: { message: string }) {
  return (
    <Link url={Script.createRunURLScheme(Script.name)} buttonStyle="plain" modifiers={widgetRootModifiers()}>
      <VStack alignment="center" spacing={8} padding={12}>
        <Image systemName="network" font={24} foregroundStyle={COLORS.secondary} widgetAccentedRenderingMode="fullColor" />
        <Text font={12} foregroundStyle={COLORS.secondary}>{message}</Text>
        <Text font={10} foregroundStyle={COLORS.secondary}>打开脚本检测 IP 与网络</Text>
      </VStack>
    </Link>
  )
}

function WidgetView(props: WidgetProps): VirtualNode {
  if (usesRadarLayout()) return <NetworkWidget
    snapshot={props.snapshot}
    family={Widget.family}
    size={props.widgetSize}
    mapImage={props.mapImage}
    privacyMode={props.privacyMode}
    refreshMinutes={props.refreshMinutes}
  />
  if (!props.ipInfo) return <EmptyWidget message="还没有共享检测结果" />
  const layout = layoutMetrics(Widget.family, props.widgetSize)
  return layout.dashboard
    ? <DashboardWidget {...props} layout={layout} />
    : <CompactWidget {...props} layout={layout} />
}

function ipInfoFromSnapshot(snapshot: WidgetSnapshot): IPInfo {
  return {
    query: snapshot.ip,
    status: "success",
    country: snapshot.country,
    countryCode: snapshot.countryCode,
    regionName: snapshot.regionName,
    city: snapshot.city,
    isp: snapshot.isp,
    org: snapshot.org,
    as: snapshot.as,
    lat: snapshot.lat ?? NaN,
    lon: snapshot.lon ?? NaN,
  }
}

export async function getWidgetProps(): Promise<WidgetProps> {
  const widgetSize = Widget.displaySize ?? { width: 338, height: 354 }
  const layout = layoutMetrics(Widget.family, widgetSize)
  const snapshot = readWidgetSnapshot()
  const { refreshMinutes } = getNetworkSettings()
  const privacyMode = getPrivacyMode()
  // No snapshot means no independent exit/reputation probes. The App owns each detection round.
  const ipInfo = snapshot ? ipInfoFromSnapshot(snapshot) : null
  const riskValue = snapshot?.riskSource === "heuristic" ? null : snapshot?.risk ?? null
  const riskSource = riskValue == null ? null : snapshot?.riskSource ?? null
  const accessType = snapshot?.accessType || "暂无分类"
  const vpnStatus = snapshot?.vpnStatus || "未知"
  let mapImage: WidgetMapImage | undefined
  let mapSize: { width: number; height: number } | undefined
  const radar = usesRadarLayout()
  const needsMap = radar || layout.dashboard || Widget.family === "systemSmall"

  if (needsMap && hasCoordinates(ipInfo)) {
    const snapshotOptions = {
      lat: ipInfo.lat,
      lon: ipInfo.lon,
      width: radar ? layout.large ? Math.min(108, Math.round((widgetSize.width - 24) * 0.33))
        : Widget.family === "systemMedium" ? Math.round((widgetSize.width - 20) * 0.43) - 8 : 50 : widgetSize.width,
      height: radar ? layout.large ? 63 : Widget.family === "systemMedium" ? widgetSize.height - 76 : 46 : widgetSize.height,
      family: Widget.family,
    }
    const [lightSnap, darkSnap] = await Promise.all([
      withTimeout(() => takeIPMapSnapshot({ ...snapshotOptions, appearance: "light" }), 6000).catch(() => null),
      withTimeout(() => takeIPMapSnapshot({ ...snapshotOptions, appearance: "dark" }), 6000).catch(() => null),
    ])
    const referenceSnap = lightSnap ?? darkSnap
    if (referenceSnap && lightSnap && darkSnap) {
      mapImage = { light: lightSnap.image, dark: darkSnap.image }
      mapSize = referenceSnap.size
    } else if (referenceSnap) {
      mapImage = referenceSnap.image
      mapSize = referenceSnap.size
    }
  }

  return {
    snapshot,
    refreshMinutes,
    privacyMode,
    ipInfo,
    riskValue,
    riskSource,
    accessType,
    vpnStatus,
    widgetSize,
    mapImage,
    mapSize,
  }
}

export async function renderIPWidget() {
  return <WidgetView {...await getWidgetProps()} />
}

async function presentIPWidget() {
  try {
    const props = await getWidgetProps()
    Widget.present(<WidgetView {...props} />, {
      policy: "after",
      date: new Date(Date.now() + props.refreshMinutes * 60_000),
    })
  } catch (error) {
    console.error("[IP检测] 小组件渲染失败", error)
    try { Widget.present(<EmptyWidget message="IP 数据暂不可用" />, {
      policy: "after", date: new Date(Date.now() + 15 * 60_000),
    }) }
    catch (fallbackError) { console.error("[IP检测] 无法呈现错误视图", fallbackError) }
  }
}
void presentIPWidget()
