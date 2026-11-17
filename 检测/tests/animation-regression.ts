import { Script } from "scripting"
import { animateIfCurrent } from "../theme"

async function run() {
  const failures: string[] = []
  let passed = 0
  const check = (name: string, condition: boolean) => condition ? passed++ : failures.push(name)
  const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
  let current = 1
  const updates: string[] = []
  animateIfCurrent(() => current === 1, () => updates.push("old"), Animation.easeOut(0.01))
  current = 2
  animateIfCurrent(() => current === 2, () => updates.push("current"), Animation.easeOut(0.01))
  await delay(100)
  check("旧轮次延迟动画不提交", !updates.includes("old"))
  check("当前轮次正常提交", updates.join(",") === "current")
  animateIfCurrent(() => false, () => updates.push("cancelled"), Animation.easeOut(0.01))
  await delay(20)
  check("过期轮次不发起状态更新", !updates.includes("cancelled"))
  Script.exit({ passed, failed: failures.length, failures })
}
void run().catch(error => Script.exit({ failed: 1, failures: [String(error)] }))
