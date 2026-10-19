import { ImageRenderer, Script, Text, VStack } from "scripting"
import { inlineImageBitmap, recognizeScreenBlocks } from "../core/screen-ocr"
import { translateScreenOverlay } from "../core/screen-overlay"

/**
 * 复现用户场景：把更新日志渲染成一张手机比例的长截图（贴吧/微博式分享图），
 * 走真实 OCR → 翻译 → 覆盖，检查：
 * 1) OCR 是否把下面一半丢掉（块数与纵向跨度）；
 * 2) 覆盖结果 lines 是否等量、每行是否都有中文；
 * 3) 覆盖图再次识别的行数是否与原图接近（有没有整段被涂掉/没画出来）。
 */
const LINES = [
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

async function main() {
  const failures: string[] = []
  const image = await ImageRenderer.toUIImage(
    <VStack spacing={18} padding={24} background="#FFFFFF" alignment="leading">
      {LINES.map((line, index) => (
        <Text key={index} font="body">
          {index < LINES.length - 1 ? `· ${line}` : line}
        </Text>
      ))}
    </VStack>,
    { scale: 3 },
  )
  const bitmap = inlineImageBitmap(image) ?? image
  const px = bitmap.getPixelData()!
  console.log(`图 ${px.width}x${px.height}px = ${((px.width * px.height) / 1e6).toFixed(1)}MP`)

  const blocks = await recognizeScreenBlocks(bitmap)
  console.log(`OCR 块 ${blocks.length}`)
  blocks.forEach((block, index) => {
    const top = block.box ? 1 - block.box.y - block.box.height : -1
    console.log(`${index + 1}. top=${top.toFixed(3)} ${block.text.slice(0, 70)}`)
  })
  if (blocks.length < LINES.length) failures.push(`OCR 只识别出 ${blocks.length}/${LINES.length} 行`)

  const started = Date.now()
  const overlay = await translateScreenOverlay(bitmap, {
    sourceLanguageCode: "en",
    targetLanguageCode: "zh-Hans",
  })
  console.log(`覆盖完成 ${Date.now() - started}ms lines=${overlay.lines.length}`)
  overlay.lines.forEach((line, index) => {
    console.log(`${index + 1}. [${line.translated.slice(0, 50)}]`)
  })
  if (overlay.lines.length !== blocks.length) failures.push("覆盖行数与 OCR 块数不一致")
  overlay.lines.forEach((line, index) => {
    if (!line.translated.trim()) failures.push(`第 ${index + 1} 行译文为空`)
    if (line.translated === line.source && index < LINES.length - 1) {
      failures.push(`第 ${index + 1} 行仍是原文`)
    }
  })

  const reread = await recognizeScreenBlocks(overlay.image)
  console.log(`覆盖图再识别 ${reread.length} 块`)
  reread.forEach((block) => console.log(`  ${block.text.slice(0, 70)}`))

  if (failures.length) {
    console.log(`更新日志截图复现失败 ${failures.length} 项：\n- ${failures.join("\n- ")}`)
    Script.exit("failed")
  }
  console.log("更新日志截图复现通过")
  Script.exit("passed")
}

void main()
