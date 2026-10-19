import { Script } from "scripting"
import { translateLines } from "../core/translate"
import { markGoogleEngineBlocked } from "../core/google_engine"

/**
 * translateLines 并行竞速回归：
 * 1) 谷歌健康：应只走谷歌，不启动原生会话（耗时应与纯谷歌同量级 <2s）；
 * 2) 谷歌冷却（等价限流/断网）：不应再串行叠加，原生一次批量直接出结果；
 * 3) 对齐：输出等长、逐行对应；
 * 4) 缓存：二次调用几乎所有 0ms；
 * 5) 同语言短路。
 */
const LINES = [
  "Photos",
  "Clean up your library with a few taps",
  "Select the pictures you want to keep",
  "Screenshots, receipts and documents",
  "Share albums with your family",
  "Search by people, places and things",
  "Memories are created automatically",
  "Edits sync across all your devices",
  "Storage recommendations save space",
  "Private sharing keeps metadata hidden",
  "Tap to review the new features",
  "Learn more in Settings",
  "Version 3.4 requires iOS 18 or later",
  "Some features may vary by region",
  "Terms and conditions apply",
  "Free for 30 days, then 12.99 per month",
  "Cancel anytime from your account",
  "Restore purchases on a new device",
  "Family sharing supports six people",
  "Contact support if you need help",
]

const failures: string[] = []
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures.push(`${name}${detail ? `：${detail}` : ""}`)
}

async function main() {
  let started = Date.now()
  const fast = await translateLines(LINES, { sourceLanguageCode: "en", targetLanguageCode: "zh-Hans" })
  const fastMs = Date.now() - started
  console.log(`[google healthy] ${fastMs}ms`)
  check("谷歌健康路径行数对齐", fast.length === LINES.length, `${fast.length}`)
  fast.forEach((value, index) => {
    if (!value.trim()) failures.push(`第 ${index + 1} 行为空`)
    else if (value === LINES[index]) failures.push(`第 ${index + 1} 行未翻译：${value}`)
  })
  check("谷歌健康路径不应明显慢于纯网络", fastMs < 3000, `${fastMs}ms`)

  started = Date.now()
  const again = await translateLines(LINES, { sourceLanguageCode: "en", targetLanguageCode: "zh-Hans" })
  const cachedMs = Date.now() - started
  console.log(`[cached] ${cachedMs}ms`)
  check("缓存命中应与首次一致", again.join("\n") === fast.join("\n"))
  check("缓存命中应显著更快", cachedMs < 200, `${cachedMs}ms`)

  // 冷却 + 全新行：只走系统原生，且只跑一轮批量的量级（不是 5s + 原生）
  markGoogleEngineBlocked()
  started = Date.now()
  const native = await translateLines(
    LINES.map((line) => `${line} today`),
    { sourceLanguageCode: "en", targetLanguageCode: "zh-Hans" },
  )
  const nativeMs = Date.now() - started
  console.log(`[google cooldown] ${nativeMs}ms`)
  check("冷却路径行数对齐", native.length === LINES.length, `${native.length}`)
  check("冷却路径应有中文", /[\u3400-\u9fff]/.test(native[0]), native[0])
  check("冷却路径不应再叠加 5s 谷歌等待", nativeMs < 12000, `${nativeMs}ms`)

  const same = await translateLines(["Hello world", ""], { sourceLanguageCode: "en", targetLanguageCode: "en" })
  check("同语言短路", same.length === 2 && same[0] === "Hello world" && same[1] === "", JSON.stringify(same))

  if (failures.length) {
    console.log(`translateLines 并行回归失败 ${failures.length} 项：\n- ${failures.join("\n- ")}`)
    Script.exit("failed")
  }
  console.log("translateLines 并行回归通过")
  Script.exit("passed")
}

void main()
