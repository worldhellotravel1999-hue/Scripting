import { HStack, ProgressView, Text, VStack } from "scripting"
import { ACCENT, Band, Note, Row, Tag } from "./theme"
import { formatIPAddress } from "./utils/ip"
import { localAddressHint } from "./utils/network"
import { latencyLabel, pendingServices, quicLabel, serviceCounts, serviceStateLabel } from "./utils/network_model"
import type { NetworkReport, ServiceGroup, ServiceResult, ServiceState } from "./utils/network_model"

function tone(state: ServiceState) {
  return state === "reachable" ? ACCENT.green : state === "restricted" ? ACCENT.orange
    : state === "failed" ? ACCENT.red : ACCENT.violet
}
function ServiceCell({ service, loading }: { service: ServiceResult; loading: boolean }) {
  const pending = loading && service.detail === "未检测"
  return <VStack alignment="leading" spacing={5} padding={{ vertical: 9 }}
    frame={{ maxWidth: "infinity", alignment: "leading" }}>
    <HStack spacing={6}>
      <Text font={13} fontWeight="medium" lineLimit={1} minScaleFactor={0.75}>{service.name}</Text>
      {pending ? <ProgressView controlSize="mini" /> : <Text font={10} foregroundStyle={tone(service.state)}>
        {serviceStateLabel(service.state)}</Text>}
    </HStack>
    <Text font={10} foregroundStyle="secondaryLabel" lineLimit={2}
      fixedSize={{ horizontal: false, vertical: true }}>
      {pending ? "检测中…" : service.status != null
        ? `HTTP ${service.status}${service.ms == null ? "" : ` · ${latencyLabel(service.ms)}`}` : service.detail || "未取得结果"}
    </Text>
    {service.policy ? <Text font={9} foregroundStyle={ACCENT.blue} lineLimit={2}>
      {`策略 · ${service.policy}`}</Text> : null}
  </VStack>
}
export function ServiceSection({ report, group, loading }: { report: NetworkReport | null; group: ServiceGroup; loading: boolean }) {
  const services = (report?.services || pendingServices()).filter(row => row.group === group)
  const count = serviceCounts(services, group)
  return <Band title={group === "media" ? "流媒体连通性" : "AI 服务连通性"}
    icon={group === "media" ? "play.rectangle" : "sparkles"}
    hint={`${count.reachable}/6 可访问${loading ? " · 检测中" : ""}`}
    shaded={group === "ai"} order={group === "media" ? 8 : 9}>
    {[0, 2, 4].map(index => <HStack key={index} alignment="top" spacing={16}>
      {services.slice(index, index + 2).map(service => <ServiceCell key={service.id} service={service} loading={loading} />)}
    </HStack>)}
    <Note text={group === "media"
      ? "检测公开页面可访问性，不代表订阅、播放或地区内容已解锁。403、429 和验证页面会标为受限。"
      : "检测公开页面，不登录账户或调用付费接口；网页可访问不代表模型和账户服务可用。"} />
  </Band>
}

export function NetworkSection({ report, loading, manual, privacy }: {
  report: NetworkReport | null; loading: boolean; manual: boolean; privacy: boolean
}) {
  if (manual) return <Band title="网络诊断" icon="waveform.path.ecg" shaded order={7}>
    <Note text="手动 IP 查询不检测本机网络和服务连通性；返回当前出口后会一起检测。" />
  </Band>
  const local = report?.local
  const measured = report ? new Date(report.measuredAt).toLocaleTimeString("zh-CN", { hour12: false }) : ""
  return <Band title="网络诊断" icon="waveform.path.ecg" shaded order={7}
      hint={loading ? "正在检测" : report?.source === "surge" ? "Surge 快照" : "本机实测"}>
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
  </Band>
}

/** 独立预览等原调用继续使用组合入口，主页面按分区分别参与排序。 */
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
