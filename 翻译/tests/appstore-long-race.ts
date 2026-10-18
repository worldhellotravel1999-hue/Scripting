// 长 App Store 文本（≈7000 字符发布说明）的真实链路诊断：
// 验证谷歌快路径的多轮并发分片不会在健康网络下被整体 5 秒上限误杀；
// 若谷歌不可用，则必须落到系统分片路径并给出进度，不允许一直空等。
import { Script } from "scripting"
import { translateText } from "../core/translate"

const sentence = "This update improves stability, fixes several crashes, and makes long release notes scroll smoothly on older devices. "
const long = Array.from({ length: 50 }, () => sentence.trim()).join("\n\n")

function guard<T>(task: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`guard timeout ${ms}ms`)), ms)
    task.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

async function run() {
  let engine = "?"
  let firstProgressAt = 0
  const progressLengths: number[] = []
  const started = Date.now()
  const value = await guard(translateText(long, {
    sourceLanguageCode: "en",
    targetLanguageCode: "zh-Hans",
    onProgress: (partial) => {
      if (!firstProgressAt) firstProgressAt = Date.now() - started
      progressLengths.push(partial.length)
    },
    onEngineResolved: (info) => { engine = info.engine },
  }), 20_000)
  const wall = Date.now() - started
  console.log(JSON.stringify({
    chars: long.length,
    engine,
    wall,
    firstProgressAt,
    progressReports: progressLengths.length,
    translatedLength: value.length,
  }))
  if (!value.trim()) throw new Error("empty long translation")
  if (progressLengths.length < 2) throw new Error("long translation reported no progressive output")
  Script.exit("PASS")
}

run().catch((error) => { console.error(String(error)); Script.exit("FAIL") })
