import { Script } from "scripting"
import { translateLines } from "../core/translate"
import { createSystemTranslationEngine } from "../core/system_engine"

/**
 * translateLines（截图多行批量）回归：
 * - 对齐输出（等长、每行有译文、与原文不同）
 * - 打包分组的换行拆回不串行
 * - 缓存二次调用命中
 * - 同语言短路 / 空行处理
 */
async function main() {
  const failures: string[] = []
  const options = { sourceLanguageCode: "en", targetLanguageCode: "zh-Hans" }
  const lines = [
    "Open Settings to change the language",
    "Tap the blue button to continue",
    "Your changes will be saved automatically",
    "Sign in with your account",
    "Search for podcasts and stations",
    "Download the latest update",
    "Privacy policy and terms of service",
    "Copy text to the clipboard",
    "Retry the failed download",
    "Loading more results",
    "Delete this item permanently",
    "Share with your friends",
    "The quick brown fox jumps over the lazy dog again",
    "Notifications can be turned off in the system preferences panel",
    "Connect to a wireless network before starting the download",
    "Your subscription will renew at the end of the current period",
    "Rate this application if you enjoy using it every day",
    "Import contacts from your previous device with one tap",
    "Background downloads continue when the screen is locked",
    "Adjust text size and display brightness from the accessibility settings",
    "Two-factor authentication adds an extra layer of security to your account",
    "Clear the cache periodically to free up storage space on this device",
    "Sync your bookmarks across all of your signed-in devices automatically",
    "Contact support if the problem keeps happening after you restart the app",
  ]
  const totalLength = lines.reduce((sum, line) => sum + line.length + 1, 0)
  console.log(`语料总长 ${totalLength} 字符（>1000 会拆多组并发）`)

  const started = Date.now()
  const translated = await translateLines(lines, options)
  const firstMs = Date.now() - started
  console.log(`translateLines ${lines.length} 行耗时 ${firstMs}ms`)

  if (translated.length !== lines.length) failures.push(`返回 ${translated.length} 行，期望 ${lines.length}`)
  translated.forEach((value, index) => {
    if (!value.trim()) failures.push(`第 ${index + 1} 行为空`)
    else if (!/[\u3400-\u9fff]/.test(value)) failures.push(`第 ${index + 1} 行没有中文：${value}`)
    else if (value === lines[index]) failures.push(`第 ${index + 1} 行未翻译：${value}`)
  })

  // 缓存：二次调用应立即返回同样结果。
  const cachedStart = Date.now()
  const again = await translateLines(lines, options)
  const cachedMs = Date.now() - cachedStart
  console.log(`二次调用 ${cachedMs}ms`)
  if (again.join("\n") !== translated.join("\n")) failures.push("二次调用结果与首次不一致（缓存未命中或拆行错位）")
  if (cachedMs >= firstMs) failures.push(`二次调用未走缓存（${cachedMs}ms >= ${firstMs}ms）`)

  // 同语言短路：原文原样返回。
  const same = await translateLines(["Hello world", ""], {
    sourceLanguageCode: "en",
    targetLanguageCode: "en",
  })
  if (same.length !== 2 || same[0] !== "Hello world" || same[1] !== "") {
    failures.push(`同语言短路异常：${JSON.stringify(same)}`)
  }

  // translateEach 对齐/空行（同语言短路不进原生，可在脚本宿主验证）。
  const each = await createSystemTranslationEngine().translateEach(
    { sourceText: "", sourceLanguageCode: "en", targetLanguageCode: "en" },
    ["Hello", "", "World"],
  )
  if (each.join("|") !== "Hello||World") {
    failures.push(`translateEach 对齐异常：${JSON.stringify(each)}`)
  }

  if (failures.length) {
    console.log(`screen-lines-speed 失败 ${failures.length} 项：\n- ${failures.join("\n- ")}`)
    Script.exit("failed")
  }
  console.log("screen-lines-speed 通过")
  Script.exit("passed")
}

void main()
