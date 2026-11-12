import { AbortController, Script } from "scripting"
import { fetchExitProbe, fetchIPInfo } from "../utils/ip"
import { fetchIPPure } from "../utils/ippure"

async function run() {
  const controller = new AbortController()
  controller.abort()
  const failures: string[] = []
  let passed = 0
  const check = (name: string, condition: boolean) => condition ? passed++ : failures.push(name)
  const started = Date.now()
  const [exit, info, pure] = await Promise.all([
    fetchExitProbe(controller.signal),
    fetchIPInfo("8.8.8.8", controller.signal),
    fetchIPPure("8.8.8.8", () => true, controller.signal),
  ])
  check("已取消时不再寻找出口", exit === null)
  check("已取消时不请求主归属源", info === null)
  check("已取消时不显示 IPPure 结果", pure.risk === null && pure.cloudflareRisk === null && pure.source === null)
  check("预取消及时返回", Date.now() - started < 2000)
  Script.exit({ passed, failed: failures.length, failures })
}
void run().catch(error => Script.exit({ failed: 1, failures: [String(error)] }))
