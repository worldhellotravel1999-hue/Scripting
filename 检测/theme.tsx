import {
  Button, Device, GeometryReader, HStack, Image, Rectangle, RoundedRectangle, Spacer, Text, VStack, ZStack,
  gradient, modifiers, useEffect, useRef, useState,
} from "scripting"
import type { Color, DynamicShapeStyle, VirtualNode } from "scripting"

export const ACCENT = {
  blue: "#279FC5" as Color,
  teal: "#16B8A6" as Color,
  violet: "#8673E8" as Color,
  green: "#28B982" as Color,
  amber: "#D6A013" as Color,
  orange: "#F08335" as Color,
  pink: "#F06591" as Color,
  red: "#E64F67" as Color,
}
export const CODE: {
  value: DynamicShapeStyle
  number: DynamicShapeStyle
  input: DynamicShapeStyle
  region: DynamicShapeStyle
} = {
  value: { light: "#25536B", dark: "#B3D7E7" },
  number: { light: "#A65225", dark: "#FFB878" },
  input: { light: "#1F6796", dark: "#8DD5FF" },
  region: { light: "#2A74B5", dark: "#8EC7FF" },
}
export const PAGE_BG = { light: "#EDF1F6" as Color, dark: "#090E16" as Color }
export const SURFACE = { light: "#FFFFFF" as Color, dark: "#111823" as Color }
export const BAND_BG = { light: "#F6F8FB" as Color, dark: "#171F2C" as Color }
export const LINE = { light: "#E7EDF3" as Color, dark: "#293344" as Color }
export const LABEL_WIDTH = 91
const SPECTRUM = gradient("linear", {
  colors: [ACCENT.teal, ACCENT.blue, ACCENT.violet], startPoint: "leading", endPoint: "trailing",
})
/** 强调色转半透明填充；传入非十六进制值时原样返回，避免拼出非法颜色。 */
export function tinted(color: Color, alpha: number): Color {
  const hex = String(color).trim()
  if (!/^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/.test(hex)) return color
  const body = hex.slice(1)
  const full = body.length === 3 ? body.split("").map(char => char + char).join("") : body
  const value = [full.slice(0, 2), full.slice(2, 4), full.slice(4, 6)]
    .map(part => parseInt(part, 16) || 0)
  const opacity = Math.max(0, Math.min(1, alpha)).toFixed(3)
  return `rgba(${value[0]}, ${value[1]}, ${value[2]}, ${opacity})` as Color
}

/** 标题图标的柔光底片：极浅的青蓝渐变，不影响正文对比度。 */
const ICON_CHIP = gradient("linear", {
  colors: ["rgba(39,159,197,0.16)", "rgba(134,115,232,0.10)"],
  startPoint: "topLeading", endPoint: "bottomTrailing",
})
const ICON_CHIP_EDGE = "rgba(39,159,197,0.24)"

// 动画失败时仍提交状态；定时器只负责启动原生动画，不做逐帧刷新。
export function animate(update: () => void, animation = Animation.smooth({ duration: 0.35 })) {
  // withAnimation 的闭包可能延后执行，Promise 也可能异步 reject；
  // 用一次性守卫保证 update 恰好提交一次，避免状态被吞掉。
  let applied = false
  const commit = () => {
    if (applied) return
    applied = true
    update()
  }
  try { void withAnimation(animation, commit).catch(commit) }
  catch { commit() }
}

/** withAnimation 的闭包可能延后执行，状态提交时要重新核对查询轮次。 */
export function animateIfCurrent(isCurrent: () => boolean, update: () => void,
  animation = Animation.smooth({ duration: 0.35 })) {
  if (!isCurrent()) return
  animate(() => { if (isCurrent()) update() }, animation)
}

export function useEntrance(delay = 0) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => {
      try { setVisible(true) }
      catch (error) { console.log("[IP检测] 入场动画", String(error)) }
    }, 24 + delay)
    return () => clearTimeout(timer)
  }, [])
  return visible
}

/** 面板入场延时钩子：所有“挂载后延迟转为可见”的动画共用同一实现。 */

/** 连续面板中的色带分区，无独立圆角、阴影或外边距。iconEffect 让图标换形时额外弹一下。 */
export function Band({ title, icon, hint, accessory, shaded = false, order = 0, iconEffect = false, children }: {
  title?: string; icon?: string; hint?: string; accessory?: VirtualNode | null; shaded?: boolean; order?: number
  iconEffect?: boolean
  children?: VirtualNode | (VirtualNode | VirtualNode[] | null | undefined | false)[]
}) {
  const visible = useEntrance(order * 55)
  return (
    <VStack alignment="leading" spacing={title ? 10 : 0}
      padding={{ horizontal: 16, vertical: 15 }}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
      background={shaded ? BAND_BG : SURFACE}>
      {title ? <VStack alignment="leading" spacing={9} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <HStack spacing={9} alignment="center" frame={{ maxWidth: "infinity" }}>
          {icon ? <ZStack frame={{ width: 26, height: 26 }}
            background={{ style: ICON_CHIP, shape: { type: "rect", cornerRadius: 8 } }}
            overlay={<RoundedRectangle cornerRadius={8}
              stroke={{ shapeStyle: ICON_CHIP_EDGE, strokeStyle: { lineWidth: 1 } }} />}>
            <Image systemName={icon} font={12} fontWeight="semibold" foregroundStyle={ACCENT.blue}
              contentTransition="symbolEffectReplace"
              symbolEffect={iconEffect ? { effect: "bounce", value: icon, options: { speed: 1.4 } } : undefined}
              animation={{ animation: Animation.smooth({ duration: 0.24 }), value: icon }} />
          </ZStack> : null}
          <Text font={16} fontWeight="bold" foregroundStyle={CODE.value} lineLimit={1}
            minScaleFactor={0.8} fixedSize={{ horizontal: true, vertical: false }}
            contentTransition="opacity"
            animation={{ animation: Animation.smooth({ duration: 0.26 }), value: title || "" }}>{title}</Text>
          <Spacer />
          {hint ? <Text font={9} fontWeight="medium" foregroundStyle="secondaryLabel"
            lineLimit={1} minScaleFactor={0.75} contentTransition="opacity"
            animation={{ animation: Animation.smooth({ duration: 0.3 }), value: hint }}
            padding={{ horizontal: 7, vertical: 3 }}
            background={{ style: shaded ? SURFACE : BAND_BG, shape: { type: "rect", cornerRadius: 7 } }}
            overlay={<RoundedRectangle cornerRadius={7}
              stroke={{ shapeStyle: LINE, strokeStyle: { lineWidth: 1 } }} />}>{hint}</Text> : null}
          {accessory}
        </HStack>
        {/* 标题下的渐隐彩条：随分区入场从左侧生长，作为分区切换的视觉锚点。 */}
        <BandRule active={visible} />
      </VStack> : null}
      <VStack alignment="leading" spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }}
        opacity={visible ? 1 : 0} offset={{ x: 0, y: visible ? 0 : 7 }}
        animation={{ animation: Animation.easeOut(0.48), value: visible }}>
        {children}
      </VStack>
    </VStack>
  )
}

/** 面板切换时的入场：只挂载当前面板，靠显式进度做淡入与轻微上移。 */
export function Reveal({ children, distance = 9 }: {
  children?: VirtualNode | (VirtualNode | VirtualNode[] | null | undefined | false)[]
  distance?: number
}) {
  const visible = useEntrance()
  return <VStack alignment="leading" spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }}
    opacity={visible ? 1 : 0} offset={{ x: 0, y: visible ? 0 : distance }}
    animation={{ animation: Animation.easeOut(0.42), value: visible }}>
    {children}
  </VStack>
}

/** 分区标题下的细分隔线：底纹常驻，彩色渐变条随入场从左侧铺开。 */
function BandRule({ active }: { active: boolean }) {
  return <ZStack alignment="leading" frame={{ height: 2, maxWidth: "infinity" }}>
    <ZStack frame={{ height: 2, maxWidth: "infinity" }} background={LINE} opacity={0.6} />
    <ZStack frame={{ height: 2, maxWidth: "infinity" }} background={SPECTRUM}
      opacity={active ? 0.9 : 0} scaleEffect={active ? { x: 1, y: 1, anchor: "leading" } : { x: 0.02, y: 1, anchor: "leading" }}
      animation={{ animation: Animation.easeOut(0.62), value: active }} />
  </ZStack>
}

export function Row({ label, value, mono = false, color, children }: {
  label: string; value?: string; mono?: boolean; color?: Color | DynamicShapeStyle; children?: VirtualNode
}) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : !!children
  return <HStack spacing={10} alignment="top" padding={{ vertical: 6 }}
    frame={{ maxWidth: "infinity", alignment: "leading" }}>
    <Text font={13} foregroundStyle="secondaryLabel"
      frame={{ width: LABEL_WIDTH, alignment: "leading" }}>{label}</Text>
    {hasChildren ? children : <Text font={13} fontDesign={mono ? "monospaced" : undefined}
      foregroundStyle={color || (mono ? CODE.number : CODE.value)} contentTransition="opacity"
      animation={{ animation: Animation.easeOut(0.28), value: value || "" }}
      fixedSize={{ horizontal: false, vertical: true }}
      frame={{ maxWidth: "infinity", alignment: "leading" }}>{value || "—"}</Text>}
  </HStack>
}

/** 标签；文本改变时外圈短促亮一下，提示该属性刷新了。 */
export function Tag({ text, color = ACCENT.blue }: { text: string; color?: Color }) {
  const [flash, setFlash] = useState(false)
  const previous = useRef(text)
  useEffect(() => {
    if (previous.current === text) return
    previous.current = text
    setFlash(true)
    const timer = setTimeout(() => {
      try { setFlash(false) }
      catch (error) { console.log("[IP检测] 标签高亮", String(error)) }
    }, 620)
    return () => clearTimeout(timer)
  }, [text])
  return <Text font={11} fontWeight="semibold" foregroundStyle="#FFFFFF"
    padding={{ horizontal: 9, vertical: 4 }}
    background={{ style: color, shape: { type: "rect", cornerRadius: 6 } }}
    overlay={<RoundedRectangle cornerRadius={6}
      stroke={{ shapeStyle: color, strokeStyle: { lineWidth: 1.4 } }}
      opacity={flash ? 0 : 0.7} scaleEffect={flash ? 1.5 : 1}
      animation={{ animation: Animation.easeOut(0.62), value: flash }} />}
    contentTransition="opacity"
    animation={{ animation: Animation.easeOut(0.36), value: text }}>{text}</Text>
}

/** 仅在阳性命中时挂载：整行弹入，标签外圈循环扫出一道光环。 */
export function FlagRow({ label, delay = 0, color = ACCENT.orange }: {
  label: string; delay?: number; color?: Color
}) {
  // 弹入定时器与 useEntrance 相同（挂载后延迟置 true），直接复用。
  const shown = useEntrance(delay)
  return <HStack spacing={10} alignment="top" padding={{ vertical: 6 }}
    frame={{ maxWidth: "infinity", alignment: "leading" }}
    opacity={shown ? 1 : 0} offset={{ x: shown ? 0 : -12, y: 0 }} scaleEffect={shown ? 1 : 0.96}
    accessibilityLabel={`${label} 已标记`}>
    <Text font={13} foregroundStyle="secondaryLabel"
      frame={{ width: LABEL_WIDTH, alignment: "leading" }}>{label}</Text>
    <Text font={11} fontWeight="semibold" foregroundStyle="#FFFFFF"
      padding={{ horizontal: 9, vertical: 4 }}
      background={{ style: color, shape: { type: "rect", cornerRadius: 6 } }}
      overlay={<RoundedRectangle cornerRadius={6}
        stroke={{ shapeStyle: color, strokeStyle: { lineWidth: 1 } }}
        opacity={shown ? 0 : 0.55} scaleEffect={shown ? 1.55 : 1}
        animation={{ animation: Animation.easeOut(1.05).repeatForever(false), value: shown }} />}
      opacity={shown ? 1 : 0} scaleEffect={shown ? 1 : 0.7}
      animation={{ animation: Animation.spring({ duration: 0.46, bounce: 0.24 }), value: shown }}>
      已标记
    </Text>
  </HStack>
}

export function Note({ text }: { text: string }) {
  return <Text font={10} foregroundStyle="secondaryLabel" lineSpacing={3}
    fixedSize={{ horizontal: false, vertical: true }} padding={{ top: 7 }}>{text}</Text>
}

export function IconButton({ icon, label, action, active = false, disabled = false, iconSize = 14, pressed = false }: {
  icon: string; label: string; action: () => void; active?: boolean; disabled?: boolean
  iconSize?: number; pressed?: boolean
}) {
  return <Button action={action} buttonStyle="plain" disabled={disabled} accessibilityLabel={label}>
    <Image systemName={icon} font={iconSize} fontWeight="medium" contentTransition="symbolEffectReplace"
      foregroundStyle={active || pressed ? ACCENT.teal : "secondaryLabel"}
      frame={{ width: 34, height: 34 }}
      background={{ style: BAND_BG, shape: { type: "rect", cornerRadius: 8 } }}
      overlay={<RoundedRectangle cornerRadius={8}
        stroke={{ shapeStyle: LINE, strokeStyle: { lineWidth: 1 } }} />}
      scaleEffect={pressed ? 0.78 : 1}
      animation={{ animation: Animation.snappy({ duration: 0.18 }), value: pressed }} />
  </Button>
}

function Sweep() {
  const visible = useEntrance()
  return <HStack spacing={0} frame={{ maxWidth: "infinity", height: 3 }}>
    <GeometryReader>{({ size }) => <ZStack alignment="leading" frame={{ width: size.width, height: 3 }}>
      <ZStack frame={{ width: 110, height: 3 }} background={SPECTRUM}
        offset={{ x: visible ? size.width : -110, y: 0 }}
        animation={{ animation: Animation.linear(1.5).repeatForever(false), value: visible }} />
    </ZStack>}</GeometryReader>
  </HStack>
}

/** 扫描态与完成态交叉淡入：进度条不突然跳回静态渐变。 */
export function ScanLine({ active }: { active: boolean }) {
  return <Rectangle fill={LINE} frame={{ height: 3 }} clipped
    overlay={<ZStack frame={{ maxWidth: "infinity", height: 3 }}>
      <Rectangle fill={SPECTRUM} frame={{ height: 3 }}
        opacity={active ? 0 : 0.75}
        scaleEffect={active ? { x: 0.24, y: 1, anchor: "leading" } : { x: 1, y: 1, anchor: "leading" }}
        animation={{ animation: Animation.easeOut(0.62), value: active }} />
      {active ? <Sweep /> : null}
    </ZStack>} />
}

export function StatusDot({ active, color }: { active: boolean; color: Color }) {
  const visible = useEntrance()
  return <ZStack frame={{ width: 14, height: 14 }}>
    {active ? <ZStack frame={{ width: 13, height: 13 }} background={color} clipShape="circle"
      opacity={visible ? 0.12 : 0.4} scaleEffect={visible ? 1 : 0.65}
      animation={{ animation: Animation.easeIn(1).repeatForever(true), value: visible }} /> : null}
    <ZStack frame={{ width: 6, height: 6 }} background={color} clipShape="circle" />
  </ZStack>
}

function riskColor(value: number): Color {
  return value >= 70 ? ACCENT.red : value >= 50 ? ACCENT.orange : value >= 40 ? ACCENT.amber
    : value >= 25 ? "#88B82C" : value >= 15 ? ACCENT.green : "#268C62"
}
function riskLabel(value: number): string {
  return value >= 70 ? "高风险" : value >= 50 ? "中度风险" : value >= 25 ? "轻度风险" : "低风险"
}

const RISK_MOVEMENT = Animation.easeOut(1.8)
// 系统版本可能带前缀或补丁号，取第一段数字即可判断 API 是否可用。
const SYSTEM_MAJOR = Number((String(Device.systemVersion).match(/\d+/) || ["0"])[0]) || 0
const SCROLL_VISIBILITY_SUPPORTED = SYSTEM_MAJOR >= 18
// 刻度取值固定，提到模块级避免每次渲染重建数组。
const RISK_MARKS = [0, 15, 25, 40, 50, 70, 100] as const
const RISK_COLORS: Color[] = ["#268C62", "#28B982", "#91CA2D", "#E9BE2B", "#F08335", "#E64F67"]

/** 气泡、指针、刻度均按实际百分比定位，0 和 100 时也不越界。 */
export function RiskScale({ value }: { value: number }) {
  const score = Math.max(0, Math.min(100, value))
  const [position, setPosition] = useState(0)
  const [visible, setVisible] = useState(!SCROLL_VISIBILITY_SUPPORTED)
  const entered = useRef(!SCROLL_VISIBILITY_SUPPORTED)
  useEffect(() => {
    // 兜底：回调可能因首次渲染已在视口内而不触发，避免数值显示真实分数、指针却停在 0%。
    if (visible) return
    const timer = setTimeout(() => {
      try { setVisible(true) }
      catch (error) { console.log("[IP检测] 风险条可见性", String(error)) }
    }, 750)
    return () => clearTimeout(timer)
  }, [visible])
  useEffect(() => {
    if (!visible) return
    // 进入屏幕后先呈现起点；GeometryReader 的位移由显式 animation 插值。
    const timer = setTimeout(() => {
      try { animate(() => setPosition(score), RISK_MOVEMENT) }
      catch (error) { console.log("[IP检测] 风险动画", String(error)) }
    }, 120)
    return () => clearTimeout(timer)
  }, [score, visible])
  const marks = RISK_MARKS
  const colors = RISK_COLORS
  const tint = riskColor(score)
  // 三行各自占据真实高度；固定高度与弹性宽度分别约束，避免刻度溢出到下方 Note。
  return <VStack spacing={5}
    modifiers={modifiers().frame({ maxWidth: "infinity", alignment: "leading" }).padding({ top: 7, bottom: 8 })}
    onScrollVisibilityChange={SCROLL_VISIBILITY_SUPPORTED ? {
      threshold: 0.35,
      onChanged: isVisible => {
        if (isVisible && !entered.current) {
          entered.current = true
          setVisible(true)
        }
      },
    } : undefined}
    accessibilityLabel={`风险分 ${Math.round(score)}，${riskLabel(score)}`}>
    <HStack spacing={0} modifiers={modifiers().frame({ height: 36, alignment: "topLeading" }).frame({ maxWidth: "infinity", alignment: "leading" })}>
      <GeometryReader>{({ size }) => {
        const width = Math.max(1, size.width)
        const x = width * position / 100
        const bubble = Math.min(132, width)
        const bubbleX = Math.max(0, Math.min(width - bubble, x - bubble / 2))
        return <ZStack alignment="topLeading" frame={{ width, height: 36, alignment: "topLeading" }}>
          <Text font={12} fontWeight="bold" foregroundStyle="#FFFFFF" contentTransition="numericText"
            frame={{ width: bubble, height: 28 }}
            background={{ style: tint, shape: { type: "rect", cornerRadius: 7 } }}
            shadow={{ color: "rgba(45,60,80,0.12)", radius: 5, y: 2 }}
            offset={{ x: bubbleX, y: 0 }}
            animation={{ animation: RISK_MOVEMENT, value: position }}>{`${Math.round(score)}%  ${riskLabel(score)}`}</Text>
          <ZStack frame={{ width: 7, height: 7 }} background={tint} rotationEffect={45}
            offset={{ x: Math.max(0, Math.min(width - 7, x - 3.5)), y: 27 }}
            animation={{ animation: RISK_MOVEMENT, value: position }} />
        </ZStack>
      }}</GeometryReader>
    </HStack>
    <HStack spacing={0} modifiers={modifiers().frame({ height: 13, alignment: "leading" }).frame({ maxWidth: "infinity", alignment: "leading" })}>
      <GeometryReader>{({ size }) => {
        const width = Math.max(1, size.width)
        const x = width * position / 100
        return <ZStack alignment="leading" frame={{ width, height: 13 }}>
          <HStack spacing={0} frame={{ width, height: 7 }} clipShape="capsule">
            {colors.map((color, i) => <ZStack key={i}
              frame={{ width: width * (marks[i + 1] - marks[i]) / 100, height: 7 }} background={color} />)}
          </HStack>
          <ZStack frame={{ width: 3, height: 13 }} background={SURFACE} clipShape="capsule"
            offset={{ x: Math.max(0, Math.min(width - 3, x - 1.5)), y: 0 }}
            animation={{ animation: RISK_MOVEMENT, value: position }} />
        </ZStack>
      }}</GeometryReader>
    </HStack>
    <HStack spacing={0} modifiers={modifiers().frame({ height: 14, alignment: "topLeading" }).frame({ maxWidth: "infinity", alignment: "leading" })}>
      <GeometryReader>{({ size }) => {
        const width = Math.max(1, size.width)
        return <ZStack alignment="topLeading" frame={{ width, height: 14, alignment: "topLeading" }}>
          {marks.map(mark => <Text key={mark} font={9} monospacedDigit foregroundStyle="secondaryLabel"
            frame={{ width: 25, height: 14 }}
            offset={{ x: Math.max(0, Math.min(width - 25, width * mark / 100 - 12.5)), y: 0 }}>{mark}</Text>)}
        </ZStack>
      }}</GeometryReader>
    </HStack>
  </VStack>
}
