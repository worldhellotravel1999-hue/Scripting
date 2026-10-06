import {
  Button,
  HStack,
  Image,
  List,
  Picker,
  ProgressView,
  Rectangle,
  RoundedRectangle,
  Section,
  Spacer,
  Text,
  TextField,
  VStack,
  ZStack,
  useEffect,
  useMemo,
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
import {
  AiGlobalSection,
  EMPTY_AI_RESULT,
  ResultSheet,
  type AiResult,
  type SetAiResult,
} from "./ai_panel"
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
  // AI 结果临时窗口：结果状态由本页持有（页面浮层展示）；离开/重开即空白
  const [aiRes, setAiResRaw] = useState<AiResult>(EMPTY_AI_RESULT)
  const [aiSheet, setAiSheet] = useState(false)
  const patchAi: SetAiResult = patch =>
    setAiResRaw(r => ({ ...r, ...(typeof patch === "function" ? patch(r) : patch) }))

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
  // 条形图只需一个最大值，只在数据真的变了时重算（每次 busy 起落都会重渲染）
  const maxTimeline = useMemo(
    () => p.timeline.reduce((a: number, r: any) => Math.max(a, r.msg_count || 0), 0),
    [p.timeline],
  )
  const maxRank = useMemo(
    () => (p.ranking || []).reduce((a: number, r: any) => Math.max(a, r.msg_count || 0), 0),
    [p.ranking],
  )

  return (
    <ZStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
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

      {/* AI 总结：常驻页面顶部（不再是底部标签里的一个页签）；
          结果在 ResultSheet 弹窗里看，行内不插结果卡片 */}
      <AiGlobalSection
        p={p}
        res={aiRes}
        setRes={patchAi}
        openSheet={() => setAiSheet(true)}
      />

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
          <Section title="发言排行">
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

    {/* AI 结果临时窗口：页面内浮层（遮罩 + 居中动态卡片），不弹全屏 sheet 二级页；
        点遮罩或「关闭」即收起，生成中也一样（后台继续跑，动作行再点重开） */}
    {aiSheet ? (
      <ZStack alignment="center" frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
        <Rectangle
          fill="rgba(0,0,0,0.32)"
          frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
          onTapGesture={() => setAiSheet(false)}
        />
        <ResultSheet res={aiRes} setRes={patchAi} onClose={() => setAiSheet(false)} p={p} />
      </ZStack>
    ) : null}
    </ZStack>
  )
}
