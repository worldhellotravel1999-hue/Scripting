import { Script } from "scripting"
import { type GitHubReleaseInfo } from "../core/github"
import { prepareGitHubReleasePage } from "../core/github-page"
import { githubPageDirectory, githubPageFile } from "../core/github-page-file"

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

async function run() {
  const source = "GITHUB_INJECTION_SENTINEL The page must accept translations after loadFile."
  const release: GitHubReleaseInfo = {
    owner: "injection-test",
    repo: "repo",
    tag: "v1",
    title: "Injection Test",
    bodyHtml: `<p>${source}</p>`,
    htmlUrl: "https://github.com/injection-test/repo/releases/tag/v1",
    isLatest: true,
    assets: [],
  }
  const prepared = prepareGitHubReleasePage(release)
  const segment = prepared.segments.find((item) => item.text === source)
  assert(segment, "fixture text was not prepared as a translation segment")

  const path = githubPageFile(prepared.html, `injection-${Date.now()}`)
  assert(path, "could not write the production GitHub page file")
  const controller = new WebViewController({ ephemeral: true })
  try {
    assert(await controller.loadFile(path, githubPageDirectory()), "production GitHub HTML failed to load")
    await controller.waitForLoad({ timeout: 15 })
    const ready = await controller.evaluateJavaScript<boolean>(
      "return window.__lingoReady === true && typeof window.__lingoSet === 'function' && window.__lingoCount > 0",
    )
    assert(ready, "page injection bridge was not ready after loadFile")

    const translated = "加载后成功注入的中文译文"
    const map = { [segment.index]: `${segment.leading}${translated}${segment.trailing}` }
    const applied = await controller.evaluateJavaScript<boolean>(
      `if (typeof window.__lingoSet !== "function") return false; window.__lingoSet(${JSON.stringify(map)}); window.__lingoMode("translated"); return true`,
    )
    assert(applied, "__lingoSet rejected the translation map")
    const pageText = await controller.evaluateJavaScript<string>(
      `return document.querySelector('[data-lingo-i="${segment.index}"]').textContent`,
    )
    assert(pageText.includes(translated), `injected translation missing from DOM: ${pageText}`)

    await controller.evaluateJavaScript("window.__lingoMode('original'); return true")
    const original = await controller.evaluateJavaScript<string>(
      `return document.querySelector('[data-lingo-i="${segment.index}"]').textContent`,
    )
    assert(original.includes(source), "original mode did not restore source text")
    console.log("PASS: production loadFile bridge, translation injection and original-mode restoration")
  } finally {
    controller.dispose()
    try { FileManager.removeSync(path) } catch {}
  }
}

void run().then(
  () => Script.exit("PASS"),
  (error) => {
    console.error(String(error))
    Script.exit("FAIL")
  },
)
