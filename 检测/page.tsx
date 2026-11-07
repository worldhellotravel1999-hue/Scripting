import {
  Button, Capsule, Circle, GeometryReader, HStack, Image, Map, MapCircle, MapCompass, MapScaleView,
  Marker, Navigation, NavigationStack, ProgressView, Rectangle, ScrollView, Spacer, Text, TextField,
  VStack, Widget, ZStack, gradient, modifiers, useEffect, useObservable, useRef, useState,
} from "scripting"
import type { Color } from "scripting"
import { fetchExitProbe, formatIPAddress, formatIPLocation, getPrivacyMode, setPrivacyMode } from "./utils/ip"
import { approximateRadiusMeters, hasCoordinates } from "./utils/map"
import { lookupAddress, validIPAddress } from "./utils/lookup"
import type { LookupResult } from "./utils/lookup"
import { accessTypeLabel, detectionTime, locationDetails, networkDetails } from "./utils/details"
import { activeRiskFlags, shouldShowRiskScale } from "./utils/flags"
import { buildWidgetSnapshot, saveWidgetSnapshot } from "./utils/widget_sync"
import { fetchGeoReport, sameIP, withTimeout } from "./utils/geo"
import type { ExitObservation, GeoReport, GeoRow } from "./utils/geo"
import { fetchIPPure } from "./utils/ippure"
import type { IPPureReport } from "./utils/ippure"
import { assessWebRTC, fetchWebRTC, normalizeRTCAddress } from "./utils/webrtc"
import type { WebRTCReport } from "./utils/webrtc"
import {
  ACCENT, Band, FlagRow, IconButton, LABEL_WIDTH, LINE, Note, PAGE_BG,
  RiskScale, Row, SURFACE, ScanLine, StatusDot, Tag, animate,
} from "./theme"

type PageState = {
  loading: boolean
  error: string | null
  ip: string
  source: string
  manual: boolean
  result: LookupResult | null
  geo: GeoReport | null
  pure: IPPureReport | null
  pureLoading: boolean
  rtc: WebRTCReport | null
  rtcLoading: boolean
  updatedAt: string
}
const EMPTY: PageState = {
  loading: true, error: null, ip: "", source: "", manual: false,
  result: null, geo: null, pure: null, pureLoading: true, rtc: null, rtcLoading: true, updatedAt: "",
}
const GEO_SOURCES = ["Cloudflare", "IP2Location", "DB-IP", "MaxMind", "IPInfo.io", "Bilibili"]
const TITLE_BORDER = gradient("linear", {
  colors: ["rgba(22,184,166,0.52)", "rgba(39,159,197,0.58)", "rgba(134,115,232,0.52)"],
  startPoint: "leading", endPoint: "trailing",
})
const TITLE_COLORS: Color[] = [
  "#16B8A6", "#1FAEC0", "#279FC5", "#3F93D9", "#5A86E2",
  "#7278E8", "#8673E8", "#9A6DE0", "#C05FB5",
]

function clean(...values: (string | null | undefined)[]) {
  return values.find(value => value && value !== "—") || "—"
}

function CloseGlyph() {
  return <ZStack frame={{ width: 38, height: 38 }}
    background={{ style: "ultraThinMaterial", shape: "circle" }}
    overlay={<Circle stroke={{ shapeStyle: "rgba(118,139,168,0.28)", strokeStyle: { lineWidth: 1 } }} />}
    shadow={{ color: "rgba(22,36,56,0.16)", radius: 5, y: 1 }}>
    <Circle fill="rgba(39,159,197,0.52)" frame={{ width: 14, height: 14 }} offset={{ x: -7, y: -5 }} />
    <Circle fill="rgba(134,115,232,0.52)" frame={{ width: 14, height: 14 }} offset={{ x: 7, y: -5 }} />
    <Circle fill="rgba(240,101,145,0.52)" frame={{ width: 14, height: 14 }} offset={{ x: 0, y: 7 }} />
  </ZStack>
}

function RevealLetter({ char, color, delay }: { char: string; color: Color; delay: number }) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => {
      try { setVisible(true) }
      catch (error) { console.log("[IP检测] 标题字母动画", String(error)) }
    }, delay)
    return () => clearTimeout(timer)
  }, [])
  return <Text font={15} fontWeight="semibold" foregroundStyle={color}
    opacity={visible ? 1 : 0}
    blur={visible ? 0 : 3}
    offset={{ x: 0, y: visible ? 0 : 4 }}
    scaleEffect={visible ? 1 : 0.86}
    animation={{ animation: Animation.easeOut(0.5), value: visible }}>
    {char}
  </Text>
}

function AnimatedTitle() {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => {
      try { setShown(true) }
      catch (error) { console.log("[IP检测] 标题入场", String(error)) }
    }, 30)
    return () => clearTimeout(timer)
  }, [])
  return <HStack spacing={0.15} padding={{ horizontal: 15, vertical: 6 }}
    background={{ style: "ultraThinMaterial", shape: "capsule" }}
    overlay={<Capsule stroke={{ shapeStyle: TITLE_BORDER, strokeStyle: { lineWidth: 1 } }} />}
    shadow={{ color: "rgba(22,36,56,0.14)", radius: 5, y: 1 }}
    opacity={shown ? 1 : 0.3}
    scaleEffect={shown ? 1 : 0.95}
    animation={{ animation: Animation.easeOut(0.55), value: shown }}
    accessibilityLabel="Report ip">
    {"Report ip".split("").map((char, index) => char === " "
      ? <ZStack key={`space-${index}`} frame={{ width: 4.4, height: 18 }} />
      : <RevealLetter key={`${char}-${index}`} char={char} color={TITLE_COLORS[index]}
        delay={140 + index * 80} />)}
  </HStack>
}

function LocationMap({ info }: { info: NonNullable<LookupResult["info"]> }) {
  const camera = useObservable(MapCameraPosition.region({
    center: { latitude: info.lat, longitude: info.lon },
    span: { latitudeDelta: 0.08, longitudeDelta: 0.08 },
  }))
  const [copied, setCopied] = useState(false)
  const [openingMap, setOpeningMap] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const coordinate = `${info.lat.toFixed(4)}, ${info.lon.toFixed(4)}`
  const title = [info.city, info.country].filter(Boolean).join(" · ") || info.query
  const radius = approximateRadiusMeters(info)

  useEffect(() => () => {
    if (copyTimer.current !== null) clearTimeout(copyTimer.current)
    if (pressTimer.current !== null) clearTimeout(pressTimer.current)
    if (openTimer.current !== null) clearTimeout(openTimer.current)
  }, [])

  function copyCoordinates() {
    Pasteboard.setString(coordinate)
    animate(() => setCopied(true), Animation.bouncy({ duration: 0.3 }))
    if (copyTimer.current !== null) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => {
      try { animate(() => setCopied(false)) }
      catch (error) { console.log("[IP检测] 坐标复制状态", String(error)) }
    }, 1500)
  }

  function openMapsWithFeedback() {
    if (openTimer.current !== null || pressTimer.current !== null) return
    animate(() => setOpeningMap(true), Animation.snappy({ duration: 0.14 }))
    pressTimer.current = setTimeout(() => {
      pressTimer.current = null
      try { animate(() => setOpeningMap(false), Animation.snappy({ duration: 0.18 })) }
      catch (error) { console.log("[IP检测] 地图按钮反馈", String(error)) }
    }, 230)
    openTimer.current = setTimeout(() => {
      openTimer.current = null
      void openInMaps()
    }, 380)
  }

  async function openInMaps() {
    const center = { latitude: info.lat, longitude: info.lon }
    try {
      const items = await MapSearch.locate({
        query: [info.city, info.regionName, info.country].filter(Boolean).join(" ") || info.query,
        region: { center, span: { latitudeDelta: 0.2, longitudeDelta: 0.2 } },
      })
      if (items.length > 0) {
        await items[0].openInMaps({ mapType: "standard" })
        return
      }
      const fallback = await MapSearch.locate({ query: `${info.lat},${info.lon}` })
      if (fallback.length > 0) await fallback[0].openInMaps()
    } catch (error) {
      console.log("[IP检测] 打开系统地图失败", error)
    }
  }

  return <VStack alignment="leading" spacing={10} frame={{ maxWidth: "infinity", alignment: "leading" }}>
    <HStack spacing={8} alignment="center" frame={{ maxWidth: "infinity" }}>
      <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Text font={12} fontWeight="medium" lineLimit={2} fixedSize={{ horizontal: false, vertical: true }}>
          {formatIPLocation(info, title)}</Text>
        <Text font={11} fontDesign="monospaced" foregroundStyle={ACCENT.blue}>{coordinate}</Text>
      </VStack>
      <IconButton icon={copied ? "checkmark" : "doc.on.doc"} label={copied ? "坐标已复制" : "复制坐标"}
        action={copyCoordinates} active={copied} />
      <IconButton icon="arrow.up.right" label="在系统地图中打开" action={openMapsWithFeedback}
        iconSize={18} pressed={openingMap} />
    </HStack>
    <Map
      cameraPosition={camera}
      mapStyle={{ style: "standard", elevation: "realistic", showsTraffic: false }}
      annotationTitles="visible"
      controls={<><MapCompass /><MapScaleView /></>}
      modifiers={modifiers()
        .frame({ height: 236 })
        .frame({ maxWidth: "infinity" })
        .clipShape({ type: "rect", cornerRadius: 14 })}
    >
      <MapCircle
        center={{ latitude: info.lat, longitude: info.lon }}
        radius={radius}
        fillColor="rgba(255, 59, 48, 0.16)"
        strokeColor="systemRed"
        strokeStyle={{ lineWidth: 1 }}
      />
      <Marker title={title} coordinate={{ latitude: info.lat, longitude: info.lon }}
        systemImage="network" tint="systemRed" />
    </Map>
    <Note text="IP 定位通常只到城市；红圈表示大致范围，并非精确街道位置。" />
  </VStack>
}

function LocationRow({ row, privacy }: { row: GeoRow; privacy: boolean }) {
  return <Row label={row.source}>
    <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      <Text font={13} foregroundStyle={row.status === "ok" ? "label" : "secondaryLabel"}
        fixedSize={{ horizontal: false, vertical: true }} contentTransition="opacity">
        {row.status === "ok" ? row.location : row.note || "暂不可用"}
      </Text>
      {row.status === "ok" && row.note ? <Text font={10} foregroundStyle={ACCENT.orange}
        fixedSize={{ horizontal: false, vertical: true }}>
        {row.note + (row.ip ? ` · ${formatIPAddress(row.ip, privacy)}` : "")}
      </Text> : null}
    </VStack>
  </Row>
}

export function LocationSection({ result, pure, rows, privacy, expanded, onToggle }: {
  result: LookupResult | null; pure: IPPureReport | null; rows: GeoRow[]
  privacy: boolean; expanded: boolean; onToggle: () => void
}) {
  const info = result?.info
  const available = hasCoordinates(info)
  const showingMap = expanded && available
  return <Band title="位置" icon="mappin.and.ellipse"
    hint={showingMap ? "地图视图" : pure?.locations.length ? "IPPure · 多源对照" : "多源对照"}
    accessory={available ? <IconButton icon={showingMap ? "list.bullet" : "map.fill"}
      label={showingMap ? "返回位置列表" : "展开地图"} action={onToggle} active={showingMap} /> : null}
    shaded order={1}>
    {showingMap && info ? <VStack key="location-map" alignment="leading" spacing={0}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
      transition={Transition.opacity().combined(Transition.offset({ x: 0, y: 10 }))}>
      <LocationMap key={`${info.query}-${info.lat},${info.lon}`} info={info} />
    </VStack> : <VStack key="location-list" alignment="leading" spacing={0}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
      transition={Transition.opacity().combined(Transition.offset({ x: 0, y: 8 }))}>
      {info && !available ? <Note text="归属数据未提供有效经纬度，暂时无法显示地图。" /> : null}
      {rows.map(row => <LocationRow key={row.source} row={row} privacy={privacy} />)}
      {info ? <Row label={result?.infoSource || "归属参考"} value={formatIPLocation(info)} /> : null}
      {result?.alternateLocation && result.infoSource !== "ipwho.is" ? <Row label="ipwho.is"
        value={formatIPLocation({
          country: clean(result.alternateLocation.country) === "—" ? "" : result.alternateLocation.country,
          countryCode: result.alternateLocation.countryCode || "",
          regionName: result.alternateLocation.region === "—" ? "" : result.alternateLocation.region,
          city: result.alternateLocation.city === "—" ? "" : result.alternateLocation.city,
        }, "暂不可用")} /> : null}
      {locationDetails(info).map(row => <Row key={row.label} label={row.label} value={row.value} />)}
      <Note text={pure?.locations.length
        ? `IPPure 补充：${pure.locations.map(row => row.source).join("、")}。各服务实际出口见下方。`
        : "位置来自 IP 数据库；不同出口已单独标注。"} />
    </VStack>}
  </Band>
}

function TrafficRatio({ value, loading }: { value: IPPureReport["traffic"]; loading: boolean }) {
  const [human, setHuman] = useState(0)
  useEffect(() => { animate(() => setHuman(value?.human || 0), Animation.smooth({ duration: 0.8 })) }, [value?.human])
  return <Row label="人机流量比">
    <VStack alignment="leading" spacing={5} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      <HStack spacing={0} frame={{ maxWidth: "infinity", height: 5 }}>
        <GeometryReader>{({ size }) => <HStack spacing={0} frame={{ width: size.width, height: 5 }} clipShape="capsule">
          <Rectangle fill={value ? ACCENT.green : LINE} frame={{ width: value ? size.width * human / 100 : size.width, height: 5 }} />
          {value ? <Rectangle fill={ACCENT.pink} frame={{ width: size.width * (100 - human) / 100, height: 5 }} /> : null}
        </HStack>}</GeometryReader>
      </HStack>
      <HStack spacing={3}>
        <Text font={10} fontDesign="monospaced" foregroundStyle={ACCENT.green} contentTransition="numericText">
          {`human ${value ? value.human.toFixed(2) + "%" : "—"}`}</Text>
        <Spacer />
        <Text font={10} fontDesign="monospaced" foregroundStyle={ACCENT.pink} contentTransition="numericText">
          {`bot ${value ? value.bot.toFixed(2) + "%" : "—"}`}</Text>
      </HStack>
      <Text font={10} foregroundStyle="secondaryLabel">{value ? "ASN 流量统计 · IPPure" : loading ? "正在查询 IPPure…" : "本次未取得统计"}</Text>
    </VStack>
  </Row>
}

function ScorePending({ loading }: { loading: boolean }) {
  return <HStack spacing={8} padding={{ vertical: 10 }}>
    {loading ? <ProgressView controlSize="small" /> : null}
    <Text font={12} foregroundStyle="secondaryLabel">{loading ? "正在获取评分…" : "本次未取得同地址评分"}</Text>
  </HStack>
}

export function ReputationFlags({ reputation, proxy }: {
  reputation: LookupResult["reputation"]; proxy?: boolean | null
}) {
  const flags = activeRiskFlags(reputation, proxy)
  return <>
    {flags.map((flag, index) => <FlagRow key={flag.id} label={flag.label} delay={index * 55} />)}
  </>
}

export function ReputationDetails({ reputation }: { reputation: LookupResult["reputation"] }) {
  const devices = reputation?.devices
  const first = detectionTime(reputation?.firstSeen)
  const last = detectionTime(reputation?.lastSeen)
  return <>
    {reputation?.confidence != null ? <Row label="阳性置信度" value={`${reputation.confidence}%`} mono /> : null}
    {devices?.address != null || devices?.subnet != null ? <Row label="设备估算">
      <VStack alignment="leading" spacing={4} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        {devices.address != null ? <Text font={13} contentTransition="numericText">{`此 IP · ${devices.address.toLocaleString()} 台`}</Text> : null}
        {devices.subnet != null ? <Text font={11} foregroundStyle="secondaryLabel" contentTransition="numericText">
          {`所在网段 · ${devices.subnet.toLocaleString()} 台`}</Text> : null}
      </VStack>
    </Row> : null}
    {first && first !== last ? <Row label="首次检出" value={first} mono /> : null}
    {last ? <Row label="最近检出" value={last} mono /> : null}
    {reputation ? <Note text="置信度表示对阳性检测的把握；设备数为数据库估算。记录时间为 UTC，不代表本机当前行为。" /> : null}
  </>
}

export function WebRTCRows({ report, exits, loading, manual, privacy }: {
  report: WebRTCReport | null; exits: ExitObservation[]; loading: boolean; manual: boolean; privacy: boolean
}) {
  const result = assessWebRTC(report, exits, loading, manual)
  const color = result.tone === "ok" ? ACCENT.green : result.tone === "warning" ? ACCENT.orange : ACCENT.violet
  const candidates = manual || loading ? [] : report?.candidates || []
  return <>
    <Row label="WebRTC"><HStack spacing={7}>
      {loading && !manual ? <ProgressView controlSize="small" /> : null}
      <Tag text={result.label} color={color} />
    </HStack></Row>
    <Note text={result.note} />
    {candidates.filter(c => c.scope !== "mdns").map(candidate => {
      const matches = exits.filter(exit => sameIP(normalizeRTCAddress(exit.ip) || "", candidate.address))
      const label = candidate.type === "relay" ? "中继地址" : candidate.scope === "local" ? "本地地址"
        : candidate.type === "srflx" ? "STUN 公网" : "WebRTC 公网"
      return <Row key={`${candidate.type}-${candidate.address}-${candidate.protocol}`} label={label}>
        <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Text font={13} fontDesign="monospaced" foregroundStyle={candidate.scope === "public" ? ACCENT.blue : "secondaryLabel"}
            fixedSize={{ horizontal: false, vertical: true }}>{formatIPAddress(candidate.address, privacy)}</Text>
          <Text font={10} foregroundStyle="secondaryLabel" fixedSize={{ horizontal: false, vertical: true }}>
            {`${candidate.type} · ${candidate.protocol.toUpperCase()}${matches.length ? " · 与 " + matches.map(exit => exit.source).join(" / ") + " 一致" : ""}`}</Text>
        </VStack>
      </Row>
    })}
    {candidates.some(c => c.scope === "mdns") ? <Row label="本地候选" value="mDNS 已隐藏地址" /> : null}
  </>
}

function ExitRows({ state, privacy }: { state: PageState; privacy: boolean }) {
  const exits: ExitObservation[] = state.manual ? [] : [
    ...(state.ip ? [{ source: state.source || "当前出口", ip: state.ip, location: "" }] : []),
    ...(state.geo?.exits || []),
    ...(state.pure?.exit ? [state.pure.exit] : []),
  ]
  const differs = exits.some(exit => state.ip && !sameIP(exit.ip, state.ip))
  return <>
    <WebRTCRows report={state.rtc} exits={exits} loading={state.rtcLoading} manual={state.manual} privacy={privacy} />
    {!state.manual ? <Note text="HTTP 出口对照" /> : null}
    {state.manual ? <Row label="出口对照" value="手动查询不检测设备出口" /> : <>
      {exits.map(exit => <Row key={exit.source} label={exit.source}>
        <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Text font={13} fontDesign="monospaced"
            foregroundStyle={sameIP(exit.ip, state.ip) ? ACCENT.blue : ACCENT.orange}
            fixedSize={{ horizontal: false, vertical: true }}>{formatIPAddress(exit.ip, privacy)}</Text>
          {exit.location ? <Text font={11} foregroundStyle="secondaryLabel"
            fixedSize={{ horizontal: false, vertical: true }}>{exit.location}</Text> : null}
        </VStack>
      </Row>)}
      <Row label="对照结果">
        <Tag text={state.loading ? "检测中" : exits.length < 2 ? "数据不足" : differs ? "存在出口差异" : "出口一致"}
          color={state.loading || exits.length < 2 ? ACCENT.violet : differs ? ACCENT.orange : ACCENT.green} />
      </Row>
      <Note text={differs
        ? "分流或 IPv4 / IPv6 路径可能造成出口差异，不能据此判定 WebRTC 泄露。"
        : "出口对照仅反映本次请求路径。"} />
    </>}
  </>
}

export default function IPPage({ initialAddress }: { initialAddress?: string }) {
  const dismiss = Navigation.useDismiss()
  const [privacy, setPrivacy] = useState(getPrivacyMode())
  const [state, setState] = useState<PageState>(EMPTY)
  const [searchOpen, setSearchOpen] = useState(false)
  const [mapExpanded, setMapExpanded] = useState(false)
  const [query, setQuery] = useState("")
  const [queryError, setQueryError] = useState("")
  const [copied, setCopied] = useState(false)
  const request = useRef(0)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const widgetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function scheduleWidgetReload() {
    if (widgetTimer.current !== null) clearTimeout(widgetTimer.current)
    // Storage 共享写入在后台落盘；稍等再刷新，避免小组件读到上一份快照或旧隐私设置。
    widgetTimer.current = setTimeout(() => {
      try { Widget.reloadUserWidgets() }
      catch (error) { console.log("[IP检测] 小组件刷新失败", String(error)) }
    }, 300)
  }

  async function detect(address?: string) {
    const run = ++request.current
    const manual = !!address
    animate(() => {
      setCopied(false)
      setMapExpanded(false)
      setState({ ...EMPTY, ip: address || "", manual, rtcLoading: !manual })
      setQueryError("")
      setSearchOpen(false)
    }, Animation.easeOut(0.28))
    let ip = address || ""
    let source = manual ? "手动查询" : ""
    const update = (patch: Partial<PageState>) => {
      if (run === request.current) animate(() => setState(previous => ({ ...previous, ...patch })))
    }
    // WebRTC 独立于 HTTP 出口探测；两者并行，HTTP 失败也能显示实际候选。
    const rtcTask = manual ? Promise.resolve() : fetchWebRTC(() => run === request.current)
      .then(rtc => update({ rtc, rtcLoading: false }))
      .catch(() => update({ rtc: { status: "error", candidates: [], errors: [], note: "WebRTC 检测失败，请重试。" }, rtcLoading: false }))
    try {
      if (!manual) {
        const probe = await withTimeout(fetchExitProbe(), 7000)
        if (run !== request.current) return
        if (!probe) throw new Error("未能获取出口 IP，请检查网络后重新检测")
        ip = probe.address
        source = probe.source
      }
      update({ ip, source })
      const lookupTask = lookupAddress(ip, true)
        .then(result => {
          update({ result, error: result.info ? null : "归属查询暂不可用，已保留同地址风险数据" })
          return result
        })
        .catch(error => {
          update({ error: String(error).replace(/^Error: /, "") })
          return null
        })
      const geoTask = fetchGeoReport(ip, !manual)
        .then(geo => { update({ geo }); return geo })
        .catch(() => { update({ error: "部分位置来源暂时不可用" }); return null })
      const pureTask = fetchIPPure(ip, () => run === request.current)
        .then(pure => { update({ pure, pureLoading: false }); return pure })
        .catch(() => { update({ pureLoading: false }); return null })
      const [result, , , pureReport] = await Promise.all([lookupTask, geoTask, rtcTask, pureTask])
      if (run !== request.current) return
      update({ loading: false, updatedAt: new Date().toLocaleTimeString("zh-CN", { hour12: false }) })
      saveWidgetSnapshot(buildWidgetSnapshot({
        ip,
        info: result?.info ?? null,
        reputation: result?.reputation ?? null,
        pure: pureReport,
      }))
      scheduleWidgetReload()
    } catch (error) {
      await rtcTask
      update({ loading: false, pureLoading: false, error: String(error).replace(/^Error: /, "") })
    }
  }

  function search() {
    const ip = query.trim()
    if (!validIPAddress(ip)) {
      setQueryError("请输入有效的 IPv4 或 IPv6 地址")
      return
    }
    void detect(ip)
  }

  function toggleSearch() {
    animate(() => {
      setQueryError("")
      if (!searchOpen) setQuery("")
      setSearchOpen(!searchOpen)
    }, Animation.easeOut(0.28))
  }

  function togglePrivacy() {
    const next = !privacy
    setPrivacyMode(next)
    animate(() => setPrivacy(next))
    scheduleWidgetReload()
  }

  function copyIP() {
    if (!state.ip) return
    Pasteboard.setString(state.ip)
    animate(() => setCopied(true), Animation.bouncy({ duration: 0.3 }))
    if (copyTimer.current !== null) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => {
      try { animate(() => setCopied(false)) } catch (error) { console.log(String(error)) }
    }, 1600)
  }

  useEffect(() => {
    void detect(initialAddress && validIPAddress(initialAddress) ? initialAddress : undefined)
    return () => {
      request.current++
      if (copyTimer.current !== null) clearTimeout(copyTimer.current)
      if (widgetTimer.current !== null) clearTimeout(widgetTimer.current)
    }
  }, [])

  const info = state.result?.info
  const flags = state.result?.reputation
  const pure = state.pure
  const asn = clean(pure?.asn, info?.as?.match(/AS\d+/i)?.[0], state.result?.connection?.asn)
  const network = clean(pure?.organization, info?.asname, state.result?.connection?.organization, info?.isp)
  const hosting = pure?.networkType === "hosting" ? true : flags?.hosting ?? info?.hosting
  const proxy = flags?.proxy ?? info?.proxy
  const attribute = accessTypeLabel(info, flags, pure)
  const geoRows = GEO_SOURCES.map(source => pure?.locations.find(row => row.source === source)
    || state.geo?.rows.find(row => row.source === source)
    || { source, ip: null, location: "", status: "unavailable" as const,
      note: state.loading ? "查询中…" : "暂不可用" })
  const risk = flags?.risk ?? null
  const refresh = () => detect(state.manual ? state.ip : undefined)
  const toggleMap = () => animate(() => setMapExpanded(value => !value), Animation.spring({ duration: 0.38, bounce: 0.12 }))

  return <NavigationStack>
    <ScrollView navigationBarTitleDisplayMode="inline"
      background={PAGE_BG} scrollIndicator="hidden" scrollDismissesKeyboard="interactively"
      refreshable={refresh}
      toolbar={{
        cancellationAction:
          <Button action={dismiss} role="close" buttonStyle="plain" accessibilityLabel="关闭">
            <CloseGlyph />
          </Button>,
        principal:
          <AnimatedTitle />,
      }}>
      <VStack spacing={0} padding={{ horizontal: 12, top: 10, bottom: 28 }}
        frame={{ maxWidth: 760, alignment: "center" }}>
        <VStack spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }}
          background={SURFACE} clipShape={{ type: "rect", cornerRadius: 18 }}>
          <ScanLine active={state.loading} />
          <Band order={0}>
            <HStack spacing={5} padding={{ bottom: 12 }}>
              <StatusDot active={state.loading} color={state.error ? ACCENT.orange : ACCENT.teal} />
              <Text font={11} fontWeight="medium" foregroundStyle="secondaryLabel">
                {state.manual ? "手动查询" : "当前出口"}</Text>
              <Spacer />
              <Text font={10} foregroundStyle="secondaryLabel" contentTransition="opacity">
                {state.loading ? state.result && state.pureLoading ? "补充 IPPure…" : "正在检测…" : state.updatedAt || "等待重试"}</Text>
              <IconButton icon={searchOpen ? "xmark" : "magnifyingglass"} label={searchOpen ? "关闭 IP 查询" : "查询 IP"}
                action={toggleSearch} active={searchOpen} />
              <IconButton icon="arrow.clockwise" label="重新检测" action={refresh} disabled={state.loading} />
            </HStack>
            <HStack spacing={10} alignment="center" padding={{ bottom: 9 }}>
              <Text font={16} fontWeight="bold" frame={{ width: LABEL_WIDTH, alignment: "leading" }}>IP</Text>
              <ZStack alignment="leading" frame={{ maxWidth: "infinity", minHeight: 34 }}>
                {searchOpen ? <TextField key="ip-query" title="IP 地址" prompt="输入 IPv4 / IPv6"
                  value={query} onChanged={value => { setQuery(value); if (queryError) setQueryError("") }}
                  autofocus textFieldStyle="plain" font={17} fontDesign="monospaced"
                  foregroundStyle={ACCENT.blue}
                  keyboardType="asciiCapable" textInputAutocapitalization="never" autocorrectionDisabled
                  submitLabel="search" onSubmit={search}
                  frame={{ maxWidth: "infinity", minHeight: 34, alignment: "leading" }}
                  transition={Transition.opacity().combined(Transition.offset({ x: 0, y: 7 }))} />
                  : <HStack key="ip-display" spacing={3}
                    frame={{ maxWidth: "infinity", alignment: "leading" }}
                    transition={Transition.opacity().combined(Transition.offset({ x: 0, y: -7 }))}>
                    <Text font={22} fontDesign="monospaced" fontWeight="medium" foregroundStyle={ACCENT.blue}
                      lineLimit={2} minScaleFactor={0.55} contentTransition="opacity"
                      frame={{ maxWidth: "infinity", alignment: "leading" }}>
                      {state.ip ? formatIPAddress(state.ip, privacy) : state.loading ? "检测中…" : "—"}</Text>
                    <IconButton icon={privacy ? "eye.slash" : "eye"} label={privacy ? "显示完整 IP" : "隐藏 IP"}
                      action={togglePrivacy} active={!privacy} />
                    <IconButton icon={copied ? "checkmark" : "doc.on.doc"} label={copied ? "已复制" : "复制完整 IP"}
                      action={copyIP} active={copied} disabled={!state.ip} />
                  </HStack>}
              </ZStack>
            </HStack>
            {searchOpen && queryError ? <Text font={11} foregroundStyle={ACCENT.red}
              padding={{ leading: LABEL_WIDTH + 10, bottom: 9 }}
              transition={Transition.opacity()}>{queryError}</Text> : null}
            {state.manual ? <Button action={() => { setQuery(""); void detect() }} buttonStyle="plain">
              <HStack spacing={5} padding={{ bottom: 8 }}>
                <Image systemName="arrow.uturn.backward" font={10} />
                <Text font={11}>返回当前出口</Text>
              </HStack>
            </Button> : null}
            {state.error ? <HStack alignment="top" spacing={6} padding={{ vertical: 8 }}>
              <Image systemName="exclamationmark.circle" font={12} foregroundStyle={ACCENT.orange} />
              <Text font={11} foregroundStyle={ACCENT.orange}
                fixedSize={{ horizontal: false, vertical: true }}>{state.error}</Text>
            </HStack> : null}
            <Row label="ASN">
              <VStack alignment="leading" spacing={4} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                <Text font={14} fontDesign="monospaced" foregroundStyle={ACCENT.blue}>{asn}</Text>
                <Text font={12} fixedSize={{ horizontal: false, vertical: true }}>{network}</Text>
              </VStack>
            </Row>
            {networkDetails(info, network).map(row => <Row key={row.label} label={row.label} value={row.value} />)}
            <Row label="AS 域名" value={clean(pure?.domain, state.result?.connection?.domain)} mono />
            {flags?.hostname ? <Row label="IP 主机名" value={privacy ? "已隐藏 · 顶部眼睛可显示" : flags.hostname} mono={!privacy} /> : null}
            <Row label="IP 范围" value={clean(pure?.range, flags?.range)} mono />
            <TrafficRatio value={pure?.traffic || null} loading={state.pureLoading} />
          </Band>

          <LocationSection result={state.result} pure={pure} rows={geoRows} privacy={privacy}
            expanded={mapExpanded} onToggle={toggleMap} />

          <Band order={2}>
            <Row label="IP 来源">
              <Tag text={pure?.isBroadcast == null ? state.pureLoading ? "查询中" : "暂无判定" : pure.isBroadcast ? "广播 IP" : "原生 IP"}
                color={pure?.isBroadcast == null ? ACCENT.violet : pure.isBroadcast ? ACCENT.pink : ACCENT.teal} />
            </Row>
            <Row label="IP 属性"><Tag text={attribute} color={hosting ? ACCENT.pink : ACCENT.blue} /></Row>
            <ReputationFlags reputation={flags || null} proxy={proxy} />
            <Note text="IP 来源与住宅分类由 IPPure 补充；代理与风险标记来自 ip-api / proxycheck，仅列出已命中项，未列出可能是未命中或暂无数据。" />
          </Band>

          <Band title="IPPure 系数" icon="shield.lefthalf.filled" hint="IPPure" shaded order={3}>
            {pure?.risk == null ? <ScorePending loading={state.pureLoading} />
              : shouldShowRiskScale(pure.risk) ? <RiskScale key={`pure-${state.ip}`} value={pure.risk} /> : null}
            {pure?.note ? <Note text={pure.note} /> : null}
          </Band>
          <Band title="Cloudflare 系数" hint="经 IPPure" order={4}>
            {pure?.cloudflareRisk == null ? <ScorePending loading={state.pureLoading} />
              : shouldShowRiskScale(pure.cloudflareRisk) ? <RiskScale key={`cf-${state.ip}`} value={pure.cloudflareRisk} /> : null}
            <Note text="浏览器检测分数会变化；仅显示与查询 IP 一致的结果。" />
          </Band>
          <Band title="proxycheck 风险" hint="proxycheck.io" shaded order={5}>
            {risk == null ? <ScorePending loading={state.loading} />
              : shouldShowRiskScale(risk) ? <RiskScale key={`pc-${state.ip}`} value={risk} /> : null}
            <ReputationDetails reputation={flags || null} />
          </Band>

          <Band title="泄露检测" icon="network" hint="WebRTC · 出口对照" order={6}>
            <ExitRows state={state} privacy={privacy} />
          </Band>
        </VStack>
        <HStack spacing={5} padding={{ top: 13 }} foregroundStyle="secondaryLabel">
          <Image systemName="arrow.down" font={9} />
          <Text font={10}>下拉刷新 · 点击眼睛切换隐私显示</Text>
        </HStack>
      </VStack>
    </ScrollView>
  </NavigationStack>
}
