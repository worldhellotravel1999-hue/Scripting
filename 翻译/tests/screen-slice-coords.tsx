import { ImageRenderer, Script, Text, VStack } from "scripting"
import { inlineImageBitmap, recognizeScreenBlocks } from "../core/screen-ocr"
import { translateScreenOverlay } from "../core/screen-overlay"

/**
 * 分片坐标映射回归：长图切片后，第 N 行的框必须落在整图对应高度。
 * 若忘记把切片内坐标映射回整图，所有片的框都会挤在顶部互相重叠。
 */
async function main() {
  const failures: string[] = []
  const rows = 200
  const lines: string[] = []
  for (let i = 0; i < rows; i += 1) lines.push(`Line ${i + 1} 设置 通用 Software Update`)

  const full = await ImageRenderer.toUIImage(
    <VStack spacing={1} padding={6} background="#FFFFFF">
      {lines.map((line, index) => <Text key={index} font="caption2">{line}</Text>)}
    </VStack>,
    { scale: 3 },
  )
  const bitmap = inlineImageBitmap(full) ?? full
  const px = bitmap.getPixelData()!
  console.log(`图 ${px.width}x${px.height}px = ${((px.width * px.height) / 1e6).toFixed(1)}MP`)

  const blocks = await recognizeScreenBlocks(bitmap)
  const withNumber = blocks
    .map(b => ({ line: Number(/Line (\d+)/.exec(b.text)?.[1] ?? NaN), top: b.box ? 1 - b.box.y - b.box.height : NaN }))
    .filter(b => Number.isFinite(b.line) && Number.isFinite(b.top))
  console.log(`带行号块 ${withNumber.length}`)

  const sorted = [...withNumber].sort((a, b) => a.line - b.line)
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  console.log(`第 ${first.line} 行 top=${first.top.toFixed(3)}；第 ${last.line} 行 top=${last.top.toFixed(3)}`)
  if (first.top > 0.15) failures.push(`首行位置偏高：top=${first.top.toFixed(3)}，预期 <0.15`)
  if (last.top < 0.75) failures.push(`末行位置偏低：top=${last.top.toFixed(3)}，预期 >0.75`)

  let inversions = 0
  for (let i = 1; i < sorted.length; i += 1) if (sorted[i].top < sorted[i - 1].top - 0.02) inversions += 1
  console.log(`纵向逆序=${inversions}/${sorted.length}`)
  if (inversions > sorted.length * 0.1) failures.push(`纵向顺序错乱：${inversions}/${sorted.length}`)

  const tops = sorted.map(b => b.top)
  const spread = Math.max(...tops) - Math.min(...tops)
  console.log(`纵向跨度=${spread.toFixed(3)}`)
  if (spread < 0.8) failures.push(`框只覆盖了 ${(spread * 100).toFixed(0)}% 的高度，疑似坐标未映射`)

  const started = Date.now()
  const overlay = await translateScreenOverlay(bitmap, {
    sourceLanguageCode: "zh-Hans",
    targetLanguageCode: "zh-Hans",
  })
  console.log(`覆盖渲染 ${Date.now() - started}ms lines=${overlay.lines.length}`)

  if (failures.length) {
    console.log(`坐标映射回归失败：\n- ${failures.join("\n- ")}`)
    Script.exit("failed")
  }
  console.log("坐标映射回归通过")
  Script.exit("passed")
}

void main()
