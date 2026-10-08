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
  useEffect,
  useMemo,
  useRef,
  useState,
} from "scripting"
import { tg, TYPE_LABEL } from "./api"
import { AccountMenu } from "./account"
import {
  Banners,
  DockIcon,
  Hint,
  PrimaryButton,
  SettingsRow,
  labelWidth,
  type HintTone,
} from "./components"
import { PAGE_SETTINGS, PAGE_TOOLS, chatPage, type PanelCtx } from "./ctx"
import { ChatDetailScreen } from "./detail"
import { ToolsScreen } from "./tools"
import { SettingsScreen } from "./settings"

/**
 * 根页：会话列表（唯一的主界面）。
 *  - 布局 2026-10-05 改 Pix 风：listStyle="plain" 整页铺满屏幕（不再装在 inset 卡片里）
 *  - 2026-10-07：搜索栏置顶；「全部/同步」缩成小按钮挂第 1、2 条会话卡右侧、
 *    第 3 行挂「暗色」开关（根视图整屏压暗蒙版）；「已同步 N」行内角标已删
 *  - 2026-10-07 晚：顶栏「TG Hub」标题删除；点会话行记住该会话（工具页「本群」
 *    默认查看它）；「已同步」筛选下支持**批量删除**——长按任一会话进入勾选
 *    （入口按钮 2026-10-07 晚已删）
 *  - 下拉可刷新；点任意一行 → 群详情
 */

/** Telegram-iOS 浅色主题设计令牌（取自 Swiftgram/Telegram-iOS 源码） */
const UI = {
  title: "#000000", // 一级标题（近黑）
  sub: "#8E8E93", // 次级文字 / 时间戳
  badge: "#34C759", // 未读角标绿
} as const

/** 对话行字号（紧凑版：标题 15 medium / 预览 14 / 时间 13 / 角标 12） */
const FONT_TITLE = 15
const FONT_PREVIEW = 14
const FONT_DATE = 13
const FONT_BADGE = 12

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

/** 方框条纹卡左侧渐变色块的配色（按会话散列取色，多彩斜条纹观感） */
const STRIPE_COLORS: [`#${string}`, `#${string}`][] = [
  ["#4FC5F7", "#1E90D6"],
  ["#5AD8A6", "#12B886"],
  ["#FFD666", "#FF9F0A"],
  ["#FF8FA3", "#FF375F"],
  ["#B48FF7", "#7C4DFF"],
  ["#6EE7F9", "#0891B2"],
  ["#F7A8B8", "#E0457B"],
  ["#A5B4FC", "#4F46E5"],
]

/** 首页筛选两枚小按钮（挂在第 1/2 条会话卡右侧）：选中浅蓝底蓝字，未选浅灰底灰字 */
const FILTER_ITEMS = [
  { tag: "all", label: "全部", icon: "list.bullet" },
  { tag: "gsync", label: "同步", icon: "checkmark.circle" },
]

/** 筛选小按钮：26pt 胶囊，固定宽度防压缩（图标 12 + 间距 4 + 文字宽 + 左右 18） */
function ScopeChip({
  item,
  selected,
  onTap,
}: {
  item: (typeof FILTER_ITEMS)[number]
  selected: boolean
  onTap: () => void
}) {
  const fg: `#${string}` = selected ? "#1E93D6" : "#8E8E93"
  const width = 12 + 4 + labelWidth(item.label, 12) + 18
  return (
    <HStack
      spacing={4}
      alignment="center"
      frame={{ width, height: 26, alignment: "center" }}
      background={<RoundedRectangle fill={selected ? "#E9F4FD" : "#F1F3F6"} cornerRadius={13} />}
      onTapGesture={onTap}
    >
      <Image systemName={item.icon} foregroundStyle={fg} frame={{ width: 12, height: 12 }} />
      <Text font={12} fontWeight={selected ? "semibold" : "medium"} foregroundStyle={fg}>
        {item.label}
      </Text>
    </HStack>
  )
}

/** 批量删除勾选圈：选中蓝底白勾、未选浅灰空心（固定 26pt 防同行压缩） */
function SelectChip({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <ZStack
      alignment="center"
      frame={{ width: 26, height: 26 }}
      background={<RoundedRectangle fill={on ? "#2AABEE" : "#F1F3F6"} cornerRadius={13} />}
      animation={{ animation: Animation.smooth({ duration: 0.2 }), value: on }}
      onTapGesture={onToggle}
    >
      {on ? (
        <Image systemName="checkmark" foregroundStyle="white" frame={{ width: 12, height: 12 }} />
      ) : null}
    </ZStack>
  )
}

/**
 * 第 3 行「暗色」开关：开 → 根视图盖全屏压暗蒙版、按钮变深底淡字；
 * 关 → 按钮浅灰底灰字（淡色）。蒙版 allowsHitTesting=false，页面照常可点。
 */function DimChip({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  const fg: `#${string}` = on ? "#F2F2F7" : "#8E8E93"
  const width = 12 + 4 + labelWidth("暗色", 12) + 18
  return (
    <HStack
      spacing={4}
      alignment="center"
      frame={{ width, height: 26, alignment: "center" }}
      background={<RoundedRectangle fill={on ? "#1C1C1E" : "#F1F3F6"} cornerRadius={13} />}
      animation={{ animation: Animation.smooth({ duration: 0.3 }), value: on }}
      onTapGesture={onToggle}
    >
      <Image systemName="moon.fill" foregroundStyle={fg} frame={{ width: 12, height: 12 }} />
      <Text font={12} fontWeight={on ? "semibold" : "medium"} foregroundStyle={fg}>
        暗色
      </Text>
    </HStack>
  )
}

function stripeOf(seed: string): [`#${string}`, `#${string}`] {
  let sum = 0
  for (let i = 0; i < seed.length; i++) sum += seed.charCodeAt(i)
  return STRIPE_COLORS[sum % STRIPE_COLORS.length]
}

/** 路由：把 path 里的页面标识渲染成目标页。 */
function renderDestination(page: string, p: PanelCtx) {
  if (page.startsWith("chat:")) {
    const raw = page.slice("chat:".length)
    const chat =
      (p.chats || []).find((c: any) => String(c.id) === raw) ||
      // 详情页压栈期间列表刷新把该会话刷掉了：补全字段默认值，
      // 否则详情页拿到半空对象、type/预览/未读处会渲染出空/错内容
      {
        id: raw,
        name: raw,
        type: "",
        preview: "",
        date: null,
        unread: 0,
        avatar: "",
        creator: false,
      }
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
  chip,
  onOpen,
  onLongPress,
}: {
  chat: any
  /** 第 1/2/3 行右侧小按钮（全部 / 同步 / 暗色；有它时点按手势改挂内容区） */
  chip?: any
  onOpen: () => void
  /** 长按（「已同步」筛选下进入批量勾选）；点按后短时间内的长按/长按后的点按互不串扰 */
  onLongPress?: () => void
}) {
  const name = chat.name || String(chat.id)
  const typeLabel = TYPE_LABEL[chat.type] || chat.type || ""
  const preview = String(chat.preview || "").trim()
  const secondLine = preview || typeLabel || "暂无消息"
  const time = chatTime(chat.date)
  const unread = Number(chat.unread) || 0
  const pair = stripeOf(`${chat.id}-${name}`)
  const initial = name.trim().slice(0, 1).toUpperCase() || "?"

  // 点按/长按并存：长按后 700ms 内的 tap 会被吞掉（否则长按被当成点一下打开群）
  const lastLong = useRef(0)
  const handleTap = () => {
    if (Date.now() - lastLong.current < 700) return
    onOpen()
  }
  const handleLong = () => {
    lastLong.current = Date.now()
    if (onLongPress) onLongPress()
  }

  return (
    <HStack
      spacing={0}
      padding={{ vertical: 0 }}
      listRowInsets={{ top: 0, bottom: 0, leading: 16, trailing: 16 }}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
      listRowSeparator={{ visibility: "hidden", edges: "all" }}
    >
      {/* 方框条纹卡：白色圆角卡 + 左侧斜纹渐变色块（照片/首字母坐落其上）；
          点按直接挂手势（不用 Button 包裹，避免其自带内边距把卡间撑开） */}
      <HStack
        spacing={10}
        padding={{ horizontal: 10, vertical: 7 }}
        frame={{ maxWidth: "infinity", alignment: "leading" }}
        background={<RoundedRectangle fill="#FFFFFF" cornerRadius={16} />}
        shadow={{ color: "rgba(0,0,0,0.08)", radius: 6, y: 2 }}
        onTapGesture={chip ? undefined : handleTap}
        onLongPressGesture={onLongPress && !chip ? handleLong : undefined}
      >
          {/* 内容区（头像 + 文字）：挂了筛选小按钮的行把点按改挂这里，
              与按钮同级互不串扰（避免父子手势嵌套，点按钮误开群） */}
          <HStack
            spacing={10}
            frame={{ maxWidth: "infinity", alignment: "leading" }}
            onTapGesture={chip ? handleTap : undefined}
            onLongPressGesture={onLongPress && chip ? handleLong : undefined}
          >
          <ZStack alignment="center" frame={{ width: 48, height: 48 }}>
            <RoundedRectangle
              fill={{ colors: pair, startPoint: "topLeading", endPoint: "bottomTrailing" }}
              cornerRadius={12}
              frame={{ width: 48, height: 48 }}
            />
            {chat.avatar ? (
              <Image
                filePath={chat.avatar}
                resizable
                scaleToFill
                clipShape="circle"
                frame={{ width: 40, height: 40 }}
              />
            ) : (
              <Text font={19} fontWeight="bold" foregroundStyle="white">
                {initial}
              </Text>
            )}
          </ZStack>
          <VStack
            alignment="leading"
            spacing={2}
            frame={{ maxWidth: "infinity", alignment: "leading" }}
          >
            {/* 行 1：标题 + 右侧时间 */}
            <HStack spacing={6} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Text
                font={FONT_TITLE}
                fontWeight="semibold"
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

            {/* 行 2：消息预览 + 未读角标（原「已同步 N」小字 2026-10-07 已删） */}
            <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Text
                font={FONT_PREVIEW}
                foregroundStyle={UI.sub}
                lineLimit={1}
                frame={{ maxWidth: "infinity", alignment: "leading" }}
              >
                {secondLine}
              </Text>
              <UnreadBadge count={unread} />
            </HStack>
          </VStack>
          </HStack>
          {chip}
      </HStack>
    </HStack>
  )
}

/**
 * 会话 id → 本地库 chat_id 口径（与后端 _canonical_chat_id 同规则）：
 * 负数取绝对值，-100 前缀（超级群/频道）再剥 3 位。list_chats 返回的是
 * Telegram 原始 id（-100…），stats.chats 是剥过的裸 id，直接 String 比对必不等。
 */
function canonicalId(id: any): string {
  const n = Number(id)
  if (!Number.isFinite(n)) return String(id)
  if (n < 0) {
    const digits = String(Math.abs(n))
    if (digits.startsWith("100") && digits.length > 3) return digits.slice(3)
    return String(Math.abs(n))
  }
  return String(n)
}

export function ChatsScreen({ p }: { p: PanelCtx }) {
  const search = p.chatSearch.trim().toLowerCase()

  // 批量删除（仅「已同步」筛选）：长按任一会话行进入勾选模式 + 行内 5 秒结果提示
  const [selMode, setSelMode] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [batchRunning, setBatchRunning] = useState(false)
  const [batchHint, setBatchHint] = useState<{ tone: HintTone; text: string } | null>(null)
  const mountedRef = useRef(true)
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (hintTimer.current !== null) clearTimeout(hintTimer.current)
    }
  }, [])
  const flashBatch = (tone: HintTone, text: string) => {
    if (!mountedRef.current) return
    setBatchHint({ tone, text })
    if (hintTimer.current !== null) clearTimeout(hintTimer.current)
    hintTimer.current = setTimeout(() => {
      hintTimer.current = null
      if (mountedRef.current) setBatchHint(cur => (cur?.text === text ? null : cur))
    }, 5000)
  }

  // 本地已同步会话名 → 只供「已同步」筛选用（行内“已同步 N”角标 2026-10-07 已删）。
  // 只在 stats 变时重建，不跟着每次重渲染重算。
  const localByName = useMemo(() => {
    const m = new Map<string, any>()
    for (const c of p.stats?.chats || []) {
      if (c.chat_name) m.set(String(c.chat_name), c)
    }
    return m
  }, [p.stats])

  // 已同步集合的 id 索引：以前只按**名字**匹配，群改名/无名会话会让它从
  // 「已同步」里凭空消失（「全部」还在，表现就是筛选结果时多时少）。
  const localIds = useMemo(() => {
    const s = new Set<string>()
    for (const c of p.stats?.chats || []) {
      if (c.chat_id != null) s.add(String(c.chat_id))
    }
    return s
  }, [p.stats])

  const rows = useMemo(
    () =>
      (p.chats || []).filter((c: any) => {
        const name = String(c.name ?? c.id)
        if (p.chatScope === "gsync") {
          // 「已同步」分组：只看本地已同步的会话，再扣掉本地移出的（「全部」不扣）
          if (p.excludedChats.includes(String(c.id))) return false
          // id 优先（稳定，不怕改名），名字兜底（老数据/异形 id）
          if (!localIds.has(canonicalId(c.id)) && !localByName.has(name)) return false
        }
        if (search && !name.toLowerCase().includes(search)) return false
        return true
      }),
    [p.chats, p.chatScope, p.excludedChats, localByName, localIds, search],
  )
  const shown = useMemo(() => rows.slice(0, p.listLimit), [rows, p.listLimit])

  // push 的身份每次根组件重渲染都会变（它闭包了 path），用 ref 转一道，
  // 行节点数组才只跟随「列表内容」变化——busy/通知/其它页签的任何状态抖动
  // 都不会重建这几十行的虚拟树（每次命令的 busy 起落都会触发根组件重渲染）。
  const pushRef = useRef(p.push)
  pushRef.current = p.push

  /** 切换筛选：带平滑动画（列表行插入/删除一并过渡）；离开「已同步」退出勾选 */
  const switchScope = (tag: string) => {
    if (tag !== "gsync") {
      setSelMode(false)
      setSelected([])
      setBatchHint(null)
    }
    withAnimation(Animation.smooth({ duration: 0.28 }), () => p.setChatScope(tag))
  }

  const toggleSelect = (id: any) => {
    const sid = String(id)
    setSelected(cur => (cur.includes(sid) ? cur.filter(x => x !== sid) : [...cur, sid]))
  }

  /** 批量删除：我创建的永久删除，其余退出（逐个执行、单个失败不影响其余） */
  const runBatchDelete = async () => {
    if (batchRunning || p.busy !== null) return
    const targets = shown.filter((c: any) => selected.includes(String(c.id)))
    if (targets.length === 0) return
    const mine = targets.filter((c: any) => !!c.creator)
    const others = targets.filter((c: any) => !c.creator)
    const ok = await Dialog.confirm({
      title: `删除 ${targets.length} 个已同步会话`,
      message:
        mine.length > 0 && others.length > 0
          ? `将永久删除我创建的 ${mine.length} 个（不可恢复）、退出其余 ${others.length} 个；本地消息记录保留。`
          : mine.length > 0
            ? `将永久删除这 ${mine.length} 个会话（仅我创建的可删除，不可恢复）；本地消息记录保留。`
            : `将退出这 ${others.length} 个会话；本地消息记录保留。`,
      confirmLabel: "删除",
    })
    if (!ok) return
    setBatchRunning(true)
    // 占 busy（2026-10-07 审计）：bulk_leave 带 0.6s 限速、可达十秒级，
    // 以前全程 busy=null → 顶栏账号菜单/退出登录等都没禁用，期间关面板、
    // 切账号都会让下面 await 之后的 setState 落到已卸载组件上。
    p.beginBusy("批量删除中…")
    let done = 0
    let failed = 0
    try {
      const step = async (list: any[], action: "leave" | "delete") => {
        if (list.length === 0) return
        const r = await tg(
          "bulk_leave",
          { chats: list.map((c: any) => c.id), action },
          600,
        )
        if (r.ok) {
          done += (r.done || []).length
          failed += (r.failed || []).length
        } else {
          failed += list.length
        }
      }
      await step(mine, "delete")
      await step(others, "leave")
    } catch {
      failed = targets.length - done // 已成功的不重复计入失败
    } finally {
      p.endBusy()
      if (mountedRef.current) setBatchRunning(false)
    }
    if (mountedRef.current) {
      setSelMode(false)
      setSelected([])
    }
    flashBatch(
      failed > 0 ? "error" : "ok",
      failed > 0 ? `已删除 ${done} 个 · 失败 ${failed} 个` : `已删除 ${done} 个会话`,
    )
    p.loadChats()
  }

  /** 第 i 行右侧的小按钮：i=0「全部」、i=1「同步」、i=2「暗色」开关，更靠后的行没有 */
  const CHIP_TOTAL = 3
  const chipAt = (i: number) => {
    // 勾选模式：每行右侧改放勾选圈，点行/圈都是切换选中
    if (selMode) {
      const c = shown[i]
      if (!c) return null
      return (
        <SelectChip
          key={`sel-${c.id}`}
          on={selected.includes(String(c.id))}
          onToggle={() => toggleSelect(c.id)}
        />
      )
    }
    if (i === 2) {
      return (
        <DimChip
          key="dim"
          on={!!p.dim}
          onToggle={() =>
            withAnimation(Animation.smooth({ duration: 0.3 }), () => p.setDim(!p.dim))
          }
        />
      )
    }
    if (i >= FILTER_ITEMS.length) return null
    const item = FILTER_ITEMS[i]
    return (
      <ScopeChip
        key={item.tag}
        item={item}
        selected={p.chatScope === item.tag}
        onTap={() => switchScope(item.tag)}
      />
    )
  }

  const rowNodes = useMemo(
    () =>
      shown.map((c: any, i: number) => (
        <ChatListRow
          key={String(c.id)}
          chat={c}
          chip={chipAt(i)}
          onOpen={() => {
            if (selMode) {
              toggleSelect(c.id)
              return
            }
            p.rememberChat(c) // 记住最后点开的会话（工具页「本群」默认看它）
            pushRef.current(chatPage(c.id))
          }}
          // 长按（已同步筛选、非勾选模式）→ 进入批量勾选并选中被按的这一行
          onLongPress={
            p.chatScope === "gsync" && !selMode
              ? () => {
                  setBatchHint(null)
                  setSelected([String(c.id)])
                  setSelMode(true)
                }
              : undefined
          }
        />
      )),
    [shown, p.chatScope, p.dim, selMode, selected],
  )

  // 行数不足 3 条（空列表 / 搜出很少）时空出的小按钮右对齐单独成行，
  // 保证「同步」筛选与「暗色」开关不会因行太少而消失、切不回去
  const spareChips = useMemo(() => {
    if (selMode) return []
    const out: any[] = []
    for (let i = shown.length; i < CHIP_TOTAL; i++) out.push(chipAt(i))
    return out
  }, [shown.length, p.chatScope, p.dim, selMode])

  const allSelected =
    shown.length > 0 && shown.every((c: any) => selected.includes(String(c.id)))
  // 「已选 N」只数**当前可见行**里被选中的：勾选后改搜索/筛选，selected
  // 里可能残留已看不见的 id，直接 selected.length 会显示「已选 8」但只能
  // 删 5 个（确认弹窗与删除目标都按可见行算），显示与实际不一致。
  const selectedVisible = shown.filter((c: any) => selected.includes(String(c.id))).length

  return (
    <List
      listStyle="plain"
      listRowSpacing={10}
      listRowInsets={{ top: 0, bottom: 0, leading: 16, trailing: 16 }}
      navigationTitle=""
      navigationBarTitleDisplayMode="inline"
      refreshable={async () => {
        await p.loadChats()
      }}
      toolbar={{
        cancellationAction: <Button title="关闭" action={p.dismiss} />,
        topBarTrailing: (
          <HStack spacing={8}>
            {p.busy ? <ProgressView /> : null}
            {/* 学 IPA-Tool 顶栏的账号快速切换胶囊（QuickSwitchAccountMenu） */}
            <AccountMenu p={p} />
          </HStack>
        ),
      }}
      navigationDestination={
        <NavigationDestination>{(page: string) => renderDestination(page, p)}</NavigationDestination>
      }
    >
      <Banners p={p} />

      {/* 搜索栏置顶 + 会话列表（整页铺满，无卡片）：
          筛选原为顶部两枚大卡，2026-10-07 缩成小按钮挂第 1/2 行右侧、第 3 行加「暗色」开关 */}
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

        {/* 批量删除（仅「已同步」筛选）：长按任一会话行进入勾选模式，这里是操作行 */}
        {p.chatScope === "gsync" && selMode ? (
          <>
              <SettingsRow
                icon="checkmark.circle"
                color="#2AABEE"
                chevron={false}
                disabled={batchRunning || shown.length === 0}
                title={allSelected ? "清空选择" : "全选本页"}
                value={`已选 ${selectedVisible}`}
                action={() =>
                  setSelected(allSelected ? [] : shown.map((c: any) => String(c.id)))
                }
              />
              <SettingsRow
                icon="trash"
                color="#FF3B30"
                danger
                chevron={false}
                disabled={batchRunning || selectedVisible === 0 || p.busy !== null}
                title={batchRunning ? "删除中…" : "删除所选"}
                value={`${selectedVisible} 个`}
                action={runBatchDelete}
                trailing={batchRunning ? <ProgressView /> : undefined}
              />
              <SettingsRow
                icon="xmark"
                color="#8E8E93"
                chevron={false}
                disabled={batchRunning}
                title="取消"
                action={() => {
                  setSelMode(false)
                  setSelected([])
                }}
              />
            </>
        ) : null}

        {/* 批量结果：临时提示（5 秒自动消失，显示在搜索栏下方） */}
        {p.chatScope === "gsync" && batchHint ? (
          <Hint tone={batchHint.tone} text={batchHint.text} />
        ) : null}

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
          <>
            {spareChips.length ? (
              <HStack
                spacing={8}
                frame={{ maxWidth: "infinity", alignment: "trailing" }}
                listRowInsets={{ top: 0, bottom: 0, leading: 16, trailing: 16 }}
                listRowSeparator={{ visibility: "hidden", edges: "all" }}
              >
                {spareChips}
              </HStack>
            ) : null}
            <Hint tone="muted" text="没有匹配的会话" />
          </>
        ) : (
          <>
            {rowNodes}
            {spareChips.length ? (
              <HStack
                spacing={8}
                frame={{ maxWidth: "infinity", alignment: "trailing" }}
                listRowInsets={{ top: 0, bottom: 0, leading: 16, trailing: 16 }}
                listRowSeparator={{ visibility: "hidden", edges: "all" }}
              >
                {spareChips}
              </HStack>
            ) : null}
          </>
        )}
      </Section>
    </List>
  )
}
