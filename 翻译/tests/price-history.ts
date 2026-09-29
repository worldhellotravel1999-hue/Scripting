import { Script } from "scripting"
import { parsePriceHistory, fetchPriceHistory, matchVersionIds, historyPrice } from "../core/price-history"
import { convertToCny } from "../core/pricing"
async function main() {
  const change = (timestamp: string, from: number, to: number) => ({ __typename: "AppActivityPriceChange", timestamp, priceTierFrom: from, priceTierTo: to })
  const list = [
    change("2025-02-01T00:00:00Z", 1, 2),
    { __typename: "AppActivityUpdate", timestamp: "2025-02-01T00:00:00Z", versionTo: "3.2.6" },
    change("2025-01-01T00:00:00Z", 1, 0),
    change("2025-03-01T00:00:00Z", 2, 0),
    change("2025-04-01T00:00:00Z", 0, 2),
    change("2025-04-01T00:00:00Z", 0, 2),
    change("2025-05-01T00:00:00Z", 2, 1),
    change("2025-06-01T00:00:00Z", 2, 999),
    change("invalid", 1, 2),
  ]
  const rows = parsePriceHistory(list, [0, 5.99, 7.99])
  if (rows.length !== 4 || rows[0].kind !== "paid" || rows[1].kind !== "free" ||
      rows[2].version !== "3.2.6" || rows[3].version !== undefined) throw new Error("解析边界验证失败")
  const ids = matchVersionIds([
    { version: "1.0", versionId: "123" }, { version: "1.0", versionId: "124" },
    { version: " 2.0 ", versionId: " 456 " }, { version: "3.0", versionId: "bad" },
  ])
  if (ids.has("1.0") || ids.has("3.0") || ids.get("2.0") !== "456") throw new Error("版本 ID 歧义处理失败")
  if (convertToCny(14, "USD", { USD: 2 }) !== "≈ ¥7.00" || convertToCny(14, "USD", {}) !== null) throw new Error("汇率换算失败")
  if (!historyPrice(1200, "JPY", "ja-JP").includes("1,200")) throw new Error("日元格式错误")
  const [actual, japan] = await Promise.all([
    fetchPriceHistory("1642733080"), fetchPriceHistory("1642733080", { regionCode: "jp" }),
  ])
  if (!japan.length || japan[0].to === actual[0]?.to) throw new Error("地区价格未隔离")
  console.log(JSON.stringify({ japan: japan.slice(0, 1), versionIds: actual.filter(r => r.versionId).length }))
  if (!actual.length || !actual.some(r => r.to > r.from)) throw new Error("真实涨价记录为空")
  let invalidRejected = false
  try { await fetchPriceHistory("invalid") } catch { invalidRejected = true }
  if (!invalidRejected) throw new Error("无效 ID 未拒绝")
  Script.exit(JSON.stringify({ parser: "passed", invalidId: "passed", liveCount: actual.length, sample: actual.slice(0, 2) }))
}
void main().catch(e => Script.exit(`FAILED: ${e.message}`))
