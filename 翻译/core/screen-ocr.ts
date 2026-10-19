/**
 * 屏幕截图文字识别（移植自「屏幕翻译」脚本的 ocr.ts，按本脚本用途裁剪）：
 * - 只保留「准确识别」（accurate），无识别模式设置；
 * - 输出阅读顺序的原文文本 + 归一化文本框，供 translateText 翻译与
 *   screen-overlay.tsx 原位覆盖渲染使用。
 */
type OCRBox = { x: number; y: number; width: number; height: number }
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
 * 列表符号：截图里「·」「•」「-」「*」常被 Vision 作为行首字符带回来。
 * 它们只是标记，不构成「噪声证据」；判定内容时先剥掉。
 */
function stripListMarker(text: string): string {
  return text.replace(/^[\s•·∙⋅▪◦‣⁃*\-–—]+/, "").trim()
}

/**
 * 过滤 OCR 噪声并按阅读顺序整理。
 * 与屏幕翻译原版的差异：原版面向「把译文画回图片」，会丢掉中文占主导的
 * 块（中英混排标题保持原样）；这里输出整页纯文本，中文块必须保留，
 * 以免丢内容（translateText 对已是目标语言的文本会原样返回）。
 * URL、星号乱码、图标误读等纯噪声仍照原样剔除。
 *
 * 2026-10-19 修复（用户更新日志截图只翻一半）：
 * - 旧规则「不含中文且出现 [_•·] 且英文单词 < 8 → 丢弃」会把
 *   `• Fixed inaccurate protocol, policy, and failed` 这类**带项目符号的
 *   短行整行删掉**；列表里的短句本来是正文，删掉就是漏译。
 * - 现在先剥掉行首列表符号再判定内容，短句只要有一个 2+ 字母单词就保留。
 *   星号乱码、纯数字、纯符号等真正的噪声仍会剔除。
 */
export function buildOCRBlocks(candidates: OCRCandidate[]): OCRBlock[] {
  const blocks = candidates.map(makeBlock).filter(block => {
    if (!block.box || /(?:https?:\/\/|www\.)\S+/i.test(block.text)) return false
    const cleanText = block.text.trim()
    if (!cleanText) return false
    // 行首列表符号不参与噪声判定（正文里的 · 分隔符仍保留原样）。
    const content = stripListMarker(cleanText)
    if (!content) return false
    const words = content.match(/[A-Za-z]{2,}/g) ?? []
    const hanCount = (content.match(/\p{Script=Han}/gu) ?? []).length
    // 纯符号/数字块没有可翻译内容。
    if (!words.length && !hanCount) return false
    // OCR 把图标误读为星号夹杂的英文时不保留。
    if (/[A-Za-z]\*|\*[A-Za-z]/.test(content)) return false
    if (!hanCount && words.length === 1 && /^[A-Z][a-z]+[A-Z]/.test(content)) return false
    if (!hanCount && words.length === 1 && /[_\d]/.test(content)) return false
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
 * 因此 OCR 前强制走 编码 → fromData 往返：
 * - 任一步失败都只返回 null（可捕获的 JS 层错误，绝不进原生崩溃区）；
 * - 成功则 Vision 拿到的是全新解码的内存位图，与源文件是否还存在无关。
 *
 * 2026-10-19 提速：编码从 toPNGData 换成 toJPEGData(0.92)。截屏物化只是
 * 为了「拿到一份确定可解码的内存位图」，不追求无损：真机整页截图上
 * PNG 编码可达数百 ms～秒级，JPEG 明显更快；0.92 质量对 OCR/覆盖
 * 渲染的底色采样与文字可读性无实际影响。物化副本带 WeakSet 标记，
 * 不会被二次编码。
 */
const inlineBitmaps = new WeakSet<object>()

export function inlineImageBitmap(image: UIImage | null | undefined): UIImage | null {
  if (!image || typeof image !== "object"
    || typeof image.width !== "number" || typeof image.height !== "number") return null
  if (!Number.isFinite(image.width) || !Number.isFinite(image.height)
    || image.width <= 0 || image.height <= 0) return null
  if (inlineBitmaps.has(image)) return image
  let data: Data | null = null
  try { data = image.toJPEGData(0.92) } catch { data = null }
  if (!data) {
    // JPEG 编码失败（极端色板/受保护图）时退回 PNG，保持旧行为。
    try { data = image.toPNGData() } catch { data = null }
  }
  if (!data) return null
  try {
    const copy = UIImage.fromData(data)
    if (!copy || !Number.isFinite(copy.width) || copy.width <= 0 || copy.height <= 0) return null
    inlineBitmaps.add(copy)
    return copy
  } catch { return null }
}

/**
 * OCR 尺寸预算（真机实测，2026-10-19）：
 * Vision 的 accurate 识别在像素总量超限后会**静默放弃**——不抛错、
 * 不返回空文本提示，而是直接给出 0～几个候选块：
 *   672x6000 (4.0MP) → 129 块；672x7000 (4.7MP) → 151 块；
 *   672x8000 (5.4MP) → 4 块；672x9000 (6.0MP) → 0 块。
 * 长截图（设置页/聊天记录/滚动截屏）很容易越过这条线，
 * 表现为「有时能翻、有时直接没结果或退出」。
 *
 * 因此不再用「宽度阈值」，而是按像素预算切片：
 * - 宽度先降到 OCR_TARGET_WIDTH_PX（1179px 内小字仍可靠，
 *   再降到 828px 会大量漏识，实测 31 块→1 块）；
 * - 高度按 OCR_SLICE_PIXELS（≈3.0MP/片）切分，每片单独识别后拼接。
 * 实测 672x4000(2.7MP) 642ms / 672x6000(4.0MP) 757ms，
 * 切片不是线性变慢，控制在 ~4MP 以内即可。
 *
 * 注意 UIImage.width/height 的单位是**点**，像素 = 点 × scale；
 * preparingThumbnail 的参数同样是点且**保留原 scale**。
 * 先前的实现直接比较 image.width，真机上永远不触发（scale=3 时
 * 672pt = 2016px），降采样与切片实际都没生效。
 */
const OCR_TARGET_WIDTH_PX = 1179
/**
 * 单片像素预算（真机实测）：3.0MP 安全；5.4MP 起 Vision accurate 静默给
 * 0～几个块。2026-10-19 曾试 4.0MP 想让整屏截图单片完成，但 598x8634 长图
 * 在 4MP 预算下块数从 200 掉到 99——安全线不只由总像素决定，还与长宽比有关。
 * 保持 3.0MP。
 */
const OCR_SLICE_PIXELS = 3_000_000
/** 单片高度上限（像素），防止极端窄图把单片拉得过高。 */
const OCR_SLICE_MAX_HEIGHT_PX = 6000

function pixelSizeOf(image: UIImage): { width: number; height: number } | null {
  const scale = image.scale && Number.isFinite(image.scale) && image.scale > 0 ? image.scale : 1
  const width = image.width * scale
  const height = image.height * scale
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { width: Math.round(width), height: Math.round(height) }
}

/** 把点尺寸换算成像素尺寸后缩放到目标像素宽；失败返回原图。 */
function downscaleToWidth(image: UIImage, targetPx: number): UIImage {
  const pixels = pixelSizeOf(image)
  if (!pixels || pixels.width <= targetPx) return image
  try {
    const ratio = targetPx / pixels.width
    // preparingThumbnail 接收点、并由原图 scale 决定实际像素，故除以 scale。
    const scale = image.scale && image.scale > 0 ? image.scale : 1
    const thumb = image.preparingThumbnail({
      width: Math.max(1, Math.round((pixels.width * ratio) / scale)),
      height: Math.max(1, Math.round((pixels.height * ratio) / scale)),
    })
    if (thumb && thumb.width > 0 && thumb.height > 0) return thumb
  } catch {}
  return image
}

/** 切片及其在整图中的像素位置（回映射必须用真实偏移）。 */
type ScreenSlice = { image: UIImage; startPx: number; heightPx: number }

/** 按像素高度切片（croppedTo 接收点）；切片失败时返回 [image]。 */
function sliceByHeight(image: UIImage, slicePx: number): ScreenSlice[] {
  const pixels = pixelSizeOf(image)
  if (!pixels) return [{ image, startPx: 0, heightPx: 0 }]
  if (pixels.height <= slicePx) return [{ image, startPx: 0, heightPx: pixels.height }]
  const scale = image.scale && image.scale > 0 ? image.scale : 1
  const slices: ScreenSlice[] = []
  for (let startPx = 0; startPx < pixels.height; startPx += slicePx) {
    const heightPx = Math.min(slicePx, pixels.height - startPx)
    if (heightPx <= 0) continue
    try {
      const slice = image.croppedTo({
        x: 0,
        y: startPx / scale,
        width: image.width,
        height: heightPx / scale,
      })
      if (slice && slice.width > 0 && slice.height > 0) {
        slices.push({ image: slice, startPx, heightPx })
      }
    } catch {}
  }
  return slices.length ? slices : [{ image, startPx: 0, heightPx: pixels.height }]
}

/**
 * 把切片内的归一化框映射回整图。**这一步不能省**：
 * Vision 的 boundingBox 是相对传入图片的归一化坐标，切片后每片的 y
 * 都从 0 开始；若直接拼接，所有片的框会在整图上重叠，
 * mergeLineBlocks 会把不同片的多行误合并成一行（实测 336 块→135 行，
 * 覆盖位置全错）。
 *
 * 坐标换算（Vision 原点左下）：
 *   片内像素 top = (1 - y - h) * sliceHeightPx
 *   整图像素 top = startPx + 片内 top
 *   整图 y    = 1 - (整图 top + 框高) / 整图高
 */
function remapBlocksToFullImage(
  blocks: OCRBlock[],
  startPx: number,
  sliceHeightPx: number,
  fullHeightPx: number,
): OCRBlock[] {
  if (fullHeightPx <= 0 || sliceHeightPx <= 0) return blocks
  return blocks.map((block) => {
    if (!block.box) return block
    const box = block.box
    const topInSlice = (1 - box.y - box.height) * sliceHeightPx
    const heightPx = box.height * sliceHeightPx
    const topInFull = startPx + topInSlice
    return {
      ...block,
      box: {
        x: box.x,
        y: 1 - (topInFull + heightPx) / fullHeightPx,
        width: box.width,
        height: heightPx / fullHeightPx,
      },
    }
  })
}

/**
 * 准确识别截图文字并输出阅读顺序的整页文本；未识别到内容返回 ""。
 * 固定 accurate + 语言校正——不提供识别模式设置。
 * （fast 模式本机实测完全无法识别中文，所有语言组合 han=0，
 * 故不可为提速切 fast；见 tests/screen-ocr.tsx 回归。）
 *
 * 语言列表顺序实测关键（tests/screen-ocr.tsx 会回归验证）：
 * ["en","zh-Hans"] 会整块漏识中文（纯中文图 0 候选、混排图只出英文行），
 * 稳定复现；["zh-Hans","en"] 简体/繁体/英文全部识别。勿改回 en 优先。
 *
 * 流程：物化 → 降宽度 → 按像素预算切片 → 逐片 accurate 识别 → 按片顺序拼接。
 * 串行识别（并行实测没有更快：两个分片并行 1823ms，串行同量级），
 * 且串行能让内存峰值只保留一片的候选，对分享扩展更安全。
 */
export async function recognizeScreenBlocks(image: UIImage): Promise<OCRBlock[]> {
  const source = inlineImageBitmap(image)
  if (!source) {
    throw new Error("截图数据无效或无法解码（可能被系统回收或文件受保护），请重新分享一次。")
  }
  const normalized = downscaleToWidth(source, OCR_TARGET_WIDTH_PX)
  const normalizedPixels = pixelSizeOf(normalized)
  if (!normalizedPixels) {
    throw new Error("截图尺寸无效，请重新分享一次。")
  }
  const slicePx = Math.max(1, Math.min(
    Math.floor(OCR_SLICE_PIXELS / Math.max(1, normalizedPixels.width)),
    OCR_SLICE_MAX_HEIGHT_PX,
  ))
  const slices = sliceByHeight(normalized, slicePx)
  const blocks: OCRBlock[] = []
  let firstError: unknown
  let succeeded = 0
  for (let index = 0; index < slices.length; index += 1) {
    const { image: slice, startPx, heightPx } = slices[index]
    try {
      const result = await Vision.recognizeText(slice, {
        recognitionLevel: "accurate",
        recognitionLanguages: ["zh-Hans", "en"],
        usesLanguageCorrection: true,
      })
      succeeded += 1
      if (!result.candidates.length) continue
      const mapped = buildOCRBlocks(result.candidates)
      blocks.push(...(slices.length > 1
        ? remapBlocksToFullImage(mapped, startPx, heightPx, normalizedPixels.height)
        : mapped))
    } catch (reason) {
      if (firstError === undefined) firstError = reason
    }
  }
  // 所有切片都失败（不是「没识别到文字」，而是原生调用出错）才抛出，
  // 保留原始错误信息供界面展示。
  if (slices.length > 1 && succeeded === 0 && firstError !== undefined) throw firstError
  return blocks
}

export async function recognizeScreenText(image: UIImage): Promise<string> {
  return buildSourceText(await recognizeScreenBlocks(image))
}
