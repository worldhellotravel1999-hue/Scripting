import { Intent, Navigation, Script } from "scripting"
import { parseAppStoreURL } from "./core/appstore"
import { inlineImageBitmap } from "./core/screen-ocr"
import { activeScreenTranslation, startScreenTranslation } from "./core/screen-job"
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
  // 拿到图的瞬间就强制解码落地（物化为内存位图）：分享扩展的临时截图
  // 文件可能在 present/OCR 之前被系统回收或受数据保护约束，UIImage 构造
  // 成功但后续解码失效会触发原生 OCR 空指针崩溃（2026-10-11 .ips 实锤）。
  // 文件路径优先（与旧逻辑一致），路径图全部不可用时才退回参数图。
  const fromPaths: UIImage[] = []
  for (const path of inputImagePaths()) {
    try {
      const image = UIImage.fromFile(path)
      if (image) {
        const bitmap = inlineImageBitmap(image)
        if (bitmap) fromPaths.push(bitmap)
      }
    } catch {}
  }
  if (fromPaths.length) return fromPaths

  const decoded = Intent.imagesParameter
  if (!Array.isArray(decoded)) return []
  const fromParams: UIImage[] = []
  for (const candidate of (decoded as UIImage[]).filter(Boolean)) {
    const bitmap = inlineImageBitmap(candidate)
    if (bitmap) fromParams.push(bitmap)
  }
  return fromParams
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

async function showScreenText(text: string) {
  try {
    await QuickLook.previewText(text)
  } catch {
    try { await Dialog.alert({ title: "截图翻译", message: text }) } catch {}
  }
}

// 页面立即呈现（只传原图这个可序列化 prop），OCR/翻译/覆盖渲染由结果页
// 挂载后从 core/screen-job 启动的同一份后台工作完成；页面关闭后 intent
// 取同一 Promise 收尾返回纯文本。旧链路「先跑完整条重管线再 present」
// 在分享扩展宿主里表现为整个扩展无响应（用不了）；App Store 流程
// （present 后在页内异步加载）一直正常，截图流程对齐它的节奏。
async function runScreenTranslation(images: UIImage[]) {
  const image = images[0]
  let presented = false
  try {
    await Navigation.present({ element: <ScreenTranslationResult image={image} /> })
    presented = true
  } catch {}

  // 工作已由结果页启动；若页面被秒关/未挂载，则此处兑底启动。
  const activeJob = activeScreenTranslation()
  const job = presented && activeJob ? activeJob : startScreenTranslation(image)
  try {
    const result = await job
    Script.exit(Intent.text(result.text))
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason)
    Script.exit(Intent.text(`截图翻译失败：${message}`))
  }
}

async function run() {
  const images = await inputImages()
  if (images.length) {
    await runScreenTranslation(images)
    return
  }

  const url = firstAppStoreURL()
  if (!url) {
    const message = inputImagePaths().length
      ? "未收到可读取的截图（文件可能已被系统回收或受数据保护限制），请重新分享一次，并确认传入的是图片而非文件链接。"
      : "未收到图片或 App Store 链接。请从照片分享截图，或让快捷指令传入截图。"
    await showScreenText(message)
    Script.exit(Intent.text(message))
    return
  }

  try {
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
