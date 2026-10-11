import { recognizeScreenText } from "./screen-ocr"
import { translateText, type TranslateTextOptions } from "./translate"

/** 仅输出整页纯文本；无图像覆盖，也不带屏幕翻译脚本的设置或引擎。 */
export async function translateScreenImages(images: UIImage[], options: TranslateTextOptions = {}): Promise<string> {
  let sourceText = ""
  let lastReason = ""
  for (const image of images) {
    try {
      sourceText = await recognizeScreenText(image)
      if (sourceText) break
    } catch (reason) {
      // 单张图无效/解码失败不致命，继续试下一张。
      lastReason = reason instanceof Error ? reason.message : String(reason)
    }
  }
  if (!sourceText) throw new Error(lastReason || "未识别到文字，请确认截图清晰且包含可识别文本。")
  const translated = (await translateText(sourceText, options)).trim()
  return translated || sourceText
}
