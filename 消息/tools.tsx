import {
  Button,
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
  useEffect,
  useState,
} from "scripting"
import { fmtNum, fmtTime } from "./api"
import {
  Avatar,
  Banners,
  FieldBox,
  Hint,
  MsgRow,
  PrimaryButton,
  RankRow,
  SegmentedTabs,
  StatCard,
  TimelineRow,
} from "./components"
import { AiGlobalSection } from "./ai_panel"
import type { PanelCtx } from "./ctx"

/**
 * 工具页：整页 plain 铺满屏幕。
 * 2026-10-05 起「消息/排行/概览」标签 + 刷新从底部 DockBar 移到顶部（搜索/内容之上），
 * 底部停靠栏删除；「AI 总结」（AI 汇总分析）常驻顶部，紧跟标签行下方。
 */

type Tab = "msg" | "rank" | "overview"

const TAB_ITEMS = [
  { tag: "msg", label: "消息" },
  { tag: "rank", label: "排行" },
  { tag: "overview", label: "概览" },
]

export function ToolsScreen({ p }: { p: PanelCtx }) {
  const [tab, setTab] = useState<Tab>("msg")

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
  const maxTimeline = p.timeline.reduce(
    (a: number, r: any) => Math.max(a, r.msg_count || 0),
    0
  )
  const maxRank = (p.ranking || []).reduce(
    (a: number, r: any) => Math.max(a, r.msg_count || 0),
    0
  )

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

      {/* AI 总结：常驻页面顶部（不再是底部标签里的一个页签） */}
      <AiGlobalSection p={p} />

      {tab === "msg" ? (
        <>
          <Section title="消息查询">
            <Hint tone="muted" text="关键词 / 今日 / 最近，全部查询本地库，不联网。" />
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
          <Section title="发言排行">
            <Hint tone="muted" text="按本地消息库统计，可限定时间窗口。" />
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
          <Section
            title={p.ranking === null ? "排行" : `${p.ranking.length} 位发言者`}
          >
            {p.ranking === null ? (
              <Hint tone="muted" text="点「统计」开始" />
            ) : p.ranking.length === 0 ? (
              <Hint tone="muted" text="该时间窗口内没有数据" />
            ) : (
              p.ranking.map((r: any, i: number) => (
                <RankRow
                  key={`${r.sender_id ?? "n"}-${i}`}
                  index={i}
                  name={r.sender_name || "未知"}
                  count={r.msg_count}
                  max={maxRank}
                  sub={fmtTime(r.last_msg)}
                />
              ))
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
            <Hint tone="muted" text="查询全部走本地 SQLite：毫秒级、离线可用。" />
          </Section>

          <Section title="最近 7 天消息量">
            {p.timeline.length === 0 ? (
              <Hint tone="muted" text="暂无数据，先在群详情页同步一些消息" />
            ) : (
              p.timeline.map((row: any) => (
                <TimelineRow key={row.period} row={row} max={maxTimeline} />
              ))
            )}
          </Section>
        </>
      ) : null}
    </List>
  )
}
