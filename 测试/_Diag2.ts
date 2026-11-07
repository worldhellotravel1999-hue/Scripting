// 诊断 2：区分是 systemPrompt、模型、还是渠道导致“无法解析响应数据”。
import { Script } from "scripting"

type Case = { label: string; modelId: string; systemPrompt?: string; content: string }

async function run(c: Case) {
  const began = Date.now()
  try {
    const options: any = { provider: { custom: "Workbuddy" }, modelId: c.modelId, messages: [{ role: "user", content: c.content }] }
    if (c.systemPrompt !== undefined) options.systemPrompt = c.systemPrompt
    const stream = await Assistant.requestStreaming(options)
    const reader = stream.getReader()
    let text = ""
    let kinds: string[] = []
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      const value: any = chunk.value
      kinds.push(String(value?.type))
      if (value?.type === "text") text += value.content
      if (text.length > 400) break
    }
    void reader.cancel().catch(() => {})
    console.log(`[${c.label}] ok ${Date.now() - began}ms kinds=${[...new Set(kinds)].join(",")} text=${JSON.stringify(text.slice(0, 120))}`)
  } catch (error) {
    console.log(`[${c.label}] ERROR ${Date.now() - began}ms: ${String((error as any)?.message ?? error)}`)
  }
}

async function main() {
  const cases: Case[] = [
    { label: "glm/no-sys", modelId: "global:glm-5.3-flash", content: "Reply with exactly: OK" },
    { label: "glm/sys", modelId: "global:glm-5.3-flash", systemPrompt: "Reply with exactly OK and nothing else.", content: "Reply with exactly: OK" },
    { label: "luna/no-sys", modelId: "global:gpt-5.6-luna", content: "Reply with exactly: OK" },
    { label: "hy4/no-sys", modelId: "global:hy4-preview", content: "Reply with exactly: OK" },
    { label: "glm/zh", modelId: "global:glm-5.3-flash", content: "回复：OK" },
  ]
  for (const c of cases) await run(c)
}

main().then(() => Script.exit("done"))
