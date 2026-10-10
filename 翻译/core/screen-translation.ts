import { recognizeScreenText } from "./screen-ocr"
import { translateText, type TranslateTextOptions } from "./translate"

/** 仅输出整页纯文本；无图像覆盖，也不带屏幕翻译脚本的设置或引擎。 */
export async function translateScreenImages(images: UIImage[], options: TranslateTextOptions = {}): Promise<string> {
  let sourceText = ""
  for (const image of images) {
    sourceText = await recognizeScreenText(image)
    if (sourceText) break
  }
  if (!sourceText) throw new Error("未识别到文字，请确认截图清晰且包含可识别文本。")
  const translated = (await translateText(sourceText, options)).trim()
  return translated || sourceText
}
