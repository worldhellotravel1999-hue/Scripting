import { AbortController, AbortSignal, fetch } from "scripting"

/** 主动测速：时延、下载、上传、流量与实时采样。只在本机当前链路上运行，不写共享快照。 */
export type SpeedPhase = "idle" | "latency" | "download" | "upload" | "done" | "stopped" | "error"
export type SpeedSample = { t: number; mbps: number; phase: "download" | "upload" }

export interface SpeedTestState {
  phase: SpeedPhase
  node: string
  ping: number | null
  jitter: number | null
  loss: number | null
  download: number | null
  upload: number | null
  samples: SpeedSample[]
  bytes: number
  startedAt: number
  elapsedMs: number
  error: string
}

export const SPEED_NODE = "Cloudflare"
const ENDPOINT = "https://speed.cloudflare.com"

/** 单次测速的流量与时长上限；按钮可随时中止。 */
export const SPEED_BUDGET = {
  downloadBytes: 48 * 1024 * 1024,
  downloadMs: 6000,
  uploadBytes: 16 * 1024 * 1024,
  uploadMs: 6000,
  latencyProbes: 6,
  latencyTimeoutMs: 3500,
}

export const EMPTY_SPEED: SpeedTestState = {
  phase: "idle", node: SPEED_NODE, ping: null, jitter: null, loss: null,
  download: null, upload: null, samples: [], bytes: 0, startedAt: 0, elapsedMs: 0, error: "",
}

/** 比特率换算：byte×8 / ms / 1000 = Mbps。 */
export function mbpsFrom(bytes: number, ms: number): number {
  if (!Number.isFinite(bytes) || !Number.isFinite(ms) || bytes <= 0 || ms <= 0) return 0
  return bytes * 8 / ms / 1000
}

export function formatMbps(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return "—"
  if (value >= 100) return value.toFixed(1).replace(/\.0$/, "")
  if (value >= 10) return value.toFixed(1)
  return value.toFixed(2)
}

export function formatTraffic(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB"
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function phaseLabel(phase: SpeedPhase): string {
  switch (phase) {
    case "latency": return "测试时延"
    case "download": return "下载测速中"
    case "upload": return "上传测速中"
    case "done": return "测速完成"
    case "stopped": return "已停止"
    case "error": return "测速失败"
    default: return "等待测速"
  }
}

export function median(values: readonly number[]): number {
  const rows = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b)
  if (!rows.length) return 0
  const middle = Math.floor(rows.length / 2)
  return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2
}

/** 取成功请求的最小时延；抖动取相邻成功样本差的中位数，失败计入丢包。 */
export function summarizeLatency(samples: readonly (number | null)[]): {
  min: number | null; jitter: number | null; loss: number
} {
  const ok = samples.filter((value): value is number => value != null && Number.isFinite(value) && value >= 0)
  if (!samples.length) return { min: null, jitter: null, loss: 0 }
  const loss = (samples.length - ok.length) / samples.length
  if (!ok.length) return { min: null, jitter: null, loss: 1 }
  const diffs: number[] = []
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1], current = samples[index]
    if (previous == null || current == null) continue
    diffs.push(Math.abs(current - previous))
  }
  return { min: Math.min(...ok), jitter: diffs.length ? median(diffs) : 0, loss }
}

export function samplesOf(samples: readonly SpeedSample[], phase: "download" | "upload"): SpeedSample[] {
  return samples.filter(sample => sample.phase === phase)
}

/** 丢弃预热段后取中位数，避免首包建连与瞬时抖动主导结果。 */
export function steadySpeed(samples: readonly SpeedSample[], phase: "download" | "upload"): number | null {
  const rows = samplesOf(samples, phase).filter(sample => Number.isFinite(sample.mbps) && sample.mbps >= 0)
  if (!rows.length) return null
  const first = rows[0].t, last = rows[rows.length - 1].t
  const warm = first + Math.max(0, last - first) * 0.4
  const steady = rows.filter(sample => sample.t >= warm)
  return median((steady.length ? steady : rows).map(sample => sample.mbps))
}

export function peakSpeed(samples: readonly SpeedSample[]): number {
  return samples.reduce((peak, sample) => Number.isFinite(sample.mbps) ? Math.max(peak, sample.mbps) : peak, 0)
}

/** 仪表上限取 1／1.5／2／3／3.5／4／5／8×10ⁿ，让指针停留在合理位置。 */
export function niceMax(value: number): number {
  const target = Math.max(0, Number.isFinite(value) ? value : 0)
  if (target <= 0) return 1
  const ladder = [1, 1.5, 2, 3, 3.5, 4, 5, 8, 10]
  let scale = Math.pow(10, Math.floor(Math.log10(target)))
  let normalized = target / scale
  let index = ladder.findIndex(step => normalized <= step + 1e-9)
  if (index < 0) index = ladder.length - 1
  // 指针顶到弧线末端时升一档，留出可见余量。
  if (target >= ladder[index] * scale * 0.995) {
    if (index < ladder.length - 1) index++
    else { index = 0; scale *= 10 }
  }
  return Math.max(1, ladder[index] * scale)
}

/**
 * 逐帧指数平滑：按真实经过时间逼近目标值。
 * 掉帧时自动走得更远，所以观感不随帧率改变。
 */
export function approach(current: number, target: number, seconds: number, rate: number): number {
  if (!Number.isFinite(current)) return target
  if (!Number.isFinite(target)) return current
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(rate) || rate <= 0) return current
  return current + (target - current) * (1 - Math.exp(-seconds * rate))
}

/**
 * 曲线时间轴：按真实时间向前推进，采样稍晚到达时略快追平，避免整条曲线随采样跳位。
 * 长时间停滞后直接对齐，采样回退（新一轮测速）重新同步。
 */
export function advanceTimeline(current: number | null, raw: number, seconds: number): number {
  if (current == null || !Number.isFinite(current) || current <= 0 || raw < current) return raw
  if (!Number.isFinite(raw)) return current
  if (!Number.isFinite(seconds) || seconds <= 0) return current
  const lag = raw - current
  if (lag <= 0) return current
  if (lag > 1.5) return raw
  return Math.min(raw, current + seconds * (1 + Math.min(5, Math.max(0, lag - 0.12) * 12)))
}

export function speedGrade(mbps: number | null | undefined): string {
  if (mbps == null || !Number.isFinite(mbps)) return "—"
  if (mbps >= 300) return "极快"
  if (mbps >= 100) return "很快"
  if (mbps >= 30) return "流畅"
  if (mbps >= 10) return "一般"
  return "较慢"
}

/** 本机接口名只用于说明当前链路，不代表测速请求一定走该接口。 */
export function linkKind(kind: string): { label: string; cellular: boolean } {
  if (/wi-?fi|en0/i.test(kind)) return { label: "Wi-Fi", cellular: false }
  if (/蜂窝|cellular|pdp_ip/i.test(kind)) return { label: "蜂窝数据", cellular: true }
  if (/其他/.test(kind)) return { label: "其他链路", cellular: false }
  return { label: kind && kind !== "未知" ? kind : "当前网络", cellular: false }
}

type Meter = { bytes: number }
type Progress = (sample: SpeedSample, totalBytes: number) => void

async function latencyProbe(signal: AbortSignal): Promise<number | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => { try { controller.abort() } catch {} }, SPEED_BUDGET.latencyTimeoutMs)
  const started = Date.now()
  try {
    const response = await fetch(`${ENDPOINT}/__down?bytes=0&_=${started}`, {
      headers: { "Cache-Control": "no-cache" },
      timeout: 5,
      signal: AbortSignal.any([signal, controller.signal]),
    })
    if (!response.ok) return null
    const ms = Date.now() - started
    // ReadableStream 本身没有 cancel；锁住 reader 再取消才能释放正文。
    try { await response.body.getReader().cancel() } catch {}
    return ms  } catch {
    return null
  } finally { clearTimeout(timer) }
}

/** 流式读取下载正文；按 150 ms 采样，达到字节或时长上限后取消剩余传输。 */
async function measureDownload(signal: AbortSignal, startedAt: number, meter: Meter, progress: Progress) {
  const samples: SpeedSample[] = []
  const controller = new AbortController()
  const timer = setTimeout(() => { try { controller.abort() } catch {} }, SPEED_BUDGET.downloadMs + 3000)
  const started = Date.now()
  let phaseBytes = 0, lastAt = started, lastBytes = 0
  try {
    const response = await fetch(`${ENDPOINT}/__down?bytes=${SPEED_BUDGET.downloadBytes}&_=${started}`, {
      headers: { "Cache-Control": "no-cache" },
      timeout: 22,
      signal: AbortSignal.any([signal, controller.signal]),
    })
    if (!response.ok) return { mbps: null, samples }
    const reader = response.body.getReader()
    try {
      while (!signal.aborted) {
        const now = Date.now()
        if (now - started >= SPEED_BUDGET.downloadMs) break
        const chunk = await reader.read()
        if (chunk.done) break
        const size = chunk.value?.byteLength ?? 0
        if (size <= 0) continue
        phaseBytes += size
        meter.bytes += size
        const at = Date.now()
        if (at - lastAt >= 150) {
          const sample: SpeedSample = { t: (at - startedAt) / 1000,
            mbps: mbpsFrom(phaseBytes - lastBytes, at - lastAt), phase: "download" }
          samples.push(sample)
          progress(sample, meter.bytes)
          lastAt = at
          lastBytes = phaseBytes
        }
        if (phaseBytes >= SPEED_BUDGET.downloadBytes) break
      }
    } finally { try { await reader.cancel() } catch {} }
  } catch {
    // 失败或取消时保留已观测的采样，由调用方判断是否有效。
  } finally { clearTimeout(timer) }
  const tailAt = Date.now()
  if (phaseBytes - lastBytes > 16_384 && tailAt - lastAt > 60) {
    const sample: SpeedSample = { t: (tailAt - startedAt) / 1000,
      mbps: mbpsFrom(phaseBytes - lastBytes, tailAt - lastAt), phase: "download" }
    samples.push(sample)
    progress(sample, meter.bytes)
  }
  return { mbps: phaseBytes >= 32 * 1024 ? steadySpeed(samples, "download") : null, samples }
}

let payloadBlock: Uint8Array | null = null
/** 随机分块拼接，避免全零正文被压缩或去重导致上传虚高。 */
function uploadPayload(size: number): Uint8Array {
  if (!payloadBlock) {
    payloadBlock = new Uint8Array(64 * 1024)
    for (let index = 0; index < payloadBlock.length; index++) payloadBlock[index] = (Math.random() * 256) | 0
  }
  const block = payloadBlock
  const payload = new Uint8Array(size)
  for (let offset = 0; offset < size; offset += block.length) {
    payload.set(block.subarray(0, Math.min(block.length, size - offset)), offset)
  }
  return payload
}

/** 上传进度无法逐块观测，按递增请求体积逐次采样；每个请求独立计时。 */
async function measureUpload(signal: AbortSignal, startedAt: number, meter: Meter, progress: Progress) {
  const samples: SpeedSample[] = []
  const started = Date.now()
  const sizes = [640 * 1024, 1536 * 1024, 3 * 1024 * 1024, 5 * 1024 * 1024, 5 * 1024 * 1024]
  let uploaded = 0, failures = 0
  // 无论成败都要释放响应体，否则连接会被占住直到超时。
  const discard = async (response: { body?: { getReader(): { cancel(): Promise<void> } } | null }) => {
    try { await response.body?.getReader().cancel() } catch {}
  }
  for (const size of sizes) {
    if (signal.aborted) break
    if (Date.now() - started >= SPEED_BUDGET.uploadMs || uploaded >= SPEED_BUDGET.uploadBytes) break
    const bytes = Math.min(size, SPEED_BUDGET.uploadBytes - uploaded)
    if (bytes < 128 * 1024) break
    const payload = uploadPayload(bytes)
    const controller = new AbortController()
    const timer = setTimeout(() => { try { controller.abort() } catch {} }, 12_000)
    const at = Date.now()
    try {
      const response = await fetch(`${ENDPOINT}/__up?_=${at}`, {
        method: "POST", body: payload,
        headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-cache" },
        timeout: 20,
        signal: AbortSignal.any([signal, controller.signal]),
      })
      const ms = Date.now() - at
      uploaded += bytes
      meter.bytes += bytes
      if (!response.ok) {
        await discard(response)
        failures++
        if (failures >= 2) break
        continue
      }
      await discard(response)
      const sample: SpeedSample = { t: (Date.now() - startedAt) / 1000, mbps: mbpsFrom(bytes, ms), phase: "upload" }
      samples.push(sample)
      progress(sample, meter.bytes)
      failures = 0
    } catch {
      // 取消或失败按可能已发出的正文计入流量，避免低报消耗。
      uploaded += bytes
      meter.bytes += bytes
      failures++
      if (signal.aborted || failures >= 2) break
    } finally { clearTimeout(timer) }
  }
  return { mbps: uploaded >= 256 * 1024 ? steadySpeed(samples, "upload") : null, samples }
}

/** 顺序执行三段；任何阶段中止都返回已取得的结果，由界面标注“已停止”。 */
export async function runSpeedTest(options: {
  signal: AbortSignal
  onUpdate: (state: SpeedTestState) => void
}): Promise<SpeedTestState> {
  const { signal, onUpdate } = options
  const startedAt = Date.now()
  const meter: Meter = { bytes: 0 }
  let state: SpeedTestState = { ...EMPTY_SPEED, phase: "latency", node: SPEED_NODE, startedAt }
  let lastEmit = 0
  const publish = (patch: Partial<SpeedTestState>, force = false) => {
    state = { ...state, ...patch, elapsedMs: Date.now() - startedAt }
    const at = Date.now()
    if (!force && at - lastEmit < 130) return
    lastEmit = at
    if (signal.aborted) return
    try { onUpdate(state) }
    catch (error) { console.log("[IP检测] 测速进度回调", String(error)) }
  }
  const finish = (phase: SpeedPhase, error = "") => {
    state = { ...state, phase, error, elapsedMs: Date.now() - startedAt }
    if (!signal.aborted) {
      try { onUpdate(state) }
      catch (callbackError) { console.log("[IP检测] 测速结果回调", String(callbackError)) }
    }
    return state
  }

  const pings: (number | null)[] = []
  for (let index = 0; index < SPEED_BUDGET.latencyProbes; index++) {
    if (signal.aborted) break
    const ping = await latencyProbe(signal)
    pings.push(ping)
    meter.bytes += 160
    const summary = summarizeLatency(pings)
    publish({ ping: summary.min, jitter: summary.jitter, loss: summary.loss, bytes: meter.bytes }, true)
  }
  if (signal.aborted) return finish("stopped")

  publish({ phase: "download" }, true)
  const download = await measureDownload(signal, startedAt, meter, (sample, total) => {
    publish({ samples: [...state.samples, sample], bytes: total })
  })
  publish({ download: signal.aborted ? null : download.mbps, bytes: meter.bytes }, true)
  if (signal.aborted) return finish("stopped")

  publish({ phase: "upload" }, true)
  const upload = await measureUpload(signal, startedAt, meter, (sample, total) => {
    publish({ samples: [...state.samples, sample], bytes: total })
  })
  publish({ upload: signal.aborted ? null : upload.mbps, bytes: meter.bytes }, true)
  if (signal.aborted) return finish("stopped")

  if (state.ping == null && state.download == null && state.upload == null) {
    return finish("error", "测速节点不可达，请检查网络连接或分流规则后重试。")
  }
  const note = state.download == null ? "下载测速未取得有效数据，结果可能受节点或分流影响。"
    : state.upload == null ? "上传测速未取得有效数据，下载结果仍可参考。" : ""
  return finish("done", note)
}

/** 最近一次测速只在本机保存；换 Wi-Fi／蜂窝后仍标注当时链路。 */
export interface SpeedRecord {
  download: number | null
  upload: number | null
  ping: number | null
  jitter: number | null
  loss: number | null
  bytes: number
  at: number
  node: string
  kind: string
}
const SPEED_KEY = "report-ip.speed.result.v1"
const finiteOrNull = (value: unknown, max: number): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : null

/** 只接受本项目写入的 schema；旧值或损坏值返回 null，界面回退为空状态。 */
export function parseSpeedRecord(raw: unknown): SpeedRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const at = value.at
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0 || at > Date.now() + 300_000) return null
  const download = finiteOrNull(value.download, 100_000), upload = finiteOrNull(value.upload, 100_000)
  if (download == null && upload == null && finiteOrNull(value.ping, 300_000) == null) return null
  const text = (item: unknown, length: number) => typeof item === "string" ? item.trim().slice(0, length) : ""
  return {
    download, upload, ping: finiteOrNull(value.ping, 300_000), jitter: finiteOrNull(value.jitter, 60_000),
    loss: finiteOrNull(value.loss, 1), bytes: finiteOrNull(value.bytes, 2e9) ?? 0, at,
    node: text(value.node, 40), kind: text(value.kind, 40),
  }
}

export function recordFromState(state: SpeedTestState, kind: string): SpeedRecord | null {
  if (state.phase !== "done") return null
  return { download: state.download, upload: state.upload, ping: state.ping, jitter: state.jitter,
    loss: state.loss, bytes: state.bytes, at: state.startedAt + state.elapsedMs, node: state.node, kind }
}

export function loadSpeedRecord(): SpeedRecord | null {
  try {
    const raw = Storage.get<unknown>(SPEED_KEY)
    return parseSpeedRecord(typeof raw === "string" ? JSON.parse(raw) : raw)
  } catch { return null }
}

export function saveSpeedRecord(record: SpeedRecord): boolean {
  try { return Storage.set(SPEED_KEY, record) }
  catch (error) { console.log("[IP检测] 测速结果保存失败", String(error)); return false }
}
