import { loadPreferences } from "./preferences"
import { isTargetLanguageLine, translateLines } from "./translate"
import {
  GOOGLE_CHUNK_LENGTH,
  isGoogleEngineAvailable,
  markGoogleEngineBlocked,
  translateGoogleChunk,
} from "./google_engine"
import type { PreparedGitHubPage, GitHubTextGroup } from "./github-page"
import type { GitHubReleaseInfo } from "./github"

/**
 * GitHub Release / README 的正文按「块内连续文本节点」分组翻译。
 *
 * 一个段落里的多个行内节点用 ⟦n⟧ 标记拼成**一行**（不再用换行分隔）：
 * - 谷歌端点实测会原样保留 ⟦n⟧，翻完再按标记拆回各个 span；
 * - translateLines 把「每个输入一行」作为批量单位；分组若含真实换行，
 *   返回行数会被标记行撑大，批量永远对不上，只能逐组重发。大 README
 *   因此会打出几百次请求、触发谷歌限流并转慢速系统引擎。
 *
 * 谷歌快路径在 GitHub 侧自行分包（每包 ≤1000 字符、并发 4），拿到结果就
 * 立即回填；不再让 translateLines 为每个批次顺带启动一条系统翻译链。
 * 谷歌没拿到的段最后统一走一次批量兜底，避免多批原生翻译排队堆积。
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

const GOOGLE_GROUP_CONCURRENCY = 4
const GOOGLE_PACK_CHARS = GOOGLE_CHUNK_LENGTH
const GOOGLE_BATCH_GROUPS = 24
const GOOGLE_BATCH_CHARS = 6000
const FALLBACK_CHUNK = 64
/** 系统兜底的整体上限：原生翻译卡住时不能让整页无限停在英文。 */
const FALLBACK_TIMEOUT_MS = 45_000

type CacheEntry = {
  at: number
  key: string
  segments: (string | null)[]
}

type GooglePack = {
  /** 组在 prepared.groups 中的位置（不是段 index）。 */
  positions: number[]
  text: string
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

function letterCount(value: string) {
  return (value.match(/\p{L}/gu) || []).length
}

function isURLText(value: string) {
  return /^(?:https?:\/\/|mailto:)\S+$/i.test(value)
}

/**
 * 版本号、文件名、包名、URL、连字符 wordmark（如 e-l-i-s-e）这类文本
 * 引擎经常原样返回；它们不是「漏翻」，不能因此让整页永远算未完成。
 */
function isTokenLikeText(value: string) {
  const text = value.trim()
  if (!text) return false
  if (isURLText(text)) return true
  if (/\s/.test(text)) return false
  if (letterCount(text) <= 6) return true
  return /[\d._/@:#+~-]/.test(text)
}

/** 标题/产品名（Release Notes、MIT License、App Store）。 */
function isLabelLikeText(value: string) {
  const text = value.trim()
  if (!text || isTokenLikeText(text)) return true
  if (/[.!?。！？;；:：]$/.test(text)) return false
  const words = text.split(/\s+/)
  if (words.length > 4 || letterCount(text) > 32) return false
  // 设备/版本标识（iPhone 15 (7f3a)、Node.js 18 或更高）也常被引擎原样返回。
  if (/\d/.test(text) && letterCount(text) <= 24) return true
  return words.every((word) => /^[\p{Lu}\p{N}]/u.test(word))
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
  // 任何一个 span 没拿到译文，就交给逐段兜底，避免把半句塞进错误的节点。
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

/** 把连续组按 1000 字符打包；每组已是单行，换行即组分隔符。 */
function packGroups(groups: GitHubTextGroup[], start: number, end: number): GooglePack[] {
  const packs: GooglePack[] = []
  let positions: number[] = []
  let text = ""
  const flush = () => {
    if (!positions.length) return
    packs.push({ positions, text })
    positions = []
    text = ""
  }
  for (let position = start; position < end; position += 1) {
    const source = groups[position].source
    if (text && text.length + 1 + source.length > GOOGLE_PACK_CHARS) flush()
    positions.push(position)
    text = text ? `${text}\n${source}` : source
  }
  flush()
  return packs
}

/**
 * 谷歌分包翻译；返回「组位置 → 整组译文」。整包换行对不上时只重试该包，
 * 逐组请求保证结果与组的对应关系，不让一个异常包拖垮整页。
 */
async function translatePacksWithGoogle(
  groups: GitHubTextGroup[],
  start: number,
  end: number,
  sourceLanguage: string,
  targetLanguage: string,
  isCancelled: () => boolean,
): Promise<Map<number, string>> {
  const values = new Map<number, string>()
  const packs = packGroups(groups, start, end)
  let cursor = 0
  const worker = async () => {
    while (true) {
      const pack = packs[cursor]
      cursor += 1
      if (!pack) return
      if (isCancelled()) return
      let translated = ""
      try {
        translated = await translateGoogleChunk(pack.text, sourceLanguage, targetLanguage)
      } catch {
        // 整包请求失败（断网/限流）时不再逐组重发：那会把一次 2s 超时放大成
        // N×2s，谷歌不可用时要几十秒才轮到真正有用的系统兜底。
        continue
      }
      if (isCancelled()) return
      const pieces = String(translated || "").split("\n")
      if (pieces.length === pack.positions.length) {
        pack.positions.forEach((position, index) => {
          const value = String(pieces[index] || "").trim()
          if (value) values.set(position, value)
        })
        continue
      }
      // 端点返回成功但换行被打乱/增删：只重试本包，逐组请求保证对应关系。
      await Promise.all(pack.positions.map(async (position) => {
        if (isCancelled() || values.has(position)) return
        try {
          const value = await translateGoogleChunk(groups[position].source, sourceLanguage, targetLanguage)
          if (value) values.set(position, value)
        } catch {}
      }))
    }
  }
  const workers = Math.min(GOOGLE_GROUP_CONCURRENCY, packs.length)
  await Promise.all(Array.from({ length: workers }, () => worker()))
  return values
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
  const isCancelled = () => options.isCancelled?.() === true
  const accept = (index: number, translated: string, allowLabel = false) => {
    const value = translated.trim()
    if (!value) return false
    const source = prepared.segments[index].text
    if (value === source) {
      if (isTargetLanguageLine(source, sourceLanguage, targetLanguage)
        || isURLText(source)
        || letterCount(source) < 4) {
        segments[index] = value
        return true
      }
      // 首轮失败的长句不能被当成「已翻译」；token/标题类留到收尾再接受，
      // 避免一个 e-l-i-s-e 让整页永远算未完成、永远不写缓存。
      if (allowLabel && (isTokenLikeText(source) || isLabelLikeText(source))) {
        segments[index] = value
        return true
      }
      return false
    }
    segments[index] = value
    return true
  }
  const report = () => {
    options.onProgress?.({
      segments: [...segments],
      changed: countChanged(prepared, segments),
      total: segments.length,
      covered: countCovered(segments),
    })
  }

  // 谷歌快路径：自行分包、自行并发，拿一组回填一组。
  if (isGoogleEngineAvailable()) {
    let cursor = 0
    let emptyBatches = 0
    while (cursor < prepared.groups.length) {
      if (isCancelled()) throw new Error("翻译任务已取消。")
      if (!isGoogleEngineAvailable()) break
      const start = cursor
      let chars = 0
      while (cursor < prepared.groups.length && cursor - start < GOOGLE_BATCH_GROUPS) {
        const group = prepared.groups[cursor]
        if (cursor > start && chars + group.source.length > GOOGLE_BATCH_CHARS) break
        chars += group.source.length
        cursor += 1
      }
      const values = await translatePacksWithGoogle(
        prepared.groups, start, cursor, sourceLanguage, targetLanguage, isCancelled,
      )
      if (isCancelled()) throw new Error("翻译任务已取消。")
      if (!values.size) {
        emptyBatches += 1
        if (emptyBatches >= 2) {
          markGoogleEngineBlocked()
          break
        }
      } else {
        emptyBatches = 0
      }
      for (let position = start; position < cursor; position += 1) {
        const group = prepared.groups[position]
        const translated = values.get(position)
        if (!translated) continue
        const split = splitGroupTranslation(group, translated)
        if (!split) continue
        for (const index of group.indices) {
          const value = split.get(index)
          if (value) accept(index, value)
        }
      }
      report()
    }
  }

  // 谷歌没拿到的段统一兜底：只在这一步启动系统引擎，避免每个批次都留一条
  // 后台原生翻译链，排到后面时整页看起来「一直不翻译」。
  const missing = prepared.segments
    .filter((segment) => !segments[segment.index])
    .map((segment) => segment.index)
  if (missing.length) {
    for (let offset = 0; offset < missing.length; offset += FALLBACK_CHUNK) {
      if (isCancelled()) throw new Error("翻译任务已取消。")
      const chunk = missing.slice(offset, offset + FALLBACK_CHUNK)
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true }, FALLBACK_TIMEOUT_MS)
      try {
        const values = await translateLines(
          chunk.map((index) => prepared.segments[index].text),
          { ...request, priority: 4, isCancelled: () => isCancelled() || timedOut },
        )
        chunk.forEach((index, position) => {
          const value = values[position] || ""
          if (accept(index, value)) return
          accept(index, value, true)
        })
      } catch (reason) {
        if (isCancelled()) throw reason
      } finally {
        clearTimeout(timer)
      }
      report()
      // 原生翻译已经卡死时，后续块只会排在同一个槽位后面：直接返回已有译文。
      if (timedOut) break
    }
  }

  // 仍然没有译文的，只剩本来就无需翻译的 token/标题：接受原文，保证整页
  // 能进入完成态并写缓存；真正的长句缺失仍会由下面的 changed 检查报错。
  for (const segment of prepared.segments) {
    if (segments[segment.index]) continue
    if (isTokenLikeText(segment.text) || isLabelLikeText(segment.text)) {
      segments[segment.index] = segment.text
    }
  }

  const changed = countChanged(prepared, segments)
  const alreadyTarget = prepared.segments.filter((segment) =>
    isTargetLanguageLine(segment.text, sourceLanguage, targetLanguage)
  ).length
  const untranslated = prepared.segments.filter((segment) => !segments[segment.index]).length

  // 引擎全都失败时会原样返回输入。只要还有真正的长句没拿到译文，就把这种
  // 「零变化」当成失败，让页面显示重试，而不是默默停在英文。
  if (changed === 0 && alreadyTarget === 0 && untranslated > 0) {
    throw new Error("GitHub 正文翻译失败，请重试。")
  }

  report()
  return { segments, changed, total: prepared.segments.length, covered: countCovered(segments) }
}
