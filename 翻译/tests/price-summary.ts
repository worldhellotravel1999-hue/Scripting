import { Script } from "scripting"
import { getRegionPrices, type RegionPrice } from "../core/pricing"

// Minecraft has public paid-app and in-app prices. Fetch the header first, then
// the opened panel: a cached header must never suppress the panel's purchases.
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

async function main() {
  const timer = setTimeout(() => Script.exit("FAIL: price-summary deadline"), 40000)
  try {
    const appid = "479516143"
    const summaryUpdates: RegionPrice[] = []
    const [summary, sameSummary] = await Promise.all([
      getRegionPrices(appid, ["us"], rows => summaryUpdates.push(...rows), { includeInAppPurchases: false }),
      getRegionPrices(appid, ["us"], undefined, { includeInAppPurchases: false }),
    ])
    const header = summary[0]
    assert(header && !header.unavailable && (header.price ?? 0) > 0, "摘要没有返回本体价格")
    assert(header.cny, "摘要没有返回人民币换算")
    assert(header.inAppPurchases.length === 0 && !header.inAppLoading && !header.inAppError, "摘要意外加载了内购")
    assert(sameSummary[0] === header, "相同摘要请求没有共享在途任务")
    assert(summaryUpdates.length > 1 && summaryUpdates.every(row => !row.inAppLoading && row.inAppPurchases.length === 0), "摘要进度混入完整内购数据")
    const cachedSummary = await getRegionPrices(appid, ["us"], undefined, { includeInAppPurchases: false })
    assert(cachedSummary[0] === header, "已完成的摘要未复用缓存")
    console.log(`PASS header summary: ${header.formatted} / ${header.cny}; no in-app data`)

    const full = await getRegionPrices(appid, ["us"])
    assert(full[0] !== header, "完整面板错误复用了摘要缓存")
    assert(!full[0].inAppError, `完整面板内购查询失败：${full[0].inAppError}`)
    assert(full[0].inAppPurchases.length > 0 && !full[0].inAppLoading, "展开面板未查询内购")
    assert(full[0].inAppPurchases.every(item => item.price === null || item.cny), "内购人民币换算不完整")
    const cachedFull = await getRegionPrices(appid, ["us"])
    assert(cachedFull[0] === full[0], "完整内购结果未复用缓存")
    const summaryAgain = await getRegionPrices(appid, ["us"], undefined, { includeInAppPurchases: false })
    assert(summaryAgain[0] === header && summaryAgain[0].inAppPurchases.length === 0, "完整结果污染了摘要缓存")
    console.log(`PASS opened price panel: ${full[0].inAppPurchases.length} purchases; independent cache`)
    clearTimeout(timer)
    Script.exit("PASS: summary/full isolation, concurrent sharing, conversion, cache")
  } catch (reason) {
    clearTimeout(timer)
    console.error(String(reason))
    Script.exit(`FAIL: ${String(reason)}`)
  }
}
void main()
