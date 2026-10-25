import { loadPreferences } from "./preferences"
import { isTargetLanguageLine, translateLines } from "./translate"
import type { PreparedGitHubPage, GitHubTextGroup } from "./github-page"
import type { GitHubReleaseInfo } from "./github"

/**
 * GitHub Release 的正文按「块内连续文本节点」分组翻译：
 *
 * - 一个段落/list item 里的多个行内节点用 ⟦n⟧ 标记拼成一条，谷歌实测会
 *   原样保留这些标记（1.5s 返回 4 组），翻完再按标记拆回各个 span；
 * - 这样标题、加粗、链接文字都保留自己的 DOM 位置，译文不会把整段排版
 *   拍成一大坨纯文本；
 * - 标记丢失时只对该组退回逐 span 翻译，不让一组异常拖垮全页。
 */
export type GitHubTranslationResult = {
  segments: (string | null)[]
  changed: number
  total: number
  covered: number
}

export type GitHubTranslationOptions = {
  targetLanguageCode: string
  sourceLanguageCode?: string
  onProgress?: (result: GitHubTranslationResult) => void
  translationHost?: Translation
  isCancelled?: () => boolean
}

const CACHE_KEY = "lingo_github_page_translations_v2"
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000
const CACHE_LIMIT = 8
const CACHE_BYTES = 512 * 1024

type CacheEntry = {
  at: number
  key: string
  segments: (string | null)[]
}

function fnv1a(value: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

export function githubTranslationCacheKey(
  release: Pick<GitHubReleaseInfo, "owner" | "repo" | "tag">,
  sourceHash: string,
  sourceLanguage: string,
  targetLanguage: string,
) {
  return `${release.owner}/${release.repo || "__profile__"}@${release.tag || "__home__"}#${targetLanguage}:${sourceLanguage}:${sourceHash}`
}

function readStore(): Record<string, CacheEntry> {
  try {
    const value = Storage.get<Record<string, CacheEntry>>(CACHE_KEY, { shared: true })
    return value && typeof value === "object" ? value : {}
  } catch {
    return {}
  }
}

function prune(store: Record<string, CacheEntry>) {
  const keys = Object.keys(store).sort((a, b) => (store[b]?.at || 0) - (store[a]?.at || 0))
  for (const key of keys.slice(CACHE_LIMIT)) delete store[key]
}

export function readGitHubTranslationCache(key: string, count: number): string[] | null {
  try {
    const entry = readStore()[fnv1a(key)]
    if (!entry || entry.key !== key || !Array.isArray(entry.segments)) return null
    if (entry.segments.length !== count) return null
    if (!Number.isFinite(entry.at) || Date.now() - entry.at > CACHE_TTL) return null
    if (!entry.segments.length || !entry.segments.every((item) => typeof item === "string" && item.trim())) return null
    return entry.segments.map((item) => typeof item === "string" ? item : "")
  } catch {
    return null
  }
}

export function writeGitHubTranslationCache(key: string, segments: (string | null)[]) {
  if (!segments.length || !segments.every((item) => typeof item === "string" && item.trim())) return
  try {
    const store = readStore()
    const entry: CacheEntry = {
      at: Date.now(),
      key,
      segments: segments.map((item) => typeof item === "string" && item.trim() ? item : null),
    }
    if (JSON.stringify(entry).length > CACHE_BYTES) return
    store[fnv1a(key)] = entry
    prune(store)
    if (JSON.stringify(store).length > CACHE_BYTES) {
      const keys = Object.keys(store).sort((a, b) => (store[b]?.at || 0) - (store[a]?.at || 0))
      for (const stale of keys.slice(Math.max(1, Math.floor(keys.length / 2)))) delete store[stale]
    }
    Storage.set(CACHE_KEY, store, { shared: true })
  } catch {}
}

function splitGroupTranslation(group: GitHubTextGroup, translated: string) {
  const result = new Map<number, string>()
  if (group.indices.length === 1) {
    const value = translated.trim()
    if (value) result.set(group.indices[0], value)
    return result
  }

  const parts = String(translated || "").split(/⟦\s*(\d+)\s*⟧/g)
  const first = (parts[0] || "").trim()
  if (first) result.set(group.indices[0], first)
  for (let index = 1; index < parts.length; index += 2) {
    const target = Number(parts[index])
    if (!group.indices.includes(target)) continue
    const value = (parts[index + 1] || "").trim()
    if (value) result.set(target, value)
  }
  // 任何一个 span 没拿到译文，就交给逐 span 回退，避免把半句塞进错误的节点。
  if (group.indices.some((index) => !result.get(index))) return null
  return result
}

function countChanged(prepared: PreparedGitHubPage, segments: (string | null)[]) {
  let changed = 0
  for (const segment of prepared.segments) {
    const value = segments[segment.index]
    if (typeof value === "string" && value.trim() && value.trim() !== segment.text.trim()) changed += 1
  }
  return changed
}

function countCovered(segments: (string | null)[]) {
  return segments.filter((value) => typeof value === "string" && !!value.trim()).length
}

export async function translateGitHubPage(
  prepared: PreparedGitHubPage,
  options: GitHubTranslationOptions,
): Promise<GitHubTranslationResult> {
  const sourceLanguage = options.sourceLanguageCode ?? loadPreferences().defaultSourceLanguageCode
  const targetLanguage = options.targetLanguageCode
  const segments: (string | null)[] = new Array(prepared.segments.length).fill(null)
  if (!prepared.groups.length) {
    return { segments, changed: 0, total: prepared.segments.length, covered: 0 }
  }
  if (sourceLanguage !== "auto" && sourceLanguage === targetLanguage) {
    return { segments, changed: 0, total: prepared.segments.length, covered: 0 }
  }
  if (options.isCancelled?.()) throw new Error("翻译任务已取消。")

  const request = {
    sourceLanguageCode: sourceLanguage,
    targetLanguageCode: targetLanguage,
    translationHost: options.translationHost,
    priority: 3,
    preferSequential: true,
    isCancelled: options.isCancelled,
  }
  const accept = (index: number, translated: string) => {
    const value = translated.trim()
    if (!value) return false
    const source = prepared.segments[index].text
    // 翻译引擎失败可能回退原文；长句原样返回不能算成功覆盖。
    // 短名称、版本号等允许保持原样，代码本身不会进入 segments。
    if (value === source && !/^(?:https?:\/\/|mailto:)\S+$/i.test(source)
      && !isTargetLanguageLine(source, sourceLanguage, targetLanguage)
      && (source.match(/\p{L}+/gu) || []).length >= 4) return false
    segments[index] = value
    return true
  }

  // 全文都排队，每批限制请求规模而非限制文档长度；完成一批立即回填。
  let cursor = 0
  while (cursor < prepared.groups.length) {
    if (options.isCancelled?.()) throw new Error("翻译任务已取消。")
    const batch: GitHubTextGroup[] = []
    let chars = 0
    while (cursor < prepared.groups.length && batch.length < 24) {
      const group = prepared.groups[cursor]
      if (batch.length && chars + group.source.length > 6000) break
      batch.push(group)
      chars += group.source.length
      cursor += 1
    }
    let values: string[] = []
    try {
      values = await translateLines(batch.map((group) => group.source), request)
    } catch (reason) {
      if (options.isCancelled?.()) throw reason
    }
    const fallbackIndices: number[] = []
    batch.forEach((group, position) => {
      const split = splitGroupTranslation(group, values[position] || "")
      if (!split || group.indices.some((index) => !split.get(index))) {
        fallbackIndices.push(...group.indices)
        return
      }
      split.forEach((value, index) => {
        if (!accept(index, value)) fallbackIndices.push(index)
      })
    })
    if (fallbackIndices.length) {
      try {
        const fallback = await translateLines(fallbackIndices.map((index) => prepared.segments[index].text), { ...request, priority: 4 })
        fallbackIndices.forEach((index, position) => accept(index, fallback[position] || ""))
      } catch (reason) {
        if (options.isCancelled?.()) throw reason
      }
    }
    if (options.isCancelled?.()) throw new Error("翻译任务已取消。")
    options.onProgress?.({ segments: [...segments], changed: countChanged(prepared, segments), total: segments.length, covered: countCovered(segments) })
  }

  const changed = countChanged(prepared, segments)
  const alreadyTarget = prepared.segments.filter((segment) =>
    isTargetLanguageLine(segment.text, sourceLanguage, targetLanguage)
  ).length

  // 引擎全都失败时会原样返回输入。只要内容本身不是目标语言，就把这种
  // 「零变化」当成失败，让页面显示重试，而不是默默停在英文。
  if (changed === 0 && alreadyTarget === 0) {
    throw new Error("GitHub 正文翻译失败，请重试。")
  }

  return { segments, changed, total: prepared.segments.length, covered: countCovered(segments) }
}
