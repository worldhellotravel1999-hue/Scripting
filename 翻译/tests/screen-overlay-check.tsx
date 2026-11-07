import { ImageRenderer, Script, Text, VStack } from "scripting"
import { recognizeScreenBlocks } from "../core/screen-ocr"
import { translateScreenOverlay } from "../core/screen-overlay"

async function main() {
  const failures: string[] = []
  // 离屏渲染一张英文测试图：验证 OCR 块 + 覆盖管线能跑通，不依赖外部截图。
  const image = await ImageRenderer.toUIImage(
    <VStack spacing={10} padding={30} background={{ light: "#FFFFFF", dark: "#FFFFFF" }}>
      <Text font="largeTitle" fontWeight="bold">{"Hello Screen Overlay"}</Text>
      <Text font="title">{"Open Settings Page"}</Text>
    </VStack>,
    { scale: 2 },
  )
  console.log(`test image ${Math.round(image.width)}x${Math.round(image.height)}`)
  const blocks = await recognizeScreenBlocks(image)
  console.log(`blocks ${blocks.length}: ${JSON.stringify(blocks.map((b) => b.text))}`)
  if (!blocks.length) failures.push("测试图未识别到文本块")
  if (!blocks.every((b) => b.box && b.box.width > 0 && b.box.height > 0)) {
    failures.push("存在无框文本块，覆盖位置不可用")
  }
  // 同源目标语言：translateText 直接返回 OCR 文本，可离线验证整条覆盖管线（含出图）。
  const overlay = await translateScreenOverlay(image, {
    sourceLanguageCode: "en",
    targetLanguageCode: "en",
  })
  console.log(`overlay ${Math.round(overlay.image.width)}x${Math.round(overlay.image.height)} lines=${overlay.lines.length}`)
  if (overlay.lines.length !== blocks.length) failures.push("覆盖行数与 OCR 块数不一致")
  if (Math.round(overlay.image.width) !== Math.round(image.width)) failures.push("覆盖图宽度与原图不一致")
  if (failures.length) {
    console.log(`screen-overlay-check 失败 ${failures.length} 项：\n- ${failures.join("\n- ")}`)
    Script.exit("failed")
  }
  console.log("screen-overlay-check 通过")
  Script.exit("passed")
}

void main()
