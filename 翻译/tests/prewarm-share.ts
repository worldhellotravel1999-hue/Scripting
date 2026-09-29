// 验证：预热（prewarm）与卡片式调用（可取消）共享在途任务/缓存的效果。
import { Script } from "scripting"
import { prewarmGoogleTranslation, translateText } from "../core/translate"

const TEXT_A = "Things is a delightful and award-winning task manager. It keeps things simple while offering powerful features to help you organize your day, plan your week, and achieve your goals."
const TEXT_B = "This update includes stability improvements and performance optimizations. We fixed several crashes reported by users and improved the overall reliability of the app."
const TEXT_C = "Bear is a beautiful, flexible writing app for crafting notes, prose, and code. Start writing on your iPhone and keep your notes in sync across all your devices."

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function guarded<T>(name: string, task: Promise<T>, fallback: T): Promise<T> {
  const timeout = new Promise<T>((resolve) => setTimeout(() => {
    console.log(`[${name}] TIMEOUT(25s)`)
    resolve(fallback)
  }, 25000))
  return await Promise.race([task, timeout])
}

async function caseA() {
  // 预热 → 400ms 后（模拟界面挂载）以卡片方式调用：应复用共享请求，省去前 400ms。
  prewarmGoogleTranslation(TEXT_A, { sourceLanguageCode: "en", targetLanguageCode: "zh-Hans" })
  await sleep(400)
  const started = Date.now()
  let engine = "?"
  let duration = -1
  const value = await guarded("A", translateText(TEXT_A, {
    sourceLanguageCode: "en",
    targetLanguageCode: "zh-Hans",
    isCancelled: () => false,
    onEngineResolved: (info) => { engine = info.engine; duration = info.durationMs },
  }), "")
  console.log(`[A] engine=${engine} reported=${duration}ms wallFromCall=${Date.now() - started}ms len=${value.length}`)
}

async function caseB() {
  // 预热 → 等它完成 → 调用：应命中缓存，几乎 0ms。
  prewarmGoogleTranslation(TEXT_B, { sourceLanguageCode: "en", targetLanguageCode: "zh-Hans" })
  await sleep(2500)
  const started = Date.now()
  let engine = "?"
  let duration = -1
  const value = await guarded("B", translateText(TEXT_B, {
    sourceLanguageCode: "en",
    targetLanguageCode: "zh-Hans",
    isCancelled: () => false,
    onEngineResolved: (info) => { engine = info.engine; duration = info.durationMs },
  }), "")
  console.log(`[B] engine=${engine} reported=${duration}ms wallFromCall=${Date.now() - started}ms len=${value.length}`)
}

async function caseC() {
  // 对照：无预热直接调用（旧面板首次翻译的等价情况）。
  const started = Date.now()
  let engine = "?"
  let duration = -1
  const value = await guarded("C", translateText(TEXT_C, {
    sourceLanguageCode: "en",
    targetLanguageCode: "zh-Hans",
    isCancelled: () => false,
    onEngineResolved: (info) => { engine = info.engine; duration = info.durationMs },
  }), "")
  console.log(`[C] engine=${engine} reported=${duration}ms wallFromCall=${Date.now() - started}ms len=${value.length}`)
}

async function main() {
  await caseA()
  await caseB()
  await caseC()
  Script.exit("prewarm-probe done")
}

void main()
