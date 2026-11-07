import { Script, ImageRenderer, Text, VStack } from "scripting"
import { buildOCRBlocks, buildSourceText, inlineImageBitmap, recognizeScreenText, type OCRCandidate } from "../core/screen-ocr"
import { translateScreenImages } from "../core/screen-translation"

const failures: string[] = []
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures.push(`${name}${detail ? `：${detail}` : ""}`)
}

// —— 阅读顺序与过滤（模拟候选） ——
const box = (x: number, y: number, w: number, h: number) => ({ x, y, width: w, height: h })
const cand = (content: string, b: { x: number; y: number; width: number; height: number }): OCRCandidate =>
  ({ content, confidence: 0.9, boundingBox: b })

// 单列：Vision 坐标系原点在左下角，top = 1 - y - height。
const single = buildOCRBlocks([
  cand("Bottom line", box(0.1, 0.1, 0.4, 0.05)),   // top 0.85
  cand("Top line", box(0.1, 0.8, 0.4, 0.05)),      // top 0.15
  cand("Middle line", box(0.1, 0.45, 0.4, 0.05)),  // top 0.5
])
check("单列按从上到下排序", buildSourceText(single) === "Top line\nMiddle line\nBottom line", buildSourceText(single))

// 双列：左右各 3 块且纵向重叠 → 先左列后右列（标签需含 2+ 字母词，否则会被噪声过滤）。
const twoCol = buildOCRBlocks([
  cand("Beta one", box(0.6, 0.7, 0.3, 0.05)),
  cand("Beta two", box(0.6, 0.45, 0.3, 0.05)),
  cand("Beta three", box(0.6, 0.2, 0.3, 0.05)),
  cand("Alpha one", box(0.1, 0.7, 0.3, 0.05)),
  cand("Alpha two", box(0.1, 0.45, 0.3, 0.05)),
  cand("Alpha three", box(0.1, 0.2, 0.3, 0.05)),
])
check("双列先左后右", buildSourceText(twoCol) === "Alpha one\nAlpha two\nAlpha three\nBeta one\nBeta two\nBeta three", buildSourceText(twoCol))

// 过滤：URL、星号乱码、纯符号、单词噪声丢弃；中文与中英混排保留。
const filtered = buildOCRBlocks([
  cand("Visit https://example.com/x now", box(0.1, 0.8, 0.5, 0.05)),
  cand("a*b", box(0.1, 0.7, 0.2, 0.05)),
  cand("12345 ***", box(0.1, 0.6, 0.2, 0.05)),
  cand("SomeVar2", box(0.1, 0.5, 0.2, 0.05)),
  cand("微信", box(0.1, 0.4, 0.2, 0.05)),
  cand("打开 Settings 界面", box(0.1, 0.3, 0.3, 0.05)),
  cand("Hello world", box(0.1, 0.2, 0.3, 0.05)),
])
const kept = filtered.map(block => block.text)
check("URL 被剔除", !kept.some(text => text.includes("example.com")), JSON.stringify(kept))
check("星号乱码被剔除", !kept.some(text => text === "a*b"), JSON.stringify(kept))
check("纯符号被剔除", !kept.some(text => text.includes("12345")), JSON.stringify(kept))
check("噪声单词被剔除", !kept.some(text => text === "SomeVar2"), JSON.stringify(kept))
check("中文块保留（本脚本差异点）", kept.includes("微信"), JSON.stringify(kept))
check("中英混排保留", kept.some(text => text.includes("打开")), JSON.stringify(kept))
check("正常英文保留", kept.includes("Hello world"), JSON.stringify(kept))

// —— 真实 Vision 准确识别：离屏渲染一段文字成图再识别 ——
async function main() {
  try {
    // 白底渲染，中英双行——同时验证识别与语言列表顺序（勿改回 en 优先，
    // 那会整块漏识中文，见 core/screen-ocr.ts 注释）。
    const image = await ImageRenderer.toUIImage(
      <VStack spacing={10} padding={30} background={{ light: "#FFFFFF", dark: "#FFFFFF" }}>
        <Text font="largeTitle" fontWeight="bold">{"Hello Screen Translation"}</Text>
        <Text font="title">{"打开设置界面查看帮助文档"}</Text>
      </VStack>,
      { scale: 2 },
    )
    const inlineImage = inlineImageBitmap(image)
    check("图片物化成功", inlineImage !== null)
    if (inlineImage) check("重复图片物化复用位图", inlineImageBitmap(inlineImage) === inlineImage)
    const text = await recognizeScreenText(inlineImage ?? image)
    check("真实 Vision 识别出英文", /hello\s+screen\s+translation/i.test(text), JSON.stringify(text))
    check("真实 Vision 识别出中文（语言顺序回归）", text.includes("打开设置界面"), JSON.stringify(text))
    // 同源/目标语言可直接返回 OCR 文本，无需网络或系统翻译；覆盖
    // “图片 → OCR → 本脚本 translateText”接线，而不假装测到了真机翻译宿主。
    const passthrough = await translateScreenImages([image], {
      sourceLanguageCode: "en",
      targetLanguageCode: "en",
    })
    check("图片共享入口已接通当前翻译引擎", passthrough === text, JSON.stringify(passthrough))
  } catch (reason) {
    check("真实 Vision 准确识别不抛错", false, reason instanceof Error ? reason.message : String(reason))
  }

  if (failures.length) {
    console.log(`screen-ocr 失败 ${failures.length} 项：\n- ${failures.join("\n- ")}`)
    Script.exit("failed")
  }
  console.log("screen-ocr 全部通过")
  Script.exit("passed")
}

void main()
