import { Button, Canvas, HStack, Image, ImageRenderer, ProgressView, Rectangle, RoundedRectangle, ScrollView, Text, TextField, VStack, ZStack, useEffect, useRef, useState } from "scripting"
import { safeTimeout } from "../core/guarded"
import { normalizeIconCanvas, prepareDarkIcon, renderDarkIcon, type DarkIconOptions, type DarkIconPlan } from "../core/dark-icon"

/** 图标导出格式：PNG / JPEG（不透明，铺白底）/ HEIF（透明） */
type IconFormat = "png" | "jpeg" | "heic"

/** 把任意 mzstatic 图标 URL（模板或固定尺寸）换成指定尺寸透明 PNG（bf 后缀），
 *  避免拿到 100px 小图或白底图。 */
function iconArtworkUrl(url: string | null | undefined, size: number): string | undefined {
  if (!url) return undefined
  const dim = `${size}x${size}bf.png`
  if (url.includes("{w}x{h}{c}.{f}")) {
    return url.replace("{w}x{h}{c}.{f}", dim)
  }
  return url.replace(/\d+x\d+bb\.\w+/, dim)
}

const CAPSULE_BG = { style: { light: "rgba(120,120,128,0.12)", dark: "rgba(120,120,128,0.18)" } as const, shape: "capsule" as const }
const CAPSULE_BG_SELECTED = { style: { light: "rgba(10,132,255,0.16)", dark: "rgba(10,132,255,0.30)" } as const, shape: "capsule" as const }
/** 效果开关选中态：淡绿色胶囊底 + 实心绿圆 */
const EFFECT_BG_SELECTED = { style: { light: "rgba(52,199,89,0.16)", dark: "rgba(52,199,89,0.26)" } as const, shape: "capsule" as const }
const EFFECT_GREEN = "#34c759"

/** 图标胶囊（与「更新」「说明」「链接」同一行，同款式样）：
 *  点击展开/收起下方的图标面板；箭头与「更新/说明」一致用 180° 旋转过渡。
 *  bare=true：去掉自带背景，嵌入外部大胶囊使用。 */
export function IconPill(props: { expanded: boolean; onToggle: () => void; bare?: boolean; foregroundStyle?: any }) {
  return (
    <Button buttonStyle="plain" action={props.onToggle}>
      <HStack
        spacing={6}
        padding={{ horizontal: 12, vertical: 8 }}
        background={props.bare ? undefined : CAPSULE_BG}
        clipShape={props.bare ? undefined : "capsule"}
      >
        <Image
          systemName="chevron.down"
          font="caption2"
          foregroundStyle={props.foregroundStyle || "secondaryLabel"}
          rotationEffect={props.expanded ? 180 : 0}
          animation={{ animation: Animation.snappy({ duration: 0.42 }), value: props.expanded }}
        />
        <Text font="subheadline" foregroundStyle={props.foregroundStyle || "secondaryLabel"}>图标</Text>
      </HStack>
    </Button>
  )
}

/** 面板内小胶囊：尺寸 / 圆角 / 保存按钮统一大小，视觉协调 */
function MiniPill(props: { selected?: boolean; disabled?: boolean; onTap: () => void; children: any }) {
  return (
    <Button buttonStyle="plain" disabled={props.disabled} action={props.onTap}>
      <HStack
        spacing={4}
        padding={{ horizontal: 9, vertical: 6 }}
        background={props.selected ? CAPSULE_BG_SELECTED : CAPSULE_BG}
        clipShape="capsule"
      >
        {props.children}
      </HStack>
    </Button>
  )
}

/** 效果芯片（外圈刷黑 / 灰色遮罩，互斥）：统一的圆形指示，选中 = 淡绿底 + 实心绿圆 */
function ModeChip(props: { selected: boolean; label: string; onTap: () => void }) {
  return (
    <Button buttonStyle="plain" action={props.onTap}>
      <HStack
        spacing={4}
        padding={{ horizontal: 9, vertical: 6 }}
        background={props.selected ? EFFECT_BG_SELECTED : CAPSULE_BG}
        clipShape="capsule"
      >
        <Image
          systemName={props.selected ? "circle.fill" : "circle"}
          font="caption2"
          foregroundStyle={props.selected ? EFFECT_GREEN : "tertiaryLabel"}
        />
        <Text
          font="caption"
          fontWeight={props.selected ? "semibold" : undefined}
          foregroundStyle={props.selected ? EFFECT_GREEN : "secondaryLabel"}
        >
          {props.label}
        </Text>
      </HStack>
    </Button>
  )
}

const PRESETS = [256, 512, 1024]
/** 暗色预览边长：256 足够 56pt 预览清晰，单次重渲 ~80ms */
const DARK_PREVIEW_PX = 256
/** 算法准备阶段的上限：App Store 图标最高 1024，再大没意义 */
const DARK_MAX_PX = 1024

/** 把「参数快照 key」还原成算法参数（key 用于异步渲染时丢弃过期结果）
 *  key = 外观 | 外圈刷黑 | 灰色遮罩；外观只用于区分缓存，不参与算法参数。 */
function darkOptionsOf(key: string): DarkIconOptions {
  const parts = key.split("|")
  return { bgBlack: Number(parts[1]) === 1, keepBg: Number(parts[2]) === 1 }
}

/** 图标面板：小预览 + 尺寸 + 外观（原图/暗色模拟）+ 圆角/直角 + 保存到相册（仅展开时挂载）。 */
export function IconDownloadPanel(props: {
  url: string | null | undefined
  title: string
}) {
  const [source, setSource] = useState<UIImage | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [px, setPx] = useState(512)
  const [rounded, setRounded] = useState(true)
  /** 自定义像素输入（非空且合法时优先于预设尺寸） */
  const [customText, setCustomText] = useState("")
  /** 保存反馈：成功变「已保存」，失败变「失败」，1.6s 后还原 */
  const [feedback, setFeedback] = useState<{ format: IconFormat; ok: boolean } | null>(null)

  /** 外观：light = 原图；dark = 暗色（本地模拟） */
  const [appearance, setAppearance] = useState<"light" | "dark">("light")
  /** 暗色模式（互斥）：外圈刷黑 / 灰色遮罩；其余参数用算法默认值 */
  const [darkKeepBg, setDarkKeepBg] = useState(false)
  const [darkBgBlack, setDarkBgBlack] = useState(false)
  /** 暗色预览（256px），以及导出时的进度 */
  const [darkPreview, setDarkPreview] = useState<UIImage | null>(null)
  const [darkProgress, setDarkProgress] = useState<number | null>(null)

  /** 预览用的算法计划（只与图片有关，参数变化时复用） */
  const previewPlanRef = useRef<DarkIconPlan | null>(null)
  /** 导出用的按尺寸缓存：同一个尺寸只 prepare 一次 */
  const planCacheRef = useRef<Map<number, DarkIconPlan>>(new Map())
  const previewBusyRef = useRef(false)
  const previewKeyRef = useRef("")

  /** 当前参数快照：async 渲染回来时用它判断是否过期 */
  const darkKey = `${appearance === "dark" ? "d" : "l"}|${darkBgBlack ? 1 : 0}|${darkKeepBg ? 1 : 0}`
  const darkKeyRef = useRef(darkKey)
  darkKeyRef.current = darkKey

  /** 是否需要走图像处理：暗色模拟，或原图叠加了外圈刷黑/灰色遮罩 */
  const effectActive = appearance === "dark" || darkBgBlack || darkKeepBg
  const effectActiveRef = useRef(effectActive)
  effectActiveRef.current = effectActive

  /** 有效尺寸：自定义输入（1–4096）优先，否则用预设 */
  const customPx = parseInt(customText, 10)
  const effectivePx = customText.trim() !== "" && Number.isFinite(customPx) && customPx >= 1
    ? Math.min(4096, customPx)
    : px

  // 挂载时下载原图（1024 透明 PNG）
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const u = iconArtworkUrl(props.url, 1024)
      if (!u) {
        setFailed(true)
        return
      }
      try {
        const img = await UIImage.fromURL(u)
        if (!cancelled) {
          if (img) setSource(img)
          else setFailed(true)
        }
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [props.url])

  useEffect(() => {
    if (!feedback) return
    const timer = safeTimeout(() => setFeedback(null), 1600)
    return () => clearTimeout(timer)
  }, [feedback])

  /** 准备暗色预览计划：只跟图片本身有关，参数变化不用重跑 */
  useEffect(() => {
    let alive = true
    previewPlanRef.current = null
    previewKeyRef.current = ""
    planCacheRef.current.clear()
    setDarkPreview(null)
    if (!source) return
    ;(async () => {
      const normalized = (await normalizeIconCanvas(source, DARK_PREVIEW_PX)) ?? source
      if (!alive) return
      const plan = await prepareDarkIcon(normalized)
      if (!alive || !plan) return
      previewPlanRef.current = plan
      if (effectActiveRef.current) void renderPreview()
    })()
    return () => {
      alive = false
    }
  }, [source])

  /** 外观或模式变化：需要时重渲预览（内部串行、自动追到最新参数） */
  useEffect(() => {
    if (!effectActive) return
    void renderPreview()
  }, [appearance, darkKeepBg, darkBgBlack])

  /** 256px 预览：同一时刻只串行跑一个渲染；参数变了就继续追 */
  async function renderPreview() {
    const plan = previewPlanRef.current
    if (!plan || previewBusyRef.current || !effectActiveRef.current) return
    previewBusyRef.current = true
    try {
      while (true) {
        const key = darkKeyRef.current
        if (previewKeyRef.current === key) break
        const img = await renderDarkIcon(plan, darkOptionsOf(key))
        if (!img) break
        previewKeyRef.current = key
        if (key === darkKeyRef.current) {
          setDarkPreview(img)
          break
        }
      }
    } catch {
      // 预览失败不影响导出
    } finally {
      previewBusyRef.current = false
    }
  }

  /** 导出用的暗色成品：先 prepare 对应尺寸（按尺寸缓存），再按当前参数渲染 */
  async function darkImageFor(targetPx: number): Promise<UIImage | null> {
    const planPx = Math.min(DARK_MAX_PX, Math.max(DARK_PREVIEW_PX, targetPx))
    const key = darkKeyRef.current
    if (planPx === DARK_PREVIEW_PX && previewPlanRef.current) {
      return renderDarkIcon(previewPlanRef.current, darkOptionsOf(key), (p) => setDarkProgress(p))
    }
    let plan = planCacheRef.current.get(planPx)
    if (!plan) {
      if (!source) return null
      const normalized =
        (await normalizeIconCanvas(source, planPx)) ??
        source.preparingThumbnail({ width: planPx, height: planPx }) ??
        source
      const prepared = await prepareDarkIcon(normalized)
      if (!prepared) return null
      plan = prepared
      planCacheRef.current.set(planPx, plan)
    }
    return renderDarkIcon(plan, darkOptionsOf(key), (p) => setDarkProgress(p))
  }

  /** 离屏渲染：按像素尺寸 + 圆角裁切（JPEG 铺白底；PNG/HEIF 保留透明） */
  async function renderIcon(src: UIImage, format: IconFormat): Promise<UIImage | null> {
    const size = effectivePx
    const radius = rounded ? Math.round(size * 0.2237) : 0
    const whiteBg = format === "jpeg"
    const imgEl = (
      <Image
        image={src}
        resizable={true}
        scaleToFill={true}
        frame={{ width: size, height: size }}
        clipShape={{ type: "rect", cornerRadius: radius }}
      />
    )
    const el = whiteBg ? (
      <ZStack>
        <Rectangle fill="white" frame={{ width: size, height: size }} />
        {imgEl}
      </ZStack>
    ) : imgEl
    try {
      return await ImageRenderer.toUIImage(el, { scale: 1, opaque: whiteBg })
    } catch {
      return null
    }
  }

  /** 两个「底色处理」开关互斥：外圈刷黑 / 灰色遮罩 */
  function pickBgMode(mode: "bgBlack" | "keepBg", on: boolean) {
    setDarkBgBlack(mode === "bgBlack" ? on : false)
    setDarkKeepBg(mode === "keepBg" ? on : false)
  }

  async function save(format: IconFormat) {
    if (!source || busy) return
    setBusy(true)
    if (effectActive) setDarkProgress(0)
    try {
      const src = effectActive ? await darkImageFor(effectivePx) : source
      if (!src) {
        setFeedback({ format, ok: false })
        return
      }
      const img = await renderIcon(src, format)
      if (!img) {
        setFeedback({ format, ok: false })
        return
      }
      const safeTitle =
        props.title.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_") || "app_icon"
      const ext = format === "png" ? "png" : format === "jpeg" ? "jpg" : "heic"
      const variant = appearance === "dark" ? "_dark" : darkBgBlack ? "_black" : darkKeepBg ? "_mask" : ""
      const fileName = `${safeTitle}_${effectivePx}px${variant}.${ext}`
      const path = FileManager.temporaryDirectory.replace(/\/$/, "") + "/" + fileName
      if (format === "heic") {
        // HEIF 走 ImageIO（保留透明圆角）
        await ImageIO.writeImage({ image: img, to: path, format: "heic", quality: 0.9 })
      } else {
        const data = format === "png" ? Data.fromPNG(img) : Data.fromJPEG(img, 0.9)
        if (!data) {
          setFeedback({ format, ok: false })
          return
        }
        FileManager.writeAsDataSync(path, data)
      }
      const ok = await Photos.savePhoto(path, { fileName: path.split("/").pop() ?? undefined })
      setFeedback({ format, ok })
      if (ok) {
        try { HapticFeedback.lightImpact() } catch {}
      }
    } catch {
      setFeedback({ format, ok: false })
    } finally {
      setBusy(false)
      setDarkProgress(null)
    }
  }

  function savePill(format: IconFormat, label: string) {
    const fb = feedback?.format === format ? feedback : null
    const color = fb ? (fb.ok ? "#34c759" : "systemRed") : "secondaryLabel"
    return (
      <MiniPill disabled={busy || !source} onTap={() => { void save(format) }}>
        {fb ? (
          <Image
            systemName={fb.ok ? "checkmark.circle.fill" : "xmark.circle.fill"}
            font="caption2"
            foregroundStyle={fb.ok ? "#34c759" : "systemRed"}
          />
        ) : (
          <Image
            systemName="square.and.arrow.down"
            font="caption2"
            foregroundStyle="secondaryLabel"
          />
        )}
        <Text font="caption" fontWeight="medium" foregroundStyle={color}>
          {fb ? (fb.ok ? "已保存" : "失败") : label}
        </Text>
      </MiniPill>
    )
  }

  const darkPending = effectActive && !darkPreview

  return (
    <VStack
      alignment="leading"
      spacing={8}
      frame={{ maxWidth: "infinity", alignment: "leading" as any }}
      padding={{ horizontal: 2, top: 2 }}
    >
      <HStack spacing={12} alignment="top" frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
        {/* 预览：小尺寸棋盘格透明背景，所见即所得（暗色时显示模拟结果） */}
        {failed ? (
          <Text font="caption" foregroundStyle="systemRed">图标加载失败</Text>
        ) : !source ? (
          <ProgressView />
        ) : (
          <ZStack frame={{ width: 64, height: 64 }} clipShape={{ type: "rect", cornerRadius: 10 }}>
            <Canvas
              frame={{ width: 64, height: 64 }}
              draw={(ctx, size) => {
                const cell = 8
                for (let y = 0; y < size.height; y += cell) {
                  for (let x = 0; x < size.width; x += cell) {
                    const dark = (x / cell + y / cell) % 2 === 0
                    ctx.fillStyle = dark ? "#c9c9c9" : "#eaeaea"
                    ctx.fillRect(x, y, cell, cell)
                  }
                }
              }}
            />
            <Image
              image={effectActive && darkPreview ? darkPreview : source}
              resizable={true}
              scaleToFill={true}
              frame={{ width: 56, height: 56 }}
              clipShape={{ type: "rect", cornerRadius: rounded ? 12 : 0 }}
            />
            {darkPending ? (
              <ZStack
                frame={{ width: 56, height: 56 }}
                background={{ style: "ultraThinMaterial", shape: { type: "rect", cornerRadius: 12 } }}
              >
                <ProgressView />
              </ZStack>
            ) : null}
            {darkProgress != null ? (
              <HStack
                spacing={3}
                padding={{ horizontal: 6, vertical: 2 }}
                background={{ style: "ultraThinMaterial", shape: "capsule" }}
                offset={{ x: 0, y: 22 }}
              >
                <ProgressView frame={{ width: 10, height: 10 }} scaleEffect={0.6} />
                <Text font="caption2">{`${Math.round(darkProgress * 100)}%`}</Text>
              </HStack>
            ) : null}
          </ZStack>
        )}
        <VStack alignment="leading" spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
          {/* 尺寸预设 + 自定义像素输入框 */}
          <HStack spacing={6}>
            {PRESETS.map((size) => (
              <MiniPill
                key={`isz-${size}`}
                selected={customText.trim() === "" && px === size}
                onTap={() => {
                  setPx(size)
                  setCustomText("")
                }}
              >
                <Text
                  font="caption"
                  fontWeight={customText.trim() === "" && px === size ? "semibold" : undefined}
                  foregroundStyle={customText.trim() === "" && px === size ? "#0a84ff" : "secondaryLabel"}
                >
                  {`${size}`}
                </Text>
              </MiniPill>
            ))}
            <HStack
              spacing={4}
              padding={{ horizontal: 9, vertical: 4 }}
              background={CAPSULE_BG}
              clipShape="capsule"
            >
              <Image systemName="pencil.and.outline" font="caption2" foregroundStyle="tertiaryLabel" />
              <TextField
                title=""
                value={customText}
                onChanged={setCustomText}
                prompt="自定义"
                keyboardType="numberPad"
                autocorrectionDisabled={true}
                textInputAutocapitalization="never"
                frame={{ width: 64 }}
              />
            </HStack>
          </HStack>
          {/* 圆角/直角 + 三格式保存：固定在第二行 */}
          <HStack spacing={6}>
            <MiniPill onTap={() => setRounded((value) => !value)}>
              <Image
                systemName={rounded ? "app.fill" : "square"}
                font="caption2"
                foregroundStyle="secondaryLabel"
              />
              <Text font="caption" foregroundStyle="secondaryLabel">
                {rounded ? "圆角" : "直角"}
              </Text>
            </MiniPill>
            {savePill("png", "PNG")}
            {savePill("jpeg", "JPG")}
            {savePill("heic", "HEIF")}
          </HStack>
          {/* 第三行：原图 / 暗色 两颗独立按钮；暗色下再显示外圈刷黑/灰色遮罩 */}
          <ScrollView axes="horizontal" scrollIndicator="never" frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
            <HStack spacing={6}>
              <MiniPill selected={appearance === "light"} onTap={() => setAppearance("light")}>
                <Image
                  systemName="sun.max"
                  font="caption2"
                  foregroundStyle={appearance === "light" ? "#0a84ff" : "secondaryLabel"}
                />
                <Text
                  font="caption"
                  fontWeight={appearance === "light" ? "semibold" : undefined}
                  foregroundStyle={appearance === "light" ? "#0a84ff" : "secondaryLabel"}
                  lineLimit={1}
                  fixedSize={{ horizontal: true, vertical: false }}
                >
                  原图
                </Text>
              </MiniPill>
              <MiniPill selected={appearance === "dark"} onTap={() => setAppearance("dark")}>
                <Image
                  systemName="moon"
                  font="caption2"
                  foregroundStyle={appearance === "dark" ? "#0a84ff" : "secondaryLabel"}
                />
                <Text
                  font="caption"
                  fontWeight={appearance === "dark" ? "semibold" : undefined}
                  foregroundStyle={appearance === "dark" ? "#0a84ff" : "secondaryLabel"}
                  lineLimit={1}
                  fixedSize={{ horizontal: true, vertical: false }}
                >
                  暗色
                </Text>
              </MiniPill>
              <ModeChip
                selected={darkBgBlack}
                label="外圈刷黑"
                onTap={() => pickBgMode("bgBlack", !darkBgBlack)}
              />
              <ModeChip
                selected={darkKeepBg}
                label="灰色遮罩"
                onTap={() => pickBgMode("keepBg", !darkKeepBg)}
              />
            </HStack>
          </ScrollView>
        </VStack>
      </HStack>
    </VStack>
  )
}

/** 链接胶囊徽章：点击复制链接。圆角长方形淡黑灰底、
 *  文字淡灰 secondaryLabel（复制成功仍变绿）。 */
export function LinkBadgeButton(props: {
  url: string | null | undefined
  fallbackUrl?: string
  foregroundStyle?: any
}) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = safeTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(timer)
  }, [copied])

  async function copy() {
    const link = props.url || props.fallbackUrl || ""
    if (!link) return
    try {
      await Pasteboard.setString(link)
    } catch {
      return
    }
    try { HapticFeedback.lightImpact() } catch {}
    setCopied(true)
  }

  return (
    <Button buttonStyle="plain" action={() => { void copy() }}>
      <HStack
        spacing={6}
        padding={{ horizontal: 10, vertical: 5 }}
        background={<RoundedRectangle fill={{ light: "rgba(0,0,0,0.05)", dark: "rgba(0,0,0,0.22)" }} cornerRadius={7} />}
        clipShape={{ type: "rect", cornerRadius: 7, style: "continuous" }}
      >
        <Text font="caption" fontWeight="medium" foregroundStyle={copied ? "#34c759" : (props.foregroundStyle || "secondaryLabel")}>
          {copied ? "已复制" : "Link"}
        </Text>
      </HStack>
    </Button>
  )
}
