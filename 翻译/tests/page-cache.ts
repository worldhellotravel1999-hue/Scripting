// 开页缓存读写往返测试：miss / 列表 / 已加入 / 分 App 键 / 空列表 / 静默容错。
import { Script } from "scripting"
import {
  readCachedJoinedState,
  readCachedUserCollections,
  writeCachedJoinedState,
  writeCachedUserCollections,
} from "../core/appraven"

const results: string[] = []
const CACHE_KEY = "lingo_appraven_page_cache_v1"
const scope = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const account1 = `${scope}-1`
const account2 = `${scope}-2`
const joinedKey = `${account1}:${scope}-app`
const originalCache = Storage.get<Record<string, any>>(CACHE_KEY, { shared: true })

function restoreCache() {
  try {
    const current = Storage.get<Record<string, any>>(CACHE_KEY, { shared: true }) || {}
    const merged = { ...(originalCache || {}), ...current }
    const collections = { ...(merged.collections || {}) }
    const joined = { ...(merged.joined || {}) }
    for (const id of [account1, account2]) {
      const value = originalCache?.collections?.[id]
      if (value !== undefined) collections[id] = value
      else delete collections[id]
    }
    const originalJoined = originalCache?.joined?.[joinedKey]
    if (originalJoined !== undefined) joined[joinedKey] = originalJoined
    else delete joined[joinedKey]
    const next = { ...merged }
    if (Object.keys(collections).length) next.collections = collections
    else delete next.collections
    if (Object.keys(joined).length) next.joined = joined
    else delete next.joined
    if (originalCache === null && Object.keys(next).length === 0) Storage.remove(CACHE_KEY, { shared: true })
    else Storage.set(CACHE_KEY, next, { shared: true })
  } catch {}
}

try {
// 1. 未写入 → miss
results.push(readCachedUserCollections(account1) === null ? "miss-ok" : `miss-fail:${JSON.stringify(readCachedUserCollections(account1))}`)

// 2. 列表写读
const list = [
  { id: "c1", title: "收藏 A", appCount: 3 },
  { id: "c2", title: "收藏 B", appCount: 0, topArtworks: ["x"] },
]
writeCachedUserCollections(account1, list)
const back = readCachedUserCollections(account1)
results.push(back && back.length === 2 && back[1].title === "收藏 B" && back[1].appCount === 0 ? "list-ok" : `list-fail:${JSON.stringify(back)}`)

// 3. 已加入状态写读
writeCachedJoinedState(account1, `${scope}-app`, "app-internal", ["c1", "c2"])
const joined = readCachedJoinedState(account1, `${scope}-app`)
results.push(joined && joined.internalAppId === "app-internal" && joined.joinedIds.length === 2 ? "joined-ok" : `joined-fail:${JSON.stringify(joined)}`)

// 4. 不同 App 键互不可见
results.push(readCachedJoinedState(account1, `${scope}-other-app`) === null ? "appkey-ok" : "appkey-fail")
// 5. 不同账号互不可见
results.push(readCachedUserCollections(account2) === null ? "acctkey-ok" : "acctkey-fail")

// 6. 空列表是有效缓存（区别于 miss）
writeCachedUserCollections(account2, [])
const empty = readCachedUserCollections(account2)
results.push(Array.isArray(empty) && empty.length === 0 ? "empty-ok" : `empty-fail:${JSON.stringify(empty)}`)

// 7. 垃圾数据不崩溃（写坏值由 readPageCache 过滤）
try {
  const current = Storage.get<Record<string, any>>(CACHE_KEY, { shared: true }) || {}
  Storage.set(CACHE_KEY, { ...current, joined: { ...(current.joined || {}), [joinedKey]: { bad: 1 } } }, { shared: true })
  results.push(readCachedJoinedState(account1, `${scope}-app`) === null ? "corrupt-ok" : "corrupt-fail")
} catch (reason) {
  results.push(`corrupt-threw:${reason}`)
}

// 8. 恢复第 3 步的数据（第 7 步清了存储）
writeCachedJoinedState(account1, `${scope}-app`, "app-internal", ["c1"])
const restored = readCachedJoinedState(account1, `${scope}-app`)
results.push(restored && restored.joinedIds.join(",") === "c1" ? "restore-ok" : `restore-fail:${JSON.stringify(restored)}`)

} catch (reason) {
  results.push(`unexpected-error:${reason}`)
} finally {
  restoreCache()
}

const allOk = results.every(line => line.endsWith("-ok"))
Script.exit(`${allOk ? "PASS" : "FAIL"}\n${results.join("\n")}`)
