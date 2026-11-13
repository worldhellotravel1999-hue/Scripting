import { Script } from "scripting"
import { getGitHubRelease, parseGitHubReleaseURL } from "../core/github"
import { prepareGitHubReleasePage } from "../core/github-page"
import { parseHTML } from "../core/linkedom"
import { translateGitHubPage } from "../core/github-translation"

const URL = "https://github.com/mirazbakis/AltLoad"

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

/**
 * 从 README HTML 收集真正会进入翻译的文本节点。测试不再硬编码 README
 * 文案：仓库更新一次，旧断言就整体失效；这里直接对照抓到的正文，
 * 验证“每个可见文本节点都进了 segments”这个真正的不变式。
 */
function visibleTextNodes(html: string): string[] {
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`)
  const skip = new Set([
    "PRE", "CODE", "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "TEMPLATE",
    "SVG", "MATH", "IFRAME", "OBJECT", "EMBED", "CANVAS", "FORM", "INPUT",
    "BUTTON", "SELECT", "VIDEO", "AUDIO", "SOURCE", "TRACK", "LINK", "META", "BASE",
  ])
  const texts: string[] = []
  const visit = (node: any) => {
    for (const child of Array.from(node.childNodes || []) as any[]) {
      if (child.nodeType === 3) {
        const text = String(child.nodeValue || "").replace(/\s+/g, " ").trim()
        if (text.length >= 20 && /[\p{L}\p{N}]/u.test(text)) texts.push(text)
      } else if (child.nodeType === 1) {
        if (!skip.has(String(child.tagName || "").toUpperCase())) visit(child)
      }
    }
  }
  visit(document.body)
  return texts
}

async function run() {
  const identity = parseGitHubReleaseURL(URL)
  assert(identity?.mode === "repository", "AltLoad 仓库根链接路由错误")

  const readme = await getGitHubRelease(identity)
  assert(readme.kind === "readme" && readme.isRepositoryHome, "AltLoad README 未从仓库主页提取")
  const prepared = prepareGitHubReleasePage(readme)
  const bodyTexts = visibleTextNodes(readme.bodyHtml)
  assert(bodyTexts.length >= 20, `README 可见文本节点过少: ${bodyTexts.length}`)
  const missing = bodyTexts.filter((text) =>
    !prepared.segments.some((segment) => segment.text.includes(text))
  )
  assert(missing.length === 0, `README 内容未进入翻译 segments: ${missing[0] || ""}`)
  assert(prepared.segments.length >= 65, `AltLoad README segments 数量异常: ${prepared.segments.length}`)
  assert(prepared.html.includes('class="image-alt-caption"'), "README 图片 alt 文案没有转成可翻译标签")
  assert(prepared.html.includes('alt=""'), "图片替代文字应由可翻译标签接管")

  const progress: number[] = []
  const result = await translateGitHubPage(prepared, {
    sourceLanguageCode: "en",
    targetLanguageCode: "zh-Hans",
    onProgress: (partial) => progress.push(partial.covered),
  })
  const sample = bodyTexts.filter((text) => text.length >= 60).slice(0, 10)
  const translated = sample.map((marker) => {
    const segment = prepared.segments.find((item) => item.text.includes(marker))!
    return { marker, source: segment.text, translation: result.segments[segment.index] || "" }
  })
  console.log(JSON.stringify({ segments: result.total, covered: result.covered, changed: result.changed, progress, translated }))
  assert(result.covered === result.total, `AltLoad README 翻译未覆盖全部 segments: ${result.covered}/${result.total}`)
  for (const item of translated) {
    assert(/[\u3400-\u9fff]/.test(item.translation), `AltLoad 长句未得到中文译文: ${item.marker}`)
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
