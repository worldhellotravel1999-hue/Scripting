import { fetch } from "scripting"
import { parseHTML } from "./linkedom"
import type { GitHubReleaseIdentity } from "./github-url"

export type GitHubProfileInfo = {
  bodyHtml: string
  ownerAvatarUrl?: string
  profileDescription?: string
}

const FETCH_OPTIONS = { method: "GET", timeout: 20, debugLabel: "Lingo GitHub Profile" }
const AVATAR_HOST = "https://avatars.githubusercontent.com/"

function httpsAvatar(value: unknown) {
  const avatar = String(value || "").trim()
  return avatar.startsWith(AVATAR_HOST) ? avatar : ""
}

function textContent(node: any) {
  return String(node?.textContent || "").replace(/\s+/g, " ").trim()
}

export function extractGitHubProfile(html: string): GitHubProfileInfo {
  const { document } = parseHTML(html)
  const article = document.querySelector(
    "#readme article.markdown-body, [data-testid=profile-readme] article.markdown-body, .js-profile-editable-area article.markdown-body, article.markdown-body.entry-content, article.markdown-body",
  )
  const bodyHtml = String(article?.innerHTML || "").trim()

  const avatarNode = document.querySelector('img[itemprop="image"], img.avatar')
  const metaAvatar = document.querySelector('meta[property="og:image"]')?.getAttribute("content")
  const ownerAvatarUrl = httpsAvatar(avatarNode?.getAttribute("src") || metaAvatar) || undefined

  let profileDescription = ""
  for (const selector of [
    '[itemprop="about"]',
    '[data-testid="profile-bio"]',
    ".p-note.user-profile-bio",
    ".org-about",
  ]) {
    profileDescription = textContent(document.querySelector(selector))
    if (profileDescription) break
  }

  return {
    bodyHtml,
    ownerAvatarUrl,
    profileDescription: profileDescription || undefined,
  }
}

function validProfileMetadata(value: unknown, login: string) {
  if (!value || typeof value !== "object") return null
  const metadata = value as { login?: unknown; html_url?: unknown; url?: unknown; avatar_url?: unknown; bio?: unknown; description?: unknown; type?: unknown }
  const metadataLogin = String(metadata.login || "")
  if (metadataLogin.toLowerCase() !== login.toLowerCase()) return null
  const profileURL = `https://github.com/${metadataLogin}`
  const htmlURL = String(metadata.html_url || "").replace(/\/$/, "")
  const apiURL = String(metadata.url || "").replace(/\/$/, "")
  if (htmlURL && htmlURL !== profileURL) return null
  if (apiURL && apiURL !== `https://api.github.com/users/${metadataLogin}` && apiURL !== `https://api.github.com/orgs/${metadataLogin}`) return null
  if (!htmlURL && !apiURL) return null
  return {
    type: String(metadata.type || ""),
    ownerAvatarUrl: httpsAvatar(metadata.avatar_url) || undefined,
    profileDescription: String(metadata.description || metadata.bio || "").replace(/\s+/g, " ").trim() || undefined,
  }
}

async function fetchProfileMetadata(login: string) {
  const encodedLogin = encodeURIComponent(login)
  const userResponse = await fetch(`https://api.github.com/users/${encodedLogin}`, FETCH_OPTIONS)
  if (!userResponse.ok) throw new Error(`GitHub user metadata HTTP ${userResponse.status}`)
  const user = validProfileMetadata(await userResponse.json(), login)
  if (!user || user.type.toLowerCase() !== "organization") return user

  try {
    const orgResponse = await fetch(`https://api.github.com/orgs/${encodedLogin}`, FETCH_OPTIONS)
    if (!orgResponse.ok) return user
    const org = validProfileMetadata(await orgResponse.json(), login)
    if (!org) return user
    return {
      ...org,
      profileDescription: org.profileDescription || user.profileDescription,
    }
  } catch {
    return user
  }
}

export async function getGitHubProfile(identity: GitHubReleaseIdentity): Promise<GitHubProfileInfo> {
  const response = await fetch(identity.url, FETCH_OPTIONS)
  if (!response.ok) throw new Error(`GitHub profile HTTP ${response.status}`)

  const profile = extractGitHubProfile(await response.text())
  if (profile.bodyHtml.trim() && profile.ownerAvatarUrl) return profile

  try {
    const fallback = await fetchProfileMetadata(identity.owner)
    return {
      bodyHtml: profile.bodyHtml,
      ownerAvatarUrl: profile.ownerAvatarUrl || fallback?.ownerAvatarUrl,
      profileDescription: profile.profileDescription || fallback?.profileDescription,
    }
  } catch {
    return profile
  }
}
