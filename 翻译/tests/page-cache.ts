// 开页缓存读写往返测试：miss / 列表 / 已加入 / 分 App 键 / 空列表 / 静默容错。
import { Script } from "scripting"
import {
  readCachedJoinedState,
  readCachedUserCollections,
  writeCachedJoinedState,
  writeCachedUserCollections,
} from "../core/appraven"

const results: string[] = []

// 1. 未写入 → miss
results.push(readCachedUserCollections("acct-1") === null ? "miss-ok" : `miss-fail:${JSON.stringify(readCachedUserCollections("acct-1"))}`)

// 2. 列表写读
const list = [
  { id: "c1", title: "收藏 A", appCount: 3 },
  { id: "c2", title: "收藏 B", appCount: 0, topArtworks: ["x"] },
]
writeCachedUserCollections("acct-1", list)
const back = readCachedUserCollections("acct-1")
results.push(back && back.length === 2 && back[1].title === "收藏 B" && back[1].appCount === 0 ? "list-ok" : `list-fail:${JSON.stringify(back)}`)

// 3. 已加入状态写读
writeCachedJoinedState("acct-1", "123456", "app-internal", ["c1", "c2"])
const joined = readCachedJoinedState("acct-1", "123456")
results.push(joined && joined.internalAppId === "app-internal" && joined.joinedIds.length === 2 ? "joined-ok" : `joined-fail:${JSON.stringify(joined)}`)

// 4. 不同 App 键互不可见
results.push(readCachedJoinedState("acct-1", "999999") === null ? "appkey-ok" : "appkey-fail")
// 5. 不同账号互不可见
results.push(readCachedUserCollections("acct-2") === null ? "acctkey-ok" : "acctkey-fail")

// 6. 空列表是有效缓存（区别于 miss）
writeCachedUserCollections("acct-2", [])
const empty = readCachedUserCollections("acct-2")
results.push(Array.isArray(empty) && empty.length === 0 ? "empty-ok" : `empty-fail:${JSON.stringify(empty)}`)

// 7. 垃圾数据不崩溃（写坏值由 readPageCache 过滤）
try {
  Storage.set("lingo_appraven_page_cache_v1", { joined: { bad: 1 } }, { shared: true })
  results.push(readCachedJoinedState("acct-1", "123456") === null ? "corrupt-ok" : "corrupt-fail")
} catch (reason) {
  results.push(`corrupt-threw:${reason}`)
}

// 8. 恢复第 3 步的数据（第 7 步清了存储）
writeCachedJoinedState("acct-1", "123456", "app-internal", ["c1"])
const restored = readCachedJoinedState("acct-1", "123456")
results.push(restored && restored.joinedIds.join(",") === "c1" ? "restore-ok" : `restore-fail:${JSON.stringify(restored)}`)

const allOk = results.every(line => line.endsWith("-ok"))
Script.exit(`${allOk ? "PASS" : "FAIL"}\n${results.join("\n")}`)
