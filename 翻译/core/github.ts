import { AbortController, fetch, type AbortSignal } from "scripting"
import { parseHTML } from "./linkedom"
import { getGitHubReadme } from "./github-readme"
import { getGitHubProfile } from "./github-profile"
import { encodeGitHubTagPath, githubAvatarURL, type GitHubReleaseIdentity } from "./github-url"

/**
 * GitHub Release 分享链接的数据加载。
 *
 * 数据优先读 releases.atom：它是 GitHub 的公开订阅源，不需要 token，
 * 也不受 API 每小时 60 次的匿名限额影响；正文已经是渲染好的 HTML，
 * 与 Release 页面上的 markdown 布局一致。Atom 只保留最近 10 条，
 * 更早的版本再回退抓取 Release 页面里的 body-content 节点。
 */
export type { GitHubReleaseIdentity } from "./github-url"
export { parseGitHubReleaseURL } from "./github-url"

export type GitHubReleaseAsset = {
  name: string
  url: string
  size?: string
}

export type GitHubReleaseInfo = {
  kind?: "release" | "readme" | "profile"
  readmeName?: string
  isRepositoryHome?: boolean
  repositoryDescription?: string
  profileDescription?: string
  /** README 文件页作为相对链接和图片的解析基准。 */
  contentBaseUrl?: string
  owner: string
  repo: string
  tag: string
  title: string
  bodyHtml: string
  publishedAt?: string
  author?: string
  /** Release 发布者头像（Atom media:thumbnail / Release 页面）。 */
  avatarUrl?: string
  /** 仓库 / 组织所有者头像，页头链接卡使用；与发布者头像区分。 */
  ownerAvatarUrl?: string
  htmlUrl: string
  isLatest: boolean
  assets: GitHubReleaseAsset[]
  /** 页面先呈现后仍可异步补入的资产列表（慢网络不阻塞正文）。 */
  assetsPromise?: Promise<GitHubReleaseAsset[]>
}

type AtomEntry = {
  tag: string
  title: string
  bodyHtml: string
  updated?: string
  author?: string
  avatarUrl?: string
  url: string
}

type ReleasePage = {
  tag: string
  title: string
  bodyHtml: string
  publishedAt?: string
  author?: string
  avatarUrl?: string
  ownerAvatarUrl?: string
  isLatest: boolean
}

const GITHUB_HOST = "https://github.com"
const FETCH_TIMEOUT = 20
const ASSET_TIMEOUT = 10
const LATEST_TAG_TIMEOUT = 4
const ASSET_WAIT_MS = 600

function decodeXmlEntities(value: string) {
  return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    const key = body.toLowerCase()
    if (key.startsWith("#x")) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? safeCodePoint(code) : whole
    }
    if (key.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? safeCodePoint(code) : whole
    }
    switch (key) {
      case "amp": return "&"
      case "lt": return "<"
      case "gt": return ">"
      case "quot": return "\""
      case "apos": return "'"
      case "nbsp": return "\u00a0"
      default: return whole
    }
  })
}

function safeCodePoint(code: number) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ""
  try {
    return String.fromCodePoint(code)
  } catch {
    return ""
  }
}

function stripHTML(value: string) {
  return decodeXmlEntities(String(value || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim()
}

function tagFromReleaseLink(link: string) {
  const match = String(link || "").match(/\/releases\/tag\/(.+?)(?:[?#].*)?$/i)
  if (!match) return ""
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

function parseAtom(xml: string): AtomEntry[] {
  const entries: AtomEntry[] = []
  const entryPattern = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi
  let match: RegExpExecArray | null
  while ((match = entryPattern.exec(xml)) !== null) {
    const block = match[1]
    const title = decodeXmlEntities(block.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "")
    const content = decodeXmlEntities(block.match(/<content\b[^>]*>([\s\S]*?)<\/content>/i)?.[1] || "")
    const updated = block.match(/<updated\b[^>]*>([\s\S]*?)<\/updated>/i)?.[1]?.trim()
    const author = decodeXmlEntities(block.match(/<author\b[^>]*>[\s\S]*?<name\b[^>]*>([\s\S]*?)<\/name>/i)?.[1] || "").trim()
    const linkTags = block.match(/<link\b[^>]*>/gi) || []
    let link = ""
    for (const tag of linkTags) {
      if (!/\brel\s*=\s*["']alternate["']/i.test(tag)) continue
      link = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1] || ""
      if (link) break
    }
    const thumbnailTag = (block.match(/<media:thumbnail\b[^>]*>/i) || [])[0] || ""
    const avatarUrl = thumbnailTag.match(/\burl\s*=\s*["']([^"']+)["']/i)?.[1] || ""
    const tag = tagFromReleaseLink(link)
    entries.push({
      tag,
      title: title.trim() || tag,
      bodyHtml: content,
      updated,
      author: author || undefined,
      avatarUrl: avatarUrl ? decodeXmlEntities(avatarUrl) : undefined,
      url: link || (tag ? `${GITHUB_HOST}/${parseRepoFromLink(link)}/releases/tag/${encodeGitHubTagPath(tag)}` : ""),
    })
  }
  return entries
}

/** Atom link 自带 owner/repo；解析失败时由调用方补。 */
function parseRepoFromLink(link: string) {
  const match = String(link || "").match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/tag\//i)
  return match ? `${match[1]}/${match[2]}` : ""
}

async function fetchAtom(owner: string, repo: string) {
  const response = await fetch(`${GITHUB_HOST}/${owner}/${repo}/releases.atom`, {
    method: "GET",
    timeout: FETCH_TIMEOUT,
    debugLabel: "Lingo GitHub Releases Atom",
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.text()
}

/**
 * GitHub 的 `/releases/latest` 指向最新**非预发布**版本，而 Atom 第一条
 * 可能是 nightly / beta（Electron 就长期如此）。API 体积小、响应快，用它
 * 先确定稳定 tag，再复用 Atom 的正文；API 限流时回退到 `/releases/latest`
 * 页面本身解析出的重定向 tag。
 */
async function fetchLatestStableTag(owner: string, repo: string): Promise<string> {
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`,
    {
      method: "GET",
      timeout: LATEST_TAG_TIMEOUT,
      debugLabel: "Lingo GitHub Latest Release",
      headers: { Accept: "application/vnd.github+json" },
    },
  )
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const payload = await response.json() as { tag_name?: unknown }
  const tag = typeof payload?.tag_name === "string" ? payload.tag_name.trim() : ""
  if (!tag) throw new Error("GitHub latest release returned no tag")
  return tag
}

function findAtomEntry(entries: AtomEntry[], tag?: string) {
  if (!entries.length) return null
  if (!tag) return entries[0]
  const exact = entries.find((entry) => entry.tag === tag)
  if (exact) return exact
  const insensitive = entries.find((entry) => entry.tag.toLowerCase() === tag.toLowerCase())
  return insensitive || null
}

/** 从 Release 页面 HTML 中按标签平衡地截取 body-content 的 div。 */
function extractBodyContentDiv(html: string) {
  let marker = html.indexOf('data-test-selector="body-content"')
  if (marker < 0) marker = html.indexOf("markdown-body")
  if (marker < 0) return ""

  const start = html.lastIndexOf("<div", marker)
  if (start < 0) return ""
  const token = /<div\b|<\/div\s*>/gi
  token.lastIndex = start
  let depth = 0
  let match: RegExpExecArray | null
  while ((match = token.exec(html)) !== null) {
    if (match[0].startsWith("</")) {
      depth -= 1
      if (depth === 0) return html.slice(start, token.lastIndex)
    } else {
      depth += 1
    }
  }
  return ""
}

function bodyHtmlFromFragment(fragment: string) {
  if (!fragment) return ""
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${fragment}</body></html>`)
  const node = document.querySelector('[data-test-selector="body-content"]') || document.querySelector(".markdown-body")
  return String(node?.innerHTML || "")
}

async function fetchReleasePage(identity: GitHubReleaseIdentity, signal?: AbortSignal) {
  const tag = identity.tag || ""
  const pageURL = tag
    ? `${GITHUB_HOST}/${identity.owner}/${identity.repo}/releases/tag/${encodeGitHubTagPath(tag)}`
    : `${GITHUB_HOST}/${identity.owner}/${identity.repo}/releases/latest`
  const response = await fetch(
    pageURL,
    { method: "GET", timeout: FETCH_TIMEOUT, debugLabel: "Lingo GitHub Release Page", signal },
  )
  if (!response.ok) throw new Error(`无法读取 GitHub Release（HTTP ${response.status}）。`)
  const html = await response.text()
  const finalURL = String(response.url || "")

  let resolvedTag = tag
  if (!resolvedTag) {
    // /releases/latest 会 302 到具体 tag；fetch 的 response.url 是最终地址。
    const fromURL = finalURL.match(/\/releases\/tag\/([^?#]+)/i)?.[1]
      || html.match(/<link\b[^>]*rel="canonical"[^>]*href="[^"]*\/releases\/tag\/([^"?#]+)"/i)?.[1]
      || html.match(/breadcrumb-item-selected[\s\S]{0,400}?\/releases\/tag\/([^"?#]+)/i)?.[1]
      || ""
    if (fromURL) {
      try { resolvedTag = decodeURIComponent(fromURL) } catch { resolvedTag = fromURL }
    }
  }

  const title = stripHTML(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "") || resolvedTag
  const releasedIndex = html.search(/released this/i)
  const metaBlock = releasedIndex >= 0
    ? html.slice(Math.max(0, releasedIndex - 3000), releasedIndex + 2000)
    : ""
  const authorMatch = metaBlock.match(
    /<a\b[^>]*class="[^"]*text-bold[^"]*"[^>]*href="\/([^"\/?#]+)"[^>]*>([^<]+)<\/a>\s*released this/i,
  )
  const author = decodeXmlEntities((authorMatch?.[2] || "").trim()) || undefined
  const dateBlock = releasedIndex >= 0 ? html.slice(releasedIndex, releasedIndex + 1800) : html
  const dateMatch = dateBlock.match(/<relative-time\b[^>]*datetime="([^"]+)"/i)
    || html.match(/<relative-time\b[^>]*datetime="([^"]+)"/i)
  const avatarMatch = metaBlock.match(/<img\b[^>]*src="([^"]+)"/i)
  const avatarUrl = avatarMatch?.[1] ? decodeXmlEntities(avatarMatch[1]) : undefined
  // 页头的仓库所有者头像（release 正文里的头像是发布者，不是所有者）。
  const ownerAvatarTag = html.match(/<img\b[^>]*data-testid="github-avatar"[^>]*>/i)?.[0]
    || html.match(/<img\b[^>]*data-component="Avatar"[^>]*>/i)?.[0]
    || ""
  const ownerAvatarRaw = ownerAvatarTag.match(/\bsrc="([^"]+)"/i)?.[1]
  const ownerAvatarUrl = ownerAvatarRaw ? decodeXmlEntities(ownerAvatarRaw) : ""
  const isLatest = /Label--success[^>]*>\s*Latest\s*</i.test(html)

  return {
    tag: resolvedTag,
    title,
    bodyHtml: bodyHtmlFromFragment(extractBodyContentDiv(html)),
    publishedAt: dateMatch?.[1],
    author,
    avatarUrl,
    ownerAvatarUrl,
    isLatest,
  }
}

async function fetchAssets(owner: string, repo: string, tag: string): Promise<GitHubReleaseAsset[]> {
  if (!tag) return []
  try {
    const response = await fetch(
      `${GITHUB_HOST}/${owner}/${repo}/releases/expanded_assets/${encodeGitHubTagPath(tag)}`,
      { method: "GET", timeout: ASSET_TIMEOUT, debugLabel: "Lingo GitHub Release Assets" },
    )
    if (!response.ok) return []
    const html = await response.text()
    const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`)
    const rows = Array.from(document.querySelectorAll("li")) as any[]
    const result: GitHubReleaseAsset[] = []
    const seen = new Set<string>()
    for (const row of rows) {
      const anchor = row.querySelector("a[href]") as any
      const href = String(anchor?.getAttribute?.("href") || "").trim()
      const name = String(anchor?.textContent || "").replace(/\s+/g, " ").trim()
      if (!href || !name) continue
      const url = href.startsWith("http")
        ? href
        : `${GITHUB_HOST}${href.startsWith("/") ? "" : "/"}${href}`
      if (seen.has(url)) continue
      seen.add(url)
      let size: string | undefined
      for (const span of Array.from(row.querySelectorAll("span")) as any[]) {
        const value = String(span.textContent || "").trim()
        if (/^\d+(?:\.\d+)?\s*(?:Bytes|KB|MB|GB)$/i.test(value)) {
          size = value
          break
        }
      }
      result.push({ name, url, size })
      if (result.length >= 30) break
    }
    return result
  } catch {
    return []
  }
}

function releaseFromAtom(
  identity: GitHubReleaseIdentity,
  entry: AtomEntry,
  assets: GitHubReleaseAsset[],
  isLatest: boolean,
  assetsPromise?: Promise<GitHubReleaseAsset[]>,
): GitHubReleaseInfo {
  return {
    owner: identity.owner,
    repo: identity.repo,
    tag: entry.tag,
    title: entry.title,
    bodyHtml: entry.bodyHtml,
    publishedAt: entry.updated,
    author: entry.author,
    avatarUrl: entry.avatarUrl,
    ownerAvatarUrl: githubAvatarURL(identity.owner),
    htmlUrl: `${GITHUB_HOST}/${identity.owner}/${identity.repo}/releases/tag/${encodeGitHubTagPath(entry.tag)}`,
    isLatest,
    assets,
    assetsPromise,
  }
}

function releaseFromPage(
  identity: GitHubReleaseIdentity,
  page: ReleasePage,
  tag: string,
  assets: GitHubReleaseAsset[],
  assetsPromise?: Promise<GitHubReleaseAsset[]>,
): GitHubReleaseInfo {
  return {
    owner: identity.owner,
    repo: identity.repo,
    tag,
    title: page.title || tag,
    bodyHtml: page.bodyHtml,
    publishedAt: page.publishedAt,
    author: page.author,
    avatarUrl: page.avatarUrl,
    ownerAvatarUrl: page.ownerAvatarUrl || githubAvatarURL(identity.owner),
    htmlUrl: tag
      ? `${GITHUB_HOST}/${identity.owner}/${identity.repo}/releases/tag/${encodeGitHubTagPath(tag)}`
      : `${GITHUB_HOST}/${identity.owner}/${identity.repo}/releases/latest`,
    isLatest: identity.mode !== "tag" || page.isLatest,
    assets,
    assetsPromise,
  }
}

/** 资产区不是正文：最多等一小段；慢请求交给页面加载后的异步注入。 */
function waitForAssets(promise: Promise<GitHubReleaseAsset[]>): Promise<GitHubReleaseAsset[]> {
  return new Promise<GitHubReleaseAsset[]>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (assets: GitHubReleaseAsset[]) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(assets)
    }
    timer = setTimeout(() => finish([]), ASSET_WAIT_MS)
    promise.then(finish, () => finish([]))
  })
}

export async function getGitHubRelease(identity: GitHubReleaseIdentity): Promise<GitHubReleaseInfo> {
  if (identity.mode === "profile") {
    const profile = await getGitHubProfile(identity)
    return {
      kind: "profile",
      owner: identity.owner,
      repo: "",
      tag: "",
      title: identity.owner,
      bodyHtml: profile.bodyHtml,
      profileDescription: profile.profileDescription,
      ownerAvatarUrl: profile.ownerAvatarUrl,
      htmlUrl: identity.url,
      isLatest: false,
      assets: [],
    }
  }
  if (identity.mode === "repository" || identity.mode === "readme") {
    return getGitHubReadme(identity)
  }

  const owner = identity.owner
  const repo = identity.repo
  const atomPromise = fetchAtom(owner, repo)
    .then(parseAtom)
    .catch(() => [] as AtomEntry[])
  // Start the page request immediately. An Atom miss used to add a full 20s
  // timeout before the page request even started, so weak networks waited
  // twice for the same release. The page is only consumed if Atom cannot
  // answer; failures are swallowed because it is an optional fallback.
  const pageController = new AbortController()
  const pagePromise = fetchReleasePage(identity, pageController.signal).catch(() => null)
  const tagAssetPromise = identity.tag
    ? fetchAssets(owner, repo, identity.tag)
    : Promise.resolve([] as GitHubReleaseAsset[])

  const pageOrThrow = async () => {
    const page = await pagePromise
    if (!page) throw new Error("无法读取 GitHub Release，请检查链接或网络后重试。")
    return page
  }

  if (identity.mode === "latest") {
    // `/releases/latest` means the latest stable release, not “newest Atom
    // entry”. Electron's Atom feed starts with a nightly while /latest points
    // at a stable tag; selecting the first entry showed the wrong release.
    // API 通常远快于整页；若它被限流/变慢，页面解析出的 tag 同样权威，
    // 谁先给出非空 tag 就用谁，避免稳定版判定把正文再拖 4~10 秒。
    const pageTagPromise = pagePromise.then((page) => {
      if (page?.tag) return page.tag
      return new Promise<string>(() => {})
    }).catch(() => "")
    const latestTag = await Promise.race([
      fetchLatestStableTag(owner, repo).catch(() => ""),
      pageTagPromise,
    ])
    if (latestTag) {
      const assetsPromise = fetchAssets(owner, repo, latestTag)
      const entries = await atomPromise
      const entry = findAtomEntry(entries, latestTag)
      if (entry) {
        pageController.abort()
        const assets = await waitForAssets(assetsPromise)
        return releaseFromAtom(identity, entry, assets, true, assetsPromise)
      }
      const [page, latestAssets] = await Promise.all([pageOrThrow(), waitForAssets(assetsPromise)])
      const pageTag = page.tag || latestTag
      let pageAssets = latestAssets
      let pageAssetsPromise = assetsPromise
      if (pageTag !== latestTag) {
        pageAssetsPromise = fetchAssets(owner, repo, pageTag)
        pageAssets = await waitForAssets(pageAssetsPromise)
      }
      return releaseFromPage(identity, page, pageTag, pageAssets, pageAssetsPromise)
    }
    // API unavailable (rate limit/offline): the page redirect is authoritative.
    const page = await pageOrThrow()
    const tag = page.tag || ""
    const assetsPromise = tag
      ? fetchAssets(owner, repo, tag)
      : Promise.resolve([] as GitHubReleaseAsset[])
    const assets = await waitForAssets(assetsPromise)
    return releaseFromPage(identity, page, tag, assets, assetsPromise)
  }

  if (identity.mode === "tag") {
    const entries = await atomPromise
    const entry = findAtomEntry(entries, identity.tag)
    if (entry) {
      pageController.abort()
      const assets = await waitForAssets(tagAssetPromise)
      return releaseFromAtom(
        identity,
        entry,
        assets,
        !!entries[0] && entries[0].tag === entry.tag,
        tagAssetPromise,
      )
    }
    // Atom only keeps the latest 10 releases; older tags use the page fallback.
    const page = await pageOrThrow()
    const assets = await waitForAssets(tagAssetPromise)
    return releaseFromPage(identity, page, identity.tag || page.tag, assets, tagAssetPromise)
  }

  // `/releases` and any other list-style entry: newest Atom entry, page fallback.
  const entries = await atomPromise
  const entry = findAtomEntry(entries, identity.tag)
  if (entry) {
    pageController.abort()
    const assetsPromise = fetchAssets(owner, repo, entry.tag)
    const assets = await waitForAssets(assetsPromise)
    return releaseFromAtom(identity, entry, assets, true, assetsPromise)
  }
  const page = await pageOrThrow()
  const tag = page.tag || ""
  const assetsPromise = tag
    ? fetchAssets(owner, repo, tag)
    : Promise.resolve([] as GitHubReleaseAsset[])
  const assets = await waitForAssets(assetsPromise)
  return releaseFromPage(identity, page, tag, assets, assetsPromise)
}

/** 页面标题里的日期（GitHub 风格）。 */
export function formatGitHubReleaseDate(value?: string) {
  if (!value) return ""
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ""
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`
}
