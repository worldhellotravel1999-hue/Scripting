import { ScrollView, Text, VStack } from "scripting"
import type { VirtualNode } from "scripting"
import { ACCENT, FlagRow, Note, RiskScale, SURFACE } from "../theme"
import { shouldShowRiskScale } from "../utils/flags"

function Card({ title, hint, children }: {
  title: string; hint: string; children: VirtualNode | VirtualNode[]
}) {
  return <VStack alignment="leading" spacing={10} padding={{ horizontal: 16, vertical: 15 }}
    frame={{ maxWidth: "infinity", alignment: "leading" }} background={SURFACE}
    clipShape={{ type: "rect", cornerRadius: 18 }}>
    <VStack alignment="leading" spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      <Text font={16} fontWeight="bold">{title}</Text>
      <Text font={10} foregroundStyle="secondaryLabel">{hint}</Text>
    </VStack>
    {children}
  </VStack>
}

export default function PreviewFlags() {
  return <ScrollView background="#EDF1F6">
    <VStack spacing={14} padding={16} frame={{ maxWidth: 520, alignment: "center" }}>
      <Card title="命中场景" hint="仅阳性项">
        <FlagRow label="代理标记" delay={0} />
        <FlagRow label="VPN 标记" delay={55} />
        <FlagRow label="Tor 出口" delay={110} color={ACCENT.pink} />
        <FlagRow label="受侵害标记" delay={165} color={ACCENT.red} />
        <Note text="仅列出已命中项；未命中的 VPN / 匿名化 / 爬虫不生成任何行。" />
      </Card>

      <Card title="未命中场景" hint="不占位">
        <Text font={13} foregroundStyle="secondaryLabel">下方故意不渲染任何标记行</Text>
        <Note text="代理 / VPN / Tor / 匿名化 / 爬虫 / 受侵害均为 false 或 null 时，整区为空。" />
      </Card>

      <Card title="proxycheck 风险" hint="0 分隐藏刻度条">
        {shouldShowRiskScale(0) ? <RiskScale value={0} />
          : <Text font={13} foregroundStyle="secondaryLabel">0 分：不渲染刻度条，也不显示文字提示</Text>}
        <Note text="无风险时整条刻度不占位；只有正分才显示 RiskScale。" />
      </Card>

    </VStack>
  </ScrollView>
}
