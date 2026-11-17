import {
  AbortController, Button, Canvas, GeometryReader, HStack, Image, RoundedRectangle,
  Spacer, Text, TimelineCanvas, VStack, ZStack, gradient, modifiers, useEffect, useRef, useState,
  useColorScheme,
} from "scripting"
import type { CanvasRenderingContext, Color } from "scripting"
import { ACCENT, BAND_BG, CODE, LINE, Note, SURFACE, tinted } from "./theme"
import {
  EMPTY_SPEED, SPEED_BUDGET, SPEED_NODE, advanceTimeline, approach, formatMbps, formatTraffic,
  linkKind, loadSpeedRecord, niceMax, peakSpeed, phaseLabel, recordFromState, runSpeedTest,
  samplesOf, saveSpeedRecord, speedGrade, steadySpeed,
} from "./utils/speedtest"
import type { SpeedPhase, SpeedRecord, SpeedSample, SpeedTestState } from "./utils/speedtest"

const STAGE_HEIGHT = 274
const DOWN_TINT: Color[] = ["#16B8A6", "#279FC5", "#6E8BE8"]
const UP_TINT: Color[] = ["#8673E8", "#A868D8", "#F06591"]
const ERROR_TINT: Color[] = ["#E64F67", "#F08335", "#D6A013"]

function tintOf(phase: SpeedPhase): Color[] {
  if (phase === "upload") return UP_TINT
  if (phase === "error") return ERROR_TINT
  return DOWN_TINT
}
function timeLabel(at: number): string {
  const date = new Date(at), now = new Date()
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
  return date.toDateString() === now.toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`
}
function trafficParts(bytes: number): { value: string; unit: string } {
  if (!Number.isFinite(bytes) || bytes <= 0) return { value: "0.00", unit: "MB" }
  const [value, unit] = formatTraffic(bytes).split(" ")
  return { value, unit: unit || "MB" }
}

/** 仪表：刻度环、渐隐轨道、进度弧、端点脉冲、扫掠高光与沿弧粒子。 */
function drawGauge(ctx: CanvasRenderingContext, size: { width: number; height: number }, time: number, options: {
  value: number; max: number; tint: Color[]; dark: boolean; running: boolean; phase: SpeedPhase
  smoother: { value: number; at: number }
}) {
  const { value, max, tint, dark, running, phase, smoother } = options
  const width = Math.max(1, size.width), height = Math.max(1, size.height)
  ctx.clearRect(0, 0, width, height)
  const cx = width / 2
  // 圆心略低于舞台中心，给顶部链路标签留白；数值层使用同一圆心。
  const cy = height * 0.505
  const r = Math.max(56, Math.min(width * 0.355, 98))
  const START = Math.PI * 0.75, SWEEP = Math.PI * 1.5
  const target = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0
  // 弧长按时间常数追随采样值：帧率变化不影响观感，也不会随采样跳格。
  if (!Number.isFinite(smoother.value)) { smoother.value = target; smoother.at = time }
  const delta = Math.min(0.25, Math.max(0, time - smoother.at))
  smoother.at = time
  smoother.value = approach(smoother.value, target, delta, running ? 7.5 : 5)
  const ratio = Math.max(0, Math.min(1, smoother.value))
  const track = dark ? "rgba(150,198,228,0.15)" : "rgba(36,86,118,0.10)"
  const tick = dark ? "rgba(160,208,238,0.40)" : "rgba(36,86,118,0.26)"

  const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 1.02)
  halo.addColorStop(0, tinted(tint[1], dark ? 0.20 : 0.11))
  halo.addColorStop(1, tinted(tint[1], 0))
  ctx.fillStyle = halo
  ctx.beginPath()
  ctx.arc(cx, cy, r * 1.02, 0, Math.PI * 2)
  ctx.fill()

  ctx.strokeStyle = tick
  ctx.lineWidth = 1.2
  ctx.lineCap = "round"
  for (let index = 0; index <= 54; index++) {
    const angle = START + SWEEP * index / 54
    const major = index % 9 === 0
    const inner = r + 9, outer = r + (major ? 16 : 12)
    ctx.beginPath()
    ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner)
    ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer)
    ctx.stroke()
  }

  ctx.strokeStyle = track
  ctx.lineWidth = 9
  ctx.beginPath()
  ctx.arc(cx, cy, r, START, START + SWEEP)
  ctx.stroke()

  ctx.strokeStyle = dark ? "rgba(150,198,228,0.10)" : "rgba(36,86,118,0.06)"
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.arc(cx, cy, Math.max(10, r - 16), START, START + SWEEP)
  ctx.stroke()

  if (ratio > 0.004) {
    const grad = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r)
    grad.addColorStop(0, tint[0])
    grad.addColorStop(0.55, tint[1])
    grad.addColorStop(1, tint[2])
    ctx.strokeStyle = grad
    ctx.lineWidth = 9
    ctx.lineCap = "round"
    ctx.shadowColor = tinted(tint[1], 0.45)
    ctx.shadowBlur = 14
    ctx.beginPath()
    ctx.arc(cx, cy, r, START, START + SWEEP * ratio)
    ctx.stroke()
    ctx.shadowBlur = 0

    const end = START + SWEEP * ratio
    const px = cx + Math.cos(end) * r, py = cy + Math.sin(end) * r
    const pulse = 0.5 + 0.5 * Math.sin(time * 3.2)
    ctx.fillStyle = tinted(tint[1], dark ? 0.16 + 0.16 * pulse : 0.12 + 0.14 * pulse)
    ctx.beginPath()
    ctx.arc(px, py, 9 + pulse * 5, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = dark ? "#F4FBFF" : "#FFFFFF"
    ctx.beginPath()
    ctx.arc(px, py, 4, 0, Math.PI * 2)
    ctx.fill()
  }

  if (running) {
    const head = START + ((time * 0.24) % 1) * SWEEP
    const sweep = ctx.createLinearGradient(cx - r, cy, cx + r, cy)
    sweep.addColorStop(0, tinted(tint[1], 0))
    sweep.addColorStop(1, tinted(tint[1], dark ? 0.5 : 0.34))
    ctx.strokeStyle = sweep
    ctx.lineWidth = 9
    ctx.lineCap = "round"
    ctx.beginPath()
    ctx.arc(cx, cy, r, head - 0.22, head)
    ctx.stroke()

    const span = Math.max(0.04, ratio)
    for (let index = 0; index < 9; index++) {
      const position = ((time * 0.17 + index / 9) % 1) * span
      const angle = START + SWEEP * position
      const radius = r + (index % 2 === 0 ? 7 : -7)
      ctx.fillStyle = tinted(tint[index % 3], 0.55)
      ctx.beginPath()
      ctx.arc(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, index % 2 === 0 ? 2.2 : 1.4, 0, Math.PI * 2)
      ctx.fill()
    }
  } else {
    const pulse = 0.5 + 0.5 * Math.sin(time * 1.9)
    const angle = START + SWEEP * ratio
    ctx.fillStyle = tinted(tint[1], 0.16 + 0.22 * pulse)
    ctx.beginPath()
    ctx.arc(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r, 6 + pulse * 4, 0, Math.PI * 2)
    ctx.fill()
  }

  if (phase === "latency") {
    // 时延阶段的声呐环，与数字同轴向外扩散。
    for (let index = 0; index < 3; index++) {
      const progress = (time * 0.42 + index / 3) % 1
      ctx.strokeStyle = tinted(tint[1], 0.30 * (1 - progress))
      ctx.lineWidth = 1.3
      ctx.beginPath()
      ctx.arc(cx, cy, r * (0.2 + 0.68 * progress), 0, Math.PI * 2)
      ctx.stroke()
    }
  }
}

/** 实时曲线：时间轴窗口逐帧滚动，采样连线做低通，端点与纵轴上限均按时间常数追随，避免跳格。 */
type ChartSmoother = {
  last: number | null; at: number; peak: number | null
  heads: Record<"download" | "upload", number | null>
}
function drawChart(ctx: CanvasRenderingContext, size: { width: number; height: number },
  samples: readonly SpeedSample[], dark: boolean, time: number, smoother: ChartSmoother) {
  const width = Math.max(1, size.width), height = Math.max(1, size.height)
  ctx.clearRect(0, 0, width, height)
  ctx.strokeStyle = dark ? "rgba(150,198,228,0.12)" : "rgba(36,86,118,0.08)"
  ctx.lineWidth = 1
  for (let index = 1; index <= 3; index++) {
    const y = Math.round(height * index / 4) + 0.5
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(width, y)
    ctx.stroke()
  }
  if (!samples.length) {
    smoother.last = null
    smoother.peak = null
    smoother.heads.download = null
    smoother.heads.upload = null
    return
  }

  const rawLast = samples.reduce((value, sample) => Math.max(value, sample.t), 0)
  const rawPeak = Math.max(1, ...samples.map(sample => sample.mbps))
  // 右边界的时间按真实时间推进，新采样便从右侧滑入，而不是整条曲线瞬间跳位。
  if (smoother.last == null || smoother.at <= 0 || rawLast < smoother.last) {
    smoother.last = rawLast
    smoother.peak = rawPeak
    smoother.at = time
  }
  const delta = Math.min(0.3, Math.max(0, time - smoother.at))
  smoother.at = time
  // 时间轴按真实时间推进，采样稍晚到达时略快追平。
  smoother.last = advanceTimeline(smoother.last, rawLast, delta)
  smoother.peak = approach(smoother.peak ?? rawPeak, rawPeak, delta, rawPeak > (smoother.peak ?? 1) ? 9 : 2.4)

  const last = smoother.last
  const span = Math.max(6, Math.min(14, last))
  const from = Math.max(0, last - span)
  const peak = Math.max(1, smoother.peak)
  // 尚未滑入的新点夹在右边缘，避免离屏绘制；左端超出窗口的部分交给画布裁切。
  const xOf = (t: number) => Math.min(width - 2, width - 2 - ((last - t) / span) * (width - 4))
  const yOf = (value: number) => height - 3 - Math.max(0, value) / peak * (height - 11)

  const series: { phase: "download" | "upload"; tint: Color }[] = [
    { phase: "download", tint: DOWN_TINT[1] },
    { phase: "upload", tint: UP_TINT[0] },
  ]
  for (const row of series) {
    const points = samplesOf(samples, row.phase).filter(sample => sample.t >= from)
    if (!points.length) continue
    // 采样间隔约 150 ms；先做一次低通，去掉单点尖峰造成的硬折角。
    let value = points[0].mbps
    const coords = points.map(sample => {
      value += (sample.mbps - value) * 0.42
      return { x: xOf(sample.t), y: yOf(value) }
    })
    const lastSample = points[points.length - 1]
    const target = lastSample.mbps
    const previous = smoother.heads[row.phase]
    const live = approach(previous ?? target, target, delta, 8)
    smoother.heads[row.phase] = live
    const head = { x: xOf(lastSample.t), y: yOf(live) }
    const body = coords.length > 1 ? coords.slice(0, -1) : []

    const trace = () => {
      if (!body.length) { ctx.moveTo(head.x, head.y); return }
      ctx.moveTo(body[0].x, body[0].y)
      for (let index = 1; index < body.length - 1; index++) {
        const current = body[index], next = body[index + 1]
        ctx.quadraticCurveTo(current.x, current.y, (current.x + next.x) / 2, (current.y + next.y) / 2)
      }
      // 末段用三次曲线过渡到头部实时值，接点处切线连续。
      const pivotPoint = body[body.length - 1]
      const before = body.length > 1 ? body[body.length - 2] : { x: pivotPoint.x - 12, y: pivotPoint.y }
      ctx.bezierCurveTo((before.x + pivotPoint.x) / 2, before.y, (pivotPoint.x + head.x) / 2, head.y, head.x, head.y)
    }

    if (coords.length > 1) {
      const area = ctx.createLinearGradient(0, 0, 0, height)
      area.addColorStop(0, tinted(row.tint, dark ? 0.30 : 0.20))
      area.addColorStop(1, tinted(row.tint, 0))
      ctx.fillStyle = area
      ctx.beginPath()
      const startX = body.length ? body[0].x : head.x
      ctx.moveTo(startX, height)
      ctx.lineTo(startX, body.length ? body[0].y : head.y)
      trace()
      ctx.lineTo(head.x, height)
      ctx.closePath()
      ctx.fill()

      ctx.strokeStyle = row.tint
      ctx.lineWidth = 2
      ctx.lineCap = "round"
      ctx.lineJoin = "round"
      ctx.shadowColor = tinted(row.tint, 0.45)
      ctx.shadowBlur = 6
      ctx.beginPath()
      trace()
      ctx.stroke()
      ctx.shadowBlur = 0
    }

    // 头部光晕按帧呼吸，作为“正在采样”的锚点。
    const breath = 0.5 + 0.5 * Math.sin(time * 3.6)
    ctx.fillStyle = tinted(row.tint, 0.16 + 0.10 * breath)
    ctx.beginPath()
    ctx.arc(head.x, head.y, 5.2 + breath * 2.6, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = row.tint
    ctx.beginPath()
    ctx.arc(head.x, head.y, 2.4, 0, Math.PI * 2)
    ctx.fill()
  }
}

function LinkChip({ kind, tint }: { kind: string; tint: Color }) {
  const link = linkKind(kind)
  return <HStack spacing={4} padding={{ horizontal: 7, vertical: 3 }}
    background={{ style: tinted(tint, 0.14), shape: { type: "capsule", style: "continuous" } }}>
    <Image systemName={link.cellular ? "antenna.radiowaves.left.and.right" : "wifi"} font={9} foregroundStyle={tint} />
    <Text font={10} fontWeight="semibold" foregroundStyle={tint}>{link.label}</Text>
  </HStack>
}

/**
 * 面板内的主操作：与分区标题图标按钮同尺寸（34×34）的图标按钮。
 * 待开始沿用标题图标按钮的底片（浅底 + 细描边 + 蓝色符号），不另造实心色块；
 * 只有进行中的停止态保留红色实心，作为唯一的高饱和提示。
 */
function RunButton({ running, showingLast, action }: {
  running: boolean; showingLast: boolean; action: () => void
}) {
  const label = running ? "停止测速" : showingLast ? "重新测速" : "开始测速"
  return <Button action={action} buttonStyle="plain" accessibilityLabel={label}>
    <ZStack frame={{ width: 34, height: 34 }}
      background={{ style: running ? ACCENT.red : BAND_BG, shape: { type: "rect", cornerRadius: 8 } }}
      overlay={<ZStack>
        {/* 静默描边：与分区图标按钮完全同款，待开始时常驻。 */}
        <RoundedRectangle cornerRadius={8}
          stroke={{ shapeStyle: LINE, strokeStyle: { lineWidth: 1 } }}
          opacity={running ? 0 : 1} />
        {/* 进行中的红色脉冲环，沿用原来的呼吸效果。 */}
        <RoundedRectangle cornerRadius={8}
          stroke={{ shapeStyle: tinted(ACCENT.red, 0.5), strokeStyle: { lineWidth: 1 } }}
          opacity={running ? 1 : 0}
          scaleEffect={running ? 1 : 1.22}
          animation={{ animation: running ? Animation.easeOut(0.95).repeatForever(true)
            : Animation.easeOut(0.24), value: running }} />
      </ZStack>}
      shadow={running ? { color: tinted(ACCENT.red, 0.3), radius: 7, y: 2 } : undefined}
      accessibilityLabel={label}>
      <Image systemName={running ? "stop.fill" : "play.fill"} font={14} fontWeight="medium"
        foregroundStyle={running ? "#FFFFFF" : ACCENT.blue} contentTransition="symbolEffectReplace"
        animation={{ animation: Animation.snappy({ duration: 0.22 }), value: running }} />
    </ZStack>
  </Button>
}

function Legend({ color, text }: { color: Color; text: string }) {
  return <HStack spacing={4}>
    <ZStack frame={{ width: 6, height: 6 }} background={color} clipShape="circle" />
    <Text font={9} foregroundStyle="secondaryLabel">{text}</Text>
  </HStack>
}

function MetricTile({ label, value, unit, note, tint, ratio, dim = false }: {
  label: string; value: string; unit: string; note: string; tint: Color; ratio: number; dim?: boolean
}) {
  return <VStack alignment="leading" spacing={5} padding={{ horizontal: 11, vertical: 10 }}
    frame={{ maxWidth: "infinity", alignment: "leading" }}
    background={{ style: SURFACE, shape: { type: "rect", cornerRadius: 12 } }}
    overlay={<RoundedRectangle cornerRadius={12}
      stroke={{ shapeStyle: LINE, strokeStyle: { lineWidth: 1 } }} />}>
    <HStack spacing={6} frame={{ maxWidth: "infinity" }}>
      <Text font={10} foregroundStyle="secondaryLabel">{label}</Text>
      <Spacer />
      <ZStack frame={{ width: 6, height: 6 }} background={dim ? LINE : tint} clipShape="circle" />
    </HStack>
    <HStack spacing={3} alignment="firstTextBaseline">
      <Text font={21} fontWeight="bold" fontDesign="rounded" lineLimit={1} minScaleFactor={0.6}
        foregroundStyle={dim ? "secondaryLabel" : CODE.value}
        contentTransition="numericText"
        animation={{ animation: Animation.smooth({ duration: 0.34 }), value }}>{value}</Text>
      <Text font={9} fontWeight="medium" foregroundStyle="secondaryLabel">{unit}</Text>
    </HStack>
    <Canvas opaque={false} modifiers={modifiers().frame({ height: 3 }).frame({ maxWidth: "infinity" })}
      draw={(ctx, size) => {
        const width = Math.max(1, size.width)
        ctx.clearRect(0, 0, width, 3)
        ctx.fillStyle = dim ? "rgba(130,155,175,0.18)" : "rgba(120,150,172,0.18)"
        ctx.fillRect(0, 1, width, 1.5)
        const filled = Math.max(0, Math.min(1, ratio)) * width
        if (dim || filled < 0.5) return
        const grad = ctx.createLinearGradient(0, 0, width, 0)
        grad.addColorStop(0, tinted(tint, 0.4))
        grad.addColorStop(1, tint)
        ctx.fillStyle = grad
        ctx.fillRect(0, 0.5, filled, 2)
      }} />
    <Text font={9} foregroundStyle="secondaryLabel" lineLimit={1} minScaleFactor={0.7}>{note}</Text>
  </VStack>
}

/** 测速面板：标题栏让位给外层分区切换，开始／停止成为面板内的主操作。 */
export function SpeedPanel({ kind, onRunningChange }: {
  kind: string; onRunningChange?: (running: boolean) => void
}) {
  const [state, setState] = useState<SpeedTestState>(() => ({ ...EMPTY_SPEED }))
  const [last, setLast] = useState<SpeedRecord | null>(() => loadSpeedRecord())
  const controller = useRef<AbortController | null>(null)
  const run = useRef(0)
  const mounted = useRef(true)
  // 逐帧平滑值放在 ref 里：Canvas 闭包不得读写 React 状态。
  const gaugeSmoother = useRef({ value: Number.NaN, at: 0 })
  const chartSmoother = useRef<ChartSmoother>({
    last: null, at: 0, peak: null, heads: { download: null, upload: null },
  })

  useEffect(() => () => {
    mounted.current = false
    run.current++
    controller.current?.abort()
  }, [])

  const running = state.phase === "latency" || state.phase === "download" || state.phase === "upload"
  const idle = state.phase === "idle"
  // 回调可能随父组件重渲染变化；用 ref 保持最新引用，卸载时才能可靠复位。
  const runningNotify = useRef(onRunningChange)
  runningNotify.current = onRunningChange
  // 折叠面板会卸载并中止测速；把进行状态交给外层，标题栏才能如实提示。
  useEffect(() => { runningNotify.current?.(running) }, [running])
  useEffect(() => () => {
    // 卸载时测速已被中止；不通知外层会留下永久“测速中”的锁定状态。
    try { runningNotify.current?.(false) } catch (error) { console.log("[IP检测] 测速状态复位", String(error)) }
  }, [])
  const link = linkKind(kind)
  // 用 hook 读取，外观切换时 Canvas 的深浅配色会跟着重绘。
  const dark = useColorScheme() === "dark"
  const tint = tintOf(state.phase)
  const samples = state.samples
  const downloadPeak = peakSpeed(samplesOf(samples, "download"))
  const uploadPeak = peakSpeed(samplesOf(samples, "upload"))
  const download = state.download ?? (idle ? last?.download ?? null : null)
  const upload = state.upload ?? (idle ? last?.upload ?? null : null)
  const ping = state.ping ?? (idle ? last?.ping ?? null : null)
  const jitter = state.jitter ?? (idle ? last?.jitter ?? null : null)
  const loss = state.loss ?? (idle ? last?.loss ?? null : null)
  const bytes = state.bytes || (idle ? last?.bytes ?? 0 : 0)
  const showingLast = idle && last != null
  // 反向扫描避免每次渲染复制整个采样数组。
  const latest = (phase: "download" | "upload") => {
    for (let index = samples.length - 1; index >= 0; index--) {
      if (samples[index].phase === phase) return samples[index].mbps
    }
    return 0
  }
  const gaugeValue = state.phase === "download" ? latest("download")
    : state.phase === "upload" ? latest("upload")
      : state.phase === "latency" ? 0 : download ?? 0
  const gaugePeak = state.phase === "upload" ? Math.max(uploadPeak, upload ?? 0) : Math.max(downloadPeak, gaugeValue)
  const gaugeMax = niceMax(gaugePeak)
  const gaugeLabel = state.phase === "upload" ? "上传" : "下载"
  const stageNote = state.phase === "download" ? `峰值 ${formatMbps(downloadPeak)} Mbps`
    : state.phase === "upload" ? `峰值 ${formatMbps(uploadPeak)} Mbps`
      : state.phase === "latency" ? "测量往返时延与抖动"
        : state.phase === "done" ? `下载中位数 · 峰值 ${formatMbps(downloadPeak)} Mbps`
          : state.phase === "stopped" ? "已停止 · 保留已取得数据"
            : state.phase === "error" ? "未能连接测速节点"
              : showingLast ? `上次测速 · ${timeLabel(last!.at)}` : "点击开始按钮测速"
  const traffic = trafficParts(bytes)
  const downloadMax = niceMax(Math.max(downloadPeak, download ?? 0))
  const uploadMax = niceMax(Math.max(uploadPeak, upload ?? 0))
  const pingNote = ping == null ? (running ? "测量中" : "尚未取得")
    : `抖动 ${jitter == null ? "—" : `${Math.round(jitter)} ms`}${loss != null ? ` · 丢包 ${Math.round(loss * 100)}%` : ""}`

  async function start() {
    if (running) {
      // 中止时 runSpeedTest 在 aborted 后不再回调，必须由界面自己落定“已停止”，
      // 否则 phase 永远停在 download/upload，仪表持续扫掠且无法再次开始。
      run.current++
      controller.current?.abort()
      controller.current = null
      try {
        setState(previous => {
          if (previous.phase !== "latency" && previous.phase !== "download" && previous.phase !== "upload") return previous
          return {
            ...previous,
            download: previous.download ?? steadySpeed(previous.samples, "download"),
            upload: previous.upload ?? steadySpeed(previous.samples, "upload"),
            phase: "stopped",
            error: "",
          }
        })
      } catch (error) { console.log("[IP检测] 测速停止", String(error)) }
      return
    }
    const id = ++run.current
    const abort = new AbortController()
    controller.current = abort
    try { setState({ ...EMPTY_SPEED, phase: "latency", node: SPEED_NODE, startedAt: Date.now() }) }
    catch (error) { console.log("[IP检测] 测速状态初始化", String(error)) }
    try {
      const result = await runSpeedTest({
        signal: abort.signal,
        onUpdate: next => {
          if (!mounted.current || id !== run.current) return
          try { setState(next) }
          catch (error) { console.log("[IP检测] 测速界面更新", String(error)) }
        },
      })
      if (!mounted.current || id !== run.current) return
      try { setState(result) }
      catch (error) { console.log("[IP检测] 测速结果展示", String(error)) }
      const record = recordFromState(result, kind)
      if (record && saveSpeedRecord(record)) setLast(record)
    } catch (error) {
      if (!mounted.current || id !== run.current) return
      try { setState(previous => ({ ...previous, phase: "error", error: `测速意外中断：${String(error)}` })) }
      catch (updateError) { console.log("[IP检测] 测速异常展示", String(updateError)) }
    } finally {
      if (id === run.current) controller.current = null
    }
  }

  return <VStack alignment="leading" spacing={10} frame={{ maxWidth: "infinity", alignment: "leading" }}>
    <HStack spacing={8} alignment="center" frame={{ maxWidth: "infinity" }}>
      <LinkChip kind={kind} tint={tint[1]} />
      <VStack alignment="leading" spacing={1} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Text font={12} fontWeight="semibold" foregroundStyle={CODE.value} lineLimit={1}
          contentTransition="opacity">{phaseLabel(state.phase)}</Text>
        <Text font={9} foregroundStyle="secondaryLabel" lineLimit={1} minScaleFactor={0.8}>
          {`${SPEED_NODE}${showingLast ? ` · 上次 ${timeLabel(last!.at)}` : running ? " · 实时采样" : " · 本机链路"}`}
        </Text>
      </VStack>
      <RunButton running={running} showingLast={showingLast} action={() => { void start() }} />
    </HStack>
    <ZStack alignment="topLeading"
      modifiers={modifiers().frame({ height: STAGE_HEIGHT }).frame({ maxWidth: "infinity" })}
      background={{ style: gradient("linear", {
        colors: dark ? ["#0E1B25", "#0A141C"] : ["#F7FBFD", "#E5F0F7"],
        startPoint: "topLeading", endPoint: "bottomTrailing",
      }), shape: { type: "rect", cornerRadius: 16 } }}
      overlay={<RoundedRectangle cornerRadius={16}
        stroke={{ shapeStyle: dark ? "rgba(110,160,190,0.24)" : "rgba(70,120,150,0.16)",
          strokeStyle: { lineWidth: 1 } }} />}
      accessibilityLabel={`测速仪表，${phaseLabel(state.phase)}`}>
      <GeometryReader>{({ size }) => {
        const radius = Math.max(56, Math.min(size.width * 0.355, 98))
        const centerY = size.height * 0.505
        return <ZStack alignment="topLeading" frame={{ width: size.width, height: size.height }}>
          <TimelineCanvas opaque={false} schedule={{ minimumInterval: running ? 1 / 30 : 1 / 12 }}
            modifiers={modifiers().frame({ width: size.width, height: size.height })}
            draw={(ctx, canvasSize, time) => drawGauge(ctx, canvasSize, time, {
              value: gaugeValue, max: gaugeMax, tint, dark, running, phase: state.phase,
              smoother: gaugeSmoother.current,
            })} />
          <VStack spacing={2} frame={{ width: Math.min(size.width - 20, radius * 1.72), height: 104 }}
            offset={{ x: (size.width - Math.min(size.width - 20, radius * 1.72)) / 2, y: centerY - 52 }}>
            <Text font={9} fontWeight="semibold" foregroundStyle="secondaryLabel" kerning={1.6}>{gaugeLabel}</Text>
            <HStack spacing={4} alignment="firstTextBaseline">
              <Text font={38} fontWeight="bold" fontDesign="rounded" foregroundStyle={CODE.value}
                lineLimit={1} minScaleFactor={0.45} contentTransition="numericText"
                animation={{ animation: Animation.smooth({ duration: 0.3 }), value: gaugeValue }}>
                {state.phase === "latency" ? "—" : formatMbps(gaugeValue)}
              </Text>
              <Text font={10} fontWeight="medium" foregroundStyle="secondaryLabel">Mbps</Text>
            </HStack>
            <Text font={9} foregroundStyle={state.phase === "error" ? ACCENT.red : "secondaryLabel"}
              lineLimit={2} minScaleFactor={0.7} multilineTextAlignment="center"
              fixedSize={{ horizontal: false, vertical: true }}>{stageNote}</Text>
          </VStack>
          <Text font={9} fontWeight="medium" foregroundStyle="secondaryLabel" lineLimit={1} minScaleFactor={0.7}
            frame={{ width: size.width - 26, alignment: "center" }}
            offset={{ x: 13, y: centerY + radius * 0.62 }}>
            {state.phase === "latency" ? "声呐扫描 · 逐次探测"
              : running ? `实时 · 已用 ${formatTraffic(bytes)}`
                : state.phase === "done" ? `完成 · 下载 ${speedGrade(download)}`
                  : showingLast ? `上次测速结果 · ${link.label}` : `${link.label} · 待开始`}
          </Text>
        </ZStack>
      }}</GeometryReader>
    </ZStack>

    <VStack alignment="leading" spacing={7} padding={{ horizontal: 11, vertical: 10 }}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
      background={{ style: SURFACE, shape: { type: "rect", cornerRadius: 12 } }}
      overlay={<RoundedRectangle cornerRadius={12}
        stroke={{ shapeStyle: LINE, strokeStyle: { lineWidth: 1 } }} />}>
      <HStack spacing={8}>
        <Text font={11} fontWeight="semibold" foregroundStyle={CODE.value}>实时曲线</Text>
        <Legend color={DOWN_TINT[1]} text="下载" />
        <Legend color={UP_TINT[0]} text="上传" />
        <Spacer />
        <Text font={9} foregroundStyle="secondaryLabel">{`${samples.length} 采样`}</Text>
      </HStack>
      <ZStack alignment="leading" modifiers={modifiers().frame({ height: 48 }).frame({ maxWidth: "infinity" })}>
        <TimelineCanvas opaque={false} schedule={{ minimumInterval: running ? 1 / 30 : 1 / 10 }}
          modifiers={modifiers().frame({ height: 48 }).frame({ maxWidth: "infinity" })}
          draw={(ctx, size, time) => drawChart(ctx, size, samples, dark, time, chartSmoother.current)} />
        {samples.length === 0 ? <Text font={9} foregroundStyle="secondaryLabel" padding={{ horizontal: 2 }}>
          {running ? "等待第一个采样…" : "开始测速后显示实时速率"}
        </Text> : null}
      </ZStack>
    </VStack>

    <HStack alignment="top" spacing={8}>
      <MetricTile label="下载" value={formatMbps(download)} unit="Mbps" tint={DOWN_TINT[0]}
        ratio={(download ?? 0) / downloadMax} dim={download == null}
        note={download == null ? (running ? "测速中" : "尚未取得")
          : downloadPeak > 0 ? `峰值 ${formatMbps(downloadPeak)} Mbps`
            : `${speedGrade(download)} · ${showingLast ? "上次结果" : "本轮结果"}`} />
      <MetricTile label="上传" value={formatMbps(upload)} unit="Mbps" tint={UP_TINT[0]}
        ratio={(upload ?? 0) / uploadMax} dim={upload == null}
        note={upload == null ? (running ? "等待下载完成" : "尚未取得")
          : uploadPeak > 0 ? `峰值 ${formatMbps(uploadPeak)} Mbps`
            : `${speedGrade(upload)} · ${showingLast ? "上次结果" : "本轮结果"}`} />
    </HStack>
    <HStack alignment="top" spacing={8}>
      <MetricTile label="时延" value={ping == null ? "—" : String(Math.round(ping))} unit="ms"
        tint={ACCENT.blue} ratio={ping == null ? 0 : Math.max(0, Math.min(1, (260 - Math.min(260, ping)) / 260))}
        dim={ping == null} note={pingNote} />
      <MetricTile label="使用流量" value={traffic.value} unit={traffic.unit} tint={ACCENT.orange}
        ratio={bytes / (SPEED_BUDGET.downloadBytes + SPEED_BUDGET.uploadBytes)} dim={bytes === 0}
        note={bytes === 0 ? "仅测速时消耗" : showingLast ? "上次测速消耗" : "本次测速消耗"} />
    </HStack>

    {state.error ? <HStack spacing={6} alignment="top">
      <Image systemName="exclamationmark.circle" font={11} foregroundStyle={ACCENT.orange} />
      <Text font={10} foregroundStyle={ACCENT.orange} fixedSize={{ horizontal: false, vertical: true }}>{state.error}</Text>
    </HStack> : null}

    <Note text={`测速经由 ${SPEED_NODE} 公共节点，只测量当前链路（${link.label}）的下行与上行速率；结果受分流规则、节点拥塞与运营商影响，时延为 HTTP 往返耗时而非 ICMP ping。一次完整测速最多消耗约 ${formatTraffic(SPEED_BUDGET.downloadBytes + SPEED_BUDGET.uploadBytes)} 流量，可随时停止。`} />
  </VStack>
}