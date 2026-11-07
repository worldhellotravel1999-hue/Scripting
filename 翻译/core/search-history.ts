/**
 * 翻译记录缓存（移植自「App Store工具」项目的搜索历史）。
 * 记录用户在翻译页搜索并选中的 App Store 应用，最新在前；
 * 用于底部工具条「记录」按钮的面板：点击可重新定位到该应用进行翻译，
 * 也可单条删除或全部清空。
 */

/** 一条翻译记录（最近搜索/选中的应用） */
export interface TranslationHistoryItem {
  /** App ID（iTunes trackId） */
  appid: string
  /** 搜索时所在地区（us/cn…，重新定位时用于 Lookup） */
  region: string
  /** 应用名 */
  trackName: string
  /** 开发者名 */
  artistName?: string
  /** 图标 URL */
  artworkUrl?: string
  /** 记录时间（毫秒时间戳） */
  recordedAt: number
}

const HISTORY_KEY = "lingo_translation_history_v1"
const MAX_ITEMS = 20

function storage(): any {
  return (globalThis as any).Storage
}

function readList(): TranslationHistoryItem[] {
  try {
    const raw = storage()?.get?.(HISTORY_KEY, { shared: true })
    if (!Array.isArray(raw)) return []
    return raw.filter((item): item is TranslationHistoryItem =>
      item && typeof item === "object"
        && typeof item.appid === "string" && item.appid.length > 0)
  } catch {
    return []
  }
}

function writeList(list: TranslationHistoryItem[]) {
  try {
    storage()?.set?.(HISTORY_KEY, list, { shared: true })
  } catch {}
}

/** 读取全部翻译记录（最新在前）。 */
export function getTranslationHistory(): TranslationHistoryItem[] {
  return readList()
}

/** 记录一次已选中的应用：按 appid 去重后放到最前并持久化（最多 20 条）。 */
export function addTranslationHistory(item: TranslationHistoryItem) {
  const list = readList().filter((h) => h.appid !== item.appid)
  list.unshift(item)
  writeList(list.slice(0, MAX_ITEMS))
}

/** 删除一条翻译记录（按 appid）。 */
export function removeTranslationHistoryItem(appid: string) {
  writeList(readList().filter((h) => h.appid !== appid))
}

/** 清空全部翻译记录。 */
export function clearTranslationHistory() {
  writeList([])
}
