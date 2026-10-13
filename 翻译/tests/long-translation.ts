import { Script } from "scripting"
import { translateText } from "../core/translate"
import { markGoogleEngineBlocked } from "../core/google_engine"

;(globalThis as any).Storage = { get: () => null, set: () => {}, remove: () => {} }
const passed: string[] = []
const long = Array.from({ length: 8 }, (_, index) => `Chunk ${index + 1}. ` + "x".repeat(850)).join("\n")

async function run() {
  const batchCalls: string[][] = []
  const host = {
    translateBatch: async (value: any) => {
      batchCalls.push(value.texts)
      return value.texts.map((text: string) => `[${text.slice(0, 8)}]`)
    },
    translate: async (value: any) => `single:${value.text}`,
    translateInstalled: async (value: any) => `single:${value.text}`,
    translateInstalledBatch: async (value: any) => value.texts.map((text: string) => `[${text.slice(0, 8)}]`),
  } as Translation
  // 该测试验证系统批量 host；避免 Google 竞速路径绕过测试替身。
  markGoogleEngineBlocked()
  const progress: string[] = []
  const result = await translateText(long, {
    sourceLanguageCode: "en",
    targetLanguageCode: "zh-Hans",
    translationHost: host,
    preferSequential: true,
    onProgress: (value) => progress.push(value),
  })
  if (!result || progress.length < 2) throw new Error("long text did not report progressive output")
  if (!batchCalls.length || batchCalls.some((texts) => texts.length < 1 || texts.length > 4)) {
    throw new Error("long text submitted an invalid batch size")
  }
  if (result.includes("single:")) throw new Error("batch path unexpectedly fell back")
  const intermediateProgress = progress.slice(0, -1)
  if (new Set(intermediateProgress).size !== intermediateProgress.length) {
    throw new Error("intermediate progress output repeated")
  }
  passed.push("长文本逐段批量翻译与进度")

  const fallbackHost = {
    translateBatch: async () => { throw new Error("batch unsupported") },
    translate: async (value: any) => `single:${value.text}`,
    translateInstalled: async (value: any) => `single:${value.text}`,
    translateInstalledBatch: async (value: any) => value.texts.map((text: string) => `single:${text}`),
  } as Translation
  const fallback = await translateText("Fallback sentence.", {
    sourceLanguageCode: "en",
    targetLanguageCode: "zh-Hans",
    translationHost: fallbackHost,
  })
  if (fallback !== "single:Fallback sentence.") throw new Error("single fallback")
  passed.push("批量失败回退单句")
  console.log(JSON.stringify({ passed }))
  Script.exit("PASS")
}
run().catch((error) => { console.error(error); Script.exit("failed") })
