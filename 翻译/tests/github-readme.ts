import { Script } from "scripting"
import {
  getGitHubRelease,
  parseGitHubReleaseURL,
  type GitHubReleaseInfo,
} from "../core/github"
import { prepareGitHubReleasePage } from "../core/github-page"
import { extractGitHubReadme } from "../core/github-readme"
import { translateGitHubPage } from "../core/github-translation"
import { GitHubReleaseContent } from "../views/github-release"

const ROOT_URL = "https://github.com/multica-ai/andrej-karpathy-skills"
const README_URL = `${ROOT_URL}/blob/main/README.md`
const RELEASE_URL = "https://github.com/multica-ai/andrej-karpathy-skills/releases/latest"

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

function checkURLRouting() {
  const root = parseGitHubReleaseURL(ROOT_URL)
  assert(root?.mode === "repository", "参考仓库根链接应解析为 repository")
  assert(root.url === ROOT_URL, "仓库根链接应保留原始仓库地址")
  for (const variant of [`${ROOT_URL}/`, `${ROOT_URL}?tab=readme#readme`, "github.com/multica-ai/andrej-karpathy-skills"]) {
    assert(parseGitHubReleaseURL(variant)?.mode === "repository", `仓库主页分享变体未识别：${variant}`)
  }

  const directReadme = parseGitHubReleaseURL(README_URL)
  assert(directReadme?.mode === "readme", "README.md 直链应解析为 readme")
  assert(directReadme.url === README_URL, "README 直链应保留文件地址")

  const translatedReadme = parseGitHubReleaseURL(`${ROOT_URL}/blob/main/README.zh.md`)
  assert(translatedReadme?.mode === "readme", "README.zh.md 直链应解析为 readme")
  const nestedReadme = parseGitHubReleaseURL(`${ROOT_URL}/blob/main/docs/README.md`)
  assert(nestedReadme?.mode === "readme", "嵌套路径 README.md 直链应解析为 readme")

  const expressRoot = parseGitHubReleaseURL("https://github.com/expressjs/express")
  assert(expressRoot?.mode === "repository", "另一个公共仓库根链接应解析为 repository")
  assert(expressRoot.url === "https://github.com/expressjs/express", "公共仓库根链接未保留")
  const expressReadme = parseGitHubReleaseURL("https://github.com/expressjs/express/blob/master/Readme.md")
  assert(expressReadme?.mode === "readme", "另一个公共仓库的 README 直链未识别")

  const latest = parseGitHubReleaseURL(RELEASE_URL)
  assert(latest?.mode === "latest" && latest.url === RELEASE_URL, "显式 releases/latest 路由发生变化")
}

function fakeReadme(bodyHtml: string): GitHubReleaseInfo {
  return {
    kind: "readme",
    readmeName: "README.md",
    owner: "test-owner",
    repo: "test-repo",
    tag: "",
    title: "README.md",
    bodyHtml,
    htmlUrl: "https://github.com/test-owner/test-repo/blob/main/README.md",
    isLatest: false,
    assets: [],
  }
}

function checkReadmeAvatar() {
  const extracted = extractGitHubReadme(`
    <img data-testid="github-avatar" src="https://avatars.githubusercontent.com/u/12?s=60&amp;v=4" alt="owner">
    <div id="readme"><article class="markdown-body"><p>Avatar fixture</p></article></div>
  `)
  assert(
    extracted.ownerAvatarUrl === "https://avatars.githubusercontent.com/u/12?s=120&v=4",
    `仓库头像未提取或未升到 120px：${extracted.ownerAvatarUrl || ""}`,
  )
}

function checkSyntheticReadmeSegments() {
  const extracted = extractGitHubReadme(`
    <aside><h2>About</h2><p class="description__fixture">Repository introduction sentinel.</p></aside>
    <div id="readme"><article class="markdown-body"><h1>README body sentinel</h1></article></div>
  `)
  assert(extracted.description === "Repository introduction sentinel.", "About 描述提取失败")
  assert(extracted.bodyHtml.includes("README body sentinel"), "About 描述提取混淆 README 正文")

  const source = fakeReadme(`
    <h1>README_HEAD_SENTINEL Opening section</h1>
    <p>Opening paragraph content.</p>
    <h2>README_MIDDLE_SENTINEL Middle section</h2>
    <p>Middle paragraph content.</p>
    <h2>README_TAIL_SENTINEL Final section</h2>
    <p>The final README paragraph must be available for translation.</p>
  `)
  const prepared = prepareGitHubReleasePage(source)
  for (const marker of ["README_HEAD_SENTINEL", "README_MIDDLE_SENTINEL", "README_TAIL_SENTINEL"]) {
    assert(prepared.segments.some((segment) => segment.text.includes(marker)), `${marker} 未进入翻译 segments`)
  }
  assert(!prepared.truncated, "普通 README 不应被截断")
  assert(!prepared.html.includes('<nav class="release-nav">'), "README 页面不应混入 Release 导航标记")
  assert(!prepared.html.includes('<span class="label">Latest</span>'), "README 页面不应显示 Release 标记")
  assert(!prepared.html.includes("released this"), "README 页面不应混入 Release 元信息")

  const longParagraph = "Every paragraph in this synthetic README must remain available for translation. ".repeat(18)
  const longBody = Array.from({ length: 24 }, (_, index) => `<p>Long section ${index + 1}. ${longParagraph}</p>`).join("")
    + "<p>README_SYNTHETIC_TAIL_SENTINEL The final paragraph must not be truncated.</p>"
  assert(longBody.length > 12000, "长正文 fixture 必须超过 12000 字符")
  const longPrepared = prepareGitHubReleasePage(fakeReadme(longBody))
  assert(!longPrepared.truncated, "README 长正文不应触发 12000 字符截断")
  assert(
    longPrepared.segments.some((segment) => segment.text.includes("README_SYNTHETIC_TAIL_SENTINEL")),
    "超过 12000 字符的 README 尾部未进入翻译 segments",
  )
  assert(
    longPrepared.segments.reduce((sum, segment) => sum + segment.text.length, 0) > 12000,
    "长 README 的可翻译 segments 未覆盖 12000 字符之后的正文",
  )

  const repositoryHome = prepareGitHubReleasePage({
    ...source,
    isRepositoryHome: true,
    repositoryDescription: "REPOSITORY_ABOUT_SENTINEL A short repository introduction.",
  })
  assert(
    repositoryHome.segments.some((segment) => segment.text.includes("REPOSITORY_ABOUT_SENTINEL")),
    "仓库 About 描述未进入翻译 segments",
  )
  assert(repositoryHome.html.includes('class="repo-description"'), "仓库介绍未使用独立的页面内容区")
  assert(repositoryHome.html.includes('class="repo-avatar"'), "仓库页头缺少所有者头像")
  assert(repositoryHome.html.includes("https://github.com/test-owner.png?size=96"), "仓库页头缺少头像兜底地址")
  assert(repositoryHome.html.includes('class="repo-title"'), "仓库页头缺少仓库名称")
  assert(repositoryHome.html.includes('class="repo-visibility">Public</span>'), "仓库页头缺少 Public 标签")
  assert(repositoryHome.segments.some((segment) => segment.text === "About"), "仓库介绍区的 About 标题未进入翻译 segments")
  assert(!repositoryHome.html.includes('class="release-title"'), "仓库主页不应重复显示 README 文件名或仓库标题")
  assert(repositoryHome.html.indexOf("REPOSITORY_ABOUT_SENTINEL") < repositoryHome.html.indexOf("README_HEAD_SENTINEL"), "About 描述应排在 README 正文前")
  assert(!repositoryHome.html.includes('<span class="tag-chip">'), "仓库主页不应显示 README 文件名标签")
}

function assertReadmeBodyOnly(bodyHtml: string) {
  assert(bodyHtml.trim().length > 0, "README bodyHtml 为空")
  assert(
    !/(?:js-navigation-container|file-navigation|repository-content|js-repo-nav|UnderlineNav)/i.test(bodyHtml),
    "README bodyHtml 混入 GitHub 文件列表或导航菜单",
  )
}

async function run() {
  assert(typeof GitHubReleaseContent === "function", "GitHub 翻译视图未正常加载")
  checkURLRouting()
  checkReadmeAvatar()
  checkSyntheticReadmeSegments()

  const rootIdentity = parseGitHubReleaseURL(ROOT_URL)
  assert(rootIdentity, "参考仓库根链接解析失败")
  const rootReadme = await getGitHubRelease(rootIdentity)
  assert(rootReadme.kind === "readme", "仓库根链接未通过兼容入口读取 README")
  assert(rootReadme.isRepositoryHome === true, "仓库根链接未标记为仓库主页")
  assert(rootReadme.title === rootReadme.repo, "仓库主页标题不应显示 README 文件名")
  assert(!!rootReadme.repositoryDescription, "仓库根链接未读取 GitHub About 描述")
  assert(/^https:\/\//.test(rootReadme.ownerAvatarUrl || ""), "仓库根链接未提取所有者头像")
  assert(rootReadme.readmeName?.toLowerCase() === "readme.md", `根链接 README 文件名错误：${rootReadme.readmeName || ""}`)
  assertReadmeBodyOnly(rootReadme.bodyHtml)

  const expressIdentity = parseGitHubReleaseURL("https://github.com/expressjs/express")
  assert(expressIdentity, "另一个公共仓库解析失败")
  const expressReadme = await getGitHubRelease(expressIdentity)
  assert(expressReadme.kind === "readme", "另一个公共仓库未读取 README")
  assertReadmeBodyOnly(expressReadme.bodyHtml)
  assert(expressReadme.bodyHtml.length > 1000, "另一个公共仓库 README 正文异常短")
  const expressPrepared = prepareGitHubReleasePage(expressReadme)
  assert(expressPrepared.segments.length > 20, "另一个公共仓库 README 可翻译内容过少")

  const directIdentity = parseGitHubReleaseURL(README_URL)
  assert(directIdentity, "参考仓库 README 直链解析失败")
  const directReadme = await getGitHubRelease(directIdentity)
  assert(directReadme.kind === "readme", "README 直链未通过兼容入口读取 README")
  assert(directReadme.readmeName?.toLowerCase() === "readme.md", `直链 README 文件名错误：${directReadme.readmeName || ""}`)
  assertReadmeBodyOnly(directReadme.bodyHtml)

  const prepared = prepareGitHubReleasePage(rootReadme)
  assert(prepared.segments.length > 10, `README 翻译 segments 过少：${prepared.segments.length}`)
  assert(/class="repo-avatar"[^>]*src="https:\/\/avatars\.githubusercontent\.com\//.test(prepared.html), "仓库页头没有渲染真实头像图片")
  const aboutSegment = prepared.segments.find((segment) => segment.text === rootReadme.repositoryDescription)
  assert(aboutSegment, "仓库 About 描述未进入实际翻译任务")
  assert(!prepared.html.includes('<nav class="release-nav">'), "实际 README 页面混入 Release 导航标记")
  assert(!prepared.html.includes('<span class="label">Latest</span>'), "实际 README 页面显示了 Release 标记")
  assert(!prepared.html.includes("released this"), "实际 README 页面混入 Release 元信息")
  const bodySegments = prepared.segments.filter((segment) => segment.block >= 0)
  const tailSegment = bodySegments[bodySegments.length - 1]
  assert(tailSegment, "参考 README 没有可翻译的尾部正文段落")

  const translateStart = Date.now()
  const progress: number[] = []
  const result = await translateGitHubPage(prepared, { sourceLanguageCode: "en", targetLanguageCode: "zh-Hans", onProgress: (partial) => progress.push(partial.covered) })
  console.log(JSON.stringify({ translateMs: Date.now() - translateStart, progress, missing: prepared.segments.filter((segment) => !result.segments[segment.index]).map((segment) => ({ index: segment.index, source: segment.text })) }))
  const tailTranslation = result.segments[tailSegment.index]
  assert(typeof tailTranslation === "string" && /[\u3400-\u9fff]/.test(tailTranslation), "参考 README 尾部段落没有中文译文")
  const aboutTranslation = result.segments[aboutSegment.index]
  assert(typeof aboutTranslation === "string" && /[\u3400-\u9fff]/.test(aboutTranslation), "仓库 About 描述没有中文译文")
  assert(result.covered === result.total, `README 翻译未覆盖全部 segments：${result.covered}/${result.total}`)

  console.log(JSON.stringify({
    rootBodyHtml: rootReadme.bodyHtml.length,
    directBodyHtml: directReadme.bodyHtml.length,
    expressBodyHtml: expressReadme.bodyHtml.length,
    expressSegments: expressPrepared.segments.length,
    segments: result.total,
    covered: result.covered,
    tailSource: tailSegment.text,
    tailTranslation,
  }))
  Script.exit("PASS: GitHub README routing, full-body segmentation and translation")
}

const deadline = setTimeout(() => Script.exit("FAIL: github-readme exceeded 180s"), 180000)
void run().then(() => {
  clearTimeout(deadline)
}, (reason) => {
  clearTimeout(deadline)
  console.error(String(reason))
  Script.exit(`FAIL: ${String(reason)}`)
})
