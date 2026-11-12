import { ScrollView, Text, VStack } from "scripting"
import { NetworkWidget } from "../network_widget"
import { buildWidgetSnapshot } from "../utils/widget_sync"
import { previewReport } from "./preview-network"

const snapshot = buildWidgetSnapshot({
  ip: "8.8.8.8", info: { query: "8.8.8.8", status: "success", country: "美国", countryCode: "US",
    regionName: "California", city: "Mountain View", isp: "Google", org: "Google LLC", as: "AS15169 Google",
    lat: 37.4, lon: -122.1 },
  reputation: null, pure: null, network: previewReport,
})
export default function PreviewNetworkWidget({ mode = "stale", dark = false, family = "systemLarge", ipv6 = false }: {
  mode?: string; dark?: boolean; family?: string; ipv6?: boolean
}) {
  const address = ipv6 ? "2001:abcd:1234:5678:90ab:cdef:1234:abcd" : snapshot.ip
  const shown = { ...snapshot, ip: address, manual: mode === "manual", risk: 42,
    riskSource: "proxycheck" as const, accessType: "住宅 IP", vpnStatus: "VPN",
    network: snapshot.network ? { ...snapshot.network, contextIP: address } : null }
  const size = family === "systemSmall" ? { width: 158, height: 158 }
    : family === "systemMedium" ? { width: 338, height: 158 } : { width: 338, height: 354 }
  const now = Date.now() + (mode === "stale" ? 60 * 60_000 : 0)
  return <ScrollView preferredColorScheme={dark ? "dark" : "light"}>
    <VStack spacing={12} padding={12}>
      <Text>{mode === "manual" ? "手动查询：诊断不混用" : "离线预览：缓存过期与受限状态"}</Text>
      <NetworkWidget snapshot={shown} size={size} family={family} now={now} privacyMode={!ipv6} />
    </VStack>
  </ScrollView>
}
