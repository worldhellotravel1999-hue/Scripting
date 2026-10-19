import { Script } from "scripting"
import { buildOCRBlocks, type OCRCandidate } from "../core/screen-ocr"
import { translateLines } from "../core/translate"
import { markGoogleEngineBlocked } from "../core/google_engine"

/**
 * 用户实例回归：应用更新日志（英文 + 中文说明混排，条目以「·」开头）。
 * 症状：截图翻译只翻前半页，后半页保持原文 / 整段不见。
 *
 * 这个脚本不依赖真实截图与网络状态：
 * 1) 用 OCR 候选块模拟整页识别结果，检查「· 条目」是否被噪声过滤误删；
 * 2) 用真实 translateLines 翻译同一批行，检查是否逐行都拿到译文；
 * 3) 谷歌冷却路径（等价限流/断网）必须仍然逐行有译文。
 *
 * 2026-10-19 根因：`buildOCRBlocks` 的旧规则会丢掉“行首带 · 且英文单词
 * 少于 8 个”的行——更新日志最后一条 `· Fixed inaccurate protocol, policy,
 * and failed` 就是这样整行消失的。
 */

const RELEASE_LINES = [
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

/** 每行一个候选块，从上到下排布（Vision 原点左下）。 */
function pageCandidates(lines: string[]): OCRCandidate[] {
  const height = 0.9 / Math.max(1, lines.length)
  return lines.map((content, index) => ({
    content,
    confidence: 0.95,
    boundingBox: {
      x: 0.04,
      y: 0.96 - (index + 1) * height,
      width: 0.92,
      height: height * 0.8,
    },
  }))
}

async function main() {
  const blocks = buildOCRBlocks(pageCandidates(RELEASE_LINES))
  console.log(`OCR 块 ${blocks.length}/${RELEASE_LINES.length}`)
  check(
    "OCR 不应丢掉更新日志的任何一行",
    blocks.length === RELEASE_LINES.length,
    blocks.map((block) => block.text.slice(0, 24)).join(" | "),
  )
  for (const line of RELEASE_LINES) {
    check(
      `OCR 保留：${line.slice(0, 28)}`,
      blocks.some((block) => block.text === line),
    )
  }
  // 真实 Vision 会把行首的「·」读成「•」，两者都必须被保留。
  const bulleted = buildOCRBlocks(pageCandidates(RELEASE_LINES.map((line) => `• ${line}`)))
  check("行首项目符号不导致整行丢失", bulleted.length === RELEASE_LINES.length, `${bulleted.length}`)
  check(
    "行首项目符号行仍保留正文",
    bulleted.some((block) => block.text.includes("inaccurate protocol, policy, and failed")),
  )

  const texts = blocks.length ? blocks.map((block) => block.text) : RELEASE_LINES
  const options = { sourceLanguageCode: "en", targetLanguageCode: "zh-Hans" }

  // 谷歌可用路径：后半页（含中文参考行）也必须有译文，不能被当成「已是目标语言」跳过。
  const online = await translateLines(texts, options)
  console.log(`在线路径 ${online.length} 行`)
  check("在线路径行数对齐", online.length === texts.length, `${online.length}`)
  online.forEach((value, index) => {
    check(`在线路径第 ${index + 1} 行非空`, !!value.trim(), value)
    const source = texts[index]
    if (index < RELEASE_LINES.length - 1) {
      check(
        `在线路径第 ${index + 1} 行确实翻译`,
        value !== source && /[\u3400-\u9fff]/.test(value),
        value.slice(0, 60),
      )
    }
  })

  // 谷歌冷却（限流/断网）：系统原生批量必须回填每一行，不能只填前半页。
  markGoogleEngineBlocked()
  const offlineTexts = texts.map((line, index) => (index === texts.length - 1 ? `${line} offline` : line))
  const offline = await translateLines(offlineTexts, options)
  console.log(`冷却路径 ${offline.length} 行`)
  check("冷却路径行数对齐", offline.length === offlineTexts.length, `${offline.length}`)
  offline.forEach((value, index) => {
    check(`冷却路径第 ${index + 1} 行非空`, !!value.trim(), value)
    if (index < RELEASE_LINES.length - 1) {
      check(
        `冷却路径第 ${index + 1} 行有中文`,
        /[\u3400-\u9fff]/.test(value),
        value.slice(0, 60),
      )
    }
  })

  if (failures.length) {
    console.log(`更新日志截图回归失败 ${failures.length} 项：\n- ${failures.join("\n- ")}`)
    Script.exit("failed")
  }
  console.log("更新日志截图回归通过")
  Script.exit("passed")
}

void main()
