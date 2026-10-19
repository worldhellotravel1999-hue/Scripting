import { Canvas, ImageRenderer, type CanvasRenderingContext } from "scripting"
import { recognizeScreenBlocks, type OCRBlock } from "./screen-ocr"
import { translateLines, type TranslateTextOptions } from "./translate"

type ScreenOverlayLine = {
  source: string
  translated: string
  /** Vision 归一化框（原点左下）；无框时只进纯文本、不覆盖。 */
  box?: { x: number; y: number; width: number; height: number }
}

export type ScreenOverlayResult = {
  /** 原图上盖住原文的译文图；渲染失败时回退原图。 */
  image: UIImage
  text: string
  lines: ScreenOverlayLine[]
}

type Rect = { x: number; y: number; width: number; height: number }

function validBox(box?: OCRBlock["box"]): box is NonNullable<OCRBlock["box"]> {
  return !!box && [box.x, box.y, box.width, box.height].every(Number.isFinite)
    && box.width > 0 && box.height > 0
}

/** 同一行相邻块先合并，避免逐词翻译破坏语序、逐词小框盖不住整行。 */
function mergeLineBlocks(blocks: OCRBlock[]): OCRBlock[] {
  const withBox = blocks.filter((block) => validBox(block.box))
  const withoutBox = blocks.filter((block) => !validBox(block.box))
  const rows: { top: number; height: number; items: OCRBlock[] }[] = []
  for (const block of withBox) {
    const box = block.box!
    const top = 1 - box.y - box.height
    const height = box.height
    const row = rows.find((candidate) => {
      const overlap = Math.min(candidate.top + candidate.height, top + height)
        - Math.max(candidate.top, top)
      return overlap > 0.4 * Math.min(candidate.height, height)
    })
    if (row) {
      row.items.push(block)
      const bottom = Math.max(row.top + row.height, top + height)
      row.top = Math.min(row.top, top)
      row.height = bottom - row.top
    } else {
      rows.push({ top, height, items: [block] })
    }
  }
  const merged: OCRBlock[] = []
  for (const row of rows.sort((a, b) => a.top - b.top)) {
    const items = row.items.sort((a, b) => a.box!.x - b.box!.x)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const item of items) {
      const box = item.box!
      if (box.x < minX) minX = box.x
      if (box.y < minY) minY = box.y
      if (box.x + box.width > maxX) maxX = box.x + box.width
      if (box.y + box.height > maxY) maxY = box.y + box.height
    }
    // 同行块之间用空格连接；中英文混排时逐块翻译容易断句，整行一次翻译更连贯。
    merged.push({
      text: items.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim(),
      box: {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
      },
    })
  }
  return [...merged, ...withoutBox]
}

/**
 * 译文按原框排版：贪心换行 + 字号自适应，保证盖住原文又不溢出。
 *
 * 性能要点（2026-10-19）：旧实现从 baseSize 开始**逐号递减**（1px 一档），
 * 每一档都要把所有 token 重新贪心排一遍、每个 token 一次 measureText。
 * 长截图几十上百行时这是 O(行数 × 字号档数 × token 数) 次原生文字测量：
 * 实测 336 行 / 8.3MP 的覆盖渲染要 14.9 秒，足够让分享扩展被系统
 * 看门狗强杀（用户感受就是「翻译完直接退出」）。
 *
 * 现在改为**二分搜索字号**（档数 60+ → ~6），且每轮只做一次排版；
 * 排版本身也预先量好每个 token 宽度（ctx.measureText 有缓存但不保证跨字号），
 * 返回值语义完全不变：仍然返回「能在框内排下的最大字号 + 换行结果」。
 */
function layoutLines(
  ctx: CanvasRenderingContext,
  text: string,
  rect: Rect,
  baseSize: number,
): { lines: string[]; size: number } {
  const spacial = text.replace(/\s+/g, " ").trim().split(" ")
  // CJK 无空格：按字切分逐字换行。
  const words = spacial.length > 1 ? spacial : []
  const tokens = words.length > 1
    ? words
    : (text.replace(/\s+/g, "") || "").split("")
  const joiner = words.length > 1 ? " " : ""
  if (!tokens.length) return { lines: [text], size: baseSize }

  const layout = (size: number): { lines: string[]; fits: boolean } => {
    ctx.font = size
    const lines: string[] = []
    let current = ""
    for (const token of tokens) {
      const probe = current ? `${current}${joiner}${token}` : token
      if (ctx.measureText(probe).width <= rect.width || !current) current = probe
      else {
        lines.push(current)
        current = token
      }
    }
    if (current) lines.push(current)
    const lineHeight = size * 1.18
    return { lines, fits: lines.length * lineHeight <= rect.height || lines.length <= 1 }
  }

  const minSize = 6
  // 先试起始字号（常见情况：短文/大字直接一次命中）。
  const initial = layout(baseSize)
  if (initial.fits) return { lines: initial.lines, size: baseSize }

  // 二分：在 (minSize, baseSize) 里找能排下的最大字号。
  let low = minSize
  let high = baseSize - 1
  let best = { lines: initial.lines, size: minSize }
  let found = false
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const attempt = layout(mid)
    if (attempt.fits) {
      best = { lines: attempt.lines, size: mid }
      found = true
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  if (found) return best
  // 连最小字号都排不下：保持旧行为（单行输出，交给人眼判断）。
  ctx.font = minSize
  return { lines: tokens.length ? [tokens.join(joiner)] : [text], size: minSize }
}

/**
 * 截图译文覆盖图：原图打底 → 每个 OCR 行取整行译文 →
 * 用白底盖住原文 → 译文按框内排版写回。
 * 失败（无文本块/翻译失败/渲染失败）时抛错，由调用方回退纯文本。
 */
export async function translateScreenOverlay(
  image: UIImage,
  options: TranslateTextOptions = {},
): Promise<ScreenOverlayResult> {
  let blocks = mergeLineBlocks(await recognizeScreenBlocks(image))
  if (!blocks.length) {
    // 空结果重试一次：Vision 在极端长宽比/瞬时空资源下会**静默**给出 0 块
    // （不抛错）。分片已按像素预算切好，这里再试一轮往往就正常了；
    // 仍为空才报错，避免把偶发空结果当成「图片没文字」直接失败。
    blocks = mergeLineBlocks(await recognizeScreenBlocks(image))
  }
  if (!blocks.length) throw new Error("未识别到文字，请确认截图清晰且包含可识别文本。")

  // 一次批量翻译全部行（旧行为是逐行串行 translateText，截图一多就要
  // 等 N 个请求 + N 次原生排队，是截图翻译慢的根因）。
  const translations = await translateLines(blocks.map((block) => block.text), options)
  const lines: ScreenOverlayLine[] = blocks.map((block, index) => ({
    source: block.text,
    translated: (translations[index] ?? "").trim() || block.text,
    box: block.box,
  }))
  const text = lines.map((line) => line.translated).join("\n").trim()
  if (!text) throw new Error("未识别到文字，请确认截图清晰且包含可识别文本。")

  try {
    return { image: await renderCoverImage(image, lines), text, lines }
  } catch {
    return { image, text, lines }
  }
}

function toHexByte(value: number): string {
  return Math.min(255, Math.max(0, Math.round(value * 255))).toString(16).padStart(2, "0")
}

/**
 * 取底色用的小代理图：长截图的整图 RGBA 缓冲很贵
 * （1075x7462px ≈ 27MB，分享扩展内存紧张时会直接被系统回收，
 * 表现为「翻译到一半脚本消失」）。这里把图缩到宽 400px 再读缓冲：
 * 同图实测 2.3MB vs 10.5MB，且取样结果几乎一致（纯色区 255,255,255
 * 对 254,254,254，肉眼看不出差异）。
 *
 * 归一化坐标与分辨率无关，所以代理图上的同一 box 采样点
 * 就对应原图同一位置。读取失败返回 null，采样回退白底。
 */
type PixelBuffer = { width: number; height: number; bytes: Uint8Array }
const PROXY_WIDTH_PX = 400

function readPixelBuffer(image: UIImage): PixelBuffer | null {
  const read = (source: UIImage): PixelBuffer | null => {
    try {
      const raw = source.getPixelData()
      if (!raw || raw.width <= 0 || raw.height <= 0) return null
      const bytes = raw.data.toUint8Array()
      if (!bytes || bytes.length < raw.width * raw.height * 4) return null
      return { width: raw.width, height: raw.height, bytes }
    } catch {
      return null
    }
  }
  try {
    const scale = image.scale && image.scale > 0 ? image.scale : 1
    const pixelWidth = image.width * scale
    if (pixelWidth > PROXY_WIDTH_PX) {
      const ratio = PROXY_WIDTH_PX / pixelWidth
      const proxy = image.preparingThumbnail({
        width: Math.max(1, Math.round((pixelWidth * ratio) / scale)),
        height: Math.max(1, Math.round((image.height * ratio))),
      })
      const buffer = proxy ? read(proxy) : null
      if (buffer) return buffer
    }
  } catch {}
  // 代理图不可用时退回整图；宁可多占内存，也不要丢底色适配。
  return read(image)
}

/**
 * 框外环带取底色：框向外扩 4px 的周界采 8 个点取中位色。
 * Vision 框是归一化左下原点；像素缓冲是左上原点，此处换算。
 * 缓冲不可用/取点越界返回 null，由调用方回退白底
 * （7 位以下短 hex 亦回退，避免色值解析问题）。
 */
function sampleFrameColor(
  buffer: PixelBuffer | null,
  box: NonNullable<OCRBlock["box"]>,
): string | null {
  if (!buffer) return null
  try {
    const pw = buffer.width
    const ph = buffer.height
    if (pw <= 0 || ph <= 0) return null
    // 环带外扩按代理图自身的像素密度换算（短边或长边都很小的时候也不出错）。
    const padX = 4 / pw
    const padY = 4 / ph
    const left = Math.max(0, box.x - padX)
    const right = Math.min(1, box.x + box.width + padX)
    const bottom = Math.max(0, box.y - padY)
    const top = Math.min(1, box.y + box.height + padY)
    const points: Array<[number, number]> = [
      [(left + right) / 2, top], [(left + right) / 2, bottom],
      [left, (bottom + top) / 2], [right, (bottom + top) / 2],
      [left, top], [right, top], [left, bottom], [right, bottom],
    ]
    const colors: Array<{ r: number; g: number; b: number }> = []
    for (const [nx, nyBottom] of points) {
      const px = Math.min(pw - 1, Math.max(0, Math.round(nx * pw)))
      const py = Math.min(ph - 1, Math.max(0, Math.round((1 - nyBottom) * ph)))
      const offset = (py * pw + px) * 4
      colors.push({ r: buffer.bytes[offset], g: buffer.bytes[offset + 1], b: buffer.bytes[offset + 2] })
    }
    if (!colors.length) return null
    const median = (pick: (color: { r: number; g: number; b: number }) => number) => {
      const sorted = colors.map(pick).sort((a, b) => a - b)
      return sorted[Math.floor(sorted.length / 2)]
    }
    return `#${toHexByte(median((c) => c.r))}${toHexByte(median((c) => c.g))}${toHexByte(median((c) => c.b))}`
  } catch {
    return null
  }
}

/** 亮度判断：亮底黑字、暗底白字。null（回退白底）视为亮色。 */
function isDarkColor(hex: string | null | undefined): boolean {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return false
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5
}

/** 把译文行按框盖回原图；框无效或渲染失败时回退原图。 */
async function renderCoverImage(image: UIImage, lines: ScreenOverlayLine[]): Promise<UIImage> {
  const width = image.width
  const height = image.height
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return image
  }
  // 全部行的底色采样共用同一次像素缓冲读取（原逐行 pixelColor 每次都可能重新解码整图）。
  const pixels = readPixelBuffer(image)
  const cover = await ImageRenderer.toUIImage(
    <Canvas
      frame={{ width, height }}
      draw={(ctx, size) => {
        ctx.drawImage({ image }, 0, 0, size.width, size.height)
        for (const line of lines) {
          if (!line.box) continue
          const box = line.box
          const rect = {
            x: box.x * size.width,
            // Vision 原点左下 → Canvas 原点左上。
            y: (1 - box.y - box.height) * size.height,
            width: Math.max(2, box.width * size.width),
            height: Math.max(2, box.height * size.height),
          }
          // 按框取底色盖住原文：框边缘 3px 环带采 8 个点取中位色，
          // 深色截图不再糊大白块；采样失败回退白底。
          const bg = sampleFrameColor(pixels, box)
          ctx.fillStyle = bg ?? "#FFFFFF"
          ctx.fillRect(rect.x - 1, rect.y - 1, rect.width + 2, rect.height + 2)
          const baseSize = Math.max(8, rect.height * 0.72)
          const laid = layoutLines(ctx, line.translated, rect, baseSize)
          // 按底色亮度选字色：亮底黑字、暗底白字，保证可读。
          ctx.fillStyle = isDarkColor(bg) ? "#FFFFFF" : "#111111"
          ctx.textAlign = "left"
          ctx.textBaseline = "top"
          ctx.font = laid.size
          const lineHeight = laid.size * 1.18
          const startY = rect.y + Math.max(0, (rect.height - laid.lines.length * lineHeight) / 2)
          laid.lines.forEach((row, index) => {
            ctx.fillText(row, rect.x, startY + index * lineHeight)
          })
        }
      }}
    />,
    { scale: 1 },
  )
  return cover ?? image
}
