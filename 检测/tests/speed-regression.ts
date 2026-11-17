import { Script } from "scripting"
import {
  EMPTY_SPEED, SPEED_BUDGET, advanceTimeline, approach, formatMbps, formatTraffic, linkKind, mbpsFrom,
  median, niceMax, parseSpeedRecord, peakSpeed, phaseLabel, recordFromState, samplesOf, speedGrade,
  steadySpeed, summarizeLatency,
} from "../utils/speedtest"
import type { SpeedSample } from "../utils/speedtest"

// 离线回归：只测纯函数与内存夹具，不发起 fetch、不读写 Storage。
const failures: string[] = []
let passed = 0
function check(name: string, assertion: () => boolean) {
  try {
    if (!assertion()) throw new Error("断言失败")
    passed++
  } catch (error) { failures.push(`${name}: ${String(error)}`) }
}
const near = (value: number, expected: number, tolerance = 1e-9) => Math.abs(value - expected) <= tolerance
const sample = (t: number, mbps: number, phase: "download" | "upload" = "download"): SpeedSample => ({ t, mbps, phase })

check("字节毫秒换算为 Mbps", () => near(mbpsFrom(1_000_000, 1000), 8))
check("零与负值不产生速率", () => mbpsFrom(0, 1000) === 0 && mbpsFrom(1000, 0) === 0 && mbpsFrom(-1, 1000) === 0)
check("非法输入不产生速率", () => mbpsFrom(Number.NaN, 1000) === 0 && mbpsFrom(1000, Infinity) === 0)

check("速率格式保留两位小数", () => formatMbps(8.456) === "8.46" && formatMbps(12.34) === "12.3")
check("百兆以上保留一位并去掉零", () => formatMbps(100) === "100" && formatMbps(237.5) === "237.5")
check("缺失速率显示占位", () => formatMbps(null) === "—" && formatMbps(undefined) === "—" && formatMbps(Number.NaN) === "—")
check("流量格式按 1024 进制", () => formatTraffic(1024) === "1 KB" && formatTraffic(1024 * 1024 * 132.63) === "132.63 MB")
check("千兆以上使用 GB", () => formatTraffic(1024 ** 3 * 2.5) === "2.50 GB")
check("零流量显示 0 MB", () => formatTraffic(0) === "0 MB" && formatTraffic(-5) === "0 MB")

check("中位数偶数取中间两值", () => median([4, 1, 3, 2]) === 2.5)
check("中位数奇数取中点", () => median([9, 1, 5]) === 5)
check("中位数忽略非法值", () => median([Number.NaN, 4, 2]) === 3)
check("空样本中位数为零", () => median([]) === 0)

check("时延取成功样本最小值", () => summarizeLatency([42, 31, null, 55]).min === 31)
check("丢包率包含失败探测", () => near(summarizeLatency([42, null, null, 60]).loss, 0.5))
check("抖动取相邻成功样本差的中位数", () => {
  // [40,50,46] 的相邻差为 10 与 4，中位数 7。
  const summary = summarizeLatency([40, 50, 46])
  return near(summary.jitter ?? -1, 7)
})
check("全部失败时保留丢包与未知时延", () => {
  const summary = summarizeLatency([null, null])
  return summary.min === null && summary.jitter === null && summary.loss === 1
})
check("空探测不虚报丢包", () => summarizeLatency([]).loss === 0)

const down = [sample(0, 5), sample(1, 10), sample(2, 20), sample(3, 20), sample(4, 20)]
check("稳态速率丢弃预热段", () => steadySpeed(down, "download") === 20)
check("稳态速率按阶段过滤", () => steadySpeed([...down, sample(5, 99, "upload")], "download") === 20)
check("无采样时返回 null", () => steadySpeed([], "download") === null && steadySpeed(down, "upload") === null)
check("阶段筛选只返回对应方向", () => samplesOf([...down, sample(6, 30, "upload")], "upload").length === 1)
check("峰值忽略非法值", () => {
  // 方向筛选由 samplesOf 负责，peakSpeed 只取全局最大有效值。
  return peakSpeed([sample(0, 12), sample(1, Number.NaN), sample(2, 40, "upload")]) === 40
})
check("空采样峰值为零", () => peakSpeed([]) === 0)

check("仪表上限取整并留出余量", () => niceMax(87) === 100 && niceMax(120) === 150 && niceMax(0.9) === 1)
check("仪表上限为零时兜底 1", () => niceMax(0) === 1 && niceMax(-10) === 1 && niceMax(Number.NaN) === 1)
check("仪表上限覆盖兆级速率", () => niceMax(940) === 1000 && niceMax(1800) === 2000)
check("速率分级边界", () => speedGrade(300) === "极快" && speedGrade(100) === "很快"
  && speedGrade(30) === "流畅" && speedGrade(10) === "一般" && speedGrade(9.9) === "较慢")
check("缺失速率不升级", () => speedGrade(null) === "—" && speedGrade(Number.NaN) === "—")

check("逐帧平滑按时间前进", () => approach(0, 100, 0.016, 8) > 0 && approach(0, 100, 0.016, 8) < 100)
check("逐帧平滑掉帧时走得更远", () => approach(0, 100, 0.1, 8) > approach(0, 100, 0.016, 8))
check("逐帧平滑零时长不改变数值", () => approach(30, 100, 0, 8) === 30 && approach(30, 100, -1, 8) === 30)
check("逐帧平滑非法目标保留原值", () => approach(30, Number.NaN, 0.016, 8) === 30)
check("逐帧平滑非法起点直接对齐", () => approach(Number.NaN, 30, 0.016, 8) === 30)
check("逐帧平滑零速率不改变数值", () => approach(30, 100, 0.016, 0) === 30)
check("平滑后不会越过目标值", () => approach(90, 100, 1, 8) <= 100 && approach(90, 100, 1, 8) > 90)

check("时间轴首次直接对齐", () => advanceTimeline(null, 4.2, 0.016) === 4.2)
check("时间轴正常推进不越过采样", () => {
  const next = advanceTimeline(3, 3.15, 0.016)
  return next > 3 && next <= 3.15
})
check("时间轴采样回退时重新同步", () => advanceTimeline(9, 1.5, 0.016) === 1.5)
check("时间轴长时间停滞后直接对齐", () => advanceTimeline(2, 8, 0.016) === 8)
check("时间轴零时长保持不动", () => advanceTimeline(3, 3.4, 0) === 3)
check("时间轴非有限采样保持不动", () => advanceTimeline(3, Number.NaN, 0.016) === 3)
check("时间轴逐帧收敛到采样值", () => {
  let cursor: number | null = null
  for (let index = 0; index < 40; index++) cursor = advanceTimeline(cursor, 6, 0.1)
  return cursor === 6
})

check("Wi-Fi 接口识别", () => linkKind("Wi-Fi 接口").label === "Wi-Fi" && !linkKind("Wi-Fi 接口").cellular)
check("蜂窝接口识别", () => linkKind("蜂窝接口").label === "蜂窝数据" && linkKind("蜂窝接口").cellular)
check("未知接口不冒充 Wi-Fi", () => linkKind("").label === "当前网络" && linkKind("未知").label === "当前网络")
check("其他接口单独标注", () => linkKind("其他接口").label === "其他链路")

check("阶段文案覆盖全部状态", () => ["idle", "latency", "download", "upload", "done", "stopped", "error"]
  .every(phase => phaseLabel(phase as never).length > 0))
check("空状态没有残留数值", () => EMPTY_SPEED.ping === null && EMPTY_SPEED.download === null
  && EMPTY_SPEED.upload === null && EMPTY_SPEED.bytes === 0 && EMPTY_SPEED.samples.length === 0)
check("流量预算为有限正数", () => SPEED_BUDGET.downloadBytes > 0 && SPEED_BUDGET.uploadBytes > 0
  && SPEED_BUDGET.latencyProbes > 0)

check("测速记录拒绝非完成状态", () => recordFromState({ ...EMPTY_SPEED, phase: "download" }, "Wi-Fi 接口") === null)
check("测速记录只采纳完成状态", () => {
  const record = recordFromState({ ...EMPTY_SPEED, phase: "done", download: 92.4,
    upload: 12.1, ping: 34, jitter: 3, loss: 0, bytes: 24_000_000, startedAt: 1, elapsedMs: 2 }, "Wi-Fi 接口")
  return !!record && record.download === 92.4 && record.ping === 34 && record.kind === "Wi-Fi 接口"
})
check("测速记录拒绝损坏结构", () => parseSpeedRecord(null) === null && parseSpeedRecord([]) === null
  && parseSpeedRecord("string") === null && parseSpeedRecord({}) === null)
check("测速记录拒绝未来时间", () => parseSpeedRecord({ at: Date.now() + 3_600_000, download: 10 }) === null)
check("测速记录要求至少一项有效数值", () => parseSpeedRecord({ at: Date.now(), download: null, upload: null, ping: null }) === null)
check("测速记录保留合法数据", () => {
  const record = parseSpeedRecord({ at: Date.now() - 1000, download: 88.8, upload: 0, ping: 0,
    jitter: 4, loss: 0, bytes: 12_000_000, node: "Cloudflare", kind: "蜂窝接口" })
  return !!record && record.download === 88.8 && record.upload === 0 && record.ping === 0 && record.loss === 0
})
check("测速记录拒绝越界数值", () => {
  // 三项均越界后没有有效数值，整条记录被丢弃。
  const record = parseSpeedRecord({ at: Date.now(), download: 1e9, upload: -5, ping: Infinity, bytes: -1 })
  return record === null
})
check("测速记录过滤超长文本", () => {
  const record = parseSpeedRecord({ at: Date.now(), download: 1, node: "x".repeat(200), kind: 42 })
  return !!record && record.node.length === 40 && record.kind === ""
})

Script.exit({ passed, failed: failures.length, failures, offline: true })
