import { Canvas, ImageRenderer, type CanvasRenderingContext } from "scripting"
import { recognizeScreenBlocks, type OCRBlock } from "./screen-ocr"
import { translateText, type TranslateTextOptions } from "./translate"

export type ScreenOverlayLine = {
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
    // 同行块之间用空格连接；中英文混排时逐块翻译容易断句，整行一次翻译更连贯。
    merged.push({
      text: items.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim(),
      box: {
        x: Math.min(...items.map((item) => item.box!.x)),
        y: Math.min(...items.map((item) => item.box!.y)),
        width: Math.max(...items.map((item) => item.box!.x + item.box!.width))
          - Math.min(...items.map((item) => item.box!.x)),
        height: Math.max(...items.map((item) => item.box!.y + item.box!.height))
          - Math.min(...items.map((item) => item.box!.y)),
      },
    })
  }
  return [...merged, ...withoutBox]
}

/** 译文按原框排版：贪心换行 + 字号自适应，保证盖住原文又不溢出。 */
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
  let size = baseSize
  while (size > 6) {
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
    if (lines.length * lineHeight <= rect.height || lines.length <= 1) {
      return { lines, size }
    }
    size -= 1
  }
  ctx.font = size
  return { lines: tokens.length ? [tokens.join(joiner)] : [text], size }
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
  const blocks = mergeLineBlocks(await recognizeScreenBlocks(image))
  if (!blocks.length) throw new Error("未识别到文字，请确认截图清晰且包含可识别文本。")

  const lines: ScreenOverlayLine[] = []
  for (const block of blocks) {
    // 逐行独立翻译：原文行与译文行一一对应，才能按框盖回。
    const translated = (await translateText(block.text, options)).trim() || block.text
    lines.push({ source: block.text, translated, box: block.box })
  }
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
 * 框外环带取底色：框向外扩 4px 的周界采 8 个点取中位色。
 * Vision 框是归一化左下原点；pixelColor 是像素左上原点，此处换算。
 * 采样失败返回 null，由调用方回退白底（7 位以下短 hex 亦回退，避免色值解析问题）。
 */
function sampleFrameColor(
  image: UIImage,
  box: NonNullable<OCRBlock["box"]>,
): string | null {
  try {
    const scale = image.scale || 1
    const pw = image.width * scale
    const ph = image.height * scale
    if (!Number.isFinite(pw) || !Number.isFinite(ph) || pw <= 0 || ph <= 0) return null
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
    const colors: RGBAColor[] = []
    for (const [nx, nyBottom] of points) {
      const px = Math.min(pw - 1, Math.max(0, Math.round(nx * pw)))
      const py = Math.min(ph - 1, Math.max(0, Math.round((1 - nyBottom) * ph)))
      const color = image.pixelColor(px, py)
      if (color) colors.push(color)
    }
    if (!colors.length) return null
    const median = (pick: (color: RGBAColor) => number) => {
      const sorted = colors.map(pick).sort((a, b) => a - b)
      return sorted[Math.floor(sorted.length / 2)]
    }
    return `#${toHexByte(median((c) => c.red))}${toHexByte(median((c) => c.green))}${toHexByte(median((c) => c.blue))}`
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
export async function renderCoverImage(image: UIImage, lines: ScreenOverlayLine[]): Promise<UIImage> {
  const width = image.width
  const height = image.height
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return image
  }
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
          const bg = sampleFrameColor(image, box)
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
