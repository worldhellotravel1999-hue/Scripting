import { TIMEOUT_MS } from "./types"
import type { History, Result, Sample } from "./types"

const WINDOW_MS = 30 * 60 * 1000

export function latencyBase(ms: number): number {
  const anchors = [[3000, 90], [5000, 85], [10000, 75], [30000, 60]]
  if (!Number.isFinite(ms) || ms < 0 || ms > TIMEOUT_MS) return 0
  if (ms <= 3000) return 90
  for (let i = 1; i < anchors.length; i++) {
    const [t1, s1] = anchors[i - 1]
    const [t2, s2] = anchors[i]
    if (ms <= t2) {
      return s1 + (Math.log(ms / t1) / Math.log(t2 / t1)) * (s2 - s1)
    }
  }
  return 60
}

export type Score = { value: number; stale: boolean; count: number; ok: boolean }

// 评分沿用旧版：30 分钟有效窗口、最近十次样本、响应耗时、成功率、前三奖励。
// 这是当前渠道的速度/可用性分数（0—100），不表示模型智能水平。
export function scoreOf(key: string, history: History, now = Date.now(), result?: Result): Score | null {
  const valid = (s: Sample) => s && typeof s.ok === "boolean" && Number.isFinite(s.ms) && s.ms >= 0 && Number.isFinite(s.at)
  let all = (history[key] ?? []).filter(valid)
  // 两份旧缓存可能只写入一份。最新结果补齐评分输入，但不伪造检测时间。
  if (result && valid(result) && !all.some(s => s.at === result.at && s.ok === result.ok && s.ms === result.ms)) {
    all = [result, ...all]
  }
  all = all.sort((a, b) => b.at - a.at).slice(0, 10)
  if (!all.length) return null
  const newest = all[0]
  const stale = newest.at <= 0 || now - newest.at > WINDOW_MS
  if (newest.at <= 0) {
    return { value: newest.ok ? Math.round(latencyBase(newest.ms)) : 0, stale: true, count: 1, ok: newest.ok && newest.ms <= TIMEOUT_MS }
  }
  // 旧记录成功但超时也必须有 0 分，不能因过滤样本留下空白。
  if (!newest.ok || newest.ms > TIMEOUT_MS) return { value: 0, stale, count: all.length, ok: false }
  const at = stale ? newest.at : Math.max(now, newest.at)
  const list = all.filter(s => s.at > 0 && at - s.at <= WINDOW_MS).map(s => ({ ...s, ok: s.ok && s.ms <= TIMEOUT_MS }))
  const weights = list.map(s => Math.exp(-0.6931 * Math.pow(Math.max(0, at - s.at) / WINDOW_MS, 2)))
  const total = weights.reduce((a, b) => a + b, 0)
  const okWeight = list.reduce((a, s, i) => a + (s.ok ? weights[i] : 0), 0)
  const avg = okWeight > 0 ? list.reduce((a, s, i) => a + (s.ok ? s.ms * weights[i] : 0), 0) / okWeight : null
  const base = avg === null ? 60 : latencyBase(Math.max(1, avg))
  const confidence = Math.min(5, Math.max(0, (list.length - 1) / 9 * 5))
  const bonus = Math.min(8, list.reduce((a, s) => a + (Number.isFinite(s.rank) ? Math.max(0, s.rank!) : 0), 0) / (total + 1))
  const penalty = Math.min(20, (total - okWeight) / (total + 0.5) * 30)
  const value = Math.round(Math.max(0, Math.min(100, base + confidence + bonus - penalty)))
  return { value, stale, count: list.length, ok: true }
}

export function addSample(history: History, key: string, sample: Sample): History {
  return { ...history, [key]: [sample, ...(history[key] ?? [])].slice(0, 10) }
}

export function rewardTopThree(history: History, samples: Array<{ key: string; ms: number; at: number }>): History {
  const next = { ...history }
  samples.filter(s => s.ms > 0).sort((a, b) => a.ms - b.ms).slice(0, 3).forEach((s, i) => {
    const list = next[s.key]
    if (list?.[0]?.at === s.at) next[s.key] = [{ ...list[0], rank: [4, 2.5, 1.5][i] }, ...list.slice(1)]
  })
  return next
}
