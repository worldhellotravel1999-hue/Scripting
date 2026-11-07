import { Script } from "scripting"
import {
  githubTranslationCacheKey,
  readGitHubTranslationCache,
  writeGitHubTranslationCache,
} from "../core/github-translation"

function assert(value: unknown, message: string) {
  if (!value) throw new Error(message)
}

const STORE_KEY = "lingo_github_page_translations_v2"
const originalStore = Storage.get<Record<string, any>>(STORE_KEY, { shared: true })
const scope = `github-translation-cache-test:${Date.now()}`
let testKey = ""

function restoreStore(key: string) {
  try {
    const current = Storage.get<Record<string, any>>(STORE_KEY, { shared: true }) || {}
    const restored = { ...(originalStore || {}), ...current }
    const index = Object.keys(restored).find((item) => restored[item]?.key === key)
    if (index) delete restored[index]
    const priorIndex = Object.keys(originalStore || {}).find((item) => (originalStore as any)[item]?.key === key)
    if (priorIndex) restored[priorIndex] = (originalStore as any)[priorIndex]
    if (Object.keys(restored).length) Storage.set(STORE_KEY, restored, { shared: true })
    else Storage.remove(STORE_KEY, { shared: true })
  } catch {}
}

try {
  const release = { owner: scope, repo: "repo", tag: "v1" }
  const key = githubTranslationCacheKey(release, "source-hash", "en", "zh-Hans")
  testKey = key
  const translations = ["修复崩溃", "提升性能"]
  writeGitHubTranslationCache(key, translations)
  assert(readGitHubTranslationCache(key, 2)?.join("|") === translations.join("|"), "完整译文缓存未命中")
  assert(readGitHubTranslationCache(key, 1) === null, "段数不匹配的缓存不应命中")
  assert(readGitHubTranslationCache(`${key}:other`, 2) === null, "不同页面键不应共用缓存")

  writeGitHubTranslationCache(key, ["部分成功", null])
  assert(readGitHubTranslationCache(key, 2)?.join("|") === translations.join("|"), "不完整结果不得覆盖成功缓存")

  const store = Storage.get<Record<string, any>>(STORE_KEY, { shared: true }) || {}
  const cacheEntry = Object.values(store).find((entry: any) => entry?.key === key) as any
  assert(cacheEntry, "未在共享 Storage 中写入缓存")
  cacheEntry.at = Date.now() - 8 * 24 * 60 * 60 * 1000
  Storage.set(STORE_KEY, store, { shared: true })
  assert(readGitHubTranslationCache(key, 2) === null, "过期 GitHub 缓存不应命中")

  console.log("PASS: GitHub translation cache hit, key/count isolation, partial-write guard and expiry")
  restoreStore(testKey)
  Script.exit("PASS")
} catch (error) {
  restoreStore(testKey)
  console.error(String(error))
  Script.exit("FAIL")
}
