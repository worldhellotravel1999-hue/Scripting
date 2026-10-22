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

try {
  Storage.set(KEY, {
    versions: {
      "111": { at: now, entries: [
        { version: "2.0", versionId: "200" },
        { version: "1.0", versionId: "100" },
      ] },
      "222": { at: now - 8 * DAY, entries: [{ version: "9.9", versionId: "999" }] },
      "333": { at: now, entries: "not-an-array" },
    },
    notes: {
      "111:us": { at: now, entries: [{ version: "2.0", notes: "Historical notes" }] },
      "111:hk": { at: now, entries: [{ version: "2.0", notes: "HK notes" }] },
      "222:us": { at: now - 8 * DAY, entries: [{ version: "9.9", notes: "Expired" }] },
    },
  }, { shared: true })

  const versions = peekCachedAppVersions("111")
  assert(versions?.length === 2 && versions[0].versionId === "200", "版本号共享缓存未命中")
  assert(peekCachedAppVersions("222") === null, "过期版本缓存不应命中")
  assert(peekCachedAppVersions("333") === null, "损坏版本缓存不应命中")
  assert(peekCachedAppVersions("444") === null, "无缓存应返回 null")

  const us = peekCachedVersionNotes("111", "us")
  assert(us?.length === 1 && us[0].notes === "Historical notes", "美区历史说明缓存未命中")
  const hk = peekCachedVersionNotes("111", "HK")
  assert(hk?.length === 1 && hk[0].notes === "HK notes", "地区大小写未归一")
  const unknown = peekCachedVersionNotes("111", "xx")
  assert(unknown?.[0]?.notes === "Historical notes", "未知地区应回退美区缓存")
  assert(peekCachedVersionNotes("222", "us") === null, "过期历史说明缓存不应命中")
  assert(peekCachedVersionNotes("111", "jp") === null, "无该地区缓存应返回 null")

  Storage.remove(KEY, { shared: true })
  assert(peekCachedAppVersions("111") !== null, "内存缓存应仍在（同进程）")
  console.log("PASS: shared version/notes cache, region normalization, expiry and malformed data")
  Script.exit("PASS")
} catch (error) {
  try { Storage.remove(KEY, { shared: true }) } catch {}
  console.error(String(error))
  Script.exit("FAIL")
}
