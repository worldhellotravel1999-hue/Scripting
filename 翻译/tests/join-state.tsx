// 冒烟：真机容器内跑通「已加入状态」新链路（AUTHOR 条目同源）。
// 输出写 tests/join-state-out.txt（console 在预览窗口末尾一并返回）。
import { Script, Text, VStack, useEffect, useState } from "scripting"
import {
  captureAppRavenSession,
  getActiveAppRavenAccount,
  getAppRavenCollectionItems,
  getJoinedAppRavenCollectionIds,
  getUserAppRavenCollections,
} from "../core/appraven"

const OUT = Script.directory + "/tests/join-state-out.txt"

function append(line: string) {
  try { FileManager.appendTextSync(OUT, line + "\n") } catch {}
}

async function run(): Promise<string> {
  const account = getActiveAppRavenAccount()
  if (!account) return "no active account"
  const session = captureAppRavenSession(account.id)
  if (!session) return "no session"
  append(`--- start ${new Date().toISOString()} account=${account.username}`)
  const t1 = Date.now()
  const mine = await getUserAppRavenCollections(account.id, session)
  append(`mine=${mine.length} in ${Date.now() - t1}ms: ${mine.map(item => `${item.id}(${item.title}:${item.appCount})`).join(", ")}`)
  // 正向对照：取第一个合集里的真实条目 App，它必须被判为「已加入」。
  const target = mine[0]
  const items = await getAppRavenCollectionItems(target.id, 0, session)
  const sample = items.content.find(item => !!item.app?.id)
  if (!sample?.app) return "FAIL: 合集首页无条目，无法做正向对照"
  const t2 = Date.now()
  const ids = await getJoinedAppRavenCollectionIds(sample.app.id, mine.map(item => item.id), session)
  const detected = ids.has(target.id)
  append(`positive control: app=${sample.app.title || sample.app.id} 期望=${target.id}(${target.title}) 检出=${detected} in ${Date.now() - t2}ms [${[...ids].join(", ")}]`)
  const titles = mine.filter(item => ids.has(item.id)).map(item => item.title)
  return `${detected ? "OK" : "FAIL 未检出"} 正向对照：${sample.app.title || sample.app.id} → 已加入=${ids.size}（${titles.join(" / ")}）`
}

export default function JoinStateSmoke() {
  const [result, setResult] = useState("running…")
  useEffect(() => {
    let cancelled = false
    void run().then(
      value => { append(`done: ${value}`); if (!cancelled) setResult(value) },
      reason => { const text = `FAIL: ${reason instanceof Error ? reason.message : String(reason)}`; append(text); if (!cancelled) setResult(text) },
    )
    return () => { cancelled = true }
  }, [])
  return (
    <VStack spacing={8} padding={16}>
      <Text>join-state smoke</Text>
      <Text font="caption">{result}</Text>
    </VStack>
  )
}
