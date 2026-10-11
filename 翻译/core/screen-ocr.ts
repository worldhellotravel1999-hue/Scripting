/**
 * 屏幕截图文字识别（移植自「屏幕翻译」脚本的 ocr.ts，按本脚本用途裁剪）：
 * - 只保留「准确识别」（accurate），无识别模式设置；
 * - 输出阅读顺序的原文文本 + 归一化文本框，供 translateText 翻译与
 *   screen-overlay.tsx 原位覆盖渲染使用。
 */
export type OCRBox = { x: number; y: number; width: number; height: number }
export type OCRCandidate = { content: string; confidence: number; boundingBox?: OCRBox }
export type OCRBlock = { text: string; box?: OCRBox }
type Block = { text: string; box?: OCRBox; top: number; bottom: number; left: number; order: number }

function validBox(box?: OCRBox): box is OCRBox {
  return !!box && [box.x, box.y, box.width, box.height].every(Number.isFinite)
    && box.width > 0 && box.height > 0 && box.x >= 0 && box.y >= 0
    && box.x + box.width <= 1.01 && box.y + box.height <= 1.01
}
function makeBlock(candidate: OCRCandidate, order: number): Block {
  const box = validBox(candidate.boundingBox) ? candidate.boundingBox : undefined
  // Vision 的归一化坐标从左下角开始，阅读顺序改用距顶部的位置。
  const top = box ? 1 - box.y - box.height : order
  return { text: candidate.content.trim(), box, top, bottom: box ? top + box.height : order, left: box?.x ?? 0, order }
}
function topFirst(a: Block, b: Block): number { return a.top - b.top || a.left - b.left || a.order - b.order }

function inReadingOrder(blocks: Block[]): Block[] {
  if (blocks.some(block => !block.box)) return blocks
  if (blocks.length < 6) return [...blocks].sort(topFirst)
  const left = blocks.filter(block => block.box!.x + block.box!.width <= 0.49)
  const right = blocks.filter(block => block.box!.x >= 0.51)
  if (left.length < 3 || right.length < 3 || (left.length + right.length) / blocks.length < 0.8) return [...blocks].sort(topFirst)
  const leftTop = Math.min(...left.map(block => block.top))
  const rightTop = Math.min(...right.map(block => block.top))
  const leftBottom = Math.max(...left.map(block => block.bottom))
  const rightBottom = Math.max(...right.map(block => block.bottom))
  const overlap = Math.min(leftBottom, rightBottom) - Math.max(leftTop, rightTop)
  if (overlap < 0.2 || overlap < 0.45 * Math.min(leftBottom - leftTop, rightBottom - rightTop)) return [...blocks].sort(topFirst)
  const other = blocks.filter(block => !left.includes(block) && !right.includes(block))
  const columnTop = Math.min(leftTop, rightTop)
  const columnBottom = Math.max(leftBottom, rightBottom)
  if (other.some(block => block.top >= columnTop && block.bottom <= columnBottom)) return [...blocks].sort(topFirst)
  const before = other.filter(block => block.bottom <= columnTop)
  const after = other.filter(block => block.bottom > columnBottom)
  return [...before.sort(topFirst), ...left.sort(topFirst), ...right.sort(topFirst), ...after.sort(topFirst)]
}

/**
 * 过滤 OCR 噪声并按阅读顺序整理。
 * 与屏幕翻译原版的差异：原版面向「把译文画回图片」，会丢掉中文占主导的
 * 块（中英混排标题保持原样）；这里输出整页纯文本，中文块必须保留，
 * 以免丢内容（translateText 对已是目标语言的文本会原样返回）。
 * URL、星号乱码、图标误读等纯噪声仍照原样剔除。
 */
export function buildOCRBlocks(candidates: OCRCandidate[]): OCRBlock[] {
  const blocks = candidates.map(makeBlock).filter(block => {
    if (!block.box || /(?:https?:\/\/|www\.)\S+/i.test(block.text)) return false
    const cleanText = block.text.trim()
    if (!cleanText) return false
    const words = cleanText.match(/[A-Za-z]{2,}/g) ?? []
    const hanCount = (cleanText.match(/\p{Script=Han}/gu) ?? []).length
    // 纯符号/数字块没有可翻译内容。
    if (!words.length && !hanCount) return false
    // OCR 把图标误读为星号夹杂的英文时不保留。
    if (/[A-Za-z]\*|\*[A-Za-z]/.test(cleanText)) return false
    if (!hanCount && /[_•·]/.test(cleanText) && words.length < 8) return false
    if (!hanCount && words.length === 1 && /^[A-Z][a-z]+[A-Z]/.test(cleanText)) return false
    if (!hanCount && words.length === 1 && /[_\d]/.test(cleanText)) return false
    return true
  })
  return inReadingOrder(blocks).map(block => ({ text: block.text, box: block.box }))
}

export function buildSourceText(blocks: OCRBlock[]): string { return blocks.map(block => block.text).join("\n") }

/**
 * 把任意来源的 UIImage 物化为「已完整解码、驻留内存」的位图副本。
 *
 * 背景（2026-10-11 崩溃日志 58EFB5AD.ips）：崩溃是 EXC_BAD_ACCESS 读 0x0，
 * 发生在 ScriptingKit 原生代码 `closure #1 in JSVision.recognizeText` ——
 * 即 Vision.recognizeText 建 Promise 时同步执行的原生闭包里解引用了空指针
 * （典型成因：传入的 UIImage 没有可用的底层位图/CGImage，原生侧未判空）。
 * 分享扩展的临时截图文件可能受数据保护、被系统提前回收或尚未落盘完成，
 * 会出现「UIImage 构造成功但 OCR 时位图已不可用」的竞态。
 *
 * 因此 OCR 前强制走 toPNGData → fromData 往返：
 * - 任一步失败都只返回 null（可捕获的 JS 层错误，绝不进原生崩溃区）；
 * - 成功则 Vision 拿到的是全新解码的内存位图，与源文件是否还存在无关。
 */
export function inlineImageBitmap(image: UIImage | null | undefined): UIImage | null {
  if (!image || typeof image !== "object"
    || typeof image.width !== "number" || typeof image.height !== "number") return null
  if (!Number.isFinite(image.width) || !Number.isFinite(image.height)
    || image.width <= 0 || image.height <= 0) return null
  let data: Data | null = null
  try { data = image.toPNGData() } catch { data = null }
  if (!data) return null
  try {
    const copy = UIImage.fromData(data)
    if (!copy || !Number.isFinite(copy.width) || copy.width <= 0 || copy.height <= 0) return null
    return copy
  } catch { return null }
}

/**
 * 准确识别截图文字并输出阅读顺序的整页文本；未识别到内容返回 ""。
 * 固定 accurate + 语言校正——不提供识别模式设置。
 *
 * 语言列表顺序实测关键（tests/screen-ocr.tsx 会回归验证）：
 * ["en","zh-Hans"] 会整块漏识中文（纯中文图 0 候选、混排图只出英文行），
 * 稳定复现；["zh-Hans","en"] 简体/繁体/英文全部识别。勿改回 en 优先。
 */
export async function recognizeScreenBlocks(image: UIImage): Promise<OCRBlock[]> {
  const source = inlineImageBitmap(image)
  if (!source) {
    throw new Error("截图数据无效或无法解码（可能被系统回收或文件受保护），请重新分享一次。")
  }
  const result = await Vision.recognizeText(source, {
    recognitionLevel: "accurate",
    recognitionLanguages: ["zh-Hans", "en"],
    usesLanguageCorrection: true,
  })
  if (!result.text.trim() || result.candidates.length === 0) return []
  return buildOCRBlocks(result.candidates)
}

export async function recognizeScreenText(image: UIImage): Promise<string> {
  return buildSourceText(await recognizeScreenBlocks(image))
}
