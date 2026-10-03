import { Button, Canvas, HStack, Image, ImageRenderer, ProgressView, Rectangle, RoundedRectangle, Text, TextField, VStack, ZStack, useEffect, useState } from "scripting"
import type { Color } from "scripting"

import { GlassBadge } from "./glass-badge"

/** 链接徽章淡红色系：与 GlassBadge rose tokens 保持一致（深色模式 systemPink）。 */
const ROSE_TINT: { light: Color; dark: Color } = { light: "#CC4A4A", dark: "systemPink" }

/** 图标导出格式：PNG / JPEG（不透明，铺白底）/ HEIF（透明） */
type IconFormat = "png" | "jpeg" | "heic"

/** 把任意 mzstatic 图标 URL（模板或固定尺寸）换成指定尺寸透明 PNG（bf 后缀），
 *  避免拿到 100px 小图或白底图。 */
export function iconArtworkUrl(url: string | null | undefined, size: number): string | undefined {
  if (!url) return undefined
  const dim = `${size}x${size}bf.png`
  if (url.includes("{w}x{h}{c}.{f}")) {
    return url.replace("{w}x{h}{c}.{f}", dim)
  }
  return url.replace(/\d+x\d+bb\.\w+/, dim)
}

const CAPSULE_BG = { style: { light: "rgba(120,120,128,0.12)", dark: "rgba(120,120,128,0.18)" } as const, shape: "capsule" as const }
const CAPSULE_BG_SELECTED = { style: { light: "rgba(10,132,255,0.16)", dark: "rgba(10,132,255,0.30)" } as const, shape: "capsule" as const }

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

const PRESETS = [256, 512, 1024]

/** 图标面板：小预览 + 尺寸 + 圆角/直角 + 保存到相册（仅展开时挂载）。 */
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
    const timer = setTimeout(() => setFeedback(null), 1600)
    return () => clearTimeout(timer)
  }, [feedback])

  /** 离屏渲染：按像素尺寸 + 圆角裁切（JPEG 铺白底；PNG/HEIF 保留透明） */
  async function renderIcon(format: IconFormat): Promise<UIImage | null> {
    if (!source) return null
    const size = effectivePx
    const radius = rounded ? Math.round(size * 0.2237) : 0
    const whiteBg = format === "jpeg"
    const imgEl = (
      <Image
        image={source}
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

  async function save(format: IconFormat) {
    if (!source || busy) return
    setBusy(true)
    try {
      const img = await renderIcon(format)
      if (!img) {
        setFeedback({ format, ok: false })
        return
      }
      const safeTitle =
        props.title.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_") || "app_icon"
      const ext = format === "png" ? "png" : format === "jpeg" ? "jpg" : "heic"
      const fileName = `${safeTitle}_${effectivePx}px.${ext}`
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

  return (
    <HStack
      spacing={12}
      frame={{ maxWidth: "infinity", alignment: "leading" as any }}
      padding={{ horizontal: 2, top: 2 }}
    >
      {/* 预览：小尺寸棋盘格透明背景，所见即所得 */}
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
            image={source}
            resizable={true}
            scaleToFill={true}
            frame={{ width: 56, height: 56 }}
            clipShape={{ type: "rect", cornerRadius: rounded ? 12 : 0 }}
          />
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
        {/* 圆角/直角 + 三格式保存（并排，同样大小） */}
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
      </VStack>
    </HStack>
  )
}

/** 链接胶囊徽章：与 v 版本徽章同款（带圆点），淡红色 rose 色系，点击复制链接。
 *  搜索页传 grayBackground=true：改成圆角长方形（淡黑灰底、无描边、无圆点），文字淡灰 secondaryLabel（复制成功仍变绿）；
 *  分享页不传，保持原 rose 玻璃胶囊。 */
export function LinkBadgeButton(props: {
  url: string | null | undefined
  fallbackUrl?: string
  grayBackground?: boolean
  foregroundStyle?: any
}) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1200)
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

  const gray = props.grayBackground === true

  return (
    <Button buttonStyle="plain" action={() => { void copy() }}>
      {gray ? (
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
      ) : (
        <GlassBadge style="rose" showDot>
          <Text font="caption" fontWeight="medium" foregroundStyle={copied ? "#34c759" : ROSE_TINT}>
            {copied ? "已复制" : "Link"}
          </Text>
        </GlassBadge>
      )}
    </Button>
  )
}
