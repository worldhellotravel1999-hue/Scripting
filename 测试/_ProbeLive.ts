// 运行时自检：对比宿主真实账号清单（Assistant.getProviders）与页面实际使用的模型键。
// 运行：scripting-ts run _ProbeLive.ts
// 用途：确认删除的模型 / 被替换的分组不会再出现在页面清单里。
import { Script } from "scripting"
import { flattenModels, loadProviders } from "./providers"

async function main() {
  const providers = await Assistant.getProviders()
  console.log("宿主账号:", providers.length)
  const liveKeys: string[] = []
  for (const p of providers) {
    const label = typeof p.provider === "string" ? p.provider : "custom:" + p.provider.custom
    console.log("  ", label, "| id=" + p.providerID, "| models=" + Object.keys(p.models ?? {}).join(","))
    for (const id of Object.keys(p.models ?? {})) {
      liveKeys.push(typeof p.provider === "string" ? `b/${p.name}/${id}` : `c/${p.provider.custom}/${id}`)
    }
  }

  const snapshot = await loadProviders()
  const pageKeys = flattenModels(snapshot).map(m => m.key)
  console.log("页面模型:", pageKeys.length)
  for (const key of pageKeys) console.log("  ", key)

  const missing = pageKeys.filter(key => !liveKeys.includes(key))
  const dropped = liveKeys.filter(key => !pageKeys.includes(key))
  console.log("多出的（应为空）:", JSON.stringify(missing))
  console.log("漏掉的（应为空）:", JSON.stringify(dropped))
  Script.exit(missing.length || dropped.length ? "MISMATCH" : "一致")
}

main().catch(e => {
  console.log("failed:", String((e as Error)?.message ?? e))
  Script.exit("failed")
})
