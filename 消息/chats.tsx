import {
  Button,
  HStack,
  Image,
  List,
  NavigationDestination,
  ProgressView,
  RoundedRectangle,
  Section,
  Spacer,
  Text,
  TextField,
  VStack,
  ZStack,
  useMemo,
  useRef,
} from "scripting"
import { fmtNum, TYPE_LABEL } from "./api"
import {
  Avatar,
  Banners,
  DockIcon,
  Hint,
  PrimaryButton,
  SegmentedTabs,
  labelWidth,
} from "./components"
import { PAGE_SETTINGS, PAGE_TOOLS, chatPage, type PanelCtx } from "./ctx"
import { ChatDetailScreen } from "./detail"
import { ToolsScreen } from "./tools"
import { SettingsScreen } from "./settings"

/**
 * 根页：会话列表（唯一的主界面）。
 *  - 布局 2026-10-05 改 Pix 风：listStyle="plain" 整页铺满屏幕（不再装在 inset 卡片里）
 *  - 顶部：「全部/已同步」筛选 + 刷新（原在底部 DockBar）→ 搜索栏
 *  - 下拉可刷新；点任意一行 → 群详情
 */

/** Telegram-iOS 浅色主题设计令牌（取自 Swiftgram/Telegram-iOS 源码） */
const UI = {
  title: "#000000", // 一级标题（近黑）
  sub: "#8E8E93", // 次级文字 / 时间戳
  badge: "#34C759", // 未读角标绿
  synced: "#8E8E93", // 已同步提示（低调灰）
} as const

/** 对话行字号（紧凑版：标题 15 medium / 预览 14 / 时间 13 / 角标 12） */
const FONT_TITLE = 15
const FONT_PREVIEW = 14
const FONT_DATE = 13
const FONT_BADGE = 12
const AVATAR_SIZE = 44

/**
 * 会话时间：后端返回 Telethon 的 naive UTC ISO 串（无时区后缀），
 * 补 'Z' 后按本机时区格式化为 Telegram 式短日期。
 */
function chatTime(iso?: string | null): string {
  if (!iso) return ""
  let s = String(iso)
  if (!/[zZ]$|[+-]\d\d:\d\d$/.test(s)) s += "Z"
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return ""
  const now = new Date()
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  if (d.toDateString() === now.toDateString()) return `${hh}:${mm}`
  const y = new Date(now)
  y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return "昨天"
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/** 未读角标：20pt 圆 / 超 99 自动拉宽成胶囊，12pt semibold 白字 */
function UnreadBadge({ count }: { count: number }) {
  if (!count || count <= 0) return null
  const label = count > 99 ? "99+" : String(count)
  const width = count > 99 ? 30 : 20
  return (
    <ZStack alignment="center" frame={{ width, height: 20 }}>
      <RoundedRectangle fill={UI.badge} cornerRadius={10} frame={{ width, height: 20 }} />
      <Text
        font={FONT_BADGE}
        fontWeight="semibold"
        monospacedDigit
        foregroundStyle="white"
      >
        {label}
      </Text>
    </ZStack>
  )
}

/** 路由：把 path 里的页面标识渲染成目标页。 */
function renderDestination(page: string, p: PanelCtx) {
  if (page.startsWith("chat:")) {
    const raw = page.slice("chat:".length)
    const chat =
      (p.chats || []).find((c: any) => String(c.id) === raw) || { id: raw, name: raw }
    return <ChatDetailScreen p={p} chat={chat} />
  }
  if (page === PAGE_TOOLS) return <ToolsScreen p={p} />
  if (page === PAGE_SETTINGS) return <SettingsScreen p={p} />
  return (
    <List navigationTitle="TG Hub" navigationBarTitleDisplayMode="inline">
      <Section>
        <Text>未知页面</Text>
      </Section>
    </List>
  )
}

export function ChatListRow({
  chat,
  syncedCount,
  onOpen,
}: {
  chat: any
  syncedCount: number
  onOpen: () => void
}) {
  const name = chat.name || String(chat.id)
  const typeLabel = TYPE_LABEL[chat.type] || chat.type || ""
  const preview = String(chat.preview || "").trim()
  const secondLine = preview || typeLabel || "暂无消息"
  const time = chatTime(chat.date)
  const unread = Number(chat.unread) || 0

  return (
    <HStack spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      <Button action={onOpen}>
      <HStack
        spacing={10}
        frame={{ maxWidth: "infinity", alignment: "leading" }}
        padding={{ vertical: 5 }}
      >
        <Avatar name={name} src={chat.avatar} size={AVATAR_SIZE} />
        <VStack
          alignment="leading"
          spacing={2}
          frame={{ maxWidth: "infinity", alignment: "leading" }}
        >
          {/* 行 1：标题 + 右侧时间（15pt medium / 13pt 次级色） */}
          <HStack spacing={6} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Text
              font={FONT_TITLE}
              fontWeight="medium"
              foregroundStyle={UI.title}
              lineLimit={1}
              frame={{ maxWidth: "infinity", alignment: "leading" }}
            >
              {name}
            </Text>
            {time ? (
              <Text font={FONT_DATE} foregroundStyle={UI.sub}>
                {time}
              </Text>
            ) : null}
          </HStack>

          {/* 行 2：消息预览 + 已同步提示 + 未读角标（14pt / 12pt） */}
          <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Text
              font={FONT_PREVIEW}
              foregroundStyle={UI.sub}
              lineLimit={1}
              frame={{ maxWidth: "infinity", alignment: "leading" }}
            >
              {secondLine}
            </Text>
            {syncedCount > 0 ? (
              <HStack
                spacing={0}
                padding={{ horizontal: 6, vertical: 1 }}
                // 固定宽度：预览行是弹性的，不固定会被挤掉
                frame={{ width: labelWidth(`已同步 ${fmtNum(syncedCount)}`, 11) + 14 }}
                background={<RoundedRectangle fill="#E9F4FD" cornerRadius={8} />}
              >
                <Text font={11} fontWeight="semibold" foregroundStyle="#1E93D6">
                  已同步 {fmtNum(syncedCount)}
                </Text>
              </HStack>
            ) : null}
            <UnreadBadge count={unread} />
          </HStack>
        </VStack>
      </HStack>
      </Button>
    </HStack>
  )
}

export function ChatsScreen({ p }: { p: PanelCtx }) {
  const search = p.chatSearch.trim().toLowerCase()

  // 本地已同步会话名 → 统计行（每行的“已同步 N”角标 + 「已同步」筛选都要用）。
  // 只在 stats 变时重建，不跟着每次重渲染重算。
  const localByName = useMemo(() => {
    const m = new Map<string, any>()
    for (const c of p.stats?.chats || []) {
      if (c.chat_name) m.set(String(c.chat_name), c)
    }
    return m
  }, [p.stats])

  const rows = useMemo(
    () =>
      (p.chats || []).filter((c: any) => {
        const name = String(c.name ?? c.id)
        if (p.chatScope === "gsync") {
          // 「已同步」分组：只看本地已同步的会话，再扣掉本地移出的（「全部」不扣）
          if (p.excludedChats.includes(String(c.id))) return false
          if (!localByName.has(name)) return false
        }
        if (search && !name.toLowerCase().includes(search)) return false
        return true
      }),
    [p.chats, p.chatScope, p.excludedChats, localByName, search],
  )
  const shown = useMemo(() => rows.slice(0, p.listLimit), [rows, p.listLimit])

  // push 的身份每次根组件重渲染都会变（它闭包了 path），用 ref 转一道，
  // 行节点数组才只跟随「列表内容」变化——busy/通知/其它页签的任何状态抖动
  // 都不会重建这几十行的虚拟树（每次命令的 busy 起落都会触发根组件重渲染）。
  const pushRef = useRef(p.push)
  pushRef.current = p.push
  const rowNodes = useMemo(
    () =>
      shown.map((c: any) => {
        const name = String(c.name ?? c.id)
        const local = localByName.get(name)
        return (
          <ChatListRow
            key={String(c.id)}
            chat={c}
            syncedCount={local ? local.msg_count : 0}
            onOpen={() => pushRef.current(chatPage(c.id))}
          />
        )
      }),
    [shown, localByName],
  )

  /** 切换底部标签：带平滑动画（列表行插入/删除一并过渡） */
  const switchScope = (tag: string) => {
    withAnimation(Animation.smooth({ duration: 0.28 }), () => p.setChatScope(tag))
  }

  return (
    <List
      listStyle="plain"
      listRowInsets={{ top: 0, bottom: 0, leading: 16, trailing: 16 }}
      navigationTitle="TG Hub"
      navigationBarTitleDisplayMode="inline"
      refreshable={async () => {
        await p.loadChats()
      }}
      toolbar={{
        cancellationAction: <Button title="关闭" action={p.dismiss} />,
        topBarTrailing: p.busy ? <ProgressView /> : undefined,
      }}
      navigationDestination={
        <NavigationDestination>{(page: string) => renderDestination(page, p)}</NavigationDestination>
      }
    >
      <Banners p={p} />

      {/* 顶部工具行：「全部/已同步」筛选 + 刷新（压在搜索栏之上，底部 DockBar 已撤） */}
      <Section>
        <HStack
          spacing={10}
          padding={{ vertical: 3 }}
          frame={{ maxWidth: "infinity" }}
          listRowSeparator={{ visibility: "hidden", edges: "all" }}
        >
          <SegmentedTabs
            items={[
              { tag: "all", label: "全部" },
              { tag: "gsync", label: "已同步" },
            ]}
            value={p.chatScope}
            onChanged={switchScope}
          />
          <ZStack
            alignment="center"
            frame={{ width: 44, height: 44 }}
            background={<RoundedRectangle fill="#F1F3F6" cornerRadius={12} />}
            onTapGesture={p.busy ? undefined : () => p.loadChats()}
          >
            <Image
              systemName="arrow.clockwise"
              foregroundStyle={p.busy ? "#C7C7CC" : "#34C759"}
              frame={{ width: 20, height: 20 }}
            />
          </ZStack>
        </HStack>
      </Section>

      {/* 搜索栏 + 会话列表（整页铺满，无卡片） */}
      <Section>
        <HStack
          spacing={7}
          padding={{ horizontal: 12, vertical: 5 }}
          frame={{ maxWidth: "infinity" }}
          background={<RoundedRectangle fill="#F1F3F6" cornerRadius={10} />}
          listRowSeparator={{ visibility: "hidden", edges: "all" }}
        >
          <Image systemName="magnifyingglass" foregroundStyle="#8E8E93" frame={{ width: 15, height: 15 }} />
          <TextField
            title="搜索群名 / 用户名"
            value={p.chatSearch}
            onChanged={p.setChatSearch}
            frame={{ maxWidth: "infinity" }}
          />
          {p.chatSearch !== "" ? (
            <DockIcon icon="xmark.circle.fill" color="#8E8E93" action={() => p.setChatSearch("")} />
          ) : null}
        </HStack>

        {p.chats === null ? (
          <>
            {/* 静默预拉也在进行中：提示改成加载态，避免“没加载”误导用户重复点 */}
            <Hint
              tone={p.chatsLoading ? "info" : "muted"}
              spinner={p.chatsLoading}
              text={p.chatsLoading ? "正在拉取会话列表…" : "还没有加载会话列表（需要已登录）"}
            />
            <PrimaryButton title="加载会话列表" action={p.loadChats} />
          </>
        ) : shown.length === 0 ? (
          <Hint tone="muted" text="没有匹配的会话" />
        ) : (
          rowNodes
        )}
      </Section>
    </List>
  )
}
