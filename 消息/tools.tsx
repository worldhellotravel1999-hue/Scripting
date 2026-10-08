import {
  BarChart,
  Chart,
  Circle,
  DonutChart,
  HStack,
  LineChart,
  List,
  Picker,
  ProgressView,
  Section,
  Spacer,
  Text,
  VStack,
  ZStack,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "scripting"
import { fmtNum } from "./api"
import {
  Avatar,
  Banners,
  Card,
  Hint,
  PrimaryButton,
  SegmentedTabs,
  StatCard,
} from "./components"
import type { PanelCtx } from "./ctx"

/**
 * 工具页：整页 plain 铺满屏幕。
 * 2026-10-07 改版：
 *  - 「消息」结果改为**柱状图**（按本地时区分桶的消息量，不再逐条列消息）；
 *  - 「排行」「概览」只统计**最后点开的会话**（点会话行即记住，切换后自动重算）；
 *  - 概览 timeline 改 hour 粒度 + 前端按本地日期合成“天”，修跨天偏 8 小时的不准；
 *  - 顶栏与标签行的刷新按钮均已删；切页签/换会话自动按需加载。
 * 配色沿用 Telegram 蓝（ACCENT），图表色见 RING_COLORS / 柱状图两档蓝。
 */

type Tab = "msg" | "rank" | "overview"

const TAB_ITEMS = [
  { tag: "msg", label: "消息" },
  { tag: "rank", label: "排行" },
  { tag: "overview", label: "概览" },
]

/** 图表配色：环形图分段色（沿用排行徽标色系，多了几档补位）。 */
const RING_COLORS = [
  "#2AABEE",
  "#FF9F0A",
  "#FF375F",
  "#34C759",
  "#AF52DE",
  "#5AC8FA",
  "#FF6482",
  "#8E8E93",
]

/** timeline 的 period（"YYYY-MM-DDTHH"，UTC 小时）→ 本地 Date */
function periodDate(period: string): Date {
  const s = String(period ?? "")
  return new Date(s.length >= 13 ? `${s.slice(0, 13)}:00:00Z` : `${s}T00:00:00Z`)
}

/** 本地日期 key（"YYYY-MM-DD"） */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`
}

const two = (n: number) => String(n).padStart(2, "0")

export function ToolsScreen({ p, initialTab }: { p: PanelCtx; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab ?? "msg")

  const switchTab = (tag: string) => {
    withAnimation(Animation.smooth({ duration: 0.28 }), () => setTab(tag as Tab))
  }

  // ── 按需加载：进页签 / 换了「最后点开的会话」/改了时间窗口就自动按新参数重算 ──
  // 2026-10-07 审计：以前键里**没有 recentHours/rankHours**，改完窗口切走再切回，
  // effect 因键没变直接跳过 —— 选择器显示新窗口、图表还是旧数据（显示与所选
  // 不一致）；这里把窗口纳入键，与 mode/会话变更同一规则。
  const chatKey = p.lastChat ? String(p.lastChat.id) : ""
  const msgKey = `${p.msgMode}|${p.recentHours}|${chatKey}`
  const rankKey = `${p.rankHours}|${chatKey}`
  const msgFor = useRef<string | null>(null)
  const rankFor = useRef<string | null>(null)
  const overviewFor = useRef<string | null>(null)
  const timelineEmpty = p.timeline.length === 0
  useEffect(() => {
    if (tab === "msg" && msgFor.current !== msgKey && (p.msgMode !== "chat" || chatKey)) {
      msgFor.current = msgKey
      p.loadMsgChart(p.msgMode)
    } else if (tab === "rank" && chatKey && rankFor.current !== rankKey) {
      rankFor.current = rankKey
      p.loadRanking()
    } else if (
      tab === "overview" &&
      (overviewFor.current !== chatKey || timelineEmpty)
    ) {
      // 概览在本地库里查（毫秒级），静默刷新不闪进度
      overviewFor.current = chatKey
      p.loadOverview({ quiet: true })
    }
    return
  }, [tab, msgKey, rankKey, chatKey, timelineEmpty])

  const localChats = p.stats?.chats || []

  // 概览「本群消息」：本地库里找最后点开的会话（名字优先，id 兜底）
  const myChatRow = useMemo(() => {
    if (!p.lastChat) return null
    const list = p.stats?.chats || []
    return (
      list.find((c: any) => String(c.chat_name) === p.lastChat!.name) ||
      list.find((c: any) => String(c.chat_id) === String(p.lastChat!.id)) ||
      null
    )
  }, [p.stats, p.lastChat])

  // 发言占比环形图数据：前 7 名分段，其余合并成「其他」，避免段数过多画不下。
  const rankSlices = useMemo(() => {
    const rows = p.ranking || []
    const total = rows.reduce((a: number, r: any) => a + (r.msg_count || 0), 0)
    if (total <= 0) return { marks: [] as any[], total: 0, topName: "", topRatio: 0 }
    const head = rows.slice(0, 7)
    const tail = rows.slice(7)
    const marks: any[] = head.map((r: any, i: number) => ({
      category: r.sender_name || "未知",
      value: r.msg_count || 0,
      innerRadius: { type: "ratio", value: 0.66 } as const,
      angularInset: 2,
      foregroundStyle: RING_COLORS[i % RING_COLORS.length],
    }))
    const rest = tail.reduce((a: number, r: any) => a + (r.msg_count || 0), 0)
    if (rest > 0) {
      marks.push({
        category: "其他",
        value: rest,
        innerRadius: { type: "ratio", value: 0.66 } as const,
        angularInset: 2,
        foregroundStyle: RING_COLORS[7],
      })
    }
    const top = rows[0]
    return {
      marks,
      total,
      topName: top?.sender_name || "—",
      topRatio: Math.round(((top?.msg_count || 0) / total) * 100),
    }
  }, [p.ranking])

  // 环形图图例（名字 + 占比，不显示原始条数）
  const rankLegend = useMemo(() => {
    const total = rankSlices.total
    if (total <= 0) return []
    return rankSlices.marks.map((m: any) => ({
      name: m.category,
      color: m.foregroundStyle as string,
      pct: Math.round((m.value / total) * 100),
    }))
  }, [rankSlices])

  // ── 消息分布柱状图：hour 粒度原始行 → 本地时区桶（缺桶补 0，柱子连续） ──
  const msgScope =
    p.msgMode === "chat"
      ? p.lastChat
        ? p.lastChat.name
        : ""
      : p.msgMode === "today"
        ? "今日"
        : (Number(p.recentHours) || 24) > 24
          ? `近 ${Math.round((Number(p.recentHours) || 24) / 24)} 天`
          : `近 ${p.recentHours} 小时`

  const msgBarsData = useMemo(() => {
    const rows = p.msgBars
    if (rows === null) return null
    const hourMode = p.msgMode === "today" || (Number(p.recentHours) || 24) <= 24
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
    const now = new Date()
    const items: { label: string; value: number }[] = []
    if (hourMode) {
      // 「今日」从本地 0 点起；「近 N 小时」从窗口起点所在整点起（首尾桶天然部分计入）
      const startMs =
        p.msgMode === "today"
          ? new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
          : now.getTime() - Math.max(1, Number(p.recentHours) || 24) * 3600000
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
      // 「近 7 天」：按本地日历天分桶，从窗口起点那天到今天（缺天补 0）
      const hours = Math.max(1, Number(p.recentHours) || 24)
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
  }, [p.msgBars, p.msgMode, p.recentHours])

  // 概览 7 天趋势：hour 粒度按本地日期合并成“天”，窗口内缺天补 0（折线不断档）
  const timelineMarks = useMemo(() => {
    const rows = p.timeline || []
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
      out.push({
        label: `${d.getMonth() + 1}/${d.getDate()}`,
        value: dayCounts.get(dayKey(d)) || 0,
      })
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
    }
    return out
  }, [p.timeline])

  const pctText = (n: number) => `${n}%`

  return (
    <List
      listStyle="plain"
      listRowSpacing={10}
      listRowInsets={{ top: 0, bottom: 0, leading: 16, trailing: 16 }}
      navigationTitle="工具"
      navigationBarTitleDisplayMode="inline"
      toolbar={{
        // 顶栏刷新按钮已删，仅保留忙碌转圈
        topBarTrailing: p.busy ? <ProgressView /> : undefined,
      }}
    >
      <Banners p={p} />

      {/* 顶部工具行：玻璃胶囊「消息/排行/概览」 */}
      <Section>
        <HStack
          spacing={10}
          padding={{ vertical: 3 }}
          frame={{ maxWidth: "infinity" }}
          listRowSeparator={{ visibility: "hidden", edges: "all" }}
        >
          <SegmentedTabs items={TAB_ITEMS} value={tab} onChanged={switchTab} />
        </HStack>
      </Section>

      {tab === "msg" ? (
        <>
          <Section title="查询">
            <Card spacing={10}>
              <Picker
                title="模式"
                value={p.msgMode}
                onChanged={p.setMsgMode}
                pickerStyle="segmented"
              >
                <Text tag="chat">本群</Text>
                <Text tag="today">今日</Text>
                <Text tag="recent">最近</Text>
              </Picker>
              {p.msgMode === "chat" ? (
                <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
                  <Text font="footnote" foregroundStyle="#8E8E93">目标会话</Text>
                  <Spacer />
                  <Text
                    font="footnote"
                    fontWeight="semibold"
                    lineLimit={1}
                    frame={{ maxWidth: "infinity", alignment: "trailing" }}
                  >
                    {p.lastChat ? p.lastChat.name : "还没有打开过会话"}
                  </Text>
                </HStack>
              ) : null}
              {p.msgMode !== "today" ? (
                <Picker
                  title="时间范围"
                  value={p.recentHours}
                  onChanged={p.setRecentHours}
                  pickerStyle="segmented"
                >
                  <Text tag="1">近 1 小时</Text>
                  <Text tag="6">近 6 小时</Text>
                  <Text tag="24">近 24 小时</Text>
                  <Text tag="168">近 7 天</Text>
                </Picker>
              ) : null}
              <PrimaryButton
                title="查询"
                action={() => p.loadMsgChart(p.msgMode)}
                disabled={p.busy !== null || (p.msgMode === "chat" && !p.lastChat)}
              />
            </Card>
          </Section>

          <Section title={msgScope ? `消息分布 · ${msgScope}` : "消息分布"}>
            {p.msgBars === null || msgBarsData === null ? (
              <Hint
                tone="muted"
                text={
                  p.msgMode === "chat" && !p.lastChat
                    ? "先在会话列表点开一个群"
                    : "点「查询」开始"
                }
              />
            ) : msgBarsData.total === 0 ? (
              <Hint tone="muted" text={`${msgScope || "该范围"}没有本地消息`} />
            ) : (
              <Card spacing={10}>
                <Chart
                  chartLegend="hidden"
                  chartXAxis="visible"
                  chartYAxis="hidden"
                  frame={{ maxWidth: "infinity", height: 168 }}
                >
                  <BarChart
                    marks={msgBarsData.items.map((it, i) => ({
                      label: it.label,
                      value: it.value,
                      // 峰值柱深一档，一眼看出最活跃时段
                      foregroundStyle: i === msgBarsData.peakIndex ? "#1E93D6" : "#2AABEE",
                      cornerRadius: 3,
                    }))}
                  />
                </Chart>
                <HStack spacing={6} frame={{ maxWidth: "infinity" }}>
                  <Text font="caption2" foregroundStyle="#8E8E93">
                    共 {fmtNum(msgBarsData.total)} 条 · {msgBarsData.items.length} 个时段
                  </Text>
                  <Spacer />
                  <Text font="caption2" fontWeight="semibold" foregroundStyle="#1E93D6">
                    峰值 {msgBarsData.items[msgBarsData.peakIndex].label} ·{" "}
                    {fmtNum(msgBarsData.items[msgBarsData.peakIndex].value)} 条
                  </Text>
                </HStack>
              </Card>
            )}
          </Section>
        </>
      ) : null}

      {tab === "rank" ? (
        <>
          <Section title="统计">
            <Card spacing={10}>
              <Picker
                title="时间窗口"
                value={p.rankHours}
                onChanged={p.setRankHours}
                pickerStyle="segmented"
              >
                <Text tag="6">6 小时</Text>
                <Text tag="24">24 小时</Text>
                <Text tag="168">7 天</Text>
                <Text tag="all">全部</Text>
              </Picker>
              <PrimaryButton
                title="统计"
                action={p.loadRanking}
                disabled={p.busy !== null || !p.lastChat}
              />
            </Card>
          </Section>

          <Section title={p.lastChat ? `发言占比 · ${p.lastChat.name}` : "发言占比"}>
            {!p.lastChat ? (
              <Hint tone="muted" text="先在会话列表点开一个群" />
            ) : p.ranking === null ? (
              <Hint tone="muted" text="点「统计」开始" />
            ) : p.ranking.length === 0 || rankSlices.total <= 0 ? (
              <Hint tone="muted" text="该会话在所选时间窗口内没有数据" />
            ) : (
              <Card spacing={12}>
              <VStack
                  alignment="center"
                  spacing={0}
                  frame={{ maxWidth: "infinity", height: 216 }}
                  listRowSeparator={{ visibility: "hidden", edges: "all" }}
                >
                  <ZStack alignment="center" frame={{ width: 216, height: 216 }}>
                    <Chart
                      chartLegend="hidden"
                      chartXAxis="hidden"
                      chartYAxis="hidden"
                      frame={{ width: 216, height: 216 }}
                    >
                      <DonutChart marks={rankSlices.marks} />
                    </Chart>
                    <VStack alignment="center" spacing={2}>
                      <Text font="title2" bold monospacedDigit>
                        {pctText(rankSlices.topRatio)}
                      </Text>
                      <Text font="caption2" foregroundStyle="#8E8E93" lineLimit={1}>
                        {rankSlices.topName}
                      </Text>
                      <Text font="caption2" foregroundStyle="#AEAEB2">
                        占比最高
                      </Text>
                    </VStack>
                  </ZStack>
                </VStack>

                {/* 图例：色点 + 名字 + 占比（不显示原始条数） */}
                <VStack
                  alignment="leading"
                  spacing={0}
                  frame={{ maxWidth: "infinity" }}
                >
                  {rankLegend.map((row: any, i: number) => (
                    <HStack
                      key={`${row.name}-${i}`}
                      spacing={8}
                      padding={{ vertical: 7 }}
                      frame={{ maxWidth: "infinity" }}
                    >
                      <Circle fill={row.color} frame={{ width: 9, height: 9 }} />
                      <Text font="footnote" lineLimit={1}>
                        {row.name}
                      </Text>
                      <Spacer />
                      <Text
                        font="footnote"
                        fontWeight="semibold"
                        monospacedDigit
                        foregroundStyle={row.color}
                      >
                        {row.pct}%
                      </Text>
                    </HStack>
                  ))}
                </VStack>
              </Card>
            )}
          </Section>
        </>
      ) : null}

      {tab === "overview" ? (
        <>
          <Section title="账号">
            <Card spacing={10}>
            {p.authorized ? (
              <HStack spacing={12}>
                <Avatar name={p.status?.me?.name || "TG"} size={46} src={p.status?.me?.avatar} />
                <VStack
                  alignment="leading"
                  spacing={2}
                  frame={{ maxWidth: "infinity", alignment: "leading" }}
                >
                  <Text font="title3" bold lineLimit={1}>
                    {p.status?.me?.name || "—"}
                  </Text>
                  <Text font="footnote" foregroundStyle="#8E8E93">
                    {p.status?.me?.username
                      ? `@${p.status.me.username}`
                      : p.status?.me?.phone || ""}
                  </Text>
                </VStack>
              </HStack>
            ) : p.status?.network_error ? (
              <>
                <Hint tone="error" text={`无法连接 Telegram：${p.status.network_error}`} />
                <PrimaryButton
                  title="重试连接"
                  action={() => p.loadStatus()}
                  disabled={p.busy !== null}
                />
              </>
            ) : (
              <Hint tone="info" text="正在检查连接…" />
            )}
            </Card>
          </Section>

          <Section title="本地数据库">
            <Card spacing={10}>
            <HStack spacing={12}>
              {p.lastChat ? (
                <StatCard
                  icon="bubble.left.fill"
                  label="本群消息"
                  value={fmtNum(myChatRow ? myChatRow.msg_count : 0)}
                  colors={["#2AABEE", "#1E93D6"]}
                />
              ) : (
                <StatCard icon="tray.full.fill" label="本地消息" value={fmtNum(p.stats?.total)} />
              )}
              <StatCard
                icon="bubble.left.and.bubble.right.fill"
                label="已同步会话"
                value={fmtNum(localChats.length)}
                colors={["#7B8FF7", "#4B5EF7"]}
              />
            </HStack>
            {p.lastChat ? (
              <Text font="caption2" foregroundStyle="#8E8E93">
                全部本地消息 {fmtNum(p.stats?.total)} 条
              </Text>
            ) : null}
            </Card>
          </Section>

          <Section
            title={`最近 7 天消息量${p.lastChat ? ` · ${p.lastChat.name}` : ""}`}
          >
            <Card spacing={6}>
            {timelineMarks.length === 0 ? (
              <Hint
                tone="muted"
                text={
                  p.lastChat
                    ? "该会话最近 7 天没有本地消息，先在群详情页同步"
                    : "先在会话列表点开一个群"
                }
              />
            ) : (
              <VStack
                alignment="leading"
                spacing={6}
                frame={{ maxWidth: "infinity" }}
                listRowSeparator={{ visibility: "hidden", edges: "all" }}
              >
                <Chart chartLegend="hidden" frame={{ maxWidth: "infinity", height: 180 }}>
                  <LineChart
                    marks={timelineMarks.map((m: any) => ({
                      ...m,
                      foregroundStyle: "#2AABEE",
                      lineStyle: { lineWidth: 2.5, lineCap: "round" },
                      interpolationMethod: "monotone" as const,
                      symbol: "circle" as const,
                      symbolSize: 6,
                    }))}
                  />
                </Chart>
                <Text font="caption2" foregroundStyle="#8E8E93">
                  按天统计，共 {timelineMarks.length} 天 ·{" "}
                  {fmtNum(timelineMarks.reduce((a, m) => a + m.value, 0))} 条
                </Text>
              </VStack>
            )}
            </Card>
          </Section>
        </>
      ) : null}
    </List>
  )
}
