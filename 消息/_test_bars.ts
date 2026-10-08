// 临时验证：tools.tsx 的消息分布分桶 / 概览按本地日期合并（逻辑逐行复制自 tools.tsx）
import { Script } from "scripting"

function periodDate(period: string): Date {
  const s = String(period ?? "")
  return new Date(s.length >= 13 ? `${s.slice(0, 13)}:00:00Z` : `${s}T00:00:00Z`)
}
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`
}
const two = (n: number) => String(n).padStart(2, "0")

function buildMsgBars(
  rows: any[] | null,
  msgMode: string,
  recentHours: string,
  now: Date,
) {
  if (rows === null) return null
  const hourMode = msgMode === "today" || (Number(recentHours) || 24) <= 24
  const hourCounts = new Map<string, number>()
  const dayCounts = new Map<string, number>()
  for (const r of rows) {
    const d = periodDate(String(r.period ?? ""))
    if (Number.isNaN(d.getTime())) continue
    const v = r.msg_count || 0
    const dk = dayKey(d)
    dayCounts.set(dk, (dayCounts.get(dk) || 0) + v)
    const hk = `${dk}#${d.getHours()}`
    hourCounts.set(hk, (hourCounts.get(hk) || 0) + v)
  }
  const items: { label: string; value: number }[] = []
  if (hourMode) {
    const startMs =
      msgMode === "today"
        ? new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
        : now.getTime() - Math.max(1, Number(recentHours) || 24) * 3600000
    const start = new Date(startMs)
    const base = new Date(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours())
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours())
    for (let t = base.getTime(); t <= end.getTime(); t += 3600000) {
      const d = new Date(t)
      items.push({
        label: `${two(d.getHours())}:00`,
        value: hourCounts.get(`${dayKey(d)}#${d.getHours()}`) || 0,
      })
    }
  } else {
    const hours = Math.max(1, Number(recentHours) || 24)
    const start = new Date(now.getTime() - hours * 3600000)
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    let d = new Date(start.getFullYear(), start.getMonth(), start.getDate())
    while (d.getTime() <= end.getTime()) {
      items.push({
        label: `${d.getMonth() + 1}/${d.getDate()}`,
        value: dayCounts.get(dayKey(d)) || 0,
      })
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
    }
  }
  const total = items.reduce((a, b) => a + b.value, 0)
  let peakIndex = 0
  items.forEach((it, i) => {
    if (it.value > items[peakIndex].value) peakIndex = i
  })
  return { items, total, peakIndex }
}

function buildTimelineMarks(rows: any[]) {
  const dayCounts = new Map<string, number>()
  for (const row of rows) {
    const d = periodDate(String(row.period ?? ""))
    if (Number.isNaN(d.getTime())) continue
    const k = dayKey(d)
    dayCounts.set(k, (dayCounts.get(k) || 0) + (row.msg_count || 0))
  }
  const keys = [...dayCounts.keys()].sort()
  if (keys.length === 0) return []
  const [fy, fm, fd] = keys[0].split("-").map(Number)
  const [ly, lm, ld] = keys[keys.length - 1].split("-").map(Number)
  const start = new Date(fy, fm - 1, fd)
  const end = new Date(ly, lm - 1, ld)
  const out: { label: string; value: number }[] = []
  for (let d = start; d.getTime() <= end.getTime(); ) {
    out.push({ label: `${d.getMonth() + 1}/${d.getDate()}`, value: dayCounts.get(dayKey(d)) || 0 })
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
  }
  return out
}

function main() {
  const now = new Date(2026, 9, 7, 19, 10) // 2026-10-07 19:10 本地(UTC+8)
  let pass = 0
  let fail = 0
  const check = (name: string, cond: boolean, extra?: any) => {
    if (cond) {
      pass++
    } else {
      fail++
      console.log("FAIL:", name, extra !== undefined ? JSON.stringify(extra) : "")
    }
  }

  // 1) 近 6 小时（hour 模式）：本地 14:00–19:00 共 6 根？起点=13:10→整点13:00 → 7 根
  const hourRows = [
    { period: "2026-10-07T06", msg_count: 3 }, // 本地 14:00
    { period: "2026-10-07T07", msg_count: 5 }, // 本地 15:00
    { period: "2026-10-07T10", msg_count: 2 }, // 本地 18:00
    { period: "2026-10-07T11", msg_count: 1 }, // 本地 19:00（当前小时）
  ]
  const t1 = buildMsgBars(hourRows, "chat", "6", now)
  console.log("近6小时桶:", JSON.stringify(t1!.items), "total=", t1!.total, "peak=", t1!.peakIndex)
  check("近6小时 total", t1!.total === 11, t1!.total)
  check("近6小时 桶数=7", t1!.items.length === 7, t1!.items.length)
  check(
    "近6小时 首桶13:00值0",
    t1!.items[0].label === "13:00" && t1!.items[0].value === 0,
    t1!.items[0],
  )
  check("近6小时 14:00=3", t1!.items[1].value === 3, t1!.items[1])
  check("近6小时 末桶19:00=1", t1!.items[6].label === "19:00" && t1!.items[6].value === 1, t1!.items[6])
  check("近6小时 peak=15:00", t1!.items[t1!.peakIndex].label === "15:00", t1!.items[t1!.peakIndex])

  // 2) 今日：带昨天尾巴的行（本地 10/06 23:00）要被丢掉；0 点到当前小时连续
  const todayRows = [
    { period: "2026-10-06T15", msg_count: 99 }, // UTC 15点 = 本地 10/06 23:00 → 昨天，该丢
    { period: "2026-10-06T16", msg_count: 7 }, // UTC 16点 = 本地 10/07 00:00 → 今天 00:00
    { period: "2026-10-06T17", msg_count: 9 }, // 本地 10/07 01:00
    { period: "2026-10-07T01", msg_count: 4 }, // 今天 09:00
    { period: "2026-10-07T10", msg_count: 6 }, // 今天 18:00
  ]
  const t2 = buildMsgBars(todayRows, "today", "24", now)
  console.log("今日桶:", JSON.stringify(t2!.items), "total=", t2!.total)
  check("今日 total=26（昨天尾巴丢弃）", t2!.total === 26, t2!.total)
  check("今日 桶数=20（00:00–19:00）", t2!.items.length === 20, t2!.items.length)
  check("今日 首桶00:00=7", t2!.items[0].label === "00:00" && t2!.items[0].value === 7, t2!.items[0])
  check("今日 09:00=4", t2!.items[9].value === 4, t2!.items[9])

  // 3) 近 7 天（day 模式）：hour 行按本地日期合并，缺天补 0，含窗口首尾部分天
  const dayRows = [
    { period: "2026-09-30T11", msg_count: 2 }, // 本地 9/30 19:00
    { period: "2026-10-01T02", msg_count: 3 }, // 本地 10/01 10:00
    { period: "2026-10-01T15", msg_count: 4 }, // 本地 10/01 23:00 → 同日合并 7
    { period: "2026-10-06T20", msg_count: 1 }, // 本地 10/07 04:00 → 归到今天
    { period: "2026-10-07T05", msg_count: 2 }, // 本地 10/07 13:00 → 今天 3
  ]
  const t3 = buildMsgBars(dayRows, "chat", "168", now)
  console.log("近7天桶:", JSON.stringify(t3!.items), "total=", t3!.total)
  check("近7天 桶数=8（9/30–10/7）", t3!.items.length === 8, t3!.items.length)
  check("近7天 total=12", t3!.total === 12, t3!.total)
  check("近7天 9/30=2", t3!.items[0].value === 2, t3!.items[0])
  check("近7天 10/1=7（跨 UTC 日合并到本地日）", t3!.items[1].value === 7, t3!.items[1])
  check("近7天 10/2=0（缺天补0）", t3!.items[2].value === 0, t3!.items[2])
  check("近7天 今天=3", t3!.items[7].value === 3, t3!.items[7])

  // 4) 概览折线：hour 行合并成本地日 + 补 0
  const marks = buildTimelineMarks(dayRows)
  console.log("概览折线:", JSON.stringify(marks))
  check("概览 8 天", marks.length === 8, marks.length)
  check("概览 10/1=7", marks[1].value === 7, marks[1])
  check("概览 10/6=0", marks[6].value === 0, marks[6])

  // 5) periodDate 解析健壮性
  check("periodDate 小时", periodDate("2026-10-07T11").getHours() === 19, periodDate("2026-10-07T11").getHours())
  check("periodDate 非法", Number.isNaN(periodDate("xxx").getTime()))
  check("periodDate 空", Number.isNaN(periodDate("").getTime()))

  console.log(`\nPASS=${pass} FAIL=${fail}（时区=${now.getTimezoneOffset()}）`)
  Script.exit()
}

main()
