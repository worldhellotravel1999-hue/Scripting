/**
 * 「暗色（模拟）」图标处理。
 *
 * 思路：把**浅色背景压成深色**、**主体颜色原样保留**（深色主体提亮到深底上仍可见）——
 * 这正是 Apple 暗色图标给人的观感（底色变深、logo 还是那个 logo、色相不变）。
 * Apple 的真实暗色图标是开发者单独设计的分层素材，公开接口拿不到，所以这里是本地模拟。
 *
 * 实现链路（Scripting 没有「原始像素 → UIImage」的直通接口，绕一圈）：
 *   UIImage.getPixelData() → 在 Uint8Array 上逐像素处理 → 自建 PNG（存储块 deflate）
 *   → UIImage.fromData() 拿回一张图。
 * 处理与编码都按行分片 + await 让出主线程，避免 1MP 级别循环卡住界面。
 *
 * 背景判定三步（踩过的坑都在这）：
 *   1. 取**四角**小块采样 —— 底色一定在角上；大 logo 会触到边中点（如 Spotify 的圆），
 *      只看整圈边缘会把 logo 当成底色压暗，所以边缘色必须**与某个角色接近**才采纳；
 *   2. 两两取中点补「渐变中间色」，避免对角渐变的中段被判成主体；
 *   3. 量化成 5bit/通道的查找表（32³），逐像素只查一次表，可负担多个参考色。
 */

/** 暗色微调参数（都是可选，缺省即推荐默认值） */
export type DarkIconOptions = {
  /** 背景明度：浅色底压深后保留的灰阶 0~42（默认 28 ≈ #1C1C1C） */
  bgGray?: number
  /** 背景灰化 0~0.6（默认 0.18） */
  bgFade?: number
  /** 主体提亮 0~1.3（默认 0.85） */
  glyphLift?: number
  /** 背景竖向渐变 0~0.6（默认 0） */
  bgGrad?: number
  /** 颜色对调：底色近黑、图案换主体色（默认 false） */
  swap?: boolean
  /** 灰色遮罩：原色不变，只盖一层深灰半透明（默认 false） */
  keepBg?: boolean
  /** 外圈刷黑：底色压成近黑，图案原样（默认 false） */
  bgBlack?: boolean
}

/** 「准备」阶段的结果：只与图片本身有关，可缓存复用 */
export type DarkIconPlan = {
  orig: Uint8Array
  width: number
  height: number
  lut: Uint8Array | null
  mask: Uint8Array | null
  w2: number
  accent: [number, number, number] | null
  /** 「颜色对调」是否可用（中间图形近白 + 外面彩色） */
  swapOk: boolean
}

/** 判定：与背景参考色的距离（归一化 0~1）< EDGE_IN 算背景，> EDGE_OUT 算主体，中间平滑过渡。
 *  EDGE_IN 必须很小：它是不透明「抗锯齿低覆盖率像素」的起算点，设大了（曾经是 0.14）
 *  边缘那些只盖住十几%的过渡像素会被直接判成背景 → 暗色版边缘比原图少一层过渡、
 *  导出的 PNG 也明显变小，看起来发糊。EMPTY 小死区只用来挡背景噪声（±10 级以内）。
 *  EDGE_OUT 保持：要盖住「离参考色稍远但确实是 logo」的颜色（如 Spotify 黑底上的绿圆，
 *  距离约 0.27——它的参考色是黑底与圆的过渡色），带太宽会把它压成半明半暗。 */
const EDGE_IN = 0.03
const EDGE_OUT = 0.22

/** 背景压深：
 *  - 中性底（白/浅灰）→ 苹果那套系统深灰观感（≈#1C1C1E），不死黑
 *  - 彩色底 → 压深 + 轻降饱和，避免「霓虹反相」味 */
const BG_K_NEUTRAL = 0.11
const BG_K_COLOR = 0.26
const BG_OFF = 2
const BG_DESAT = 0.18
const NEUTRAL_SAT = 0.12

/** 彩色底图标里的「近纯白」像素（如白 logo/气泡）要保护，不被当成底色压暗 */
const WHITE_KEEP_V = 0.97
const WHITE_KEEP_SAT = 0.12

// ─── 当前渲染参数（单线程、串行渲染，用模块级变量传到像素函数里） ───────────
let _bgGray = 28
let _bgFade = 0.18
let _glyphLift = 0.85
let _bgGrad = 0
let _swap = false
/** 「外圈刷黑」：底色压成近黑，但图案保持自己的颜色（不换成主体色） */
let _swapKeepArt = false
let _keepBg = false
/** 「外圈刷黑」用：从画布四边沿底色泛洪得到的外圈底色图（1 = 外圈底色，0 = 图案内部）
 *  只有这张图上的像素才允许被刷黑，其余像素一个都不动 */
let _bgReach: Uint8Array | null = null
/** 底色基准亮度（从画布最外圈像素统计）：比它明显更暗的像素一律当主体，不做底色压深 */
let _bgRefLum = 0
/** 底色基准色（外圈平均 RGB）：用来判定「贴底色且颜色接近底色」的残边 */
let _bgRefR = -1
let _bgRefG = -1
let _bgRefB = -1
/** 对调时的图案色（= 全图主体色经 glyphTune，渲染前算一次） */
let _swapFgR = 255
let _swapFgG = 255
let _swapFgB = 255

function applyOptions(options?: DarkIconOptions) {
  _bgGray = clampNum(options?.bgGray ?? 28, 0, 42)
  _bgFade = clampNum(options?.bgFade ?? 0.18, 0, 0.6)
  _glyphLift = clampNum(options?.glyphLift ?? 0.85, 0, 1.3)
  _bgGrad = clampNum(options?.bgGrad ?? 0, 0, 0.6)
  // 「外圈刷黑」复用「颜色对调」的底色→近黑通路；两者同开时以「颜色对调」为准（图案换主体色）
  _swap = options?.swap === true || options?.bgBlack === true
  _swapKeepArt = options?.bgBlack === true && options?.swap !== true
  _keepBg = options?.keepBg === true
  // 上一次渲染的泛洪图不能留到下一次（只有「外圈刷黑」才会重算）
  _bgReach = null
}

function clampNum(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v
}

const GLYPH_V = 0.55
const GLYPH_POP = 1.06
/** 「颜色对调」的底色目标值：近黑（白底 → 黑底，图案保留原色） */
const SWAP_BG = 5
/** 「外圈刷黑」：每通道离外圈底色的最大差 ≤ 这个值就算「底色系」（淡渐变、淡阴影、白边都在里面） */
const BGBLACK_TOL = 40
/** 「外圈刷黑」泛洪：相邻像素每通道最大差 ≤ 这个值才算「同一片平滑底色」。
 *  底色渐变每步只有 1~3 级；但**图案自己也可能是平滑渐变**，单靠「步长小」会把整块图案也泛进去 ✗
 *  —— 所以泛洪同时要求「离底色 ≤ BGBLACK_TOL」（彩色扇区那一步色差 ≥80，进不来） */
const BGBLACK_STEP = 20
/** 外圈底色「色域」的宽容量：以四边采样带的每通道 min/max 为准，再各放宽这么多，
 *  用来吸收 JPEG 噪声与渐变边角的最深值 */
const BG_RANGE_SLACK = 18

/** 从画布四边出发、沿「属于外圈底色（每通道落在四边采样带的色域内）且相邻色差 ≤ stepMax」的像素泛洪，
 *  标出与外界连通的那片底色。返回 1/0 图（长度 width*height）。全透明像素当墙。
 *
 *  ⚠ 为什么不用「离底色均值 ≤ tol」：底色常是一整片渐变（信息图标就是 5af074 → 27c040 的绿渐变），
 *  离均值能差 70+，泛洪半路就被挡住 → 外圈只刷黑了最外几像素。
 *  改用「四边采样带的每通道色域」后，渐变整片都落在自己的色域里（刷得完），
 *  而白气泡 / 饱和图案的通道值会跑出色域 → 依旧挡住。 */
function reachFromEdge(
  px: Uint8Array,
  width: number,
  height: number,
  stepMax: number,
  refR: number,
  refG: number,
  refB: number,
  tol: number,
): Uint8Array {
  const out = new Uint8Array(width * height)
  const stack = new Int32Array(width * height)
  let sp = 0
  // 先量出「四边采样带」的每通道色域（band 厚度按图尺寸 1%，最少 2px）
  const band = Math.max(2, Math.round(Math.min(width, height) * 0.01))
  let loR = 255
  let loG = 255
  let loB = 255
  let hiR = 0
  let hiG = 0
  let hiB = 0
  let samples = 0
  const scan = (x: number, y: number) => {
    const j = (y * width + x) * 4
    if (px[j + 3] < 128) return
    const r = px[j]
    const g = px[j + 1]
    const b = px[j + 2]
    if (r < loR) loR = r
    if (g < loG) loG = g
    if (b < loB) loB = b
    if (r > hiR) hiR = r
    if (g > hiG) hiG = g
    if (b > hiB) hiB = b
    samples++
  }
  for (let d = 0; d < band; d++) {
    for (let x = 0; x < width; x++) {
      scan(x, d)
      scan(x, height - 1 - d)
    }
    for (let y = 0; y < height; y++) {
      scan(d, y)
      scan(width - 1 - d, y)
    }
  }
  const useRange = samples >= 16
  const ok = (j: number) => {
    if (px[j + 3] < 128) return false
    const r = px[j]
    const g = px[j + 1]
    const b = px[j + 2]
    if (useRange) {
      return (
        r >= loR - BG_RANGE_SLACK && r <= hiR + BG_RANGE_SLACK &&
        g >= loG - BG_RANGE_SLACK && g <= hiG + BG_RANGE_SLACK &&
        b >= loB - BG_RANGE_SLACK && b <= hiB + BG_RANGE_SLACK
      )
    }
    // 四边几乎没有不透明像素（全是透明留白）：退回「离底色均值 ≤ tol」
    return Math.abs(r - refR) <= tol && Math.abs(g - refG) <= tol && Math.abs(b - refB) <= tol
  }
  for (let x = 0; x < width; x++) {
    for (const p of [x, (height - 1) * width + x]) {
      if (!out[p] && ok(p * 4)) {
        out[p] = 1
        stack[sp++] = p
      }
    }
  }
  for (let y = 0; y < height; y++) {
    for (const p of [y * width, y * width + width - 1]) {
      if (!out[p] && ok(p * 4)) {
        out[p] = 1
        stack[sp++] = p
      }
    }
  }
  while (sp > 0) {
    const p = stack[--sp]
    const i = p * 4
    const r = px[i]
    const g = px[i + 1]
    const b = px[i + 2]
    const x = p % width
    const y = (p - x) / width
    for (let k = 0; k < 4; k++) {
      if (k === 0 && x === 0) continue
      if (k === 1 && x === width - 1) continue
      if (k === 2 && y === 0) continue
      if (k === 3 && y === height - 1) continue
      const q = k === 0 ? p - 1 : k === 1 ? p + 1 : k === 2 ? p - width : p + width
      if (out[q]) continue
      const j = q * 4
      if (!ok(j)) continue
      if (
        Math.abs(px[j] - r) <= stepMax &&
        Math.abs(px[j + 1] - g) <= stepMax &&
        Math.abs(px[j + 2] - b) <= stepMax
      ) {
        out[q] = 1
        stack[sp++] = q
      }
    }
  }
  return out
}

/** 「背景原色」的压暗系数：比原来深一档（约 20%），但仍保留原色 */
const KEEP_BG_K = 0.8
/** 「背景原色」里往灰靠的程度：1 = 完全不降饱和；越小越灰。
 *  用户要求底色「要看得出是原来的颜色（蓝还是蓝、绿还是绿），只不过像加了一层灰蒙蒙的」
 *  → 保留色相、只降一点饱和度（0.78）再整体压暗，就有「蒙了一层灰」的感觉 */
const KEEP_BG_SAT = 0.78
/** 区域生长掩码（半分辨率）：MASK_STEP = 1<<MASK_SHIFT */
const MASK_SHIFT = 1
const MASK_STEP = 1 << MASK_SHIFT
/** 掩码生长的最低亮度系数：比「底色基准亮度」暗到这个比例以下的格子一律不吃（保护投影/深色主体） */
const DARK_STOP_K = 0.7
/** 像素亮度低于「底色基准亮度 × 此系数」时直接当主体（提亮）：保护投影 / 深色主体不被压成底色 */
const DARK_SUBJECT_K = 0.6
/** 掩码生长的绝对亮度差：底色本身就很暗时（暗底图标），按「比底色暗 > 此值」判。比例判据对暗底无效 */
const DARK_STOP_ABS = 12
/** 底色基准亮度低于此值就认为「暗底图标」：这类图标里与底色相近的暗色区域几乎都是投影/暗部，不该压成底色 */
const DARK_BG_MAX = 60
/** 「护下来的暗部/投影」的压暗系数：不做提亮（glyphTune 会把近黑翻成近白），只轻压一点，保住与底色的层次 */
const SHADOW_K = 0.85
/** 暗底图标专用：低饱和（灰调）且亮度落在「底色亮度×此系数 + 此增量」以内的区域一律当底色。
 *  这类像素是投影/底座/灰阶阴影，不当心会被当成图案部分提亮，在深底上留一块灰斑 */
const SHADOW_SAT = 0.06
/** 「灰调当作投影吃掉」只在**中性底色**（白/灰/黑）上做：
 *  底色本身带颜色时（如深蓝底 + 银色图案），银色/灰阶图案的暗部亮度也会落进那个带，
 *  被换成底色就成了「银色变蓝」；而当初要清的投影都出现在白底/灰底上，所以带色底色直接不做 */
const SHADOW_BG_SAT_MAX = 0.12
/** 「背景原色」＝原图标颜色不变，只在整张图上盖一层**深灰半透明遮罩**：
 *  c' = c×(1-α) + 深灰×α。浓度 α 跟「背景灰化」滑块（默认 18%）、深灰跟「背景明度」滑块（默认 #1C1C1C）走，
 *  所以这两个滑块在这个模式下也照样有反应，默认观感与之前一致 */
const SHADOW_LUM_K = 2.8
const SHADOW_LUM_ADD = 8
/** 亮底图标（底色本身就很亮）：灰调投影/底座的亮度区间（相对底色亮度）。
 *  高于上限＝比底色更亮的纯白图案（保留），低于下限＝黑色图案（保留）；
 *  上限取 1.0：投影/底座的「边缘泛白」部分（底色 255 时 242~255 一段）也要吃掉，
 *  否则会在深底上剩一圈「白雾」清不干净 */
const SHADOW_DARK_LO = 0.25
const SHADOW_DARK_HI = 1.0
/** 「颜色离底色多近才算底色本身」的阈值（相对最大色距 sqrt(3)*255 的比例）：
 *  只在这个范围内才把像素颜色统一成底色色（见 tonePixel），避免把 LUT 误判成底色的图案像素也刷掉 */
const RIM_DIST = 0.34
/** 上面那个常量的平方×441.67 —— 原来是写在 tonePixel 里的「4 个常量相乘」，
 *  每个像素都要乘一遍；提到模块级只算一次 */
const RIM_DIST2 = RIM_DIST * RIM_DIST * 441.67 * 441.67
const MASK_SEED_W = 0.4
const MASK_DELTA = 14
/** 格子内部的最大通道极差：超过就认为这格「含边缘过渡」，不许被掩码吃掉。
 *  4px 格子里如果没有明显过渡，极差很小（<10）；跨过 logo 边沿的格子动辄几十。
 *  没有这条限制时，区域生长会把沿边缘那一圈抗锯齿像素也归成底色，
 *  结果暗色版 logo 边缘少了过渡层、PNG 也比亮色小一截。 */
const MASK_SPREAD_MAX = 22
const MASK_MAX_SHARE = 0.9
/** 被 logo 围住、又和底色同色的近白元素（YouTube 播放三角、Chrome 球心）→ 当主体保留 */
const ENCLOSED_WHITE_V = 0.92
const ENCLOSED_WHITE_SAT = 0.15

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(bytes: Uint8Array, length: number) {
  let c = 0xffffffff
  for (let i = 0; i < length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function adler32(bytes: Uint8Array) {
  let a = 1
  let s = 0
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521
    s = (s + a) % 65521
  }
  return ((s << 16) | a) >>> 0
}

/** 让出一帧，保证分片处理时界面不卡 */
function yieldFrame() {
  return new Promise<void>((resolve) => {
    // 运行时 setTimeout 是全局函数，但类型声明里挂在 Scripting 的全局对象上，这里按需取
    const t = (globalThis as any).setTimeout as ((cb: () => void, ms?: number) => unknown) | undefined
    if (typeof t === "function") t(resolve, 0)
    else resolve()
  })
}

const colorDistance = (r: number, g: number, b: number, c: readonly number[]) => {
  const dr = (r - c[0]) / 255
  const dg = (g - c[1]) / 255
  const db = (b - c[2]) / 255
  return Math.sqrt((dr * dr + dg * dg + db * db) / 3)
}

/** 一格格统计到的颜色桶 → 代表色（量化中点） */
const bucketColor = (key: number): [number, number, number] => [
  ((key >> 10) & 31) * 8 + 4,
  ((key >> 5) & 31) * 8 + 4,
  (key & 31) * 8 + 4,
]

/** 量化直方图 */
type Histogram = { counts: Map<number, number>; total: number }

/** 背景参考色集合：四角采样为主（每个角各取前两名）、边缘采样为辅（需与角色接近）。
 *  渐变底（如 Messages 的绿→浅薄荷）两头都会被收进来，配合 LUT 里「两两连线」覆盖中间色。 */
function backgroundRefs(width: number, height: number, px: Uint8Array) {
  const refs: [number, number, number][] = []
  const push = (c: [number, number, number]) => {
    for (const r of refs) if (colorDistance(c[0], c[1], c[2], r) < 0.06) return false
    refs.push(c)
    return true
  }
  /** 某块区域的量化直方图 */
  const histogram = (x0: number, y0: number, x1: number, y1: number, dense = false): Histogram => {
    const counts = new Map<number, number>()
    let total = 0
    const step = dense ? 1 : Math.max(1, Math.floor(Math.min(width, height) / 64))
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y += step) {
      for (let x = Math.max(0, x0); x < Math.min(width, x1); x += step) {
        const i = (y * width + x) * 4
        if (px[i + 3] < 128) continue
        const key = ((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3)
        counts.set(key, (counts.get(key) ?? 0) + 1)
        total++
      }
    }
    return { counts, total }
  }
  const topColors = (h: Histogram, n: number, minShare: number) =>
    [...h.counts.entries()]
      .filter(([, cnt]) => h.total > 0 && cnt >= h.total * minShare)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([key]) => bucketColor(key))
  const patch = Math.max(3, Math.round(Math.min(width, height) * 0.05))
  const cornerInset = Math.max(patch, Math.round(Math.min(width, height) * 0.06))
  const cornerBoxes: [number, number, number, number][] = [
    [cornerInset, cornerInset, cornerInset + patch, cornerInset + patch],
    [width - cornerInset - patch, cornerInset, width - cornerInset, cornerInset + patch],
    [cornerInset, height - cornerInset - patch, cornerInset + patch, height - cornerInset],
    [width - cornerInset - patch, height - cornerInset - patch, width - cornerInset, height - cornerInset],
  ]
  // 1) 四角：每角各取前两名（渐变底两头都能进参考集）
  let cornerPixels = 0
  for (const [x0, y0, x1, y1] of cornerBoxes) {
    const h = histogram(x0, y0, x1, y1, true)
    cornerPixels += h.total
    for (const c of topColors(h, 2, 0.02)) push(c)
  }
  // 2) 边缘（跳过四角区域）：需与已有参考色接近，防止触边的大 logo 被当成底色
  const inCorner = (x: number, y: number) =>
    cornerBoxes.some(([x0, y0, x1, y1]) => x >= x0 - 1 && x < x1 + 1 && y >= y0 - 1 && y < y1 + 1)
  const ring = new Map<number, number>()
  let ringTotal = 0
  const takeRing = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height || inCorner(x, y)) return
    const i = (y * width + x) * 4
    if (px[i + 3] < 128) return
    const key = ((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3)
    ring.set(key, (ring.get(key) ?? 0) + 1)
    ringTotal++
  }
  const inset = Math.max(1, Math.round(Math.min(width, height) * 0.04))
  for (let x = inset; x < width - inset; x++) {
    takeRing(x, inset)
    takeRing(x, height - 1 - inset)
  }
  for (let y = inset; y < height - inset; y++) {
    takeRing(inset, y)
    takeRing(width - 1 - inset, y)
  }
  let ringColors = topColors({ counts: ring, total: ringTotal }, 6, 0.03)
  if (ringColors.length === 0 && ringTotal > 0) {
    ringColors = [...ring.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => bucketColor(k))
  }
  for (const c of ringColors) {
    if (refs.length >= 10) break
    let near = 9
    for (const r of refs) near = Math.min(near, colorDistance(c[0], c[1], c[2], r))
    if (near <= 0.3) push(c)
  }
  // 3) 兜底：四角/边缘都取不到色（极端图）→ 整图降采样统计首位
  if (refs.length === 0 && cornerPixels === 0) {
    const all = histogram(0, 0, width, height, false)
    const top = topColors(all, 1, 0)
    if (top.length > 0) push(top[0])
  }
  return refs
}

/** 参考色是否为「彩色底」（决定要不要保护近纯白像素） */
function isColoredBackground(refs: readonly (readonly number[])[]) {
  let colored = 0
  for (const c of refs.slice(0, 4)) {
    const maxC = Math.max(c[0], c[1], c[2])
    const minC = Math.min(c[0], c[1], c[2])
    if (maxC > 0 && (maxC - minC) / maxC >= 0.25) colored++
  }
  return colored >= 2
}

/** 点到「两个参考色连线」的距离：渐变底的中间色就落在这些线段附近 */
function segmentDistance(px: readonly number[], a: readonly number[], c: readonly number[]) {
  const abx = c[0] - a[0]
  const aby = c[1] - a[1]
  const abz = c[2] - a[2]
  const apx = px[0] - a[0]
  const apy = px[1] - a[1]
  const apz = px[2] - a[2]
  const denom = abx * abx + aby * aby + abz * abz
  let t = denom > 0 ? (apx * abx + apy * aby + apz * abz) / denom : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const dx = apx - abx * t
  const dy = apy - aby * t
  const dz = apz - abz * t
  return Math.sqrt((dx * dx + dy * dy + dz * dz) / 3) / 255
}

/** 5bit/通道的「背景权重」查找表：0 = 背景，255 = 主体 */
function buildWeightLUT(refs: readonly (readonly number[])[], protectWhites: boolean) {
  // 参考色两两连线（取前 4 个 → 最多 6 条线段），覆盖渐变中间色
  const segs: [readonly number[], readonly number[]][] = []
  const base = refs.slice(0, 4)
  for (let i = 0; i < base.length; i++) {
    for (let j = i + 1; j < base.length; j++) segs.push([base[i], base[j]])
  }
  const lut = new Uint8Array(32 * 32 * 32)
  for (let key = 0; key < lut.length; key++) {
    const r = ((key >> 10) & 31) * 8 + 4
    const g = ((key >> 5) & 31) * 8 + 4
    const b = (key & 31) * 8 + 4
    // 彩色底上的「近纯白」（白 logo / 白气泡）保护：永远算主体
    const maxC = Math.max(r, g, b)
    const minC = Math.min(r, g, b)
    const sat = maxC > 0 ? (maxC - minC) / maxC : 0
    if (protectWhites && maxC / 255 >= WHITE_KEEP_V && sat <= WHITE_KEEP_SAT) {
      lut[key] = 255
      continue
    }
    let best = 9
    for (let i = 0; i < refs.length; i++) {
      const d = colorDistance(r, g, b, refs[i])
      if (d < best) best = d
    }
    for (let i = 0; i < segs.length; i++) {
      const d = segmentDistance([r, g, b], segs[i][0], segs[i][1])
      if (d < best) best = d
    }
    const w = best <= EDGE_IN ? 0 : best >= EDGE_OUT ? 1 : (best - EDGE_IN) / (EDGE_OUT - EDGE_IN)
    lut[key] = Math.round(w * 255)
  }
  return lut
}

/** 主体在深底上的目标颜色：保色相/饱和度，只把偏暗的提亮；亮色微增饱和 */
function glyphTune(r: number, g: number, b: number, out: number[]) {
  const maxC = r > g ? (r > b ? r : b) : g > b ? g : b
  const v = maxC / 255
  if (v < GLYPH_V) {
    const lift = (1 - v / GLYPH_V) * _glyphLift
    const v2 = v + (1 - v) * lift
    if (v > 0.02) {
      // 整体缩放 = 保色相、保饱和度，只提亮
      const k = v2 / v
      out[0] = Math.min(255, r * k)
      out[1] = Math.min(255, g * k)
      out[2] = Math.min(255, b * k)
    } else {
      // 纯黑（无彩度可保）→ 中性浅色，深底上才看得见
      out[0] = out[1] = out[2] = v2 * 255
    }
    return
  }
  const gray = 0.299 * r + 0.587 * g + 0.114 * b
  // 亮主体不再提亮（本来就亮），但饱和增强也跟「主体提亮」滑块联动，
  // 否则这个滑块对亮主体图标完全没反应
  const pop = 1 + (GLYPH_POP - 1) * (_glyphLift / 0.85)
  // 注意：这里会出现负数（某通道远低于灰度），必须上下都夹住，
  // 否则写回 Uint8Array 会回绕（0,222,82 的绿会变成 248,226,78 的黄）
  out[0] = Math.max(0, Math.min(255, gray + (r - gray) * pop))
  out[1] = Math.max(0, Math.min(255, gray + (g - gray) * pop))
  out[2] = Math.max(0, Math.min(255, gray + (b - gray) * pop))
}

/** 非对调暗色下「图案」的目标色：**保持原色相与原亮度**，只往自身灰度靠一点点（一点点灰）。
 *  用户要求「中间图案部分颜色不要大变，只加一点点灰色」。
 *  只有特别暗的图案（最大通道 < DARK_ART_DIM，在深底上会糊成一片）才按比例轻微提亮，
 *  提亮幅度跟着「主体提亮」滑块走（默认 85 → 提到 0.30 左右），依旧保色相 */
const DARK_ART_SAT = 0.88
const DARK_ART_DIM = 0.2
const DARK_ART_LIFT_TO = 0.3
function artTune(r: number, g: number, b: number, out: number[]) {
  const gray = 0.299 * r + 0.587 * g + 0.114 * b
  const v = Math.max(r, g, b) / 255
  let k = 1
  if (v < DARK_ART_DIM) {
    const target = DARK_ART_DIM + (DARK_ART_LIFT_TO - DARK_ART_DIM) * (_glyphLift / 0.85)
    if (v <= 0.02) {
      // 近黑：没有色相可保，给个中性灰
      const gv = target * 255
      out[0] = gv
      out[1] = gv
      out[2] = gv
      return
    }
    k = target / v
  }
  out[0] = Math.max(0, Math.min(255, (gray + (r - gray) * DARK_ART_SAT) * k))
  out[1] = Math.max(0, Math.min(255, (gray + (g - gray) * DARK_ART_SAT) * k))
  out[2] = Math.max(0, Math.min(255, (gray + (b - gray) * DARK_ART_SAT) * k))
}

/** 单像素：背景压深 + 主体调色，按权重 w 混合（模块级暂存数组，避免每像素分配）
 *  m = 该行的背景明暗系数（竖向渐变；1 = 不渐变） */
const _bg = [0, 0, 0]
const _fg = [0, 0, 0]
function tonePixel(px: Uint8Array, i: number, w: number, m: number) {
  // 背景像素（w=0）一律用底色基准色来压深：投影/底面那圈带一点色相的像素若用自己的颜色，
  // 会被当成「彩色底色」只乘 BG_K_COLOR(0.26)，与周围中性底色的 BG_K_NEUTRAL(0.11) 不等
  // → 深底上留下一块比底色亮一截的淡斑/残边。统一成底色色，整片背景深度就一致了。
  // 只作用于 w=0（已判为底色）的像素，图案（w>0）不受影响
  if (w <= 0 && !_swap && _bgRefR >= 0) {
    const dr0 = px[i] - _bgRefR
    const dg0 = px[i + 1] - _bgRefG
    const db0 = px[i + 2] - _bgRefB
    if (dr0 * dr0 + dg0 * dg0 + db0 * db0 < RIM_DIST2) {
      px[i] = _bgRefR
      px[i + 1] = _bgRefG
      px[i + 2] = _bgRefB
    }
  }
  const r = px[i]
  const g = px[i + 1]
  const b = px[i + 2]
  if (_swap) {
    // 颜色对调：底色 → 近黑；图案 → 全图主体色（如微信的绿）
    // 外圈刷黑：底色同样 → 近黑，但图案保持它自己的颜色（原样不动）
    _bg[0] = SWAP_BG
    _bg[1] = SWAP_BG
    _bg[2] = SWAP_BG
    _fg[0] = _swapKeepArt ? r : _swapFgR
    _fg[1] = _swapKeepArt ? g : _swapFgG
    _fg[2] = _swapKeepArt ? b : _swapFgB
  } else if (_keepBg) {
    // 背景原色：保留原色相（蓝的还是蓝的、绿的还是绿的），只往灰靠一点再整体压暗 ——
    // 看上去就是在原来的底色上蒙了一层灰，而不是把颜色也一起改掉
    const gray0 = 0.299 * r + 0.587 * g + 0.114 * b
    _bg[0] = (gray0 + (r - gray0) * KEEP_BG_SAT) * KEEP_BG_K
    _bg[1] = (gray0 + (g - gray0) * KEEP_BG_SAT) * KEEP_BG_K
    _bg[2] = (gray0 + (b - gray0) * KEEP_BG_SAT) * KEEP_BG_K
    if (m !== 1) {
      _bg[0] = Math.min(255, _bg[0] * m)
      _bg[1] = Math.min(255, _bg[1] * m)
      _bg[2] = Math.min(255, _bg[2] * m)
    }
    artTune(r, g, b, _fg)
  } else {
    darkenBackground(r, g, b, _bg)
    if (m !== 1) {
      _bg[0] = Math.min(255, _bg[0] * m)
      _bg[1] = Math.min(255, _bg[1] * m)
      _bg[2] = Math.min(255, _bg[2] * m)
    }
    artTune(r, g, b, _fg)
  }
  if (w === 0) {
    px[i] = _bg[0]
    px[i + 1] = _bg[1]
    px[i + 2] = _bg[2]
    return
  }
  px[i] = _bg[0] + (_fg[0] - _bg[0]) * w
  px[i + 1] = _bg[1] + (_fg[1] - _bg[1]) * w
  px[i + 2] = _bg[2] + (_fg[2] - _bg[2]) * w
}

/** 「颜色对调」后：把不与画布边缘连通的底色像素补成图案色。
 *  否则图标内部「和底色同色的镂空」（消息气泡里的白点、白缝等）会被一起刷成黑色，
 *  看起来像图案被挖掉一块。
 *  泛洪只走「实心」底色（3x3 邻域里底色占多数）：低分辨率预览时图案上的细白缝会被
 *  抗锯齿糊成 1~2px，不封住就会顺着缝钻进图案内部。 */
function fillEnclosedBg(px: Uint8Array, width: number, height: number) {
  const n = width * height
  const bg = new Uint8Array(n)
  for (let p = 0; p < n; p++) {
    const i = p * 4
    if (px[i + 3] < 128) continue
    // 比图案色更靠近底色就算底色（边缘那圈半混合的像素也带上）
    const db = Math.abs(px[i] - SWAP_BG) + Math.abs(px[i + 1] - SWAP_BG) + Math.abs(px[i + 2] - SWAP_BG)
    const df =
      Math.abs(px[i] - _swapFgR) + Math.abs(px[i + 1] - _swapFgG) + Math.abs(px[i + 2] - _swapFgB)
    if (db < df) bg[p] = 1
  }
  // 实心底色：3x3 邻域里 ≥6 格也是底色才算能流动的通道
  const solid = new Uint8Array(n)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x
      if (!bg[p]) continue
      let cnt = 0
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= height) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= width) continue
          if (bg[yy * width + xx]) cnt++
        }
      }
      if (cnt >= 6) solid[p] = 1
    }
  }
  const reached = new Uint8Array(n)
  const queue = new Int32Array(n)
  let head = 0
  let tail = 0
  const push = (p: number) => {
    if (reached[p] || !solid[p]) return
    reached[p] = 1
    queue[tail++] = p
  }
  // 画布四边上的底色像素一律算「外部」（哪怕它很细）
  for (let x = 0; x < width; x++) {
    const a = x
    const b = (height - 1) * width + x
    if (bg[a] && !reached[a]) {
      reached[a] = 1
      queue[tail++] = a
    }
    if (bg[b] && !reached[b]) {
      reached[b] = 1
      queue[tail++] = b
    }
  }
  for (let y = 0; y < height; y++) {
    const a = y * width
    const b = a + width - 1
    if (bg[a] && !reached[a]) {
      reached[a] = 1
      queue[tail++] = a
    }
    if (bg[b] && !reached[b]) {
      reached[b] = 1
      queue[tail++] = b
    }
  }
  while (head < tail) {
    const p = queue[head++]
    const x = p % width
    const y = (p - x) / width
    if (x > 0) push(p - 1)
    if (x < width - 1) push(p + 1)
    if (y > 0) push(p - width)
    if (y < height - 1) push(p + width)
  }
  for (let p = 0; p < n; p++) {
    if (reached[p] || !bg[p]) continue
    const i = p * 4
    px[i] = _swapFgR
    px[i + 1] = _swapFgG
    px[i + 2] = _swapFgB
  }
}

/** 把像素当成「投影/暗部」处理：不提亮、只按 SHADOW_K（乘竖向渐变）轻压暗 */
function keepDim(px: Uint8Array, i: number, m: number) {
  px[i] = Math.min(255, px[i] * SHADOW_K * m)
  px[i + 1] = Math.min(255, px[i + 1] * SHADOW_K * m)
  px[i + 2] = Math.min(255, px[i + 2] * SHADOW_K * m)
}

/** 背景压深后的颜色 */
function darkenBackground(r: number, g: number, b: number, out: number[]) {
  const maxC = r > g ? (r > b ? r : b) : g > b ? g : b
  const minC = r < g ? (r < b ? r : b) : g < b ? g : b
  const sat = maxC > 0 ? (maxC - minC) / maxC : 0
  const kNeutral = _bgGray / 255
  const kColor = kNeutral * (BG_K_COLOR / BG_K_NEUTRAL)
  if (sat < NEUTRAL_SAT) {
    // 白/浅灰底 → 系统深灰观感（默认 ≈#1C1C1C），不死黑
    out[0] = r * kNeutral
    out[1] = g * kNeutral
    out[2] = b * kNeutral
    return
  }
  const dr = r * kColor + BG_OFF
  const dg = g * kColor + BG_OFF
  const db = b * kColor + BG_OFF
  const gray = 0.299 * dr + 0.587 * dg + 0.114 * db
  out[0] = dr + (gray - dr) * _bgFade
  out[1] = dg + (gray - dg) * _bgFade
  out[2] = db + (gray - db) * _bgFade
}

/**
 * 从四边向内「区域生长」，把与边缘平滑连通的整块区域认成底色。
 * 解决纯颜色判定搞不定的情况：渐变底的远端（离参考色很远但和边缘平滑相连）、
 * 以及低对比玻璃风图标（如 Messages 的浅薄荷底）。被明显边界围住的形状（白气泡、logo）吃不进去。
 * 半分辨率跑，够快；边缘细节仍由 LUT 权重过渡。
 */
function growBackgroundMask(width: number, height: number, px: Uint8Array, lut: Uint8Array) {
  const w2 = Math.ceil(width / MASK_STEP)
  const h2 = Math.ceil(height / MASK_STEP)
  const cells = w2 * h2
  const colors = new Uint8Array(cells * 3)
  const usable = new Uint8Array(cells)
  // 每格内部的通道极差（判断这格是不是含边缘过渡）
  const spread = new Uint8Array(cells)
  for (let cy = 0; cy < h2; cy++) {
    const y1 = Math.min(height, (cy + 1) * MASK_STEP)
    for (let cx = 0; cx < w2; cx++) {
      const x1 = Math.min(width, (cx + 1) * MASK_STEP)
      let sr = 0
      let sg = 0
      let sb = 0
      let opaque = 0
      let n = 0
      let minR = 255
      let maxR = 0
      let minG = 255
      let maxG = 0
      let minB = 255
      let maxB = 0
      for (let y = cy * MASK_STEP; y < y1; y++) {
        let i = (y * width + cx * MASK_STEP) * 4
        for (let x = cx * MASK_STEP; x < x1; x++, i += 4) {
          n++
          if (px[i + 3] < 128) continue
          sr += px[i]
          sg += px[i + 1]
          sb += px[i + 2]
          if (px[i] < minR) minR = px[i]
          if (px[i] > maxR) maxR = px[i]
          if (px[i + 1] < minG) minG = px[i + 1]
          if (px[i + 1] > maxG) maxG = px[i + 1]
          if (px[i + 2] < minB) minB = px[i + 2]
          if (px[i + 2] > maxB) maxB = px[i + 2]
          opaque++
        }
      }
      const c = cy * w2 + cx
      if (opaque * 2 < n) continue
      usable[c] = 1
      colors[c * 3] = sr / opaque
      colors[c * 3 + 1] = sg / opaque
      colors[c * 3 + 2] = sb / opaque
      const sp = Math.max(maxR - minR, maxG - minG, maxB - minB)
      spread[c] = sp > 255 ? 255 : sp
    }
  }
  const weightOf = (c: number) => {
    const key =
      ((colors[c * 3] >> 3) << 10) | ((colors[c * 3 + 1] >> 3) << 5) | (colors[c * 3 + 2] >> 3)
    return lut[key] / 255
  }
  /** 格子平均亮度：掩码生长时用来挡住「比底色明显更暗」的区域（投影 / 深色主体） */
  const lumOf = (c: number) =>
    0.299 * colors[c * 3] + 0.587 * colors[c * 3 + 1] + 0.114 * colors[c * 3 + 2]
  let seedLum = 0
  const mask = new Uint8Array(cells)
  const queue = new Int32Array(cells)
  let head = 0
  let tail = 0
  const seed = (cx: number, cy: number) => {
    const c = cy * w2 + cx
    if (!usable[c] || mask[c]) return
    if (spread[c] > MASK_SPREAD_MAX) return
    if (weightOf(c) > MASK_SEED_W) return
    mask[c] = 1
    queue[tail++] = c
    const l = lumOf(c)
    if (l > seedLum) seedLum = l
  }
  for (let cx = 0; cx < w2; cx++) {
    seed(cx, 0)
    seed(cx, h2 - 1)
  }
  for (let cy = 0; cy < h2; cy++) {
    seed(0, cy)
    seed(w2 - 1, cy)
  }
  if (tail === 0) return null
  const near = (a: number, b: number) => {
    const i = a * 3
    const j = b * 3
    for (let k = 0; k < 3; k++) {
      if (Math.abs(colors[i + k] - colors[j + k]) > MASK_DELTA) return false
    }
    return true
  }
  let masked = tail
  while (head < tail) {
    const c = queue[head++]
    const cx = c % w2
    const cy = (c - cx) / w2
    for (let k = 0; k < 4; k++) {
      const nx = cx + (k === 0 ? -1 : k === 1 ? 1 : 0)
      const ny = cy + (k === 2 ? -1 : k === 3 ? 1 : 0)
      if (nx < 0 || ny < 0 || nx >= w2 || ny >= h2) continue
      const q = ny * w2 + nx
      if (mask[q] || !usable[q] || spread[q] > MASK_SPREAD_MAX || !near(c, q)) continue
      // 比底色明显更暗的格子不吃（柔和的投影 / 深色主体）：吃掉就会看起来「图案缺了一块」。
      // 暗底图标不能用比例判（底色只有 25 时「×0.7」只剩 17，什么都护不住）→ 再看绝对亮度差
      const qLum = lumOf(q)
      if (qLum < seedLum * DARK_STOP_K || qLum < seedLum - DARK_STOP_ABS) continue
      mask[q] = 1
      queue[tail++] = q
      masked++
    }
  }
  let usableCount = 0
  for (let c = 0; c < cells; c++) if (usable[c]) usableCount++
  // 整图几乎全被吃掉（照片类图标）→ 不用 mask，回退到参考色判定
  if (usableCount > 0 && masked / usableCount > MASK_MAX_SHARE) return null
  return { mask, w2 }
}

/** 处理第 y0~y1 行：背景压深、主体保留（深色主体提亮），边缘按权重平滑过渡 */
function transformRows(
  px: Uint8Array,
  width: number,
  height: number,
  y0: number,
  y1: number,
  lut: Uint8Array,
  bgMask: Uint8Array | null,
  bgW2: number,
) {
  const denom = Math.max(1, height - 1)
  const cellsY = Math.ceil(height / MASK_STEP)
  // 下面这些只跟底色基准色有关（与具体像素无关）——以前写在像素循环最里面，
  // 每个像素都要重算 max/min/除法与两个乘加，是整条管线里最贵的浪费。提到循环外只算一次。
  const bgMax = Math.max(_bgRefR, _bgRefG, _bgRefB)
  const bgMin = Math.min(_bgRefR, _bgRefG, _bgRefB)
  const bgSat = bgMax > 0 ? (bgMax - bgMin) / bgMax : 0
  const shadowOn = !_swap && _bgRefLum > 0 && bgSat < SHADOW_BG_SAT_MAX
  const shadowDarkBg = _bgRefLum < DARK_BG_MAX
  const shadowLo = shadowDarkBg ? _bgRefLum : _bgRefLum * SHADOW_DARK_LO
  const shadowHi = shadowDarkBg ? _bgRefLum * SHADOW_LUM_K + SHADOW_LUM_ADD : _bgRefLum * SHADOW_DARK_HI
  for (let y = y0; y < y1; y++) {
    let i = y * width * 4
    const maskRow = bgMask ? (y >> MASK_SHIFT) * bgW2 : 0
    const my = y >> MASK_SHIFT
    // 竖向渐变：顶亮底暗（苹果暗色图标底色的微渐变）
    const m = _bgGrad > 0 ? 1 + _bgGrad * (1 - (2 * y) / denom) : 1
    for (let x = 0; x < width; x++, i += 4) {
      if (px[i + 3] === 0) continue
      // 「背景原色」：整张图统一只盖一层深灰半透明遮罩 —— 不改色相、不压背景、不清理投影，
      // 原来是什么颜色就还是什么颜色，只是整体蒙层灰、暗一点（用户定义）。
      // 遮罩浓度跟「背景灰化」走、灰的深浅跟「背景明度」走（默认 18% / #1C1C1C）。
      if (_keepBg) {
        const inv = 1 - _bgFade
        const add = _bgGray * _bgFade
        px[i] = px[i] * inv + add
        px[i + 1] = px[i + 1] * inv + add
        px[i + 2] = px[i + 2] * inv + add
        continue
      }
      // 灰调（低饱和）且亮度落在「底色附近的灰阶带」里的像素＝投影/底座/灰阶阴影 → 直接按底色吃掉。
      // 参照图里这些区域是与底色融为一体的；不提亮它们，就不会在深底或亮底上留一块灰斑。
      // 带外一律不动：比底色亮的是白/浅色图案，比下限暗的是黑色图案，都不受影响。
      // 1.4.163：再加一道「必须属于背景区域」的限制 —— 这条规则跑在底色分类之前，
      // 原先会把图案内部的浅色/高光/扇区边界（如转盘上的浅色块）当投影一块块吃掉，
      // 在暗色下就是图案上几道黑斑（用户报「常规情况不要改内圈图标」）。
      // 投影/底座本来就长在背景上（掩码内），不受影响；没有掩码时保持原行为。
      if (shadowOn && (bgMask ? bgMask[maskRow + (x >> MASK_SHIFT)] === 1 : true)) {
        const mx2 = Math.max(px[i], px[i + 1], px[i + 2])
        const mn2 = Math.min(px[i], px[i + 1], px[i + 2])
        const sat2 = mx2 > 0 ? (mx2 - mn2) / mx2 : 0
        // 只在「中性底色」（白/灰/黑）上才做（底色是否中性已提到循环外算一次）：底色带颜色时，
        // 银色暗部的亮度也落在同一个带里，被换成底色就会「银色变蓝」
        if (sat2 < SHADOW_SAT) {
          const lum2 = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
          if (lum2 >= shadowLo && lum2 <= shadowHi) {
            // 先把像素换成底色本身的颜色，再按底色处理：否则带一点色相的投影/投影会被
            // 当成「彩色底色」（只乘 BG_K_COLOR 0.26）而周围中性底色乘 0.11，两者不等 → 留下淡斑/残边
            px[i] = _bgRefR
            px[i + 1] = _bgRefG
            px[i + 2] = _bgRefB
            tonePixel(px, i, 0, m)
            continue
          }
        }
      }
      // 比底色明显更暗的像素（柔和的投影 / 深色主体）直接当主体提亮：
      // 它们的颜色与底色相近，LUT 权重会算出 0，不当心就会被当底色压掉 → 看起来「图案缺一块」
      if (!_swap && _bgRefLum > 0 && 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2] < _bgRefLum * DARK_SUBJECT_K) {
        // 不提亮（glyphTune 会把近黑翻成近白），只轻压暗
        keepDim(px, i, m)
        continue
      }
      // 「外圈刷黑」：只动外圈，图案内部**一个像素都不改**。
      // 「外圈」= 从画布四边沿底色泛洪得到的那片（_bgReach）∪ 底色掩码内的像素
      //（掩码能盖住泛洪因色差停下而漏掉的稍深底色，如投影/底座）；
      // 其余像素直接 continue 跳出整条处理链路：不参与 LUT 权重混合，所以图案边缘不会被压暗
      if (_swapKeepArt) {
        const inMask = bgMask ? bgMask[maskRow + (x >> MASK_SHIFT)] === 1 : false
        const reach = _bgReach ? _bgReach[y * width + x] === 1 : false
        if (inMask || reach) {
          px[i] = SWAP_BG
          px[i + 1] = SWAP_BG
          px[i + 2] = SWAP_BG
        }
        continue
      }
      const key = ((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3)
      if (bgMask) {
        const mx = x >> MASK_SHIFT
        if (bgMask[maskRow + mx]) {
          // 与四边平滑连通 ⇒ 底色
          tonePixel(px, i, 0, m)
          continue
        }
        const w = lut[key] / 255
        // 紧贴底色外侧的半透明抗锯齿像素（图标外缘那圈 AA）直接按底色处理：它们本来是
        // 「图案色×底色」的混色，被当成图案提亮后会在深底上留一圈发亮的描边。
        // 只对 alpha<250 的外缘像素生效，不碰图案内部的实心区域。
        // 亮底图标（如白底）额外放宽到 alpha=255：图案与「图标内部底色」交界那圈 AA
        // 同样会被提亮成白色/一明一暗的颗粒，看起来边缘毛糙——只要它离底色格很近且权重<0.6
        // （本身就更像底色）就并入底色。暗底图标保持原来的 alpha<250，不动 1.4.139~1.4.142 的深色保护
        const edgeBg =
          (px[i + 3] < 250 || _bgRefLum >= DARK_BG_MAX) &&
          w < 0.6 &&
          ((mx > 0 && bgMask[maskRow + mx - 1] === 1) ||
            (mx < bgW2 - 1 && bgMask[maskRow + mx + 1] === 1) ||
            (my > 0 && bgMask[(my - 1) * bgW2 + mx] === 1) ||
            (my < cellsY - 1 && bgMask[(my + 1) * bgW2 + mx] === 1))
        if (edgeBg) {
          tonePixel(px, i, 0, m)
          continue
        }
        // 亮底图标：图案与底色交界那圈抗锯齿像素，只要「紧贴底色格」且「颜色离底色很近」就并入底色。
        // 这类像素本来是「图案色×底色」的混色，留在深底上就是白色细边/一明一暗的颗粒感（用户报「边缘毛糙」）。
        // 只限紧贴底色格（约2px）+ 颜色距底色 < 0.34：图案内部、饱和图案本体都不会被吃掉
        if (
          _bgRefLum >= DARK_BG_MAX &&
          _bgRefR >= 0 &&
          ((mx > 0 && bgMask[maskRow + mx - 1] === 1) ||
            (mx < bgW2 - 1 && bgMask[maskRow + mx + 1] === 1) ||
            (my > 0 && bgMask[(my - 1) * bgW2 + mx] === 1) ||
            (my < cellsY - 1 && bgMask[(my + 1) * bgW2 + mx] === 1) ||
            (mx > 1 && bgMask[maskRow + mx - 2] === 1) ||
            (mx < bgW2 - 2 && bgMask[maskRow + mx + 2] === 1) ||
            (my > 1 && bgMask[(my - 2) * bgW2 + mx] === 1) ||
            (my < cellsY - 2 && bgMask[(my + 2) * bgW2 + mx] === 1))
        ) {
          const dr = px[i] - _bgRefR
          const dg = px[i + 1] - _bgRefG
          const db = px[i + 2] - _bgRefB
          if (dr * dr + dg * dg + db * db < RIM_DIST * RIM_DIST * 441.67 * 441.67) {
            px[i] = _bgRefR
            px[i + 1] = _bgRefG
            px[i + 2] = _bgRefB
            tonePixel(px, i, 0, m)
            continue
          }
        }
        if (w === 0) {
          // 暗底图标：没被掩码吃掉的「与底色相近但暗」的像素基本是投影/暗部，
          // 压成底色就会看起来「图案缺一块」→ 按主体轻度提亮
          if (!_swap && _bgRefLum > 0 && _bgRefLum < DARK_BG_MAX) {
            keepDim(px, i, m)
            continue
          }
          // 没被掩码吃掉、但颜色和底色一样 ⇒ 被 logo 围住的内部区域：
          // 近白的是「故意留白的元素」保留，其余（如 Spotify 三段弧、镜头孔）当底色压深
          const maxC = Math.max(px[i], px[i + 1], px[i + 2])
          const minC = Math.min(px[i], px[i + 1], px[i + 2])
          const sat = maxC > 0 ? (maxC - minC) / maxC : 0
          tonePixel(px, i, maxC / 255 >= ENCLOSED_WHITE_V && sat <= ENCLOSED_WHITE_SAT ? 1 : 0, m)
          continue
        }
        tonePixel(px, i, w, m)
        continue
      }
      // 暗底图标：没被掩码吃掉、又和底色同色的像素基本是投影/暗部 → 提亮保留
      // （掩码存在才敢这么判：掩码不存在时无法区分底色与暗部）
      if (!_swap && bgMask != null && _bgRefLum > 0 && _bgRefLum < DARK_BG_MAX && lut[key] === 0) {
        keepDim(px, i, m)
        continue
      }
      tonePixel(px, i, lut[key] / 255, m)
    }
  }
}

/**
 * zlib 流（全用「存储块」deflate）——PNG 的 IDAT 必须是真的 zlib，
 * 而 Scripting 的 Data.compressed("zlib") 实际产出的是 LZFSE 帧，所以自己封。
 * 体积无所谓：这张 PNG 只作为中间产物喂给 UIImage.fromData，导出时由系统重新编码。
 */
function zlibStored(raw: Uint8Array) {
  const MAX = 65535
  const blocks = Math.max(1, Math.ceil(raw.length / MAX))
  const out = new Uint8Array(2 + blocks * 5 + raw.length + 4)
  out[0] = 0x78
  out[1] = 0x01
  let o = 2
  for (let i = 0; i < blocks; i++) {
    const start = i * MAX
    const len = Math.min(MAX, raw.length - start)
    out[o] = i === blocks - 1 ? 1 : 0
    out[o + 1] = len & 0xff
    out[o + 2] = (len >>> 8) & 0xff
    out[o + 3] = ~len & 0xff
    out[o + 4] = (~len >>> 8) & 0xff
    out.set(raw.subarray(start, start + len), o + 5)
    o += 5 + len
  }
  const ad = adler32(raw)
  out[o] = (ad >>> 24) & 0xff
  out[o + 1] = (ad >>> 16) & 0xff
  out[o + 2] = (ad >>> 8) & 0xff
  out[o + 3] = ad & 0xff
  return out
}

function writeChunk(file: Uint8Array, offset: number, type: string, data: Uint8Array) {
  const dv = new DataView(file.buffer, file.byteOffset)
  dv.setUint32(offset, data.length)
  for (let i = 0; i < 4; i++) file[offset + 4 + i] = type.charCodeAt(i)
  file.set(data, offset + 8)
  dv.setUint32(offset + 8 + data.length, crc32(file.subarray(offset + 4, offset + 8 + data.length), 4 + data.length))
}

/** 扫描线（已含每行 filter 字节）→ PNG 文件字节 */
function encodePNG(width: number, height: number, rawScan: Uint8Array) {
  const idat = zlibStored(rawScan)
  const ihdr = new Uint8Array(13)
  const idv = new DataView(ihdr.buffer)
  idv.setUint32(0, width)
  idv.setUint32(4, height)
  ihdr[8] = 8
  ihdr[9] = 6
  const file = new Uint8Array(8 + (12 + 13) + (12 + idat.length) + 12)
  const sig = [137, 80, 78, 71, 13, 10, 26, 10]
  for (let i = 0; i < 8; i++) file[i] = sig[i]
  writeChunk(file, 8, "IHDR", ihdr)
  writeChunk(file, 8 + 12 + 13, "IDAT", idat)
  writeChunk(file, 8 + 12 + 13 + 12 + idat.length, "IEND", new Uint8Array(0))
  return file
}

/** 全图「主体色」：不透明像素里按饱和度加权的平均色（微信这种得到绿）。
 *  图里没有有彩色时，退回「非底色」像素的平均色（灰阶图标 → 灰/白）。用于「颜色对调」的图案色。 */
function dominantAccent(px: Uint8Array, lut: Uint8Array | null): [number, number, number] {
  let sr = 0
  let sg = 0
  let sb = 0
  let sw = 0
  let ar = 0
  let ag = 0
  let ab = 0
  let an = 0
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 200) continue
    const r = px[i]
    const g = px[i + 1]
    const b = px[i + 2]
    const maxC = r > g ? (r > b ? r : b) : g > b ? g : b
    const minC = r < g ? (r < b ? r : b) : g < b ? g : b
    const sat = maxC > 0 ? (maxC - minC) / maxC : 0
    if (sat > 0.25) {
      sr += r * sat
      sg += g * sat
      sb += b * sat
      sw += sat
    }
    if (!lut) {
      ar += r
      ag += g
      ab += b
      an++
    } else {
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
      if (lut[key] > 76) continue // > 0.3：算底色，不计入主体
      ar += r
      ag += g
      ab += b
      an++
    }
  }
  if (sw > 0) return [sr / sw, sg / sw, sb / sw]
  if (an > 0) return [ar / an, ag / an, ab / an]
  return [255, 255, 255]
}

/** 「相近且连通」的颜色归一（区域平均）：把「颜色相近 + 四邻连通」的像素并成一片，
 *  整片用同一个平均色。这样同一片颜色在暗色下会**统一变色**，
 *  不会一块深一块浅；区域内部的噪声/轻微色差（JPEG 块班）也会被抹平，不再有颗粒感。
 *  但**真正的渐变**（每像素只差几级、连续变）不能被抹：一片里色差跨度超过
 *  REGION_FLAT_MAX 时就当作渐变，整片原样保留（只抹平噪声那种紧凑的微差）。 */
const REGION_TOL = 10
/** 一片内各通道色差跨度 ≤ 这个值才认为是「同一色 + 噪声」，才做整片平均；
 *  超过就当成真渐变，整片不碰（否则平滑的玻璃/渐变会被切成一条条色带） */
const REGION_FLAT_MAX = 8
function regionAverage(px: Uint8Array, width: number, height: number) {
  const n = width * height
  const out = new Uint8Array(px.length)
  out.set(px)
  const label = new Int32Array(n).fill(-1)
  const stack = new Int32Array(n)
  let regions = 0
  for (let s = 0; s < n; s++) {
    if (label[s] >= 0) continue
    const sp0 = s * 4
    if (px[sp0 + 3] === 0) {
      label[s] = -2 // 全透明像素不参与
      continue
    }
    const r0 = px[sp0]
    const g0 = px[sp0 + 1]
    const b0 = px[sp0 + 2]
    const id = regions++
    let sp = 0
    stack[sp++] = s
    label[s] = id
    while (sp > 0) {
      const cur = stack[--sp]
      const cx = cur % width
      const cy = (cur / width) | 0
      // 四邻：颜色与「种子像素」相差不超过 REGION_TOL 就算同一片
      if (cx > 0) {
        const q = cur - 1
        if (label[q] === -1) {
          const p = q * 4
          if (
            px[p + 3] > 0 &&
            Math.abs(px[p] - r0) <= REGION_TOL &&
            Math.abs(px[p + 1] - g0) <= REGION_TOL &&
            Math.abs(px[p + 2] - b0) <= REGION_TOL
          ) {
            label[q] = id
            stack[sp++] = q
          }
        }
      }
      if (cx < width - 1) {
        const q = cur + 1
        if (label[q] === -1) {
          const p = q * 4
          if (
            px[p + 3] > 0 &&
            Math.abs(px[p] - r0) <= REGION_TOL &&
            Math.abs(px[p + 1] - g0) <= REGION_TOL &&
            Math.abs(px[p + 2] - b0) <= REGION_TOL
          ) {
            label[q] = id
            stack[sp++] = q
          }
        }
      }
      if (cy > 0) {
        const q = cur - width
        if (label[q] === -1) {
          const p = q * 4
          if (
            px[p + 3] > 0 &&
            Math.abs(px[p] - r0) <= REGION_TOL &&
            Math.abs(px[p + 1] - g0) <= REGION_TOL &&
            Math.abs(px[p + 2] - b0) <= REGION_TOL
          ) {
            label[q] = id
            stack[sp++] = q
          }
        }
      }
      if (cy < height - 1) {
        const q = cur + width
        if (label[q] === -1) {
          const p = q * 4
          if (
            px[p + 3] > 0 &&
            Math.abs(px[p] - r0) <= REGION_TOL &&
            Math.abs(px[p + 1] - g0) <= REGION_TOL &&
            Math.abs(px[p + 2] - b0) <= REGION_TOL
          ) {
            label[q] = id
            stack[sp++] = q
          }
        }
      }
    }
  }
  // 每片求平均色，再整片写回去
  const sumR = new Float64Array(regions)
  const sumG = new Float64Array(regions)
  const sumB = new Float64Array(regions)
  const sumA = new Float64Array(regions)
  const cnt = new Int32Array(regions)
  // 每片各通道的最小/最大值：用来判断这片是「同一色 + 噪声」还是「真渐变」
  const minR = new Float64Array(regions).fill(255)
  const minG = new Float64Array(regions).fill(255)
  const minB = new Float64Array(regions).fill(255)
  const maxR = new Float64Array(regions)
  const maxG = new Float64Array(regions)
  const maxB = new Float64Array(regions)
  for (let k = 0; k < n; k++) {
    const l = label[k]
    if (l < 0) continue
    const p = k * 4
    sumR[l] += px[p]
    sumG[l] += px[p + 1]
    sumB[l] += px[p + 2]
    sumA[l] += px[p + 3]
    cnt[l]++
    if (px[p] < minR[l]) minR[l] = px[p]
    if (px[p] > maxR[l]) maxR[l] = px[p]
    if (px[p + 1] < minG[l]) minG[l] = px[p + 1]
    if (px[p + 1] > maxG[l]) maxG[l] = px[p + 1]
    if (px[p + 2] < minB[l]) minB[l] = px[p + 2]
    if (px[p + 2] > maxB[l]) maxB[l] = px[p + 2]
  }
  for (let k = 0; k < n; k++) {
    const l = label[k]
    if (l < 0) continue
    // 跨度太大 = 真渐变：整片保持原样，绝不平均（否则渐变会被切成色带）
    if (
      maxR[l] - minR[l] > REGION_FLAT_MAX ||
      maxG[l] - minG[l] > REGION_FLAT_MAX ||
      maxB[l] - minB[l] > REGION_FLAT_MAX
    ) {
      continue
    }
    const p = k * 4
    const c = cnt[l] || 1
    out[p] = Math.round(sumR[l] / c)
    out[p + 1] = Math.round(sumG[l] / c)
    out[p + 2] = Math.round(sumB[l] / c)
    out[p + 3] = Math.round(sumA[l] / c)
  }
  return out
}

/** 「颜色对调」是否可用：**中间图形接近白色**（≥半数像素三通道都 ≥190）且**外面是彩色**。
 *  只有这种图标对调后才有「黑底 + 亮色图案」的意义（如微信：白气泡 + 绿底）；
 *  中间图形本身有色（如白底 + 绿 logo）就不该给这个开关。
 *  中间图形 = 不在底色掩码里的不透明像素（掩码是「贴着画布外沿长进来的底色」）。 */
function swapUsable(orig: Uint8Array, width: number, height: number) {
  // ① 采「外圈颜色」＝图标最外两圈不透明像素的均值
  let n = 0
  let sr = 0
  let sg = 0
  let sb = 0
  const band = Math.max(1, Math.round(Math.min(width, height) * 0.01))
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      if (x >= band && x < width - band && y >= band && y < height - band) continue
      const i = (y * width + x) * 4
      if (orig[i + 3] === 0) continue
      sr += orig[i]
      sg += orig[i + 1]
      sb += orig[i + 2]
      n++
    }
  }
  if (n < 8) return false
  const br = sr / n
  const bgc = sg / n
  const bb = sb / n
  // ② 外面必须是「彩色」（白/灰/黑底不算）
  const bgMax = Math.max(br, bgc, bb)
  const bgMin = Math.min(br, bgc, bb)
  if (bgMax <= 0 || (bgMax - bgMin) / bgMax < 0.15) return false
  // ③ 中间图形（离外圈颜色足够远）里，三通道都 ≥190 的像素要占一半以上
  let art = 0
  let white = 0
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4
      if (orig[i + 3] === 0) continue
      const d = Math.max(
        Math.abs(orig[i] - br),
        Math.abs(orig[i + 1] - bgc),
        Math.abs(orig[i + 2] - bb),
      ) / 255
      if (d <= 0.15) continue // 算底色，不算中间图形
      art++
      if (Math.min(orig[i], orig[i + 1], orig[i + 2]) >= 190) white++
    }
  }
  if (art < 16) return false
  return white / art >= 0.5
}

/** 抽样求不透明内容包围盒 + 不透明像素占比 */
function contentBox(data: Uint8Array, w: number, h: number, step: number) {
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1
  let opaque = 0
  let total = 0
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const a = data[(y * w + x) * 4 + 3]
      total++
      if (a > 250) {
        opaque++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return { minX, minY, maxX, maxY, opaqueRatio: opaque / Math.max(1, total) }
}

/** 按内容框裁剪 + 双线性缩放到 out×out（保留 alpha） */
function cropAndScale(data: Uint8Array, w: number, h: number, out: number, box: ReturnType<typeof contentBox>) {
  const cx = (box.minX + box.maxX) / 2
  const cy = (box.minY + box.maxY) / 2
  const side = Math.max(1, Math.min(box.maxX - box.minX + 1, box.maxY - box.minY + 1, Math.min(w, h)))
  const sx = cx - side / 2
  const sy = cy - side / 2
  const dst = new Uint8Array(out * out * 4)
  for (let y = 0; y < out; y++) {
    for (let x = 0; x < out; x++) {
      const fx = sx + ((x + 0.5) * side) / out - 0.5
      const fy = sy + ((y + 0.5) * side) / out - 0.5
      const x0 = Math.max(0, Math.min(w - 1, Math.floor(fx)))
      const y0 = Math.max(0, Math.min(h - 1, Math.floor(fy)))
      const x1 = Math.min(w - 1, x0 + 1)
      const y1 = Math.min(h - 1, y0 + 1)
      const tx = Math.max(0, Math.min(1, fx - x0))
      const ty = Math.max(0, Math.min(1, fy - y0))
      const w00 = (1 - tx) * (1 - ty)
      const w10 = tx * (1 - ty)
      const w01 = (1 - tx) * ty
      const w11 = tx * ty
      const o = (y * out + x) * 4
      for (let k = 0; k < 4; k++) {
        const v =
          data[(y0 * w + x0) * 4 + k] * w00 +
          data[(y0 * w + x1) * 4 + k] * w10 +
          data[(y1 * w + x0) * 4 + k] * w01 +
          data[(y1 * w + x1) * 4 + k] * w11
        dst[o + k] = Math.max(0, Math.min(255, Math.round(v)))
      }
    }
  }
  return dst
}

/**
 * App 图标自适应：不少 mzstatic 图标「图案只占中间 ~80%、四周一圈透明留白」，
 * 直接跑暗色算法会让边缘采样全落在透明区（外圈刷黑/投影清理都失效）。
 * 这里按 alpha 内容框裁掉留白再拉满到 out×out；内容已满幅的图标只做缩略图，不做插值。
 * 返回 null 表示无法处理（调用方回退原图）。
 */
export async function normalizeIconCanvas(image: UIImage, out: number): Promise<UIImage | null> {
  const pd = image.getPixelData()
  if (!pd) return null
  const data = pd.data.toUint8Array()
  if (!data || data.length < pd.width * pd.height * 4) return null
  const step = Math.max(1, Math.round(Math.max(pd.width, pd.height) / 128))
  const box = contentBox(data, pd.width, pd.height, step)
  // 全透明（或几乎全透明）：没有可裁的内容，原样返回
  if (box.maxX < 0 || box.maxY < 0) return image
  if (box.opaqueRatio > 0.985) {
    if (pd.width <= out && pd.height <= out) return image
    return image.preparingThumbnail({ width: out, height: out }) ?? image
  }
  const rgba = cropAndScale(data, pd.width, pd.height, out, box)
  const stride = out * 4 + 1
  const raw = new Uint8Array(stride * out)
  for (let y = 0; y < out; y++) {
    raw[y * stride] = 0
    raw.set(rgba.subarray(y * out * 4, (y + 1) * out * 4), y * stride + 1)
  }
  try {
    const encoded = Data.fromUint8Array(encodePNG(out, out, raw))
    return encoded ? UIImage.fromData(encoded) : null
  } catch {
    return null
  }
}

/**
 * 「准备」阶段：读像素 + 找背景参考色 + 建查找表 + 区域生长掩码。
 * 这些都只和图片本身有关、**与微调参数无关**，所以可以缓存复用：
 * 拖动滑块时只需重跑 renderDarkIcon（预览尺寸下约 20ms）。
 */
export async function prepareDarkIcon(src: UIImage): Promise<DarkIconPlan | null> {
  const pd = src.getPixelData()
  const orig = pd ? pd.data.toUint8Array() : null
  if (!pd || !orig) return null
  const width = pd.width
  const height = pd.height
  if (!width || !height) return null
  const refs = backgroundRefs(width, height, orig)
  if (refs.length === 0) {
    return {
      orig: regionAverage(orig, width, height),
      width,
      height,
      lut: null,
      mask: null,
      w2: 0,
      accent: null,
      swapOk: false,
    }
  }
  const lut = buildWeightLUT(refs, isColoredBackground(refs))
  await yieldFrame()
  const grown = growBackgroundMask(width, height, orig, lut)
  // 「相近且连通」的颜色归一：后续所有变换用统一后的颜色，同一片颜色就会统一变色
  await yieldFrame()
  const flat = regionAverage(orig, width, height)
  return {
    orig: flat,
    width,
    height,
    lut,
    mask: grown ? grown.mask : null,
    w2: grown ? grown.w2 : 0,
    accent: dominantAccent(orig, lut),
    swapOk: swapUsable(orig, width, height),
  }
}

/** 渲染串行队列：算法内部用模块级参数暂存，预览与导出必须一前一后跑，
 *  否则 1024 导出在分片让出时会被预览重渲改掉参数（颜色/模式错乱）。 */
let renderQueue: Promise<unknown> = Promise.resolve()

/**
 * 「渲染」阶段：按当前微调参数把像素跑一遍，再编成 UIImage。
 * onProgress: 0~1，用于界面提示进度。
 */
async function renderDarkIconNow(
  plan: DarkIconPlan,
  options?: DarkIconOptions,
  onProgress?: (progress: number) => void,
): Promise<UIImage | null> {
  applyOptions(options)
  // 「颜色对调」的图案色：全图主体色（提亮/饱和增强照旧走 glyphTune），每次渲染算一次
  const acc = plan.accent ?? [255, 255, 255]
  const accOut = [0, 0, 0]
  glyphTune(acc[0], acc[1], acc[2], accOut)
  _swapFgR = accOut[0]
  _swapFgG = accOut[1]
  _swapFgB = accOut[2]
  const { width, height } = plan
  // 每次渲染都在原始像素上重做（微调参数会反复渲染）
  const px = plan.orig.slice()
  // 底色基准亮度：取画布最外圈不透明像素的平均亮度（正常情况下那圈就是底色）。
  // 用来把「比底色明显更暗」的投影/深色主体护下来，不让它们被当成底色压掉
  {
    const o = plan.orig
    const w = width
    const h = height
    let sum = 0
    let sumR = 0
    let sumG = 0
    let sumB = 0
    let cnt = 0
    const take = (p: number) => {
      if (o[p + 3] < 128) return
      sum += 0.299 * o[p] + 0.587 * o[p + 1] + 0.114 * o[p + 2]
      sumR += o[p]
      sumG += o[p + 1]
      sumB += o[p + 2]
      cnt++
    }
    for (let x = 0; x < w; x++) {
      take(x * 4)
      take(((h - 1) * w + x) * 4)
    }
    for (let y = 0; y < h; y++) {
      take(y * w * 4)
      take((y * w + w - 1) * 4)
    }
    _bgRefLum = cnt > 0 ? sum / cnt : 0
    _bgRefR = cnt > 0 ? Math.round(sumR / cnt) : -1
    _bgRefG = cnt > 0 ? Math.round(sumG / cnt) : -1
    _bgRefB = cnt > 0 ? Math.round(sumB / cnt) : -1
  }
  // 「外圈刷黑」：图案保持原样、不换色，所以把「补图案色」用的参考色改回底色本身 ——
  // 这样被刷黑又不与外界连通的封闭底色块（图案内部的镂空）会还原成原来的底色，而不是被染成别的颜色
  if (_swapKeepArt) {
    _swapFgR = _bgRefR >= 0 ? _bgRefR : SWAP_BG
    _swapFgG = _bgRefG >= 0 ? _bgRefG : SWAP_BG
    _swapFgB = _bgRefB >= 0 ? _bgRefB : SWAP_BG
  }
  // 「外圈刷黑」：算出「从画布四边沿底色泛洪」得到的外圈底色图 —— 只有它（和底色掩码）内的像素
  // 才允许被刷黑，图案内部一个像素都不动（所以图案边缘不会被权重混合压暗成黑环）
  if (_swapKeepArt) {
    _bgReach = reachFromEdge(
      plan.orig,
      width,
      height,
      BGBLACK_STEP,
      _bgRefR >= 0 ? _bgRefR : 255,
      _bgRefG >= 0 ? _bgRefG : 255,
      _bgRefB >= 0 ? _bgRefB : 255,
      BGBLACK_TOL,
    )
  }
  if (plan.lut) {
    // 区域生长：把与四边平滑连通的整块区域（含渐变远端）都算底色
    const lut = plan.lut
    // 分片让出主线程（实测每次让出 ≈ 150ms！）—— 小图绝对别分，只有原尺寸（≥1024）才真分片
    const heavy = Math.max(width, height) > 640
    const band = heavy ? Math.max(8, Math.ceil(height / 12)) : height
    for (let y = 0; y < height; y += band) {
      const y1 = Math.min(y + band, height)
      transformRows(px, width, height, y, y1, lut, plan.mask, plan.w2)
      onProgress?.(0.8 * (y1 / height))
      if (heavy) await yieldFrame()
    }
    // 「颜色对调」：底色刷成近黑后，把不与画布边缘连通的底色块补成图案色。
    // 「外圈刷黑」不用它：内部像素压根没被刷黑，跑它反而会把封闭底色块从原色改成「参考底色」（差十几级）
    if (_swap && !_swapKeepArt) fillEnclosedBg(px, width, height)
  }
  // 拼扫描线（每行前面一个 filter 字节 0 = None）
  const rowBytes = width * 4
  const rowStride = rowBytes + 1
  const rawScan = new Uint8Array(rowStride * height)
  const heavy2 = Math.max(width, height) > 640
  const band2 = heavy2 ? Math.max(8, Math.ceil(height / 8)) : height
  for (let y = 0; y < height; y += band2) {
    const y1 = Math.min(y + band2, height)
    for (let r = y; r < y1; r++) {
      rawScan[r * rowStride] = 0
      rawScan.set(px.subarray(r * rowBytes, r * rowBytes + rowBytes), r * rowStride + 1)
    }
    onProgress?.(0.8 + (0.18 * y1) / height)
    if (heavy2) await yieldFrame()
  }
  onProgress?.(0.99)
  let img: UIImage | null = null
  try {
    const data = Data.fromUint8Array(encodePNG(width, height, rawScan))
    img = data ? UIImage.fromData(data) : null
  } catch {
    img = null
  }
  onProgress?.(1)
  return img
}

/** 串行入口：排队到上一个渲染之后，内部状态不会交叉污染 */
export function renderDarkIcon(
  plan: DarkIconPlan,
  options?: DarkIconOptions,
  onProgress?: (progress: number) => void,
): Promise<UIImage | null> {
  const run = () => renderDarkIconNow(plan, options, onProgress)
  const task = renderQueue.then(run, run)
  renderQueue = task.then(
    () => undefined,
    () => undefined,
  )
  return task
}

/** 一步到位（准备 + 渲染）；需要反复微调时用 prepareDarkIcon + renderDarkIcon 更划算 */
export async function makeDarkIcon(
  src: UIImage,
  onProgress?: (progress: number) => void,
  options?: DarkIconOptions,
): Promise<UIImage | null> {
  const plan = await prepareDarkIcon(src)
  if (!plan) return null
  return renderDarkIcon(plan, options, onProgress)
}

