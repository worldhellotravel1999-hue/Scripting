import { Script } from "scripting"
import { fetchAppVersions } from "../core/versions"

/**
 * 版本 ID 查询计时：验证「首源胜出 + 0.7s 汇合窗口 + 2 分钟缓存」。
 * 期望：冷查询远快于旧 allSettled 慢源拖尾（通常 10s），且同 appid 二次调用命中缓存。
 */
function assert(value: unknown, message: string) {
  if (!value) throw new Error(message)
}

async function timed(appid: string, label: string) {
  const start = Date.now()
  const entries = await fetchAppVersions(appid)
  const elapsed = Date.now() - start
  assert(entries.length > 0 && entries[0].versionId && entries[0].version, `${label}: 返回数据不完整`)
  return { label, elapsed, count: entries.length, top: entries[0].version }
}

async function run() {
  const apps = [
    { appid: "1442620678", label: "Surge US" },
    { appid: "1443988620", label: "Quantumult X JP" },
    { appid: "6479691128", label: "Scripting CN" },
  ]
  const cold = []
  for (const app of apps) cold.push(await timed(app.appid, app.label))
  console.log("COLD", JSON.stringify(cold))
  const warm = []
  for (const app of apps) warm.push(await timed(app.appid, `${app.label} (cache)`))
  console.log("WARM", JSON.stringify(warm))
  assert(warm.every(item => item.elapsed < 50), "缓存未生效")
  Script.exit("PASS")
}

void run().catch(reason => { console.error(String(reason)); Script.exit("FAIL") })
