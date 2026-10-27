import { Script } from "scripting"
import {
  getGitHubRelease,
  parseGitHubReleaseURL,
  parseGitHubReleaseURLFromValue,
  type GitHubReleaseInfo,
} from "../core/github"
import { prepareGitHubReleasePage } from "../core/github-page"
import { translateGitHubPage } from "../core/github-translation"

const RELEASE_URL = "https://github.com/electron/electron/releases/tag/v30.0.0"

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

function checkURLs() {
  const variants = [
    RELEASE_URL,
    `${RELEASE_URL}?foo=bar`,
    `Release notes\n${RELEASE_URL}`,
    `<${RELEASE_URL}>`,
    `「${RELEASE_URL}」`,
    `${RELEASE_URL}\u200b`,
    `${RELEASE_URL}。`,
    RELEASE_URL.replace("https://", "http://").replace("github.com", "www.github.com"),
    "github.com/electron/electron/releases/tag/v30.0.0",
    "https://github.com/electron/electron/releases/latest",
    "https://github.com/electron/electron/releases",
    "https://github.com/electron/electron/releases/tag/release%2F1.0",
    "https://github.com/electron/electron",
    "https://github.com/electron/electron/",
    "github.com/electron/electron?tab=readme#readme",
  ]
  for (const input of variants) {
    const identity = parseGitHubReleaseURL(input)
    assert(identity?.owner === "electron" && identity.repo === "electron", `分享链接解析失败：${input}`)
    assert(identity.url.startsWith("https://github.com/"), "链接未规范化")
  }
  const repo = parseGitHubReleaseURL("https://github.com/electron/electron")!
  assert(repo.owner === "electron" && repo.repo === "electron" && repo.mode === "repository" && !repo.tag, "仓库主页解析错误")
  assert(repo.url === "https://github.com/electron/electron", "仓库主页链接未保留")
  const tag = parseGitHubReleaseURL(RELEASE_URL)!
  assert(tag.tag === "v30.0.0" && tag.mode === "tag", "tag 解析错误")
  const latest = parseGitHubReleaseURL("https://github.com/electron/electron/releases/latest")!
  assert(latest.mode === "latest" && !latest.tag, "latest 解析错误")
  const slash = parseGitHubReleaseURL("https://github.com/electron/electron/releases/tag/release%2F1.0")!
  assert(slash.tag === "release/1.0", "带斜杠 tag 解析错误")
  const shortcutJSON = parseGitHubReleaseURLFromValue({
    shortcutInput: { sharedURL: `Release notes: ${RELEASE_URL}` },
  })
  assert(shortcutJSON?.tag === "v30.0.0", "快捷指令嵌套 JSON 中的 Release 链接未识别")
  assert(parseGitHubReleaseURLFromValue(["not a link", RELEASE_URL])?.tag === "v30.0.0", "快捷指令 JSON 数组中的 Release 链接未识别")
  assert(parseGitHubReleaseURLFromValue({ note: "no release link" }) === null, "JSON 中无链接时不应命中")
  const tooDeep: Record<string, unknown> = {}
  let nested = tooDeep
  for (let index = 0; index < 6; index += 1) {
    const child: Record<string, unknown> = {}
    nested.child = child
    nested = child
  }
  nested.value = RELEASE_URL
  assert(parseGitHubReleaseURLFromValue(tooDeep) === null, "超出扫描深度的链接不应被读取")
  for (const invalid of [
    "https://github.com/electron/electron/issues/3",
    "https://github.com/electron/electron/pull/3",
    "https://example.com/electron/electron/releases/tag/v1",
    "https://github.com/electron/electron/releases/download/v1/a.ipa",
  ]) {
    assert(parseGitHubReleaseURL(invalid) === null, `非 Release 链接被接受：${invalid}`)
  }
  console.log(`PASS: ${variants.length} GitHub Release URL variants and shortcut JSON inputs`)
}

function checkSanitize() {
  const fake: GitHubReleaseInfo = {
    owner: "owner",
    repo: "repo",
    tag: "v1.0",
    title: "Test <script> title",
    bodyHtml: `<p>Hello <strong>world</strong> and <a href="javascript:alert(1)">bad link</a>.
      <script>alert(1)</script><img src="x" onerror="alert(2)">
      <code>inlineCode()</code></p><pre><code>const a = 1</code></pre><p>literal </script> tag</p>`,
    htmlUrl: "https://github.com/owner/repo/releases/tag/v1.0",
    isLatest: true,
    assets: [{ name: "app.ipa", url: "https://github.com/owner/repo/releases/download/v1.0/app.ipa", size: "1.2 MB" }],
  }
  const page = prepareGitHubReleasePage(fake)
  assert(!page.html.includes("alert(1)") && !page.html.includes("alert(2)"), "脚本/事件属性未被清理")
  assert((page.html.match(/<\/script>/gi) || []).length === 1, "正文中的 script 结束标签未被转义")
  assert(!page.html.includes("javascript:"), "javascript: 链接未被清理")
  assert(page.html.includes("const a = 1"), "代码块内容丢失")
  assert(!/data-lingo-i="[^"]*"[^>]*>const a = 1/.test(page.html), "代码块被错误地送去翻译")
  assert(page.segments.length > 3, "正文文本节点没有切分")
  assert(page.html.includes("data-lingo-i"), "没有生成译文字段")
  console.log(`PASS: sanitize, ${page.segments.length} segments, ${page.groups.length} groups`)
}

async function run() {
  checkURLs()
  checkSanitize()
  const started = Date.now()
  const identity = parseGitHubReleaseURL(RELEASE_URL)
  assert(identity, "示例 Release URL 解析失败")
  const release = await getGitHubRelease(identity)
  assert(release.title.includes("30.0.0"), `读取了错误的 Release：${release.title}`)
  assert(release.bodyHtml.length > 1000, "Release 正文没有读取到")
  assert(release.tag === "v30.0.0", "Release tag 不匹配")
  const fetchMs = Date.now() - started

  const prepared = prepareGitHubReleasePage(release)
  assert(prepared.segments.length > 20, `文本节点过少：${prepared.segments.length}`)
  assert(prepared.groups.length > 5, `翻译分组过少：${prepared.groups.length}`)
  const translateStarted = Date.now()
  const result = await translateGitHubPage(prepared, { targetLanguageCode: "zh-Hans" })
  assert(result.changed > 0, "没有任何文本被翻译")
  const translated = result.segments.filter((item): item is string => typeof item === "string")
  assert(translated.some((item) => /[\u3400-\u9fff]/.test(item)), "译文里没有中文")
  console.log(JSON.stringify({
    fetchMs,
    translateMs: Date.now() - translateStarted,
    title: release.title,
    assets: release.assets.length,
    segments: prepared.segments.length,
    groups: prepared.groups.length,
    changed: result.changed,
    sample: translated.slice(0, 5),
  }))

  const repoIdentity = parseGitHubReleaseURL("https://github.com/electron/electron")
  assert(repoIdentity?.mode === "repository" && repoIdentity.url === "https://github.com/electron/electron", "仓库主页路由错误")

  const latestIdentity = parseGitHubReleaseURL("https://github.com/electron/electron/releases/latest")
  assert(latestIdentity, "latest URL 解析失败")
  const latest = await getGitHubRelease(latestIdentity)
  assert(latest.tag.length > 0 && latest.isLatest, `latest 未解析到具体 tag：${latest.tag}`)

  // Atom 只有最近 10 条，v29.0.0 必须走 Release 页面回退。
  const oldIdentity = parseGitHubReleaseURL("https://github.com/electron/electron/releases/tag/v29.0.0")
  assert(oldIdentity, "旧版本 URL 解析失败")
  const oldRelease = await getGitHubRelease(oldIdentity)
  assert(oldRelease.tag === "v29.0.0", `旧版本 tag 错误：${oldRelease.tag}`)
  assert(oldRelease.title.trim().length > 0, "旧版本标题为空")
  assert(oldRelease.bodyHtml.trim().length > 0, "旧版本正文为空（页面回退失败）")
  const oldPrepared = prepareGitHubReleasePage(oldRelease)
  assert(oldPrepared.segments.length > 10, `旧版本正文切分过少：${oldPrepared.segments.length}`)
  console.log(`PASS: latest=${latest.tag}, page fallback=${oldRelease.tag}, body=${oldRelease.bodyHtml.length}, segments=${oldPrepared.segments.length}`)
}

const deadline = setTimeout(() => Script.exit("FAIL: github-release exceeded 90s"), 90000)
void run().then(() => {
  clearTimeout(deadline)
  Script.exit("PASS: GitHub Release URL, fetch, sanitize and translation")
}, (reason) => {
  clearTimeout(deadline)
  console.error(String(reason))
  Script.exit(`FAIL: ${String(reason)}`)
})
