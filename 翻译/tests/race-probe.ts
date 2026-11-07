// 双引擎并行竞速探针（2026-10-01）：
// [race-1] 谷歌可用 → 应由谷歌胜出，onProgress 有前缀进度；
// [race-2] 谷歌强制冷却 → 纯系统路径。scripting-ts 宿主没有系统翻译 UI，
//           原生 Translation 不会结算，预期 15s 守卫超时（只为验证不崩溃、
//           无未处理拒绝、错误路径可控），不代表真机系统引擎性能。
import { Script } from "scripting"
import { translateText } from "../core/translate"
import { markGoogleEngineBlocked } from "../core/google_engine"

function guard<T>(task: Promise<T>, fallback: T, ms = 15000, tag = ""): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      console.log(`[guard] TIMEOUT(${ms}ms) ${tag}`)
      reject(new Error("guard timeout " + tag))
    }, ms)
    task.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

async function main() {
  // 案例 1：谷歌可用
  try {
    const progress: string[] = []
    let engine = "?"
    const started = Date.now()
    const value = await guard(translateText(
      "Hello world. This is a quick probe for the parallel translation race between Google and the system engine.",
      {
        sourceLanguageCode: "en",
        targetLanguageCode: "zh-Hans",
        onProgress: (partial) => progress.push(String(partial.length)),
        onEngineResolved: (info) => { engine = info.engine },
      },
    ), "", 15000, "race-1")
    console.log(`[race-1] engine=${engine} wall=${Date.now() - started}ms len=${value.length} progressReports=${progress.length}`)
  } catch (error) {
    console.log(`[race-1] FAILED ${error instanceof Error ? error.message : String(error)}`)
  }

  // 案例 2：谷歌冷却 → 纯系统（测试宿主预期超时，见文件头注释）
  markGoogleEngineBlocked()
  try {
    let engine = "?"
    const started = Date.now()
    const value = await guard(translateText(
      "Another sentence used to probe the system-only path after the Google cooldown is engaged.",
      {
        sourceLanguageCode: "en",
        targetLanguageCode: "zh-Hans",
        onEngineResolved: (info) => { engine = info.engine },
      },
    ), "", 15000, "race-2")
    console.log(`[race-2] engine=${engine} wall=${Date.now() - started}ms len=${value.length}`)
  } catch (error) {
    console.log(`[race-2] expected-in-test-host ${error instanceof Error ? error.message : String(error)}`)
  }

  Script.exit("race-probe done")
}

void main()
