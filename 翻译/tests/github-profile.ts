import { Script } from "scripting"
import { parseGitHubReleaseURL } from "../core/github-url"
import { extractGitHubProfile } from "../core/github-profile"
import type { GitHubReleaseInfo } from "../core/github"
import { prepareGitHubReleasePage } from "../core/github-page"

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

function checkRouting() {
  const variants = [
    "https://github.com/OpenMinis",
    "https://github.com/OpenMinis/",
    "https://github.com/OpenMinis?tab=overview#readme",
    "github.com/OpenMinis",
    "https://github.com/orgs/OpenMinis",
    "https://github.com/orgs/OpenMinis/",
  ]
  for (const input of variants) {
    const identity = parseGitHubReleaseURL(input)
    assert(identity?.mode === "profile", `组织主页未识别为 profile：${input}`)
    assert(identity.owner === "OpenMinis" && identity.repo === "", `组织主页 owner/repo 错误：${input}`)
    assert(identity.url === "https://github.com/OpenMinis", `组织主页未规范化：${input}`)
  }

  const repository = parseGitHubReleaseURL("https://github.com/OpenMinis/iCTRL")
  assert(repository?.mode === "repository" && repository.repo === "iCTRL", "既有仓库主页路由发生回归")

  for (const input of [
    "https://github.com/OpenMinis/repositories",
    "https://github.com/OpenMinis/events",
    "https://github.com/orgs/OpenMinis/repositories",
    "https://github.com/login",
    "https://github.com/OpenMinis/OpenMinis/issues/1",
  ]) {
    assert(parseGitHubReleaseURL(input) === null, `非主页链接被错误接受：${input}`)
  }
}

function checkExtractionAndPage() {
  const extracted = extractGitHubProfile(`<!doctype html><html><head>
    <meta property="og:image" content="https://avatars.githubusercontent.com/u/12?v=4">
    </head><body><img itemprop="image" src="https://avatars.githubusercontent.com/u/12?s=200&amp;v=4">
    <article class="markdown-body entry-content"><h1>Open Minis</h1>
      <p>PROFILE_README_SENTINEL Your Private On-Device AI Agent.</p>
      <p>It takes action across your devices with <a href="https://github.com/OpenMinis/iCTRL">iCTRL</a>.</p>
      <img src="https://avatars.githubusercontent.com/u/99?v=1" alt="linked image">
    </article></body></html>`)
  assert(extracted.bodyHtml.includes("PROFILE_README_SENTINEL"), "组织 profile README 正文未提取")
  assert(extracted.ownerAvatarUrl === "https://avatars.githubusercontent.com/u/12?s=200&v=4", "组织头像未提取或未解码")
  assert(!extracted.profileDescription, "profile README 首段不应被错误复制为独立简介")

  const noBio = extractGitHubProfile(`<article class="markdown-body entry-content"><h1>OpenMinis</h1><p>README_ONLY_SENTINEL</p></article>`)
  assert(noBio.bodyHtml.includes("README_ONLY_SENTINEL"), "没有 profile bio 时 README 正文应仍可提取")
  assert(!noBio.profileDescription, "没有明确 bio 时不应合成简介")

  const release: GitHubReleaseInfo = {
    kind: "profile",
    owner: "OpenMinis",
    repo: "",
    tag: "",
    title: "OpenMinis",
    bodyHtml: extracted.bodyHtml,
    ownerAvatarUrl: extracted.ownerAvatarUrl,
    htmlUrl: "https://github.com/OpenMinis",
    isLatest: false,
    assets: [],
  }
  const page = prepareGitHubReleasePage(release)
  assert(page.segments.some((segment) => segment.text.includes("PROFILE_README_SENTINEL")), "profile README 未进入翻译分段")
  assert(page.html.includes("class=\"github-mark\""), "页面顶部缺少 GitHub 品牌图标")
  assert(page.html.includes("href=\"https://github.com/OpenMinis\" title=\"https://github.com/OpenMinis\""), "页面顶部来源链接缺失或不正确")
  assert(page.html.includes("avatars.githubusercontent.com/u/12?s=200&amp;v=4"), "页面顶部组织头像缺失")
  assert(page.html.includes('class="repo-avatar"'), "页面顶部头像图片未渲染")
  assert(!page.html.includes("class=\"release-nav\""), "组织主页错误显示 Release 导航")
  assert(page.html.includes("href=\"https://github.com/OpenMinis/iCTRL\""), "README 正文原链接丢失")
  assert(page.html.includes("src=\"https://avatars.githubusercontent.com/u/99?v=1\""), "README 正文图片丢失")
}

try {
  checkRouting()
  checkExtractionAndPage()
  Script.exit("PASS: GitHub profile URL routing, README extraction and page header")
} catch (reason) {
  const message = reason instanceof Error ? reason.message : String(reason)
  Script.exit(`FAIL: ${message}`)
}
