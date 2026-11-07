// 诊断：直接对 Workbuddy / global:glm-5.3-flash 发起请求，打印宿主返回的错误与流式分片。
const provider = { custom: "Workbuddy" } as const
const modelId = "global:glm-5.3-flash"

async function run(label: string, systemPrompt: string, content: string) {
  const began = Date.now()
  try {
    const stream = await Assistant.requestStreaming({
      provider, modelId, systemPrompt,
      messages: [{ role: "user", content }],
    } as any)
    const reader = stream.getReader()
    let text = ""
    let kinds: string[] = []
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      const value: any = chunk.value
      kinds.push(String(value?.type))
      if (value?.type === "text") text += value.content
    }
    console.log(`[${label}] ok ${Date.now() - began}ms kinds=${[...new Set(kinds)].join(",")} text=${JSON.stringify(text.slice(0, 200))}`)
  } catch (error) {
    console.log(`[${label}] ERROR ${Date.now() - began}ms: ${String((error as any)?.message ?? error)}`)
  }
}

async function main() {
  await run("small", "This is an API health check. Reply with exactly OK and nothing else.", "Reply with exactly: OK")
  await run("quota", "This is an API health check. Reply with exactly OK and nothing else.", "The quick brown fox jumps over the lazy dog. ".repeat(1800) + "\n\nReply with exactly: OK")
}

main().then(() => console.log("done"))
