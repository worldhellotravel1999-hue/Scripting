import { VStack, Text, useEffect, useState } from "scripting"
import { captureAppRavenSession, getActiveAppRavenAccount, getSavedAppRavenAccounts, isAppRavenLoggedOut } from "../core/appraven"

export default function ProbeMountSession() {
  // 模合集页挂载路径：useState 初始化器里同步取会话
  const [mountSession, setMountSession] = useState(() => {
    try {
      const active = getActiveAppRavenAccount()
      return active ? `ok:${captureAppRavenSession(active.id).accountId}` : "no-account"
    } catch (reason) {
      return `mount-ERR:${reason instanceof Error ? reason.message : String(reason)}`
    }
  })
  const [later, setLater] = useState("pending")
  useEffect(() => {
    let value = ""
    try {
      const active = getActiveAppRavenAccount()
      value = active ? `ok:${captureAppRavenSession(active.id).accountId}` : "no-account"
      setLater(value)
    } catch (reason) {
      value = `later-ERR:${reason instanceof Error ? reason.message : String(reason)}`
      setLater(value)
    }
    try {
      const raw = Storage.get("lingo_appraven_accounts_v1", { shared: true })
      let cookieState = "?"
      try {
        const saved = getSavedAppRavenAccounts()
        cookieState = saved.length === 0 ? "no-accounts" : (captureAppRavenSession(saved[0].id) ? "cookie-ok" : "cookie-null")
      } catch (e) {
        cookieState = `cookieERR:${e instanceof Error ? e.message : String(e)}`
      }
      console.log(`PROBE-MOUNT mount=${mountSession} later=${value} loggedOut=${isAppRavenLoggedOut()} cookie=${cookieState}\nraw=${JSON.stringify(raw)?.slice(0, 500)}`)
    } catch (reason) {
      console.log(`PROBE-MOUNT logERR ${String(reason)}`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <VStack spacing={4} padding={12}>
      <Text font="caption">mount: {mountSession}</Text>
      <Text font="caption">later: {later}</Text>
    </VStack>
  )
}
