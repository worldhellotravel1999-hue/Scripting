import {
  Button,
  Chart,
  HStack,
  Image,
  List,
  Picker,
  ProgressView,
  RoundedRectangle,
  Section,
  Spacer,
  Text,
  TextField,
  VStack,
  ZStack,
  Circle,
  DonutChart,
  LineChart,
  useEffect,
  useMemo,
  useState,
} from "scripting"
import { fmtNum } from "./api"
import {
  Avatar,
  Banners,
  FieldBox,
  Hint,
  MsgRow,
  PrimaryButton,
  SegmentedTabs,
  StatCard,
} from "./components"
import type { PanelCtx } from "./ctx"

/**
 * 工具页：整页 plain 铺满屏幕。
 * 2026-10-06 改版：
 *  - 排行不再逐行罗列「每人发了多少条」，改为 DonutChart 发言占比环形图 + 图例；
 *  - 概览的 7 天消息量不再用字符条形，改为 LineChart 折线趋势（参考股票 App 图表风格）；
 *  - AI 汇总统计区块（AiGlobalSection）与结果浮层整体移除。
 * 顶部仍是「消息/排行/概览」标签 + 刷新（原底部 DockBar 已删）。
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

export function ToolsScreen({ p, initialTab }: { p: PanelCtx; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab ?? "msg")

  const switchTab = (tag: string) => {
    withAnimation(Animation.smooth({ duration: 0.28 }), () => setTab(tag as Tab))
  }

  // 首次切到某个工具时按需加载
  useEffect(() => {
    if (tab === "msg" && p.messages === null) p.loadMessages(p.msgMode)
    if (tab === "rank" && p.ranking === null) p.loadRanking()
    if (tab === "overview" && p.timeline.length === 0) p.loadOverview()
    return
  }, [tab])

  const refresh = () => {
    if (tab === "msg") p.loadMessages(p.msgMode)
    else if (tab === "rank") p.loadRanking()
    else {
      p.loadStatus()
      p.loadOverview()
    }
  }

  const localChats = p.stats?.chats || []

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
    return rankSlices.marks.map((m: any, i: number) => ({
      name: m.category,
      color: m.foregroundStyle as string,
      pct: Math.round((m.value / total) * 100),
    }))
  }, [rankSlices])

  // 7 天趋势折线数据：label 用 MM-DD
  const timelineMarks = useMemo(
    () =>
      (p.timeline || []).map((row: any) => ({
        label: String(row.period ?? "").slice(5),
        value: row.msg_count || 0,
      })),
    [p.timeline],
  )

  const pctText = (n: number) => `${n}%`

  return (
    <List
      listStyle="plain"
      listRowInsets={{ top: 0, bottom: 0, leading: 16, trailing: 16 }}
      navigationTitle="工具"
      navigationBarTitleDisplayMode="inline"
      toolbar={{
        topBarTrailing: p.busy ? (
          <ProgressView />
        ) : (
          <Button action={refresh}>
            <Image systemName="arrow.clockwise" frame={{ width: 17, height: 17 }} />
          </Button>
        ),
      }}
    >
      <Banners p={p} />

      {/* 顶部工具行：「消息/排行/概览」标签 + 刷新（原底部 DockBar 已删） */}
      <Section>
        <HStack
          spacing={10}
          padding={{ vertical: 3 }}
          frame={{ maxWidth: "infinity" }}
          listRowSeparator={{ visibility: "hidden", edges: "all" }}
        >
          <SegmentedTabs items={TAB_ITEMS} value={tab} onChanged={switchTab} />
          <ZStack
            alignment="center"
            frame={{ width: 44, height: 44 }}
            background={<RoundedRectangle fill="#F1F3F6" cornerRadius={12} />}
            onTapGesture={p.busy ? undefined : refresh}
          >
            <Image
              systemName="arrow.clockwise"
              foregroundStyle={p.busy ? "#C7C7CC" : "#34C759"}
              frame={{ width: 20, height: 20 }}
            />
          </ZStack>
        </HStack>
      </Section>

      {tab === "msg" ? (
        <>
          <Section title="消息查询">
            <Picker
              title="模式"
              value={p.msgMode}
              onChanged={p.setMsgMode}
              pickerStyle="segmented"
            >
              <Text tag="search">搜索</Text>
              <Text tag="today">今日</Text>
              <Text tag="recent">最近</Text>
            </Picker>
            {p.msgMode === "search" ? (
              <>
                <HStack spacing={8}>
                  <Text font="footnote">关键词</Text>
                  <Spacer />
                  <FieldBox width={190}>
                    <TextField
                      title="任意文本"
                      value={p.query}
                      onChanged={p.setQuery}
                      frame={{ maxWidth: "infinity" }}
                    />
                  </FieldBox>
                </HStack>
                <Picker
                  title="时间范围"
                  value={p.msgHours}
                  onChanged={p.setMsgHours}
                >
                  <Text tag="6">近 6 小时</Text>
                  <Text tag="24">近 24 小时</Text>
                  <Text tag="72">近 3 天</Text>
                  <Text tag="168">近 7 天</Text>
                  <Text tag="all">全部时间</Text>
                </Picker>
              </>
            ) : p.msgMode === "recent" ? (
              <Picker
                title="时间范围"
                value={p.recentHours}
                onChanged={p.setRecentHours}
              >
                <Text tag="1">近 1 小时</Text>
                <Text tag="6">近 6 小时</Text>
                <Text tag="24">近 24 小时</Text>
                <Text tag="168">近 7 天</Text>
              </Picker>
            ) : null}
            <PrimaryButton
              title="查询"
              action={() => p.loadMessages(p.msgMode)}
              disabled={p.busy !== null}
            />
          </Section>

          <Section
            title={
              p.messages === null ? "结果" : `${p.messages.length} 条（最多显示 50）`
            }
          >
            {p.messages === null ? (
              <Hint tone="muted" text="点「查询」开始" />
            ) : p.messages.length === 0 ? (
              <Hint tone="muted" text="没有匹配的消息" />
            ) : (
              p.messages.map((m: any, i: number) => (
                <MsgRow
                  key={`${m.chat_id ?? 0}-${m.id ?? i}`}
                  m={m}
                  onOpenUrl={url => Safari.openURL(url)}
                />
              ))
            )}
          </Section>
        </>
      ) : null}

      {tab === "rank" ? (
        <>
          <Section title="发言占比">
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
              disabled={p.busy !== null}
            />
          </Section>

          <Section title="图表">
            {p.ranking === null ? (
              <Hint tone="muted" text="点「统计」开始" />
            ) : p.ranking.length === 0 ? (
              <Hint tone="muted" text="该时间窗口内没有数据" />
            ) : (
              <>
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
              </>
            )}
          </Section>
        </>
      ) : null}

      {tab === "overview" ? (
        <>
          <Section title="账号">
            {p.authorized ? (
              <HStack spacing={12}>
                <Avatar name={p.status?.me?.name || "TG"} size={46} />
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
          </Section>

          <Section title="本地数据库">
            <HStack spacing={12}>
              <StatCard icon="tray.full.fill" label="本地消息" value={fmtNum(p.stats?.total)} />
              <StatCard
                icon="bubble.left.and.bubble.right.fill"
                label="已同步会话"
                value={fmtNum(localChats.length)}
                colors={["#7B8FF7", "#4B5EF7"]}
              />
            </HStack>
          </Section>

          <Section title="最近 7 天消息量">
            {timelineMarks.length === 0 ? (
              <Hint tone="muted" text="暂无数据，先在群详情页同步一些消息" />
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
                  按天统计，共 {timelineMarks.length} 天
                </Text>
              </VStack>
            )}
          </Section>
        </>
      ) : null}
    </List>
  )
}
