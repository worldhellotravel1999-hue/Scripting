import { Script } from "scripting"
import { getGitHubRelease, parseGitHubReleaseURL } from "../core/github"
import { prepareGitHubReleasePage } from "../core/github-page"
import { translateGitHubPage } from "../core/github-translation"

const URL = "https://github.com/mirazbakis/AltLoad"

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

async function run() {
  const identity = parseGitHubReleaseURL(URL)
  assert(identity?.mode === "repository", "AltLoad 仓库根链接路由错误")

  const readme = await getGitHubRelease(identity)
  assert(readme.kind === "readme" && readme.isRepositoryHome, "AltLoad README 未从仓库主页提取")
  const prepared = prepareGitHubReleasePage(readme)
  const required = [
    "Sideload AltStore, SideStore and LiveContainer from the iPhone itself.",
    "Download on AltStore",
    "Add AltSource",
    "Download .ipa",
    "How it works",
    "Normally a store like AltStore needs a computer",
    "Signed install.",
    "AltStore or SideStore.",
    "What it does",
    "App extensions, your choice.",
    "AltServer on the phone.",
    "Sign-in that keeps working.",
    "When sources go down.",
    "Privacy",
    "Troubleshooting",
    "Sign-in fails",
    "Apple has been refusing many public anisette servers",
    "Not enough available App IDs",
    "Can't connect to this iPhone",
    "Certificate limit reached",
    "SideStore won't download",
    "How it's built",
    "A SwiftUI app on top of a Rust core.",
  ]
  for (const marker of required) {
    assert(prepared.segments.some((segment) => segment.text.includes(marker)), `README 内容未进入翻译 segments: ${marker}`)
  }
  assert(prepared.segments.length >= 65, `AltLoad README segments 数量异常: ${prepared.segments.length}`)
  assert(prepared.html.includes('class="image-alt-caption"'), "README 图片 alt 文案没有转成可翻译标签")
  assert(prepared.html.includes('alt=""'), "图片替代文字应由可翻译标签接管")

  const progress: number[] = []
  const result = await translateGitHubPage(prepared, {
    sourceLanguageCode: "en",
    targetLanguageCode: "zh-Hans",
    onProgress: (partial) => progress.push(partial.covered),
  })
  const translated = required.map((marker) => {
    const segment = prepared.segments.find((item) => item.text.includes(marker))!
    return { marker, source: segment.text, translation: result.segments[segment.index] || "" }
  })
  console.log(JSON.stringify({ segments: result.total, covered: result.covered, changed: result.changed, progress, translated }))
  assert(result.covered === result.total, `AltLoad README 翻译未覆盖全部 segments: ${result.covered}/${result.total}`)
  for (const item of translated) {
    assert(/[\u3400-\u9fff]/.test(item.translation), `AltLoad 上部/应用内容未得到中文译文: ${item.marker}`)
  }
  Script.exit("PASS: AltLoad README full extraction and translation coverage")
}

const deadline = setTimeout(() => Script.exit("FAIL: github-altload exceeded 120s"), 120000)
void run().then(() => {
  clearTimeout(deadline)
}, (reason) => {
  clearTimeout(deadline)
  console.error(String(reason))
  Script.exit(`FAIL: ${String(reason)}`)
})
