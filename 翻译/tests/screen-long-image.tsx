import { ImageRenderer, Script, Text, VStack } from "scripting"
import { inlineImageBitmap, recognizeScreenBlocks } from "../core/screen-ocr"

/**
 * 长截图回归：修复前 9.9MP 长图返回 0 块（Vision >5MP 静默放弃），
 * 修复后应按像素预算切片、逐片识别并拼接，且顺序正确。
 */
async function main() {
  const failures: string[] = []
  const rows = 160
  const lines: string[] = []
  for (let i = 0; i < rows; i += 1) {
    lines.push(`Line ${i + 1} 设置 通用 关于本机 Software Update`)
  }

  const full = await ImageRenderer.toUIImage(
    <VStack spacing={2} padding={8} background="#FFFFFF">
      {lines.map((line, index) => <Text key={index} font="caption2">{line}</Text>)}
    </VStack>,
    { scale: 3 },
  )
  const bitmap = inlineImageBitmap(full) ?? full
  const px = bitmap.getPixelData()!
  const mp = (px.width * px.height) / 1e6
  console.log(`长图 ${px.width}x${px.height}px = ${mp.toFixed(1)}MP`)

  const started = Date.now()
  const blocks = await recognizeScreenBlocks(bitmap)
  const elapsed = Date.now() - started
  console.log(`分片 OCR ${elapsed}ms blocks=${blocks.length}`)

  if (blocks.length < rows * 0.7) failures.push(`块数过少：${blocks.length}，预期 ≥ ${Math.round(rows * 0.7)}`)

  // 顺序：每个块的行号应单调递增（分片按 y 从上到下，片内已是阅读顺序）。
  const numbers = blocks
    .map(b => /Line (\d+)/.exec(b.text)?.[1])
    .filter((v): v is string => !!v)
    .map(Number)
  console.log(`识别到编号 ${numbers.length} 个：${numbers.slice(0, 5).join(",")} ... ${numbers.slice(-5).join(",")}`)
  if (numbers.length < rows * 0.6) failures.push(`带行号的块太少：${numbers.length}`)
  let inversions = 0
  for (let i = 1; i < numbers.length; i += 1) if (numbers[i] < numbers[i - 1]) inversions += 1
  console.log(`顺序逆序次数=${inversions}`)
  if (inversions > numbers.length * 0.1) failures.push(`拼接顺序错乱：逆序 ${inversions}/${numbers.length}`)

  // 中文是否保住
  const text = blocks.map(b => b.text).join("\n")
  if (!/设置|关于本机/.test(text)) failures.push("中文内容丢失")

  // 各块 box 应仍在 0..1 之间（分片后需重新归一化，若实现有误会越界）。
  const bad = blocks.filter(b => b.box && (b.box.y < -0.01 || b.box.y > 1.01 || b.box.x < -0.01 || b.box.x > 1.01))
  console.log(`越界框=${bad.length}`)
  if (bad.length) failures.push(`有 ${bad.length} 个框超出归一化范围`)

  if (failures.length) {
    console.log(`长图 OCR 回归失败：\n- ${failures.join("\n- ")}`)
    Script.exit("failed")
  }
  console.log("长图 OCR 回归通过")
  Script.exit("passed")
}

void main()
