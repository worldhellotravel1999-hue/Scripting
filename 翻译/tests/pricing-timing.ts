import { Script } from "scripting"
import { getRegionPrices } from "../core/pricing"
const start = Date.now()
const events: string[] = []
const seen = new Set<string>()
void getRegionPrices("1443988620", ["us", "kr", "jp"], (rows) => {
  for (const row of rows) {
    const stage = row.loading ? "pending" : row.inAppLoading ? (row.cny ? "converted" : "base") : "iap-ready"
    const key = `${row.region}:${stage}`
    if (!seen.has(key)) {
      seen.add(key)
      events.push(`${Date.now() - start}ms ${key} ${row.formatted}`)
    }
  }
}).then(() => Script.exit(events.join("\n"))).catch((e) => Script.exit(String(e)))
