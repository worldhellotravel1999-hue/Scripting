/**
 * GitHub 仓库 README / Release 链接解析（不依赖 linkedom）。
 *
 * intent 在截图/App Store 路径上完全不该加载 200KB 的 HTML 解析器，
 * 因此把纯字符串解析单独放在这里，数据抓取与页面构建再按需加载。
 */
export type GitHubReleaseIdentity = {
  owner: string
  repo: string
  /** 未指定 tag（/releases、/releases/latest）时为空，取 Atom 第一条。 */
  tag?: string
  url: string
  mode: "tag" | "latest" | "list" | "repository" | "readme" | "profile"
}

const GITHUB_HOST = "https://github.com"

function githubURLFromInput(input: string) {
  const raw = String(input || "").replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim()
  if (!raw) return ""
  // 分享文本里常带中文引号、书名号或句末标点；GitHub 链接本身不含这些字符。
  const match = raw.match(/(?:(?:https?):\/\/)?(?:www\.)?github\.com\/[^\s<>"'“”‘’「」『』《》]+/i)
  if (!match) return ""
  return String(match[0] || "")
    .replace(/[\])}>.,;!，。；！、）】」』》]+$/g, "")
    .trim()
}

export function encodeGitHubTagPath(tag: string) {
  return String(tag || "")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")
}

/**
 * 仓库/组织/用户头像的稳定地址。GitHub 会 302 到
 * avatars.githubusercontent.com，不占 API 限额，供页头头像兜底。
 */
export function githubAvatarURL(owner: string, size = 96) {
  const login = String(owner || "").trim()
  if (!login) return ""
  return `${GITHUB_HOST}/${encodeURIComponent(login)}.png?size=${size}`
}

/** 保留分享内容：仓库主页读 README，显式 Release 链接仍读发布说明。 */
export function parseGitHubReleaseURL(input: string): GitHubReleaseIdentity | null {
  const candidate = githubURLFromInput(input)
  if (!candidate) return null

  const normalized = candidate.replace(/^(?!https?:\/\/)/i, "https://")
  const pathOnly = normalized.replace(/[?#].*$/, "").replace(/\/+$/, "")
  const profileMatch = pathOnly.match(
    /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)$/i,
  )
  if (profileMatch) {
    const login = profileMatch[1]
    const reserved = new Set([
      "about", "account", "actions", "api", "apps", "assets", "codespaces", "collections",
      "contact", "copilot", "customer-stories", "dashboard", "education", "enterprise", "events",
      "explore", "features", "gist", "gists", "issues", "join", "login", "marketplace", "mobile",
      "new", "notifications", "organizations", "orgs", "pricing", "pull_requests", "raw", "readme",
      "resources", "search", "security", "settings", "site", "solutions", "sponsors", "team",
      "topics", "trending", "users",
    ])
    if (!reserved.has(login.toLowerCase())) {
      return { owner: login, repo: "", url: `${GITHUB_HOST}/${login}`, mode: "profile" }
    }
    return null
  }

  const orgNamespace = pathOnly.match(
    /^https?:\/\/(?:www\.)?github\.com\/orgs(?:\/|$)/i,
  )
  if (orgNamespace) {
    const orgProfileMatch = pathOnly.match(
      /^https?:\/\/(?:www\.)?github\.com\/orgs\/([A-Za-z0-9_.-]+)$/i,
    )
    if (!orgProfileMatch) return null
    const login = orgProfileMatch[1]
    return { owner: login, repo: "", url: `${GITHUB_HOST}/${login}`, mode: "profile" }
  }

  const profileSubroute = pathOnly.match(
    /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/(events|followers|following|packages|projects|repositories|sponsorships|stars)$/i,
  )
  if (profileSubroute) return null

  const repoMatch = pathOnly.match(
    /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/i,
  )
  if (repoMatch) {
    const owner = repoMatch[1]
    const repo = repoMatch[2].replace(/\.git$/i, "")
    if (owner && repo) {
      return { owner, repo, url: `${GITHUB_HOST}/${owner}/${repo}`, mode: "repository" }
    }
  }

  const readmeMatch = pathOnly.match(
    /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/blob\/(.+)$/i,
  )
  if (readmeMatch) {
    const owner = readmeMatch[1]
    const repo = readmeMatch[2].replace(/\.git$/i, "")
    const path = readmeMatch[3]
    let filename = path.split("/").pop() || ""
    try { filename = decodeURIComponent(filename) } catch {}
    if (repo && path.includes("/") && /^readme(?:[._-][^/]*)?$/i.test(filename)) {
      return { owner, repo, url: `${GITHUB_HOST}/${owner}/${repo}/blob/${path}`, mode: "readme" }
    }
    return null
  }

  const match = pathOnly.match(
    /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/releases(?:\/(.*))?\/?$/i,
  )
  if (!match) return null

  const owner = match[1]
  const repo = match[2].replace(/\.git$/i, "")
  if (!owner || !repo) return null

  const rest = (match[3] || "").replace(/[?#].*$/, "").replace(/^\/+|\/+$/g, "")
  if (!rest) {
    return { owner, repo, url: `${GITHUB_HOST}/${owner}/${repo}/releases`, mode: "list" }
  }
  if (/^latest$/i.test(rest)) {
    return { owner, repo, url: `${GITHUB_HOST}/${owner}/${repo}/releases/latest`, mode: "latest" }
  }
  if (!/^tag\//i.test(rest)) return null

  const rawTag = rest.slice(4)
  if (!rawTag) return null
  let tag = rawTag
  try {
    tag = decodeURIComponent(rawTag)
  } catch {
    tag = rawTag
  }
  // 资产下载地址 /releases/download/... 不是发布页面。
  if (!tag || /^download\//i.test(tag)) return null
  return {
    owner,
    repo,
    tag,
    url: `${GITHUB_HOST}/${owner}/${repo}/releases/tag/${encodeGitHubTagPath(tag)}`,
    mode: "tag",
  }
}

/** Find a Release link in the JSON value Shortcuts can pass as its input. */
export function parseGitHubReleaseURLFromValue(value: unknown): GitHubReleaseIdentity | null {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  const visited = new Set<object>()
  let visitedCount = 0

  while (pending.length && visitedCount < 128) {
    const current = pending.pop()!
    visitedCount += 1
    if (typeof current.value === "string") {
      if (current.value.length <= 16_384) {
        const identity = parseGitHubReleaseURL(current.value)
        if (identity) return identity
      }
      continue
    }
    if (!current.value || typeof current.value !== "object" || current.depth >= 5) continue
    if (visited.has(current.value)) continue
    visited.add(current.value)

    let children: unknown[]
    try {
      children = Array.isArray(current.value)
        ? current.value.slice(0, 64)
        : Object.values(current.value as Record<string, unknown>).slice(0, 64)
    } catch {
      continue
    }
    for (const child of children) pending.push({ value: child, depth: current.depth + 1 })
  }
  return null
}
