import { NavigationStack, ScrollView, Text, VStack, useEffect, useState } from "scripting"
import { SortableModules } from "../sortable_modules"
import type { PageModuleViews } from "../sortable_modules"
import { scoreModules } from "../score_modules"
import { parseIPPure } from "../utils/ippure"
import { PAGE_BG, SURFACE, BAND_BG } from "../theme"
import { PAGE_MODULES } from "../utils/module_order"
import type { PageModuleID } from "../utils/module_order"

const titles: Record<PageModuleID, string> = {
  overview: "IP · ASN", location: "位置", attributes: "IP 属性", ippure: "IPPure 系数",
  cloudflare: "Cloudflare 系数", proxycheck: "proxycheck 风险", leak: "泄露检测",
  network: "网络诊断 · 测速", media: "流媒体连通性", ai: "AI 服务连通性", settings: "网络诊断设置",
}

/** 使用真实排序与系数分区；只用内存数据，resolve 模拟评分异步到达。 */
export default function PreviewModules({ manual = false, risk = 33, cloudflareRisk = 67, resolve = false }: {
  manual?: boolean; risk?: number | null; cloudflareRisk?: number | null; resolve?: boolean
}) {
  const [scores, setScores] = useState({ risk: resolve ? null : risk, cloudflareRisk: resolve ? null : cloudflareRisk })
  useEffect(() => {
    if (!resolve) return
    const timer = setTimeout(() => {
      try { setScores({ risk, cloudflareRisk }) }
      catch (error) { console.log("[预览] 评分更新失败", String(error)) }
    }, 600)
    return () => clearTimeout(timer)
  }, [])
  const ip = "8.8.8.8"
  const report = parseIPPure(ip, { queriedIP: ip, basic: { ip }, riskIP: ip,
    risk: scores.risk, cf: { ip, risk_score: scores.cloudflareRisk } }, null)
  const modules = Object.fromEntries(PAGE_MODULES.map((id, index) => [id,
    <VStack spacing={6} alignment="leading" padding={16}
      frame={{ maxWidth: "infinity", alignment: "leading" }} background={index % 2 ? BAND_BG : SURFACE}>
      <Text font={16} fontWeight="bold">{titles[id]}</Text>
      <Text font={12} foregroundStyle="secondaryLabel">{id === "overview" ? "8.8.8.8 · AS15169" : "示例数据"}</Text>
    </VStack>,
  ])) as PageModuleViews
  Object.assign(modules, scoreModules(report, ip))
  return <NavigationStack>
    <ScrollView background={PAGE_BG} scrollIndicator="hidden" navigationTitle="Report ip" navigationBarTitleDisplayMode="inline">
      <VStack spacing={0} padding={{ horizontal: 12, top: 10, bottom: 28 }} frame={{ maxWidth: 760 }}>
        <VStack spacing={0} background={SURFACE} clipShape={{ type: "rect", cornerRadius: 18 }}>
          <SortableModules modules={modules} manual={manual} initialOrder={[...PAGE_MODULES]} onOrderChange={() => {}} />
        </VStack>
      </VStack>
    </ScrollView>
  </NavigationStack>
}
