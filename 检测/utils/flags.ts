import type { LookupResult } from "./lookup"

export type RiskFlagId = "proxy" | "vpn" | "tor" | "anonymous" | "scraper" | "compromised"
export type RiskFlag = { id: RiskFlagId; label: string; short: string }

const ORDER: RiskFlag[] = [
  { id: "proxy", label: "代理标记", short: "代理" },
  { id: "vpn", label: "VPN 标记", short: "VPN" },
  { id: "tor", label: "Tor 出口", short: "Tor" },
  { id: "anonymous", label: "匿名化标记", short: "匿名化" },
  { id: "scraper", label: "爬虫标记", short: "爬虫" },
  { id: "compromised", label: "受侵害标记", short: "受侵害" },
]

/**
 * 只返回数据库明确命中的标记。false 与 null 都不占位：
 * 未标记、查询中、暂无数据不再生成任何行。
 * proxy 已由页面按 proxycheck 优先、ip-api 兜底解析。
 */
export function activeRiskFlags(
  reputation: LookupResult["reputation"],
  proxy?: boolean | null,
): RiskFlag[] {
  const hits: Record<RiskFlagId, boolean> = {
    proxy: proxy === true || reputation?.proxy === true,
    vpn: reputation?.vpn === true,
    tor: reputation?.tor === true,
    anonymous: reputation?.anonymous === true,
    scraper: reputation?.scraper === true,
    compromised: reputation?.compromised === true,
  }
  return ORDER.filter(flag => hits[flag.id])
}

/** 至少有一个布尔标记可判定时，才能把空结果称为“未标记”。 */
export function hasKnownRiskFlags(
  reputation: LookupResult["reputation"],
  proxy?: boolean | null,
): boolean {
  if (proxy != null) return true
  return !!reputation && [
    reputation.proxy, reputation.vpn, reputation.tor,
    reputation.anonymous, reputation.scraper, reputation.compromised,
  ].some(value => value != null)
}

/** 0 分代表无风险，不渲染刻度条；缺失与正分分别交给待获取状态和 RiskScale。 */
export function shouldShowRiskScale(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}
