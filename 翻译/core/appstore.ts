import { fetch } from "scripting"
import type { AppVersionNotes } from "./versions"

export type AppStoreIdentity = {
  appid: string
  region: string
  url: string
}

export type AppStoreInfo = {
  trackName?: string
  version?: string
  releaseDate?: string
  bundleId?: string
  description?: string
  releaseNotes?: string
  artworkUrl512?: string
  artworkUrl100?: string
  sellerName?: string
  primaryGenreName?: string
  averageUserRating?: number
  userRatingCount?: number
  trackViewUrl?: string
}

/** 更新内容始终绑定所选版本；上下换位只交换展示位置。 */
export function appStoreTextSlots(
  info: Pick<AppStoreInfo, "version" | "releaseNotes" | "description">,
  selected: AppVersionNotes | null | undefined,
  swapped: boolean,
) {
  const version = selected?.version ?? info.version
  const rawNotes = selected?.notes ?? info.releaseNotes
  // Release notes were the last unbounded App Store input: a long history note
  // could drive dozens of native Translation chunks plus a huge text view in
  // the share extension (small memory budget). Cap them like the description.
  const content = rawNotes === undefined ? undefined : limitAppStoreText(rawNotes, "发布说明")
  const notes = {
    content,
    version,
    identity: JSON.stringify(["notes", version || "", content || ""]),
    emptyText: "此版本未提供发布说明。",
  }
  const description = {
    // App Store 介绍可能远超原生 Translation 会话的稳定范围；限制只作用于
    // 介绍翻译，避免分享宿主因超长内容在原生翻译/渲染阶段退出。
    content: limitAppStoreText(info.description, "应用说明") || undefined,
    version: undefined as string | undefined,
    identity: "description",
    emptyText: "App Store 未提供应用说明。",
  }
  return swapped ? [description, notes] as const : [notes, description] as const
}

// 分享扩展的原生翻译会话与文本视图都不适合处理整篇超长内容；8k 字符已能
// 覆盖绝大多数商店页，同时把分片数限制在谷歌快路径两轮并发之内。
const MAX_APPSTORE_TEXT_LENGTH = 8000

/** 统一裁剪商店长文本；空串保留（发布说明为空与缺失语义不同）。 */
function limitAppStoreText(value: string | undefined, label: string) {
  const text = typeof value === "string" ? value.trim() : ""
  if (text.length <= MAX_APPSTORE_TEXT_LENGTH) return text
  return `${text.slice(0, MAX_APPSTORE_TEXT_LENGTH)}\n\n（${label}过长，已截取前 ${MAX_APPSTORE_TEXT_LENGTH} 个字符）`
}

function normalizeRegion(value: string) {
  const region = String(value || "").trim().toLowerCase()
  return /^[a-z]{2}(?:-[a-z]{2})?$/.test(region) ? region : "us"
}

function appStoreURLFromInput(input: string) {
  const raw = String(input || "").trim()
  if (!raw) return ""
  const match = raw.match(/(?:(?:https?|itms-apps):\/\/)?(?:itunes|apps)\.apple\.com\/[^\s<>"']+/i)
  return String(match?.[0] || "")
    .replace(/[\])}>.,;!，。；！、]+$/g, "")
    .trim()
}

export function parseAppStoreURL(input: string): AppStoreIdentity | null {
  const candidate = appStoreURLFromInput(input)
  if (!candidate) return null

  const hostMatch = candidate.match(/^(?:(?:https?|itms-apps):\/\/)?(?:itunes|apps)\.apple\.com\/([^/?#]+)/i)
  if (!hostMatch) return null

  const idMatch = candidate.match(/(?:\/|[?&])id(\d+)(?:[/?#&]|$)/i)
    ?? candidate.match(/[?&]id=(\d+)/i)
  if (!idMatch) return null

  const appid = idMatch[1]
  const region = normalizeRegion(hostMatch[1])
  const url = candidate
    .replace(/^itms-apps:\/\//i, "https://")
    .replace(/^(?!https?:\/\/)/i, "https://")

  return { appid, region, url }
}

export async function getAppInfo(identity: AppStoreIdentity): Promise<AppStoreInfo> {
  const endpoint = `https://itunes.apple.com/${encodeURIComponent(identity.region)}/lookup?id=${encodeURIComponent(identity.appid)}`
  const response = await fetch(endpoint, {
    method: "GET",
    timeout: 20,
    debugLabel: "Lingo App Store Lookup",
  })
  if (!response.ok) throw new Error(`无法读取 App Store 信息（HTTP ${response.status}）。`)

  const payload = await response.json()
  const result = Array.isArray(payload?.results) ? payload.results[0] : null
  if (!result) throw new Error("没有找到对应的 App Store 应用，请检查链接或商店地区。")
  return result as AppStoreInfo
}

export type AppStoreSearchResult = {
  trackId: number
  trackName: string
  artistName?: string
  artworkUrl100?: string
  formattedPrice?: string
  version?: string
  region: string
  description?: string
  releaseNotes?: string
}

/** 用 iTunes Search API 按名称搜索应用（参考 App Store工具 的 searchAppsOnAppStore）。 */
export async function searchAppStore(
  term: string,
  country = "us"
): Promise<AppStoreSearchResult[]> {
  const query = encodeURIComponent(String(term || "").trim())
  if (!query) return []
  const endpoint = `https://itunes.apple.com/search?term=${query}&entity=software&country=${encodeURIComponent(country)}&limit=15`
  const response = await fetch(endpoint, {
    method: "GET",
    timeout: 20,
    debugLabel: "Lingo App Store Search",
  })
  if (!response.ok) throw new Error(`App Store 搜索失败（HTTP ${response.status}）。`)
  const payload = await response.json()
  const results = (Array.isArray(payload?.results) ? payload.results : []) as Array<{
    trackId?: number
    trackName?: string
    artistName?: string
    artworkUrl100?: string
    formattedPrice?: string
    version?: string
    description?: string
    releaseNotes?: string
  }>
  return results
    .filter((item) => typeof item.trackId === "number")
    .map((item) => ({
      trackId: item.trackId!,
      trackName: String(item.trackName || ""),
      artistName: item.artistName,
      artworkUrl100: item.artworkUrl100,
      formattedPrice: item.formattedPrice,
      version: item.version,
      region: normalizeRegion(country),
      description: typeof item.description === "string" ? item.description : undefined,
      releaseNotes: typeof item.releaseNotes === "string" ? item.releaseNotes : undefined,
    }))
}
