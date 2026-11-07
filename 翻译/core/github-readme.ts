import { fetch } from "scripting"
import { parseHTML } from "./linkedom"
import type { GitHubReleaseIdentity } from "./github-url"
import { githubAvatarURL } from "./github-url"
import type { GitHubReleaseInfo } from "./github"

const OPTIONS = { method: "GET", timeout: 20, debugLabel: "Lingo GitHub README" }
const README_NAME = /^readme(?:[._-][^/]*)?$/i

function decoded(value: string) {
  try { return decodeURIComponent(value) } catch { return value }
}

/** 仓库页头那颗所有者头像；与 GitHub 自己的 repo header 是同一张图。 */
function avatarFromDocument(document: any) {
  for (const selector of [
    'img[data-testid="github-avatar"]',
    'img[data-component="Avatar"]',
    "img.avatar",
  ]) {
    const raw = String(document.querySelector(selector)?.getAttribute?.("src") || "").trim()
    if (!raw) continue
    const absolute = raw.startsWith("//") ? `https:${raw}`
      : raw.startsWith("/") ? `https://github.com${raw}`
      : /^https?:\/\//i.test(raw) ? raw : ""
    if (!absolute) continue
    // GitHub 页头给的是 s=60（配 24pt）。这里显示 32pt，升到 120 才不发虚。
    return absolute.replace(/([?&])s=(\d+)/, (whole, separator: string, size: string) => {
      const value = Number(size)
      return Number.isFinite(value) && value < 120 ? `${separator}s=120` : whole
    })
  }
  return ""
}

/** README 正文单独提取；仓库 About 描述另存，不混入 README 正文。 */
export function extractGitHubReadme(html: string) {
  const { document } = parseHTML(html)
  const ownerAvatarUrl = avatarFromDocument(document)
  const descriptionNode = document.querySelector('p[class*="description__"]')
  const description = String(descriptionNode?.textContent || "").replace(/\s+/g, " ").trim()
  for (const selector of [
    "#readme article.markdown-body", "#readme .markdown-body",
    '[data-testid="readme"] .markdown-body', "article.markdown-body",
  ]) {
    const node = document.querySelector(selector)
    if (node && String(node.innerHTML || "").trim()) {
      return { bodyHtml: String(node.innerHTML), document, description, ownerAvatarUrl }
    }
  }
  // GitHub 的 React 文件页有时只把服务端渲染结果放在 JSON payload 中。
  for (const script of Array.from(document.querySelectorAll('script[type="application/json"]')) as any[]) {
    try {
      const payload = JSON.parse(script.textContent || "{}")
      const blob = payload?.payload?.blob || payload?.blob
      const richText = blob?.richText
      if (typeof richText === "string" && richText.trim()) {
        return { bodyHtml: richText, document, description, ownerAvatarUrl }
      }
      const overview = payload?.payload?.overview || payload?.overview
      for (const item of overview?.overviewFiles || []) {
        if (README_NAME.test(String(item.name || item.path || "").split("/").pop() || "")
          && typeof item.richText === "string" && item.richText.trim()) {
          return { bodyHtml: item.richText, document, description, ownerAvatarUrl }
        }
      }
    } catch {}
  }
  return { bodyHtml: "", document, description, ownerAvatarUrl }
}

function readmeLink(document: any, base: string) {
  const prefix = `${base}/blob/`
  const links = (Array.from(document.querySelectorAll("a[href]")) as any[])
    .map((node) => String(node.getAttribute("href") || ""))
    .map((href) => href.startsWith("/") ? `https://github.com${href}` : href)
    .filter((href) => href.startsWith(prefix) && README_NAME.test(decoded(href.split(/[?#]/)[0].split("/").pop() || "")))
  return links.find((href) => /\/readme\.(?:md|markdown|rst|txt)(?:[?#]|$)/i.test(href)) || links[0] || ""
}

function info(
  identity: GitHubReleaseIdentity,
  bodyHtml: string,
  contentUrl: string,
  repositoryDescription = "",
  ownerAvatarUrl = "",
): GitHubReleaseInfo {
  const filename = contentUrl.includes("/blob/")
    ? decoded(contentUrl.split(/[?#]/)[0].split("/").pop() || "README") : "README"
  const isRepositoryHome = identity.mode === "repository"
  return {
    owner: identity.owner, repo: identity.repo, kind: "readme",
    isRepositoryHome,
    repositoryDescription: isRepositoryHome ? repositoryDescription : undefined,
    tag: "", title: isRepositoryHome ? identity.repo : filename || identity.repo, readmeName: filename,
    bodyHtml,
    ownerAvatarUrl: ownerAvatarUrl || githubAvatarURL(identity.owner),
    htmlUrl: isRepositoryHome ? `https://github.com/${identity.owner}/${identity.repo}` : contentUrl || identity.url,
    contentBaseUrl: contentUrl || identity.url,
    isLatest: false, assets: [],
  }
}

export async function getGitHubReadme(identity: GitHubReleaseIdentity): Promise<GitHubReleaseInfo> {
  const base = `https://github.com/${identity.owner}/${identity.repo}`
  let lastError = "未找到可读取的 README 正文"
  let repositoryDescription = ""
  try {
    const response = await fetch(identity.url, OPTIONS)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const { bodyHtml, document, description, ownerAvatarUrl } = extractGitHubReadme(await response.text())
    repositoryDescription = description
    if (bodyHtml.trim()) {
      const contentUrl = identity.mode === "readme" ? identity.url : readmeLink(document, base) || `${base}/blob/HEAD/README.md`
      return info(identity, bodyHtml, contentUrl, repositoryDescription, ownerAvatarUrl)
    }
  } catch (reason) {
    lastError = reason instanceof Error ? reason.message : String(reason)
  }

  // HTML 结构变化/页面加载失败时，用 GitHub 官方 Contents API 的 HTML 媒体类型。
  // 默认 README 由 GitHub 选择，不假设 main 分支、根目录或 README.md 文件名。
  // 文档：https://docs.github.com/en/rest/repos/contents#get-a-repository-readme
  if (identity.mode === "repository") {
    try {
      const endpoint = `https://api.github.com/repos/${identity.owner}/${identity.repo}/readme`
      const metaResponse = await fetch(endpoint, { ...OPTIONS, headers: { Accept: "application/vnd.github+json" } })
      if (!metaResponse.ok) throw new Error(`README API HTTP ${metaResponse.status}`)
      const metadata = await metaResponse.json() as { html_url?: string; url?: string }
      const contentUrl = String(metadata.html_url || "")
      const apiURL = String(metadata.url || "")
      if (!contentUrl.startsWith("https://github.com/") || !apiURL.startsWith("https://api.github.com/repos/")) {
        throw new Error("README API 没有返回有效文件地址")
      }
      const response = await fetch(apiURL, { ...OPTIONS, headers: { Accept: "application/vnd.github.html+json" } })
      if (!response.ok) throw new Error(`README HTML HTTP ${response.status}`)
      const html = await response.text()
      const { bodyHtml, document, description, ownerAvatarUrl } = extractGitHubReadme(html)
      repositoryDescription = repositoryDescription || description
      const content = bodyHtml || (/^\s*</.test(html) && document.querySelector("p,h1,h2,pre,ul,table") ? html : "")
      if (!content.trim()) throw new Error("README 正文为空")
      return info(identity, content, contentUrl, repositoryDescription, ownerAvatarUrl)
    } catch (reason) {
      lastError = reason instanceof Error ? reason.message : String(reason)
    }
  }
  // 指定 README 文件失败时，不偷换成默认分支上的另一份 README。
  throw new Error(`无法读取 GitHub README（${lastError}）。仓库可能未提供 README、需要登录或暂时受限，请重试。`)
}
