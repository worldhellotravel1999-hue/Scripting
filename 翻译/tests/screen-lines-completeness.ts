import { Script } from "scripting"
import { translateLines } from "../core/translate"
import { markGoogleEngineBlocked } from "../core/google_engine"

/**
 * 翻译完整性回归（2026-10-19 截图只翻一半）：
 * 1) 自动识别模式下，中英混排页面必须逐行都有译文，不能因为某行被识别成
 *    目标语言而跳翻；
 * 2) 谷歌冷却（限流/断网）路径必须照样整页完成；
 * 3) 「译文 === 原文」不得被写进缓存，否则一次失败会永久生效。
 */
const MIXED = [
  "Fixed large uploads stalling on some proxy protocols, and connections not falling back to a working IP when a domain resolves to multiple IPs",
  "Fixed profile changes and manually updated resources not taking effect immediately",
  "Fixed DNS hijacking mistakenly capturing non-DNS UDP traffic (e.g. SNTP)",
  "Fixed logical rules (AND/OR/NOT) with unsupported sub-rules matching all traffic; they are now ignored entirely",
  "Fixed Hysteria2 skip-cert-verify not applying, occasional false failures in Hysteria2 / TUIC latency tests, and inflated HTTP proxy latency results",
  "Fixed VLESS `encryption: none` being dropped from Clash subscriptions, and VLESS / VMess links being misidentified",
  "Fixed bare keys dropped from INI `#!arguments`, and YAML module argument placeholders in numeric fields",
  "Fixed IPv6 availability not updating after switching networks",
  "Fixed inaccurate protocol, policy, and failed",
  "这是一段参考文字，我用这个脚本的截图翻译，它只能翻译一半，剩下的一半他直接不翻译偷懒，而且翻译不完全给我诊断修复",
]

const failures: string[] = []
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures.push(`${name}${detail ? `：${detail}` : ""}`)
}

async function main() {
  const options = { sourceLanguageCode: "auto", targetLanguageCode: "zh-Hans" }
  const first = await translateLines(MIXED, options)
  first.forEach((value, index) => {
    check(`自动识别第 ${index + 1} 行非空`, !!value.trim(), value)
    if (index < MIXED.length - 1) {
      check(`自动识别第 ${index + 1} 行已翻译`, value !== MIXED[index], value.slice(0, 60))
    }
  })

  // 二次调用必须命中缓存且与首次一致（确保没有把原文写进缓存）。
  const second = await translateLines(MIXED, options)
  check("缓存结果与首次一致", second.join("\n") === first.join("\n"))

  markGoogleEngineBlocked()
  const offline = await translateLines(
    MIXED.map((line, index) => (index === MIXED.length - 1 ? line : `${line} today`)),
    options,
  )
  offline.forEach((value, index) => {
    check(`冷却路径第 ${index + 1} 行非空`, !!value.trim(), value)
    check(`冷却路径第 ${index + 1} 行有中文`, /[\u3400-\u9fff]/.test(value), value.slice(0, 60))
  })

  if (failures.length) {
    console.log(`翻译完整性回归失败 ${failures.length} 项：\n- ${failures.join("\n- ")}`)
    Script.exit("failed")
  }
  console.log("翻译完整性回归通过")
  Script.exit("passed")
}

void main()
