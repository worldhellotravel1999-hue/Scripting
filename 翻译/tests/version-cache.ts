import { Script } from "scripting"
import { peekCachedAppVersions, peekCachedVersionNotes } from "../core/versions"

/**
 * 跨进程版本缓存回归：
 * 1) 分享扩展是新进程，只能用共享 Storage 里的上次结果首帧出列表；
 * 2) 地区必须与 fetch 使用同一 key，未知地区回退美区；
 * 3) 过期（>7 天）或结构损坏的数据不能当缓存用。
 */
function assert(value: unknown, message: string) {
  if (!value) throw new Error(message)
}

const KEY = "lingo_app_version_cache_v1"
const DAY = 24 * 60 * 60 * 1000
const now = Date.now()
const scope = `${now}${Math.floor(Math.random() * 1_000_000).toString().padStart(6, "0")}`
const versionIds = [`${scope}1`, `${scope}2`, `${scope}3`]
const noteKeys = [`${versionIds[0]}:us`, `${versionIds[0]}:hk`, `${versionIds[1]}:us`]
const original = Storage.get<Record<string, any>>(KEY, { shared: true })

function updateTestEntries(source: Record<string, any> | null, restoreOriginal: boolean) {
  const current = Storage.get<Record<string, any>>(KEY, { shared: true }) || {}
  const versions = { ...(current.versions || {}) }
  const notes = { ...(current.notes || {}) }
  for (const id of versionIds) {
    const value = source?.versions?.[id]
    if (restoreOriginal && value !== undefined) versions[id] = value
    else if (!restoreOriginal) versions[id] = id === versionIds[0]
      ? { at: now, entries: [{ version: "2.0", versionId: "200" }, { version: "1.0", versionId: "100" }] }
      : id === versionIds[1]
        ? { at: now - 8 * DAY, entries: [{ version: "9.9", versionId: "999" }] }
        : { at: now, entries: "not-an-array" }
    else delete versions[id]
  }
  for (const key of noteKeys) {
    const value = source?.notes?.[key]
    if (restoreOriginal && value !== undefined) notes[key] = value
    else if (!restoreOriginal) notes[key] = key === noteKeys[0]
      ? { at: now, entries: [{ version: "2.0", notes: "Historical notes" }] }
      : key === noteKeys[1]
        ? { at: now, entries: [{ version: "2.0", notes: "HK notes" }] }
        : { at: now - 8 * DAY, entries: [{ version: "9.9", notes: "Expired" }] }
    else delete notes[key]
  }
  Storage.set(KEY, { ...current, versions, notes }, { shared: true })
}

function restore() {
  try { updateTestEntries(original, true) } catch {}
}

let passed = false
try {
  updateTestEntries(null, false)

  const versions = peekCachedAppVersions(versionIds[0])
  assert(versions?.length === 2 && versions[0].versionId === "200", `版本号共享缓存未命中：${JSON.stringify(versions)}`)
  assert(peekCachedAppVersions(versionIds[1]) === null, "过期版本缓存不应命中")
  assert(peekCachedAppVersions(versionIds[2]) === null, "损坏版本缓存不应命中")
  assert(peekCachedAppVersions(`${scope}-missing`) === null, "无缓存应返回 null")

  const us = peekCachedVersionNotes(versionIds[0], "us")
  assert(us?.length === 1 && us[0].notes === "Historical notes", "美区历史说明缓存未命中")
  const hk = peekCachedVersionNotes(versionIds[0], "HK")
  assert(hk?.length === 1 && hk[0].notes === "HK notes", "地区大小写未归一")
  const unknown = peekCachedVersionNotes(versionIds[0], "xx")
  assert(unknown?.[0]?.notes === "Historical notes", "未知地区应回退美区缓存")
  assert(peekCachedVersionNotes(versionIds[1], "us") === null, "过期历史说明缓存不应命中")
  assert(peekCachedVersionNotes(versionIds[0], "jp") === null, "无该地区缓存应返回 null")

  const current = Storage.get<Record<string, any>>(KEY, { shared: true }) || {}
  const storedVersions = { ...(current.versions || {}) }
  delete storedVersions[versionIds[0]]
  Storage.set(KEY, { ...current, versions: storedVersions }, { shared: true })
  assert(peekCachedAppVersions(versionIds[0]) !== null, "内存缓存应仍在（同进程）")
  console.log("PASS: shared version/notes cache, region normalization, expiry and malformed data")
  passed = true
} catch (error) {
  console.error(String(error))
} finally {
  restore()
}
Script.exit(passed ? "PASS" : "FAIL")
