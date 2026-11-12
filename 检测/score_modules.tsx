import type { VirtualNode } from "scripting"
import { Band, Note, RiskScale } from "./theme"
import { hasRiskScore, shouldShowRiskScale } from "./utils/flags"
import type { IPPureReport } from "./utils/ippure"

/** 两个来源独立判断；无有效评分时连同标题、说明和排序项一起隐藏。 */
export function scoreModules(pure: IPPureReport | null, ip: string): Record<"ippure" | "cloudflare", VirtualNode | null> {
  const risk = pure?.risk
  const cloudflareRisk = pure?.cloudflareRisk
  return {
    ippure: hasRiskScore(risk) ? <Band title="IPPure 系数" icon="shield.lefthalf.filled" hint="IPPure" shaded order={3}>
      {shouldShowRiskScale(risk) ? <RiskScale key={`pure-${ip}`} value={risk} /> : null}
      {pure?.note ? <Note text={pure.note} /> : null}
    </Band> : null,
    cloudflare: hasRiskScore(cloudflareRisk) ? <Band title="Cloudflare 系数" hint="经 IPPure" order={4}>
      {shouldShowRiskScale(cloudflareRisk) ? <RiskScale key={`cf-${ip}`} value={cloudflareRisk} /> : null}
      <Note text="浏览器检测分数会变化；仅显示与查询 IP 一致的结果。" />
    </Band> : null,
  }
}
