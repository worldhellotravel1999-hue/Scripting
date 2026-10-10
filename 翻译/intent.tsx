import { Intent, Navigation, Script } from "scripting"
import { parseAppStoreURL } from "./core/appstore"
import { translateScreenOverlay } from "./core/screen-overlay"
import { AppStoreView } from "./views/app-store"
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
  const images: UIImage[] = []
  const paths = inputImagePaths()
  for (const path of paths) {
    try {
      const image = UIImage.fromFile(path)
      if (image) images.push(image)
    } catch {}
  }
  if (images.length) return images

  // Keep the direct parameter as a fallback for hosts that already decoded it.
  const decoded = Intent.imagesParameter
  return Array.isArray(decoded) ? (decoded as UIImage[]).filter(Boolean) : []
}

function inputCandidates() {
  const values: string[] = []
  for (const value of Intent.urlsParameter || []) values.push(String(value || "").trim())
  for (const value of Intent.textsParameter || []) values.push(String(value || "").trim())

  const shortcut = Intent.shortcutParameter
  if (shortcut?.type === "text" || shortcut?.type === "fileURL") {
    values.push(String(shortcut.value || "").trim())
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

/**
 * 屏幕翻译（内置自「屏幕翻译」脚本，按需求裁剪）：
 * - 图片输入 → Vision 准确识别（无识别模式设置）→ 本脚本 translateText
 *   （谷歌快路径 + 系统回退，语言取共享偏好）→ 译文覆盖图 + 纯文本；
 * - 不带它的翻译设置、引擎选择、API 配置；结果页优先 present 覆盖图，
 *   快捷指令调用方仍收到纯文本译文。
 */
async function showScreenText(text: string) {
  // Intent.text returns a value to the caller; it does not display the translation.
  // Use the system's text preview without creating a translation page or image overlay.
  try {
    await QuickLook.previewText(text)
  } catch {
    try { await Dialog.alert({ title: "截图翻译", message: text }) } catch {}
  }
}

/** 成功时优先呈现“译文覆盖图 + 纯文本”结果页；宿主拒绝呈现再回退纯文本预览。 */
async function showScreenResult(image: UIImage | undefined, cover: UIImage | undefined, text: string) {
  if (image) {
    try {
      await Navigation.present({ element: <ScreenTranslationResult image={image} coverImage={cover} text={text} /> })
      return
    } catch {}
  }
  await showScreenText(text)
}

async function runScreenTranslation(images: UIImage[]) {
  try {
    const translated = await translateScreenOverlay(images[0])
    await showScreenResult(images[0], translated.image, translated.text)
    Script.exit(Intent.text(translated.text))
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason)
    const result = `截图翻译失败：${message}`
    await showScreenText(result)
    Script.exit(Intent.text(result))
  }
}

async function run() {
  const images = await inputImages()
  if (images.length) {
    // 同时传入图片与链接时，图片按屏幕翻译处理；其余输入走原有 App Store 流程。
    await runScreenTranslation(images)
    return
  }

  const url = firstAppStoreURL()
  if (!url) {
    const message = inputImagePaths().length
      ? "未收到可读取的截图，请确认传入的是图片，不是文件链接。"
      : "未收到图片或 App Store 链接。请从照片分享截图，或让快捷指令传入截图。"
    await showScreenText(message)
    Script.exit(Intent.text(message))
    return
  }

  await Navigation.present({ element: <AppStoreView url={url} /> })
  Script.exit()
}

void run().catch(async (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason)
  try {
    await Dialog.alert({ title: Script.name, message })
  } finally {
    Script.exit()
  }
})
