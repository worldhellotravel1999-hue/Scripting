/**
 * 跨进程译文快照缓存。
 *
 * App Store 分享扩展每次分享都是全新 JS 进程，core/translate.ts 里 30 分钟的
 * 内存译文缓存留不住：同一篇更新说明（尤其是「查看新说明」选中的历史版本）
 * 下次打开又从头翻译一遍，看起来就是「每次打开都重新刷新」。
 * 这里把已完成的译文按「卡片身份 + 原文 + 源/目标语言」写入共享 Storage，
 * 新进程首帧直接显示上次结果；只有用户主动刷新（translationToken 变化）或
 * 内容变化时才重新翻译。
 *
 * 全部读写静默容错，缓存失败不影响翻译本身。
 */
export type TranslationSnapshotResult = {
  languageCode: string
  text: string
  error: string
  loading: boolean
}

type SnapshotEntry = {
  at: number
  /** 原文快照：命中时逐字比对，防止哈希碰撞或内容更新后误用旧译文。 */
  text: string
  results: TranslationSnapshotResult[]
}

const STORAGE_KEY = "lingo_translation_snapshots_v1"
const TTL_MS = 7 * 24 * 60 * 60 * 1000
const LIMIT = 12
/** 单条快照上限（8000 字原文 × 3 目标语言译文可能很大）。 */
const RECORD_LIMIT_BYTES = 192 * 1024
const STORE_LIMIT_BYTES = 768 * 1024

/** FNV-1a：身份串最长可达 8000 字，不能直接当 Storage 键。 */
function hash(value: string) {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(36)
}

/** 卡片身份（稳定，不含每次会话递增的选择序号）+ 原文 + 语言组合 → 稳定短键。 */
export function translationSnapshotKey(
  scope: string,
  sourceText: string,
  sourceLanguage: string,
  targetLanguages: string[],
) {
  return [
    hash(scope),
    hash(sourceText),
    hash(sourceLanguage),
    targetLanguages.join(","),
  ].join(":")
}

function readStore(): Record<string, SnapshotEntry> {
  try {
    const value = Storage.get<Record<string, SnapshotEntry>>(STORAGE_KEY, { shared: true })
    return value && typeof value === "object" ? value : {}
  } catch {
    return {}
  }
}

function prune(store: Record<string, SnapshotEntry>) {
  const keys = Object.keys(store).sort((a, b) => (store[b]?.at || 0) - (store[a]?.at || 0))
  for (const key of keys.slice(LIMIT)) delete store[key]
}

/** 读取已完成的译文；原文不一致、过期或数据不完整时返回 null。 */
export function readTranslationSnapshot(key: string, sourceText: string): TranslationSnapshotResult[] | null {
  try {
    const entry = readStore()[key]
    if (!entry || entry.text !== sourceText || !Number.isFinite(entry.at)) return null
    if (Date.now() - entry.at > TTL_MS) return null
    if (!Array.isArray(entry.results) || !entry.results.length) return null
    // 部分失败（空译文/报错）的快照不可复用：仍需重新翻译补齐。
    if (entry.results.some(item => !item || typeof item.text !== "string" || !item.text.trim() || item.error)) return null
    return entry.results.map(item => ({
      languageCode: String(item.languageCode || ""),
      text: item.text,
      error: "",
      loading: false,
    }))
  } catch {
    return null
  }
}

/** 写入完整译文快照：只接受全部成功的结果，失败结果绝不进缓存。 */
export function writeTranslationSnapshot(key: string, sourceText: string, results: TranslationSnapshotResult[]) {
  if (!results.length || results.some(item => !item.text.trim() || item.error)) return
  try {
    const store = readStore()
    const entry: SnapshotEntry = {
      at: Date.now(),
      text: sourceText,
      results: results.map(item => ({
        languageCode: item.languageCode,
        text: item.text,
        error: "",
        loading: false,
      })),
    }
    if (JSON.stringify(entry).length > RECORD_LIMIT_BYTES) return
    store[key] = entry
    prune(store)
    if (JSON.stringify(store).length > STORE_LIMIT_BYTES) {
      // 超限时丢掉最早的一半，保证热门条目仍能命中。
      const keys = Object.keys(store).sort((a, b) => (store[b]?.at || 0) - (store[a]?.at || 0))
      for (const stale of keys.slice(Math.max(1, Math.floor(keys.length / 2)))) delete store[stale]
    }
    Storage.set(STORAGE_KEY, store, { shared: true })
  } catch {}
}
