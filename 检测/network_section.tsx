import { HStack, ProgressView, Text, VStack, useState } from "scripting"
import type { Color } from "scripting"
import { ACCENT, Band, CODE, IconButton, Note, Row, Tag, animate, tinted, useEntrance } from "./theme"
import { SpeedPanel } from "./speed_section"
import { formatIPAddress } from "./utils/ip"
import { localAddressHint } from "./utils/network"
import { latencyLabel, pendingServices, quicLabel, serviceCounts, serviceStateParts } from "./utils/network_model"
import type { NetworkReport, ServiceGroup, ServiceResult, ServiceState } from "./utils/network_model"
import { serviceRegionSourceLabel } from "./utils/network_region"

function tone(state: ServiceState) {
  return state === "reachable" ? ACCENT.green : state === "restricted" ? ACCENT.orange
    : state === "failed" ? ACCENT.red : ACCENT.violet
}
/** 状态胶囊：极浅底色加同色文字，比裸文字更易在列表里横向扫读。 */
function StateChip({ label, color }: { label: string; color: Color }) {
  return <Text font={10} fontWeight="semibold" foregroundStyle={color} lineLimit={1} minScaleFactor={0.7}
    padding={{ horizontal: 6, vertical: 2 }}
    background={{ style: tinted(color, 0.14), shape: { type: "capsule", style: "continuous" } }}
    contentTransition="opacity"
    animation={{ animation: Animation.smooth({ duration: 0.3 }), value: label }}>
    {label}
  </Text>
}
function ServiceCell({ service, loading, index = 0 }: {
  service: ServiceResult; loading: boolean; index?: number
}) {
  const shown = useEntrance(index * 26)
  const pending = loading && service.detail === "未检测"
  const state = serviceStateParts(service.state, service.regionCode)
  const regionText = state.code || (loading ? "检测中…" : "未取得")
  const regionSource = state.code ? serviceRegionSourceLabel(service.regionSource) : ""
  const tint = tone(service.state)
  return <VStack alignment="leading" spacing={5} padding={{ vertical: 9 }}
    frame={{ maxWidth: "infinity", alignment: "leading" }}
    opacity={shown ? 1 : 0} offset={{ x: 0, y: shown ? 0 : 6 }}
    animation={{ animation: Animation.easeOut(0.42), value: shown }}>
    <HStack spacing={6}>
      <Text font={13} fontWeight="medium" foregroundStyle={CODE.value} lineLimit={1} minScaleFactor={0.75}
        frame={{ maxWidth: "infinity", alignment: "leading" }}>{service.name}</Text>
      {pending ? <ProgressView controlSize="mini" /> : <StateChip label={state.label} color={tint} />}
    </HStack>
    <HStack spacing={5}>
      <Text font={9} foregroundStyle="secondaryLabel">地区码</Text>
      <Text font={10} fontDesign="monospaced" fontWeight="semibold"
        foregroundStyle={state.code ? CODE.region : "secondaryLabel"}
        lineLimit={1} fixedSize={{ horizontal: true, vertical: false }}
        contentTransition="opacity"
        animation={{ animation: Animation.easeOut(0.3), value: regionText }}>{regionText}</Text>
      {regionSource ? <Text font={8} foregroundStyle="secondaryLabel" lineLimit={1} minScaleFactor={0.8}>{regionSource}</Text> : null}
    </HStack>
    <Text font={10} foregroundStyle="secondaryLabel" lineLimit={2}
      contentTransition="opacity"
      animation={{ animation: Animation.easeOut(0.3), value: service.status == null ? "none" : String(service.status) }}
      fixedSize={{ horizontal: false, vertical: true }}>
      {pending ? "检测中…" : service.status != null
        ? `HTTP ${service.status}${service.ms == null ? "" : ` · ${latencyLabel(service.ms)}`}` : service.detail || "未取得结果"}
    </Text>
    {service.policy ? <Text font={9} foregroundStyle={ACCENT.blue} lineLimit={2}>
      {`策略 · ${service.policy}`}</Text> : null}
  </VStack>
}
export function ServiceSection({ report, group, loading }: { report: NetworkReport | null; group: ServiceGroup; loading: boolean }) {
  const services = pendingServices().filter(row => row.group === group).map(base =>
    report?.services.find(row => row.id === base.id && row.group === group) || base)
  const count = serviceCounts(services, group)
  // 两列布局按组内实际数量分页，新增服务不会因为写死 6 而漏掉。
  const rows: ServiceResult[][] = []
  for (let index = 0; index < services.length; index += 2) rows.push(services.slice(index, index + 2))
  return <Band title={group === "media" ? "流媒体连通性" : "AI 服务连通性"}
    icon={group === "media" ? "play.rectangle" : "sparkles"}
    hint={`${count.reachable}/${count.total} 可用${loading ? " · 检测中" : ""}`}
    shaded={group === "ai"} order={group === "media" ? 9 : 10}>
    {rows.map((pair, index) => <HStack key={index} alignment="top" spacing={16}>
      {pair.map((service, column) => <ServiceCell key={service.id} service={service} loading={loading}
        index={index * 2 + column} />)}
    </HStack>)}
    <Note text={group === "media"
      ? "检测公开页面可访问性，不代表订阅或播放已解锁。地区码附来源：匿名配置为服务接口所报告地区，服务区域为路由区域。"
      : "同域观测为服务 CDN 识别的访问地区；页面地区／区域是页面配置值，不等于 IP 国家或账户、模型可用地区。未取得表示本轮未返回代码。"} />
  </Band>
}

export function NetworkSection({ report, loading, manual, privacy }: {
  report: NetworkReport | null; loading: boolean; manual: boolean; privacy: boolean
}) {
  const [panel, setPanel] = useState<"diagnose" | "speed">("diagnose")
  const [running, setRunning] = useState(false)
  const local = report?.local
  const measured = report ? new Date(report.measuredAt).toLocaleTimeString("zh-CN", { hour12: false }) : ""
  const measuring = panel === "speed"
  const toggle = () => {
    // 测速进行中不允许切走，避免卸载时被中止却看不到原因。
    if (measuring && running) return
    animate(() => setPanel(current => current === "speed" ? "diagnose" : "speed"),
      Animation.spring({ duration: 0.36, bounce: 0.12 }))
  }
  return <Band title={measuring ? "网络测速" : "网络诊断"} icon={measuring ? "speedometer" : "waveform.path.ecg"}
    shaded order={7}
    hint={manual ? "手动查询" : measuring ? (running ? "测速中" : "待开始") : loading ? "正在检测"
      : report?.source === "surge" ? "Surge 快照" : "本机实测"}
    accessory={manual ? null : <IconButton icon={measuring ? "list.bullet" : "speedometer"}
      label={measuring ? (running ? "测速进行中，暂不能返回" : "返回网络诊断") : "展开网络测速"}
      action={toggle} active={measuring} disabled={measuring && running} />}>
    {manual ? <Note text="手动 IP 查询不检测本机网络和服务连通性；返回当前出口后会一起检测。" />
      : <VStack spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }}
        key={measuring ? "network-speed" : "network-diagnose"}
        transition={Transition.opacity().combined(Transition.offset({ x: 0, y: 9 }))}>
        {measuring ? <SpeedPanel kind={local?.kind || ""} onRunningChange={setRunning} />
          : <VStack spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Row label="本机接口" value={local?.kind || (loading ? "读取中…" : "未知")} />
          {local?.ipv4 ? <Row label="本地 IPv4" value={formatIPAddress(local.ipv4, privacy)} mono /> : null}
          {local?.ipv6 ? <Row label="本地 IPv6" value={formatIPAddress(local.ipv6, privacy)} mono /> : null}
          <Row label="隧道接口" value={local?.tunnel == null ? "未知" : local.tunnel ? "检测到" : "未检测到"} />
          {local?.ipv4 ? <Note text={localAddressHint(local.ipv4)} /> : null}
          {local?.gateway ? <Row label="网关" value={privacy ? "已隐藏" : local.gateway} mono /> : null}
          {local?.dns ? <Row label="DNS" value={privacy ? "已隐藏" : local.dns} mono /> : null}
          <Row label="国内响应" value={latencyLabel(report?.latency.domestic)} mono />
          <Row label="国际响应" value={latencyLabel(report?.latency.overseas)} mono />
          <Row label="HTTP/3"><Tag text={quicLabel(report)}
            color={report?.quic === "h3" ? ACCENT.green : ACCENT.violet} /></Row>
          <Note text="响应为国内／国际站点的 HTTP 请求耗时，取本轮成功请求最小值，包含建连等开销；请求遵循当前分流。接口存在不代表实际出站，未观测到 H3 也不等于 UDP 被禁用。" />
          {report?.surge ? <>
            <Row label="出站模式" value={report.surge.mode} />
            {report.surge.node ? <Row label="活跃节点" value={report.surge.node} /> : null}
            {report.surge.policy ? <Row label="策略组" value={report.surge.policy} /> : null}
            {report.surge.protocol ? <Row label="协议" value={report.surge.protocol} /> : null}
            {report.surge.note ? <Note text={report.surge.note} /> : null}
          </> : null}
          {report?.note ? <Note text={report.note} /> : null}
          {!loading && measured ? <Note text={`${measured} · ${report?.source === "surge" ? "来自 Surge 快照" : `本轮耗时 ${((report?.durationMs || 0) / 1000).toFixed(1)} 秒`}`} /> : null}
          </VStack>}
      </VStack>}
  </Band>
}

/** 独立预览等原调用继续使用组合入口，主页面按分区分别参与排序。测速已并入网络诊断分区。 */
export function NetworkSections(props: {
  report: NetworkReport | null; loading: boolean; manual: boolean; privacy: boolean
}) {
  return <>
    <NetworkSection {...props} />
    {!props.manual ? <>
      <ServiceSection report={props.report} group="media" loading={props.loading} />
      <ServiceSection report={props.report} group="ai" loading={props.loading} />
    </> : null}
  </>
}
