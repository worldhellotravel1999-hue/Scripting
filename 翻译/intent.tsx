import { Intent, Navigation, Script } from "scripting"
import { parseAppStoreURL } from "./core/appstore"
import { parseGitHubReleaseURL, parseGitHubReleaseURLFromValue } from "./core/github-url"
import { inlineImageBitmap } from "./core/screen-ocr"
import { beginScreenTranslation } from "./core/screen-job"
import { ScreenTranslationResult } from "./views/screen-result"

function cleanPath(value: unknown): string {
  const path = String(value || "").trim()
  if (!path) return ""
  return path.startsWith("file://") ? path.slice(7) : path
}

function inputImagePaths(): string[] {
  const paths: string[] = []
  for (const value of Intent.imagePathsParameter || []) {
    const path = cleanPath(value)
    if (path) paths.push(path)
  }
  // Some Shortcuts actions expose a shared image as a file URL rather than
  // populating imagePathsParameter.
  for (const value of Intent.fileURLsParameter || []) {
    const path = cleanPath(value)
    if (path) paths.push(path)
  }
  const shortcut = Intent.shortcutParameter
  if (shortcut?.type === "fileURL") {
    const path = cleanPath(shortcut.value)
    if (path) paths.push(path)
  }
  return [...new Set(paths)]
}

async function inputImages(): Promise<UIImage[]> {
  // 分享扩展中的临时截图可能在 present/OCR 前被系统回收；这里仍在
  // 读取瞬间物化为内存位图。主界面相册路径不经过此函数，首帧提速由
  // home.tsx 的延后物化负责。
  for (const path of inputImagePaths()) {
    try {
      const image = UIImage.fromFile(path)
      const bitmap = inlineImageBitmap(image)
      if (bitmap) return [bitmap]
    } catch {}
  }

  const decoded = Intent.imagesParameter
  if (!Array.isArray(decoded)) return []
  for (const candidate of decoded as UIImage[]) {
    const bitmap = inlineImageBitmap(candidate)
    if (bitmap) return [bitmap]
  }
  return []
}

function inputCandidates() {
  const values: string[] = []
  for (const value of Intent.urlsParameter || []) values.push(String(value || "").trim())
  for (const value of Intent.textsParameter || []) values.push(String(value || "").trim())
  const shortcut = Intent.shortcutParameter
  // Shortcuts 可能把同一链接作为 URL、文本或文件 URL 传入；只要 value
  // 是字符串就交给 App Store/GitHub 解析，避免载体差异误走截图分支。
  if (shortcut && typeof shortcut.value === "string") {
    values.push(String(shortcut.value).trim())
  }
  return values.filter(Boolean)
}

function firstAppStoreURL() {
  for (const value of inputCandidates()) {
    const identity = parseAppStoreURL(value)
    if (identity) return identity.url
  }
  return ""
}

function firstGitHubURL() {
  for (const value of inputCandidates()) {
    const identity = parseGitHubReleaseURL(value)
    if (identity) return identity.url
  }
  const shortcut = Intent.shortcutParameter
  if (shortcut?.type === "json") {
    return parseGitHubReleaseURLFromValue(shortcut.value)?.url || ""
  }
  return ""
}

async function showScreenText(text: string) {
  try {
    await QuickLook.previewText(text)
  } catch {
    try { await Dialog.alert({ title: "截图翻译", message: text }) } catch {}
  }
}

// 页面立即呈现，**同时**在呈现之前就把「OCR → 翻译 → 覆盖渲染」跑起来。
//
// 2026-10-19 速度修复（分享入口 4~5 秒 → 对齐主界面 1 秒）：
// 旧实现要等 `await Navigation.present(...)` 返回、结果页挂载、useEffect
// 触发后才开始工作，等于「分享扩展冷启动 + present + 首帧挂载 + 整条管线」
// 串行相加；主界面相册入口（views/home.tsx）本来就是先 begin 再 present，
// 管线与页面呈现重叠，所以只有它快。
//
// 关键区别：这里只是**不 await** 地启动异步管线（首帧不会被长任务阻塞，
// 旧版「先 await 完整管线再 present」才会让扩展无响应），present 照常立即
// 发起。页面挂载后 startScreenTranslation 复用的就是这一份工作。
async function runScreenTranslation(images: UIImage[]) {
  const image = images[0]
  // 先把工作登记进 screen-job（同步就能 set active，页面挂载时一定复用得到），
  // 紧接着发 present 但**不 await**：管线与页面首帧完全并行。
  // 用 begin（无条件新建）而不是 start：intent 进程里 active 可能残留上一次
  // 分享的已完成任务，复用会立刻显示上一张的结果。
  const job = beginScreenTranslation(image)
  const presenting = Navigation.present({ element: <ScreenTranslationResult image={image} /> })
  try {
    await presenting
  } catch {}

  // 页面被秒关/未挂载也不影响：这里取的就是上面那份工作。
  try {
    const result = await job
    Script.exit(Intent.text(result.text))
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason)
    Script.exit(Intent.text(`截图翻译失败：${message}`))
  }
}

async function run() {
  // App Store 分享项可能同时提供链接与预览图。有效链接必须先分流，
  // 避免读取惰性 imagesParameter 或解码预览图后误入截图/OCR 管线。
  const url = firstAppStoreURL()
  if (!url) {
    const githubURL = firstGitHubURL()
    if (githubURL) {
      try {
        // 按需加载：GitHub 页面会连带引入 linkedom 与网页构建逻辑，
        // 截图/App Store 路径完全不需要它们。
        const { GitHubReleaseView } = await import("./views/github-release")
        await Navigation.present({ element: <GitHubReleaseView url={githubURL} /> })
        Script.exit()
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason)
        const fallback = `GitHub 正文打开失败：${message}`
        await showScreenText(fallback)
        Script.exit(Intent.text(fallback))
      }
      return
    }

    const images = await inputImages()
    if (images.length) {
      await runScreenTranslation(images)
      return
    }

    const message = inputImagePaths().length
      ? "未收到可读取的截图（文件可能已被系统回收或受数据保护限制），请重新分享一次，并确认传入的是图片而非文件链接。"
      : "未收到图片、App Store 或 GitHub 链接。请分享 GitHub 仓库主页、README 文件、Release 链接或截图。"
    await showScreenText(message)
    Script.exit(Intent.text(message))
    return
  }

  try {
    // 按需加载：views/app-store 会连带引入 region-prices → pricing → linkedom(201KB)
    // 与 appraven(41KB)，对截图翻译毫无用处；动态 import 让截图路径完全不碰这条链。
    const { AppStoreView } = await import("./views/app-store")
    await Navigation.present({ element: <AppStoreView url={url} /> })
    Script.exit()
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason)
    const fallback = `App Store 介绍页打开失败：${message}`
    await showScreenText(fallback)
    Script.exit(Intent.text(fallback))
  }
}

void run().catch(async (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason)
  try {
    await Dialog.alert({ title: Script.name, message })
  } finally {
    Script.exit()
  }
})
