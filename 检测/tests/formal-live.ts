import { AbortController, Script } from "scripting"
import { fetchExitProbe } from "../utils/ip"
import { fetchIPPure } from "../utils/ippure"

;(async () => {
  const controller = new AbortController()
  try {
    const started = Date.now()
    const probe = await fetchExitProbe(controller.signal)
    console.log(`[exit] ${Date.now() - started}ms ${JSON.stringify(probe)}`)
    if (!probe) { Script.exit({ probe: null }); return }
    const pureStarted = Date.now()
    const pure = await fetchIPPure(probe.address, () => true, controller.signal)
    console.log(`[pure] ${Date.now() - pureStarted}ms traffic=${JSON.stringify(pure.traffic)} risk=${pure.risk} asn=${pure.asn} source=${pure.source} note=${pure.note}`)
    Script.exit({ probe: { source: probe.source }, pure: { traffic: pure.traffic, risk: pure.risk, asn: pure.asn, source: pure.source } })
  } catch (error) {
    Script.exit({ error: String(error) })
  }
})()
