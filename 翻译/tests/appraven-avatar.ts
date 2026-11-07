import { Script } from "scripting"
import {
  APPRAVEN_DEFAULT_USER_ICON_URL,
  appRavenUserIconURL,
  parseAppRavenUser,
} from "../core/appraven"

const passed: string[] = []

function equal<T>(actual: T, expected: T, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

function run() {
  equal(
    appRavenUserIconURL("abc123"),
    "https://appraven.net/appraven/images/user/icons/abc123.jpg",
    "avatar URL",
  )
  equal(appRavenUserIconURL(""), APPRAVEN_DEFAULT_USER_ICON_URL, "empty avatar falls back to default")
  equal(appRavenUserIconURL(undefined), APPRAVEN_DEFAULT_USER_ICON_URL, "missing avatar falls back to default")
  equal(
    parseAppRavenUser({ id: "u1", username: "a", displayName: "A", iconSmall: "s1", iconMedium: "m1" }),
    { id: "u1", username: "a", displayName: "A", iconSmall: "s1", iconMedium: "m1" },
    "user icons parsed",
  )
  equal(
    parseAppRavenUser({ id: "u1" }),
    { id: "u1" },
    "user without icons stays clean",
  )
  passed.push("头像 URL 拼接与用户解析")
  return passed
}

try {
  const result = run()
  console.log(JSON.stringify({ passed: result }))
  Script.exit({ passed: result })
} catch (reason) {
  const message = reason instanceof Error ? reason.message : String(reason)
  console.log(JSON.stringify({ failed: message, passed }))
  Script.exit({ failed: message, passed })
}
