import type { Color, ContentTransition, Font, FontWeight, TextProps, VirtualNode } from "scripting"
import { Circle, HStack } from "scripting"
import { AnimText } from "./anim-text"

/**
 * GlassBadge — 半透明胶囊徽章（取自 IPA-Tool-3.0）。
 * info / success / warning / error / neutral / teal 六种色系，浅色深色自适应。
 */
export type GlassBadgeStyle = "info" | "success" | "warning" | "error" | "neutral" | "teal" | "rose" | "purple"

type AdaptiveColor = Color | {
  light: Color
  dark: Color
}

type GlassBadgeTokens = {
  tint: AdaptiveColor
  background: AdaptiveColor
  border: AdaptiveColor
}

type GlassBadgeProps = {
  style?: GlassBadgeStyle
  children: VirtualNode | VirtualNode[]
  showDot?: boolean
  /** 可选底色覆盖（不改文字色）；仅搜索页个别徽章用 */
  background?: AdaptiveColor
  /** true：去掉描边（配合灰底时使用） */
  hideBorder?: boolean
}

type AnimTextGlassBadgeProps = {
  style?: GlassBadgeStyle
  children: Extract<TextProps, { children: any }>["children"]
  showDot?: boolean
  anim?: ContentTransition
  dur?: number
  font?: number | Font | { name: string; size: number }
  fontWeight?: FontWeight
  background?: AdaptiveColor
  hideBorder?: boolean
  /** 可选文字前景覆盖；传入时跟随 App Store 卡片九色主题 */
  foregroundStyle?: any
}

const badgeTokenMap: Record<GlassBadgeStyle, GlassBadgeTokens> = {
  info: {
    tint: { light: "#0057B8", dark: "systemBlue" },
    background: { light: "rgba(0,122,255,0.18)", dark: "rgba(0,122,255,0.16)" },
    border: { light: "rgba(0,122,255,0.34)", dark: "rgba(0,122,255,0.32)" },
  },
  success: {
    tint: { light: "#1F7A35", dark: "systemGreen" },
    background: { light: "rgba(52,199,89,0.18)", dark: "rgba(52,199,89,0.16)" },
    border: { light: "rgba(52,199,89,0.34)", dark: "rgba(52,199,89,0.32)" },
  },
  warning: {
    tint: { light: "#9A5A00", dark: "systemOrange" },
    background: { light: "rgba(255,149,0,0.20)", dark: "rgba(255,149,0,0.16)" },
    border: { light: "rgba(255,149,0,0.36)", dark: "rgba(255,149,0,0.32)" },
  },
  error: {
    tint: { light: "#B42318", dark: "systemRed" },
    background: { light: "rgba(255,59,48,0.18)", dark: "rgba(255,59,48,0.16)" },
    border: { light: "rgba(255,59,48,0.34)", dark: "rgba(255,59,48,0.32)" },
  },
  neutral: {
    tint: { light: "#4F4F55", dark: "secondaryLabel" },
    background: { light: "rgba(142,142,147,0.17)", dark: "rgba(142,142,147,0.14)" },
    border: { light: "rgba(142,142,147,0.32)", dark: "rgba(142,142,147,0.28)" },
  },
  teal: {
    tint: { light: "#087989", dark: "systemTeal" },
    background: { light: "rgba(48,176,199,0.18)", dark: "rgba(48,176,199,0.16)" },
    border: { light: "rgba(48,176,199,0.34)", dark: "rgba(48,176,199,0.32)" },
  },
  rose: {
    tint: { light: "#CC4A4A", dark: "systemPink" },
    background: { light: "rgba(255,107,107,0.18)", dark: "rgba(255,107,107,0.16)" },
    border: { light: "rgba(255,107,107,0.34)", dark: "rgba(255,107,107,0.32)" },
  },
  purple: {
    tint: { light: "#7D4FB2", dark: "systemPurple" },
    background: { light: "rgba(175,82,222,0.18)", dark: "rgba(175,82,222,0.16)" },
    border: { light: "rgba(175,82,222,0.34)", dark: "rgba(175,82,222,0.32)" },
  },
}

export const getGlassBadgeTokens = (style: GlassBadgeStyle) => badgeTokenMap[style]

export function GlassBadge({ style = "neutral", children, showDot = false, background, hideBorder }: GlassBadgeProps) {
  const tokens = getGlassBadgeTokens(style)

  return (
    <HStack
      spacing={6}
      padding={{ horizontal: 10, vertical: 5 }}
      background={{ style: background ?? tokens.background, shape: "capsule" }}
      border={hideBorder ? undefined : { style: tokens.border, width: 0.5 }}
      clipShape="capsule"
    >
      {showDot && <Circle fill={tokens.tint} frame={{ width: 6, height: 6 }} />}
      {children}
    </HStack>
  )
}

export function AnimTextGlassBadge({
  style = "neutral",
  children,
  showDot = false,
  anim,
  dur,
  font,
  fontWeight,
  background,
  hideBorder,
  foregroundStyle,
}: AnimTextGlassBadgeProps) {
  const tokens = getGlassBadgeTokens(style)

  return (
    <GlassBadge style={style} showDot={showDot} background={background} hideBorder={hideBorder}>
      <AnimText
        font={font}
        fontWeight={fontWeight}
        anim={anim}
        dur={dur}
        foregroundStyle={foregroundStyle || tokens.tint}
      >
        {children}
      </AnimText>
    </GlassBadge>
  )
}

/**
 * 玻璃卡片背景（iOS 26 Liquid Glass，低版本自动降级为空属性）。
 */
export function glassCardEffect(shape: { type: "rect"; cornerRadius: number } | "capsule") {
  const glass = typeof UIGlass !== "undefined" ? UIGlass.clear().interactive(true) : undefined
  return glass ? { glassEffect: { glass, shape } } : {}
}
