import { Response, Script } from "scripting"
import { readSurgeJSON } from "../utils/network_surge"

async function run() {
  const failures: string[] = []
  let passed = 0
  const check = (name: string, condition: boolean) => condition ? passed++ : failures.push(name)
  const normal = await readSurgeJSON(new Response('{"node":"hello"}', { status: 200 }))
  check("有效 JSON 响应正常解析", normal.status === 200 && (normal.data as { node?: string })?.node === "hello")
  const large = await readSurgeJSON(new Response("x".repeat(1_048_577), { status: 200 }))
  check("超过 1 MiB 的响应被拒绝", large.status === 200 && large.data === null)
  const invalid = await readSurgeJSON(new Response("{", { status: 200 }))
  check("损坏 JSON 被拒绝", invalid.status === 200 && invalid.data === null)
  const denied = await readSurgeJSON(new Response("denied", { status: 403 }))
  check("非成功响应保留状态", denied.status === 403 && denied.data === null)
  const sanitized = await readSurgeJSON(new Response('{"text":"my-secret and my-secret"}', { status: 200 }), "my-secret")
  check("响应中的密钥被隐藏", !JSON.stringify(sanitized).includes("my-secret"))
  Script.exit({ passed, failed: failures.length, failures, offline: true })
}
void run().catch(error => Script.exit({ failed: 1, failures: [String(error)] }))
