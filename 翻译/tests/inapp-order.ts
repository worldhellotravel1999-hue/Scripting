import { Script } from "scripting"
import { getRegionPrices } from "../core/pricing"

/** 用户报告场景：Surge 5 的 Feature Subscription / Surge Pro 在各国顺序跳动。 */
const SURGE = "1442620678"
/** 内购条目多、且带同价并列，用来检验排序在长列表上的稳定性（各国商品集合不同，只查各列表自身有序）。 */
const MINECRAFT = "479516143"

function priceKey(value: number | null): number {
  return value === null ? Number.NEGATIVE_INFINITY : value
}

function isDescending(prices: (number | null)[]): boolean {
  for (let i = 1; i < prices.length; i++) {
    if (priceKey(prices[i - 1]) < priceKey(prices[i])) return false
  }
  return true
}

async function check(
  appid: string,
  label: string,
  regions: string[],
  requireSameOrder: boolean,
  lines: string[],
): Promise<boolean> {
  const rows = await getRegionPrices(appid, regions)
  let ok = true
  const sequences = new Map<string, string>()
  for (const row of rows) {
    const names = row.inAppPurchases.map((item) => item.name)
    const prices = row.inAppPurchases.map((item) => item.price)
    const desc = isDescending(prices)
    if (!desc) ok = false
    if (names.length) sequences.set(row.region, names.join(" | "))
    lines.push(`${label} ${row.region}: [${names.join(" | ")}] desc=${desc}${row.inAppError ? ` error=${row.inAppError}` : ""}`)
  }
  if (sequences.size < 2) {
    ok = false
    lines.push(`${label} FAIL: 有效地区不足（${sequences.size}）`)
  } else if (requireSameOrder && new Set(sequences.values()).size !== 1) {
    ok = false
    lines.push(`${label} FAIL: 各地区顺序不一致`)
  }
  return ok
}

async function main() {
  const lines: string[] = []
  lines.push(`surge expected: [Surge Pro | Feature Subscription]`)
  let ok = true
  ok = await check(SURGE, "surge", ["us", "kr", "jp", "gb", "hk", "de"], true, lines) && ok
  ok = await check(MINECRAFT, "minecraft", ["us", "jp"], false, lines) && ok
  lines.push(ok ? "OK: 所有地区内购顺序一致且按价格高→低" : "FAIL: 见上方明细")
  Script.exit(lines.join("\n"))
}

void main().catch((e) => Script.exit("FATAL " + String(e)))
