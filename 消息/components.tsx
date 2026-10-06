import {
  Button,
  Circle,
  HStack,
  Image,
  ProgressView,
  Rectangle,
  RoundedRectangle,
  Section,
  Spacer,
  Text,
  VStack,
  ZStack,
  useRef,
} from "scripting"
import { fmtNum, fmtTime } from "./api"
import type { PanelCtx } from "./ctx"

/**
 * 跨页面共享的展示组件（自 Telegram 浅色主题）。
 * 所有业务状态在 view.tsx，经 PanelCtx 下发；这里只负责渲染。
 *
 * 2026-10-05 现代化改版的设计基元：
 *  · RowButton → 胶囊 chip（浅色底 + 深色字，可 filled 实心），告别“裸文字按钮”
 *  · Hint      → 状态提示气泡（浅色圆角底 + 图标 + 文字），告别裸提示文字
 *  · FieldBox  → 输入框统一浅灰圆角底，白卡上不再“隐形”
 *  · PrimaryButton → 全宽胶囊主按钮
 */

export const ACCENT = "#2AABEE" // Telegram 品牌蓝

// ── 颜色工具（Scripting 不支持 8 位 #RRGGBBAA，半透明观感一律手算成实色）──
function parseHex(hex: string): [number, number, number] {
  const s = hex.replace("#", "")
  const v = s.length === 3 ? s.split("").map(c => c + c).join("") : s.slice(0, 6)
  const n = parseInt(v, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function toHex(r: number, g: number, b: number): `#${string}` {
  const h = (x: number) =>
    Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")
  return `#${h(r)}${h(g)}${h(b)}`
}
/** 与白色按 whiteRatio 混合 → chip / 气泡的浅色底 */
export function fade(hex: string, whiteRatio = 0.87): `#${string}` {
  const [r, g, b] = parseHex(hex)
  return toHex(r + (255 - r) * whiteRatio, g + (255 - g) * whiteRatio, b + (255 - b) * whiteRatio)
}
/** 与黑色按 blackRatio 混合 → 浅底上的深色文字 */
export function darken(hex: string, blackRatio = 0.16): `#${string}` {
  const [r, g, b] = parseHex(hex)
  const k = 1 - blackRatio
  return toHex(r * k, g * k, b * k)
}

/**
 * 文本自然宽度估算（CJK 全角按 font 宽，西文/数字按 0.6）。
 * 用于给行内 chip 算出**固定宽度**：SwiftUI 压缩从最后一个子视图开始，
 * 弹性（带 padding）的 chip 会被挤成色块，固定 frame 则受保护。
 */
export function labelWidth(label: string, font: number): number {
  let w = 0
  for (const ch of label) {
    const c = ch.codePointAt(0) ?? 0
    w += c >= 0x2e80 && c <= 0xffff ? font : font * 0.6
  }
  return Math.ceil(w)
}

const AVATAR_COLORS: [`#${string}`, `#${string}`][] = [
  ["#4FC5F7", "#1E90D6"],
  ["#7B8FF7", "#4B5EF7"],
  ["#5AD8A6", "#12B886"],
  ["#FFB06B", "#FF7043"],
  ["#F78CA0", "#F45D8C"],
  ["#A78BFA", "#6C5CE7"],
  ["#4FD1C5", "#1FA39B"],
  ["#F6C453", "#E0992E"],
]

/** 头像：有真实照片（src=本地图片路径）则用照片裁圆，否则渐变首字母 */
export function Avatar({
  name,
  size = 38,
  src,
}: {
  name?: string
  size?: number
  src?: string
}) {
  const raw = String(name ?? "").trim()
  const ch = raw ? raw.slice(0, 1).toUpperCase() : "?"
  if (src) {
    return (
      <Image
        filePath={src}
        resizable
        scaleToFill
        clipShape="circle"
        frame={{ width: size, height: size }}
      />
    )
  }
  let sum = 0
  for (let i = 0; i < raw.length; i++) sum += raw.charCodeAt(i)
  const pair = AVATAR_COLORS[sum % AVATAR_COLORS.length]
  return (
    <ZStack alignment="center" frame={{ width: size, height: size }}>
      <Circle
        fill={{ colors: pair, startPoint: "topLeading", endPoint: "bottomTrailing" }}
        frame={{ width: size, height: size }}
      />
      <Text font={Math.max(13, Math.round(size * 0.4))} fontWeight="semibold" foregroundStyle="white">
        {ch}
      </Text>
    </ZStack>
  )
}

/**
 * Telegram 设置页风格行（参考官方设置截图）：圆角彩色图标 + 标题 +
 * 右侧值/控件 + chevron。传 action 即整行可点（点图标/点行都触发）；
 * danger 标题变红；onLongPress 提供长按入口（如自定义动作删除），
 * 长按后 700ms 内的 tap 会被屏蔽，避免“长按被当成点一下”。
 * 2026-10-06：新增 hint —— 行内临时提示直接显示在本行空白处（行内小字，
 * 固定宽度防压缩、超长省略号），不再在按钮行下方另起一行 Hint 气泡。
 */
export function SettingsRow({
  icon,
  color = "#2AABEE",
  title,
  value,
  hint,
  hintTone = "info",
  trailing,
  chevron = true,
  danger = false,
  disabled = false,
  action,
  onLongPress,
}: {
  icon: string
  color?: `#${string}`
  title: string
  value?: string
  /** 行内临时提示（显示在标题右侧空白处，超长截断）；不再用行下气泡 */
  hint?: string
  hintTone?: HintTone
  /** 右侧额外内容（TextField / ProgressView / 小按钮） */
  trailing?: any
  chevron?: boolean
  danger?: boolean
  disabled?: boolean
  action?: () => void
  /** 长按回调（与 action 并存时，长按后的短时间 tap 会被吞掉） */
  onLongPress?: () => void
}) {
  const tappable = (!!action || !!onLongPress) && !disabled
  const lastLongPress = useRef(0)
  return (
    <HStack
      spacing={12}
      padding={{ vertical: 9 }}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
      onTapGesture={
        tappable
          ? () => {
              if (Date.now() - lastLongPress.current < 700) return
              if (action) action()
            }
          : undefined
      }
      onLongPressGesture={
        onLongPress && !disabled
          ? () => {
              lastLongPress.current = Date.now()
              onLongPress()
            }
          : undefined
      }
    >
      <ZStack alignment="center" frame={{ width: 30, height: 30 }}>
        <RoundedRectangle fill={color} cornerRadius={7} frame={{ width: 30, height: 30 }} />
        <Image systemName={icon} foregroundStyle="white" frame={{ width: 17, height: 17 }} />
      </ZStack>
      <Text
        font={15}
        lineLimit={1}
        foregroundStyle={danger ? "#FF3B30" : disabled ? "#C7C7CC" : "#000000"}
        frame={{ maxWidth: "infinity", alignment: "leading" }}
      >
        {title}
      </Text>
      {hint ? (
        <Text
          font={11}
          fontWeight="medium"
          foregroundStyle={hintColor(hintTone)}
          lineLimit={1}
          // 固定宽度 = 文字自然宽（封顶 150）：压缩时先让标题退让，提示不被挤掉
          frame={{ width: Math.min(150, labelWidth(hint, 11) + 6) }}
        >
          {hint}
        </Text>
      ) : null}
      {value ? <Text font="subheadline" foregroundStyle="#8E8E93">{value}</Text> : null}
      {trailing}
      {chevron ? (
        <Image systemName="chevron.right" foregroundStyle="#C7C7CC" frame={{ width: 13, height: 13 }} />
      ) : null}
    </HStack>
  )
}

/**
 * Telegram 风全宽主按钮：胶囊 + 实心品牌蓝（卡片内主操作：查询 / 统计 / 加载…）。
 * 原生 Button 不吃 frame 宽度，自绘最稳（同 login.tsx 的 TgButton）。
 */
export function PrimaryButton(props: {
  title: string
  action: () => void
  disabled?: boolean
  color?: `#${string}`
}) {
  const height = 46
  const base: `#${string}` = props.color ?? ACCENT
  const fill: `#${string}` = props.disabled ? fade(base, 0.72) : base
  return (
    <ZStack
      alignment="center"
      frame={{ maxWidth: "infinity", height }}
      onTapGesture={props.disabled ? undefined : props.action}
    >
      <RoundedRectangle fill={fill} cornerRadius={height / 2} frame={{ maxWidth: "infinity", height }} />
      <Text font={17} fontWeight="semibold" foregroundStyle="white">
        {props.title}
      </Text>
    </ZStack>
  )
}

/**
 * 行内小按钮（SettingsRow 的 trailing / 格式面板 / 结果卡片操作行用）：
 * 原生 Button 在 HStack 里理想宽度被算成 ~0，自绘 chip 占位才稳定。
 * 现代化改版：胶囊浅色底 + 同色系深字（不再是一行裸文字）；
 * filled=true 时为实心主按钮（白字）。
 */
export function RowButton({
  title,
  color = ACCENT,
  disabled = false,
  filled = false,
  action,
}: {
  title: string
  color?: `#${string}`
  disabled?: boolean
  /** 实心样式（白字），用于主操作如「发送」 */
  filled?: boolean
  action: () => void
}) {
  const bg: `#${string}` = disabled ? "#EFEFF1" : filled ? color : fade(color)
  const fg: `#${string}` = disabled ? "#B9BCC2" : filled ? "#FFFFFF" : darken(color)
  // 固定宽度 = 文字自然宽 + 左右 padding：同行被压缩时 chip 不会被挤成色块
  const width = Math.max(44, labelWidth(title, 13) + 28)
  return (
    <HStack
      spacing={0}
      padding={{ horizontal: 11, vertical: 6 }}
      frame={{ width, minHeight: 30 }}
      background={<RoundedRectangle fill={bg} cornerRadius={15} />}
      onTapGesture={disabled ? undefined : action}
    >
      <Text font="footnote" fontWeight="semibold" foregroundStyle={fg} lineLimit={1}>
        {title}
      </Text>
    </HStack>
  )
}

/**
 * 状态提示气泡：浅色圆角底 + 语义色图标 + 文字（替代满屏裸 footnote 红绿字）。
 * tone: ok 绿 / error 红 / warn 橙 / info 蓝 / muted 灰；spinner 显示转圈。
 */
export type HintTone = "ok" | "error" | "warn" | "info" | "muted"

/** 行内提示小字的语义色（与 Hint 气泡同色系），供 SettingsRow.hint 使用 */
export function hintColor(tone: HintTone): `#${string}` {
  return HINT_STYLE[tone].fg
}

const HINT_STYLE: Record<HintTone, { bg: `#${string}`; fg: `#${string}`; icon: string }> = {
  ok: { bg: "#E8F8EE", fg: "#1FA257", icon: "checkmark.circle.fill" },
  error: { bg: "#FDEBEC", fg: "#E0353B", icon: "exclamationmark.circle.fill" },
  warn: { bg: "#FFF4E4", fg: "#E08600", icon: "exclamationmark.triangle.fill" },
  info: { bg: "#E9F4FD", fg: "#1E93D6", icon: "info.circle.fill" },
  muted: { bg: "#F1F2F4", fg: "#83878E", icon: "info.circle" },
}

export function Hint({
  tone = "info",
  text,
  icon,
  spinner = false,
}: {
  tone?: HintTone
  text: string
  /** 覆盖默认语义图标（SF Symbol） */
  icon?: string
  spinner?: boolean
}) {
  if (!text) return null
  const s = HINT_STYLE[tone]
  return (
    <HStack
      spacing={7}
      padding={{ horizontal: 10, vertical: 7 }}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
      background={<RoundedRectangle fill={s.bg} cornerRadius={10} />}
      transition={Transition.fade(0.25)}
    >
      {spinner ? (
        <ProgressView />
      ) : (
        <Image systemName={icon ?? s.icon} foregroundStyle={s.fg} frame={{ width: 14, height: 14 }} />
      )}
      <Text
        font="footnote"
        foregroundStyle={s.fg}
        frame={{ maxWidth: "infinity", alignment: "leading" }}
      >
        {text}
      </Text>
    </HStack>
  )
}

/**
 * 输入框底：浅灰圆角容器（白卡里的裸输入文字不再隐形）。
 * width 固定宽度（行内小输入），不传则占满剩余宽度。
 */
export function FieldBox({
  width,
  children,
}: {
  width?: number
  children: any
}) {
  return (
    <HStack
      spacing={6}
      padding={{ horizontal: 9, vertical: 4 }}
      alignment="center"
      frame={width !== undefined ? { width } : { maxWidth: "infinity" }}
      background={<RoundedRectangle fill="#F1F3F6" cornerRadius={9} />}
    >
      {children}
    </HStack>
  )
}

/**
 * 底部停靠栏容器（Pix 同款悬浮玻璃胶囊）：外层透明留白，内层是
 * Liquid Glass 药丸（glassEffect capsule + 阴影），浮在列表之上。
 * 放在 List 的 safeAreaInset.bottom 里，整体在 home indicator 之上。
 */
export function DockBar({ children }: { children: any }) {
  return (
    <HStack
      alignment="center"
      spacing={0}
      padding={{ horizontal: 14, top: 6, bottom: 10 }}
      frame={{ maxWidth: "infinity" }}
      background="clear"
    >
      <GlassDockCapsule>{children}</GlassDockCapsule>
    </HStack>
  )
}

/** 玻璃药丸主体：半透明底 + 玻璃材质 + 投影 */
function GlassDockCapsule({ children }: { children: any }) {
  return (
    <HStack
      alignment="center"
      spacing={12}
      padding={{ horizontal: 12, vertical: 8 }}
      frame={{ maxWidth: "infinity", minHeight: 60 }}
      glassEffect="capsule"
      contentShape="capsule"
      background={<RoundedRectangle fill="rgba(255,255,255,0.72)" cornerRadius={30} />}
      shadow={{ color: "rgba(0,0,0,0.16)", radius: 16, y: 6 }}
    >
      {children}
    </HStack>
  )
}

/**
 * 分段标签（底部停靠栏用，替代页面顶部的 segmented Picker）：
 * 灰轨道 + 白色滑块，选中态用 animation(value:) 平滑过渡（颜色 + 滑块交叉淡化）。
 */
export interface SegItem {
  tag: string
  label: string
}

export function SegmentedTabs(props: {
  items: ReadonlyArray<SegItem>
  value: string
  onChanged: (tag: string) => void
}) {
  const anim = Animation.smooth({ duration: 0.26 })
  return (
    <HStack
      spacing={0}
      padding={4}
      frame={{ maxWidth: "infinity", height: 46 }}
      background={<RoundedRectangle fill="rgba(118,118,128,0.12)" cornerRadius={14} />}
    >
      {props.items.map(item => {
        const selected = item.tag === props.value
        return (
          <Button
            key={item.tag}
            buttonStyle="plain"
            frame={{ maxWidth: "infinity", height: 38 }}
            action={() => {
              if (!selected) props.onChanged(item.tag)
            }}
          >
            <ZStack
              alignment="center"
              frame={{ maxWidth: "infinity", height: 38 }}
            >
              <RoundedRectangle
                fill={selected ? "rgba(255,255,255,0.94)" : "rgba(255,255,255,0)"}
                cornerRadius={11}
                frame={{ maxWidth: "infinity", height: 38 }}
                shadow={
                  selected
                    ? { color: "rgba(0,0,0,0.12)", radius: 4, y: 1 }
                    : undefined
                }
                animation={{ animation: anim, value: selected }}
              />
              <Text
                font="subheadline"
                fontWeight={selected ? "semibold" : "medium"}
                foregroundStyle={selected ? ACCENT : "#4B4B50"}
                lineLimit={1}
                animation={{ animation: anim, value: selected }}
              >
                {item.label}
              </Text>
            </ZStack>
          </Button>
        )
      })}
    </HStack>
  )
}

/**
 * 停靠栏图标按钮：44×44 玻璃圆角方块（固定 frame 防同行压缩），
 * 玻璃底 + 深色符号，disabled 置灰。
 */
export function DockIcon({
  icon,
  color = ACCENT,
  disabled = false,
  action,
}: {
  icon: string
  color?: `#${string}`
  disabled?: boolean
  action: () => void
}) {
  return (
    <ZStack
      alignment="center"
      frame={{ width: 44, height: 44 }}
      glassEffect={disabled ? undefined : "capsule"}
      contentShape="capsule"
      background={
        <RoundedRectangle
          fill={disabled ? "rgba(118,118,128,0.08)" : "rgba(255,255,255,0.82)"}
          cornerRadius={14}
        />
      }
      onTapGesture={disabled ? undefined : action}
    >
      <Image
        systemName={icon}
        foregroundStyle={disabled ? "#C7C7CC" : color}
        frame={{ width: 21, height: 21 }}
      />
    </ZStack>
  )
}

/** 指标卡片：渐变图标徽标 + 大数字 + 标签 */
export function StatCard({
  icon,
  label,
  value,
  colors = ["#4FC5F7", "#1E90D6"],
}: {
  icon: string
  label: string
  value: string
  colors?: [`#${string}`, `#${string}`]
}) {
  return (
    <HStack spacing={10} frame={{ maxWidth: "infinity" }}>
      <ZStack alignment="center" frame={{ width: 36, height: 36 }}>
        <Circle
          fill={{ colors, startPoint: "topLeading", endPoint: "bottomTrailing" }}
          frame={{ width: 36, height: 36 }}
        />
        <Image systemName={icon} foregroundStyle="white" frame={{ width: 17, height: 17 }} />
      </ZStack>
      <VStack alignment="leading" spacing={1}>
        <Text font="title3" bold monospacedDigit>
          {value}
        </Text>
        <Text font="caption" foregroundStyle="#8E8E93">
          {label}
        </Text>
      </VStack>
    </HStack>
  )
}

function Bar({ ratio, color }: { ratio: number; color: `#${string}` }) {
  const r = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0
  const n = r <= 0 ? 0 : Math.max(1, Math.round(r * 16))
  return (
    <Text font="caption" monospaced foregroundStyle={color}>
      {"█".repeat(n)}
    </Text>
  )
}

export function TimelineRow({ row, max }: { row: any; max: number }) {
  return (
    <HStack spacing={8}>
      <Text font="footnote" foregroundStyle="#8E8E93" frame={{ width: 58 }}>
        {String(row.period).slice(5)}
      </Text>
      <Bar ratio={max > 0 ? row.msg_count / max : 0} color="#2AABEE" />
      <Spacer />
      <Text font="footnote" monospacedDigit bold>
        {fmtNum(row.msg_count)}
      </Text>
    </HStack>
  )
}

export function RankRow({ index, name, count, max, sub }: any) {
  const colors: (`#${string}`)[] = ["#FF9F0A", "#FF375F", "#0A84FF", "#8E8E93"]
  return (
    <HStack spacing={10}>
      <ZStack alignment="center" frame={{ width: 26, height: 26 }}>
        <Circle
          fill={index < 3 ? colors[index] : "#C7C7CC"}
          frame={{ width: 26, height: 26 }}
        />
        <Text font="caption" bold foregroundStyle="white">
          {index + 1}
        </Text>
      </ZStack>
      <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Text font="headline" lineLimit={1}>
          {name}
        </Text>
        <HStack spacing={6}>
          <Bar ratio={max > 0 ? count / max : 0} color="#2AABEE" />
          <Text font="caption2" foregroundStyle="#8E8E93">
            {sub}
          </Text>
        </HStack>
      </VStack>
      <Text font="subheadline" monospacedDigit bold>
        {fmtNum(count)}
      </Text>
    </HStack>
  )
}

/** 从文本中提取第一个 http(s) 网址（粗粒度，够用即可）。 */
function firstUrl(text: string): string {
  const m = text.match(/https?:\/\/[^\s<>"']+/i)
  return m ? m[0].replace(/[),.;:]+$/, "") : ""
}

export function MsgRow({ m, onOpenUrl }: { m: any; onOpenUrl?: (url: string) => void }) {
  const raw = String(m.content ?? "").replace(/\s+/g, " ").trim()
  const url = firstUrl(raw)
  return (
    <VStack alignment="leading" spacing={3}>
      <Text font="caption" foregroundStyle="#8E8E93">
        {fmtTime(m.timestamp)} · {m.chat_name || "未知会话"}
      </Text>
      <Text lineLimit={4}>{raw.slice(0, 200)}</Text>
      <HStack spacing={10} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Text font="caption2" foregroundStyle="#2AABEE">
          {m.sender_name || "未知发送者"}
        </Text>
        {url !== "" && onOpenUrl ? (
          <Text
            font="caption2"
            foregroundStyle="#2AABEE"
            onTapGesture={() => onOpenUrl(url)}
          >
            打开链接 ›
          </Text>
        ) : null}
      </HStack>
    </VStack>
  )
}

export function InfoRow({ label, value }: { label: string; value: any }) {
  return (
    <HStack spacing={8}>
      <Text font="footnote" foregroundStyle="#8E8E93" frame={{ width: 84 }}>
        {label}
      </Text>
      <Text font="footnote" lineLimit={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        {String(value ?? "—")}
      </Text>
    </HStack>
  )
}

/** 执行中 / 出错 / 提示 横幅（页面顶部共用）：语义色气泡，不再是裸标题 + 裸文字 */
export function Banners({ p }: { p: PanelCtx }) {
  return (
    <>
      {p.busy ? (
        <Section>
          <Hint tone="info" spinner text={p.busy} />
        </Section>
      ) : null}
      {p.error ? (
        <Section>
          <Hint tone="error" text={p.error} />
        </Section>
      ) : null}
      {p.notice ? (
        <Section>
          <Hint tone="ok" text={p.notice} />
        </Section>
      ) : null}
    </>
  )
}
