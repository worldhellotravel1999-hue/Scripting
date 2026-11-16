import { ScrollView, VStack } from "scripting"
import { NetworkSections, ServiceSection } from "../network_section"
import { PAGE_BG, SURFACE } from "../theme"
import { pendingServices } from "../utils/network_model"
import type { NetworkReport } from "../utils/network_model"
import type { ServiceRegionSource } from "../utils/network_region"

const services = pendingServices().map((item, index) => ({ ...item,
  state: index % 4 === 0 ? "reachable" as const : index % 4 === 1 ? "restricted" as const
    : index % 4 === 2 ? "failed" as const : "unknown" as const,
  status: index % 4 === 0 ? 200 : index % 4 === 1 ? 403 : index % 4 === 2 ? 503 : null,
  ms: index % 4 < 2 ? 120 + index * 21 : null,
  regionCode: ["SG", "US", "JP", "SG", "HK", "SG", "US", "US", "US", "CN", "US", "US"][index],
  regionSource: (["page", "page", "config", "route", "page", "page", "trace", "trace", "market", "page", "header", "trace"] as ServiceRegionSource[])[index],
  detail: index % 4 === 1 ? "HTTP 403 · 认证或访问限制" : "连接失败或超时", policy: "",
}))
export const previewReport: NetworkReport = {
  version: 1, measuredAt: Date.now(), contextIP: "8.8.8.8", source: "device",
  local: { kind: "Wi-Fi 接口", ipv4: "192.168.3.24", ipv6: "2001:db8::1", tunnel: true,
    interfaces: ["en0"], gateway: "", dns: "" },
  domesticExit: { ip: "1.2.3.4", location: "上海", isp: "中国电信" },
  latency: { domestic: 44, overseas: 208 }, quic: "other", httpProtocol: "HTTP/2", services,
  surge: { mode: "规则分流", node: "节点名称示例", policy: "节点选择", protocol: "VLESS",
    note: "近期请求日志活跃节点，不代表所有服务的出口" },
  note: "", durationMs: 2870,
}
export default function PreviewNetwork({ servicesOnly = false, dark = false }: { servicesOnly?: boolean; dark?: boolean }) {
  return <ScrollView background={PAGE_BG} preferredColorScheme={dark ? "dark" : "light"}>
    <VStack spacing={0} padding={{ horizontal: 12, top: 12, bottom: 20 }}
      frame={{ maxWidth: 760 }} background={SURFACE}>
      {servicesOnly ? <>
        <ServiceSection report={previewReport} group="media" loading={false} />
        <ServiceSection report={previewReport} group="ai" loading={false} />
      </> : <NetworkSections report={previewReport} loading={false} manual={false} privacy={true} />}
    </VStack>
  </ScrollView>
}
