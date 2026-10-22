import { Script } from "scripting"
import {
  readTranslationSnapshot,
  translationSnapshotKey,
  writeTranslationSnapshot,
} from "../core/translation-snapshot"

/**
 * 跨进程译文快照回归：
 * 1) 同一「作用域 + 原文 + 语言」在任意新进程都命中同一键；
 * 2) 原文或语言变了绝不能命中旧译文；
 * 3) 只有完整成功的译文能写入，失败/空结果不缓存；
 * 4) 过期快照不可用。
 */
function assert(value: unknown, message: string) {
  if (!value) throw new Error(message)
}

const text = "This version fixes crashes and improves performance."
const results = [
  { languageCode: "zh-Hans", text: "此版本修复了崩溃并提升了性能。", error: "", loading: false },
]

try {
  const key = translationSnapshotKey("share-release-notes:111:us:notes:2.0", text, "auto", ["zh-Hans"])
  assert(key === translationSnapshotKey("share-release-notes:111:us:notes:2.0", text, "auto", ["zh-Hans"]), "同输入必须生成同键")
  assert(key !== translationSnapshotKey("share-release-notes:111:us:notes:2.1", text, "auto", ["zh-Hans"]), "不同版本必须生成不同键")
  assert(key !== translationSnapshotKey("share-release-notes:111:us:notes:2.0", `${text} `, "auto", ["zh-Hans"]), "原文变化必须生成不同键")
  assert(key !== translationSnapshotKey("share-release-notes:111:us:notes:2.0", text, "en", ["zh-Hans"]), "源语言变化必须生成不同键")
  assert(key !== translationSnapshotKey("share-release-notes:111:us:notes:2.0", text, "auto", ["zh-Hant"]), "目标语言变化必须生成不同键")

  writeTranslationSnapshot(key, text, results)
  const hit = readTranslationSnapshot(key, text)
  assert(hit?.length === 1 && hit[0].text === results[0].text, "快照未命中或译文不一致")
  assert(hit?.[0].loading === false && hit?.[0].error === "", "快照应清理 loading/error")

  assert(readTranslationSnapshot(key, `${text} changed`) === null, "原文不一致不得命中")
  assert(readTranslationSnapshot("missing", text) === null, "无快照应返回 null")

  // 失败/空译文不缓存
  const partialKey = translationSnapshotKey("partial", text, "auto", ["zh-Hans"])
  writeTranslationSnapshot(partialKey, text, [{ languageCode: "zh-Hans", text: "", error: "失败", loading: false }])
  assert(readTranslationSnapshot(partialKey, text) === null, "失败译文不得写入缓存")
  writeTranslationSnapshot(partialKey, text, [{ languageCode: "zh-Hans", text: "好的", error: "", loading: false }])
  assert(readTranslationSnapshot(partialKey, text)?.[0]?.text === "好的", "成功译文应写入缓存")

  // 过期快照：直接改写存储时间
  const storeKey = "lingo_translation_snapshots_v1"
  const store = Storage.get<Record<string, any>>(storeKey, { shared: true }) || {}
  const expiredKey = translationSnapshotKey("expired", text, "auto", ["zh-Hans"])
  writeTranslationSnapshot(expiredKey, text, results)
  const after = Storage.get<Record<string, any>>(storeKey, { shared: true }) || {}
  after[expiredKey] = { ...after[expiredKey], at: Date.now() - 8 * 24 * 60 * 60 * 1000 }
  Storage.set(storeKey, after, { shared: true })
  assert(readTranslationSnapshot(expiredKey, text) === null, "过期快照不得命中")

  Storage.remove(storeKey, { shared: true })
  console.log("PASS: snapshot key stability, hit isolation, failure and expiry guards")
  Script.exit("PASS")
} catch (error) {
  try { Storage.remove("lingo_translation_snapshots_v1", { shared: true }) } catch {}
  console.error(String(error))
  Script.exit("FAIL")
}
