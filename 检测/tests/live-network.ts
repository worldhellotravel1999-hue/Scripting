import { AbortController, Script } from "scripting"
import { diagnoseNetwork } from "../utils/network"

async function run() {
  const controller = new AbortController()
  const timer = setTimeout(() => { try { controller.abort() } catch {} }, 25_000)
  try {
    const report = await diagnoseNetwork(null, controller.signal)
    // 本入口仅做人工冒烟验证，不保存快照，不输出 IP、密钥或节点名。
    Script.exit({ completed: !controller.signal.aborted, durationMs: report.durationMs,
      local: { kind: report.local.kind, hasIPv4: !!report.local.ipv4, hasIPv6: !!report.local.ipv6, tunnel: report.local.tunnel },
      domesticExitReceived: !!report.domesticExit, latency: report.latency, quic: report.quic,
      services: report.services.map(row => ({ id: row.id, state: row.state, status: row.status, ms: row.ms, regionCode: row.regionCode, regionSource: row.regionSource })) })
  } catch (error) { Script.exit({ error: String(error) }) }
  finally { clearTimeout(timer) }
}
void run()
