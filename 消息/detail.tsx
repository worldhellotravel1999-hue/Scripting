import {
  Button,
  Device,
  HStack,
  Image,
  List,
  ProgressView,
  Rectangle,
  RoundedRectangle,
  ScrollView,
  Section,
  Text,
  TextField,
  ZStack,
  VStack,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "scripting"
import { fmtNum, fmtTime, tg, TYPE_LABEL } from "./api"
import {
  Avatar,
  Banners,
  FieldBox,
  Hint,
  hintColor,
  labelWidth,
  MsgRow,
  RowButton,
  SettingsRow,
  type HintTone,
} from "./components"
import {
  AiActionsSection,
  EMPTY_AI_RESULT,
  ResultSheet,
  type AiResult,
  type SetAiResult,
} from "./ai_panel"
import { type PanelCtx } from "./ctx"

/**
 * 群详情页（点会话列表里的任意一个群进入）：
 *  1. 直接输入文本发送消息（以登录账号发出，相当于本地部署的 Telegram 客户端）
 *  2. 一键「同步消息」
 *  3. 点一下动作 → AI 分析该群消息（动作可自定义），分析结果可一键发回本群
 *  4. 查看本地最近消息（紧跟行下的**动态窗口**，内容自适应高度）/ 清除本地记录
 *  5. 卡片末尾：批量退出 / 批量删除（原在设置页，2026-10-05 移入本卡片）
 * 2026-10-05 二次改版：行内不再放「输入框 + 按钮」，危险操作一律**点行弹窗
 * 确认/输入**（Dialog），说明文案收进弹窗。
 * 2026-10-06 三次改版：AI 分析/提问结果改**页面内浮层临时窗口**（遮罩 + 居中
 * 动态卡片，不弹全屏 sheet 二级页，也无重新生成/刷新按钮）；所有临时结果提示改成
 * **行内小字**（显示在对应按钮行自己的空白处），不再在行下另起气泡；
 * 「查看最近消息」收成**紧跟行下的动态窗口**（高度随内容自适应、内部滚动，
 * 原「刷新本地消息」行与行下提示气泡删除）。
 */

/**
 * 批量退出 / 批量删除自己创建的频道群（预览用 p.chats，执行走 bulk_leave 命令）。
 * 2026-10-06 终版：**整块收成一个按钮、联动显示** —— 菜单上平时只显示一行
 * 「群组频道管理」，点它以后同一行按逻辑逐步切换内容（始终只占一行）：
 *   收起 → [←] [退出] [删除我创建] → [←] [全部] [群组] [频道]
 *        → 执行行（先弹「名称包含」筛选输入，再弹执行确认）。
 * 执行成功自动收起回「群组频道管理」，结果小字行内显示 5 秒；
 * 弹窗点「取消」= 退回上一步，行内 ← 可一路退回收起态。
 */
export function BulkLeaveSection({ p }: { p: PanelCtx }) {
  const [op, setOp] = useState("leave")
  const [scope, setScope] = useState("group")
  // 步进联动：idle（收起的单按钮「群组频道管理」）→ op → scope → run
  const [step, setStep] = useState<"idle" | "op" | "scope" | "run">("idle")
  const [keyword, setKeyword] = useState("")
  const [running, setRunning] = useState(false)
  const [hint, setHint] = useState("")

  // 卸载守卫：await / 定时器回来时组件可能已退出，直接 setState 会崩
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  /** 定时提示：卸载后不再触发 setState */
  function later(ms: number, fn: () => void) {
    setTimeout(() => {
      if (mountedRef.current) fn()
    }, ms)
  }

  /** 按 操作 + 范围 + 关键词 过滤（执行前可用新关键词重算数量与名单） */
  function filterChats(k: string, o: string, s: string) {
    const kk = k.trim().toLowerCase()
    return (p.chats || []).filter((c: any) => {
      const t = c.type
      if (s === "group" && t !== "group" && t !== "supergroup") return false
      if (s === "channel" && t !== "channel") return false
      if (o === "delete" && !c.creator) return false
      if (kk && !String(c.name ?? c.id).toLowerCase().includes(kk)) return false
      return true
    })
  }

  const matches = filterChats(keyword, op, scope)
  const verb = op === "delete" ? "删除" : "退出"
  const namesOf = (list: any[]) => list.slice(0, 4).map((c: any) => c.name || c.id).join("、")
  const tailOf = (list: any[]) => (list.length > 4 ? ` 等 ${list.length} 个` : "")

  async function run(list: any[]) {
    if (running || list.length === 0) return
    setRunning(true)
    setHint("")
    try {
      const res = await tg(
        "bulk_leave",
        { chats: list.map((c: any) => c.id), action: op },
        600
      )
      if (res.ok) {
        const fails: any[] = res.failed || []
        const failText =
          fails.length > 0
            ? `；失败 ${fails.length} 个：${fails
                .slice(0, 3)
                .map((f: any) => `${f.name}（${f.error}）`)
                .join("、")}${fails.length > 3 ? "…" : ""}`
            : ""
        if (!mountedRef.current) return
        const msg = `完成：成功 ${(res.done || []).length} / ${res.processed}${failText}`
        // 成功 = 自动收起回单按钮，结果小字显示在收起行上 5 秒
        setStep("idle")
        setHint(msg)
        later(5000, () => setHint(cur => (cur === msg ? "" : cur)))
        p.loadChats()
      } else {
        if (!mountedRef.current) return
        const msg = res.error || "执行失败"
        setHint(msg)
        later(5000, () => setHint(cur => (cur === msg ? "" : cur)))
      }
    } finally {
      if (mountedRef.current) setRunning(false)
    }
  }

  const choice = (
    icon: string,
    title: string,
    selected: boolean,
    color: `#${string}`,
    action: () => void
  ) => (
    <Button
      buttonStyle="plain"
      action={action}
      frame={{ maxWidth: "infinity" }}
    >
      {/* 与 SettingsRow 完全一致：不固定高度，由 30pt 图标 + 上下 9pt 内边距自然撑开。 */}
      <HStack
        spacing={12}
        padding={{ vertical: 9 }}
        frame={{ maxWidth: "infinity", alignment: "center" }}
      >
        <ZStack alignment="center" frame={{ width: 30, height: 30 }}>
          <RoundedRectangle fill={color} cornerRadius={7} frame={{ width: 30, height: 30 }} />
          <Image systemName={icon} foregroundStyle="white" frame={{ width: 17, height: 17 }} />
        </ZStack>
        <Text
          font={15}
          fontWeight={selected ? "semibold" : "medium"}
          foregroundStyle="#000000"
          lineLimit={1}
        >
          {title}
        </Text>
      </HStack>
    </Button>
  )

  /** 行内退回箭头：窄固定宽（固定 frame 不受压缩），把宽度留给选择格 */
  const back = (to: "idle" | "op" | "scope", width: number) => (
    <Button
      buttonStyle="plain"
      action={() => {
        setHint("")
        setStep(to)
      }}
      frame={{ width }}
    >
      <HStack padding={{ vertical: 9 }} frame={{ maxWidth: "infinity", alignment: "center" }}>
        <Image systemName="chevron.left" foregroundStyle="#8E8E93" frame={{ width: 14, height: 14 }} />
      </HStack>
    </Button>
  )

  // 同一行按步进切换内容，整块始终只占一行（菜单上平时只有「群组频道管理」一个按钮）；
  // 每一步都是独立 List 行，分割线由 List 统一绘制，与上下其它行完全对齐。
  if (step === "idle") {
    return (
      <>
        <SettingsRow
          icon="person.3.fill"
          color="#2AABEE"
          title="群组频道管理"
          hint={hint !== "" ? hint : undefined}
          hintTone={hint.startsWith("完成") ? "ok" : "error"}
          action={() => {
            setHint("")
            setStep("op")
          }}
        />
      </>
    )
  }

  if (step === "op") {
    return (
      <>
        <HStack spacing={12} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          {back("idle", 16)}
          {choice("arrow.uturn.left", "退出", op === "leave", "#FF9500", () => {
            setOp("leave")
            setHint("")
            setStep("scope")
          })}
          {choice("trash", "删除我创建", op === "delete", "#FF3B30", () => {
            setOp("delete")
            setHint("")
            setStep("scope")
          })}
        </HStack>
      </>
    )
  }

  if (step === "scope") {
    return (
      <>
        <HStack spacing={12} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          {back("op", 24)}
          {choice("line.3.horizontal", "全部", scope === "all", "#2AABEE", () => {
            setScope("all")
            setHint("")
            setStep("run")
          })}
          {choice("person.3.fill", "群组", scope === "group", "#2AABEE", () => {
            setScope("group")
            setHint("")
            setStep("run")
          })}
          {choice("antenna.radiowaves.left.and.right", "频道", scope === "channel", "#2AABEE", () => {
            setScope("channel")
            setHint("")
            setStep("run")
          })}
        </HStack>
      </>
    )
  }

  // 执行行：行首带 ←，任何状态（包括执行被禁用时）都能退回范围排 → 一路退回收起态；
  // 点行先弹「名称包含」筛选（0 匹配也能进来改关键词，避免死路），再弹执行确认
  return (
    <>
      <HStack spacing={12} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        {back("scope", 24)}
        <SettingsRow
          icon={op === "delete" ? "trash" : "arrow.uturn.left"}
          color={op === "delete" ? "#FF3B30" : "#FF9500"}
          danger
          disabled={running || p.busy !== null}
          title={running ? "处理中…" : `${verb} ${matches.length} 个匹配会话`}
          hint={
            hint !== ""
              ? hint
              : matches.length === 0
                ? p.chats === null
                  ? "会话列表还没加载"
                  : "没有匹配的会话"
                : undefined
          }
          hintTone={hint !== "" ? (hint.startsWith("完成") ? "ok" : "error") : "muted"}
          action={async () => {
            if (running || p.busy !== null) return
            // 第 1 弹：名称包含筛选（取消 = 退回范围排，再点 ← 可改操作）
            const v = await Dialog.prompt({
              title: "名称包含",
              message: `筛选要批量${verb}的会话名（当前匹配 ${matches.length} 个），留空 = 全部`,
              defaultValue: keyword,
              placeholder: "留空 = 全部",
              confirmLabel: "确定",
            })
            if (v === null) {
              setStep("scope")
              return
            }
            setKeyword(v)
            const m = filterChats(v, op, scope)
            // 0 匹配：行内空态提示会自动显示，停在本行改关键词即可
            if (m.length === 0) return
            // 第 2 弹：执行确认（名单与数量按新关键词实时计算）
            const ok = await Dialog.confirm({
              title: `${verb} ${m.length} 个匹配会话`,
              message: `将${verb}：${namesOf(m)}${tailOf(m)}。${
                op === "delete" ? "删除后不可恢复！" : "退出后本地消息仍保留。"
              }`,
              confirmLabel: verb,
            })
            if (ok) await run(m)
            else setStep("scope")
          }}
          trailing={running ? <ProgressView /> : undefined}
        />
      </HStack>
    </>
  )
}

/**
 * 最近消息动态窗口的高度估算：逐条估行高（时间行 16 + 正文每行 22（lineLimit 4）
 * + 发送者行 15 + 块内/块间距），内容多大窗口多大。
 */
function estimateMsgsHeight(msgs: any[], availWidth: number): number {
  let h = 0
  for (const m of msgs) {
    const raw = String(m.content ?? "").replace(/\s+/g, " ").trim().slice(0, 200)
    const lines = Math.max(
      1,
      Math.min(4, Math.ceil(labelWidth(raw, 17) / Math.max(60, availWidth))),
    )
    h += 16 + lines * 22 + 15 + 6 + 10
  }
  return h
}

// ── 文本格式面板（仿 Telegram 输入框格式栏）：点按钮把对应 HTML 标签包住整段草稿，
// 再点一次同按钮取消；发送时后端按 HTML 解析成 Telegram 格式实体。

type FmtWrap = { label: string; open: string; close: string }

const FMT_ROW_1: FmtWrap[] = [
  { label: "引用", open: "<blockquote>", close: "</blockquote>" },
  { label: "遮罩", open: '<span class="tg-spoiler">', close: "</span>" },
  { label: "粗体", open: "<b>", close: "</b>" },
  { label: "斜体", open: "<i>", close: "</i>" },
  { label: "等宽", open: "<code>", close: "</code>" },
]

const FMT_ROW_2: FmtWrap[] = [
  { label: "删除线", open: "<s>", close: "</s>" },
  { label: "下划线", open: "<u>", close: "</u>" },
  { label: "代码", open: "<pre>", close: "</pre>" },
]

export function ChatDetailScreen({ p, chat }: { p: PanelCtx; chat: any }) {
  const chatName: string = chat.name || String(chat.id)
  const [syncRes, setSyncRes] = useState<any>(null)
  const [localMsgs, setLocalMsgs] = useState<any[] | null>(null)
  const [msgError, setMsgError] = useState("")
  const [msgLoading, setMsgLoading] = useState(false)
  const [showMsgs, setShowMsgs] = useState(false)
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [sendHint, setSendHint] = useState<{
    tone: "ok" | "warn" | "error"
    text: string
  } | null>(null)
  const [recallCount, setRecallCount] = useState("2")
  const [recalling, setRecalling] = useState(false)
  const [recallHint, setRecallHint] = useState("")
  const [leaving, setLeaving] = useState(false)
  const [leaveHint, setLeaveHint] = useState("")
  const [destroying, setDestroying] = useState(false)
  const [destroyHint, setDestroyHint] = useState("")
  const [folderHint, setFolderHint] = useState("")
  const [showFormats, setShowFormats] = useState(false)
  const [formatHint, setFormatHint] = useState("")
  // 发送防重入：sending 是 state，双击窗口内读到的还是旧值，用 ref 兑底
  const sendingRef = useRef(false)
  // AI 结果临时窗口：结果状态由本页持有（页面浮层展示）；页面重开即空白
  const [aiRes, setAiResRaw] = useState<AiResult>(EMPTY_AI_RESULT)
  const [aiSheet, setAiSheet] = useState(false)
  const patchAi: SetAiResult = patch =>
    setAiResRaw(r => ({ ...r, ...(typeof patch === "function" ? patch(r) : patch) }))

  // 卸载守卫：本页每次 await / 定时器回来时可能已退出导航栈，直接 setState
  // 会触发「组件已销毁」崩溃（用户反馈的偶发闪退之一）
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  /** 定时提示：卸载后不再触发 setState */
  function later(ms: number, fn: () => void) {
    setTimeout(() => {
      if (mountedRef.current) fn()
    }, ms)
  }

  // 该会话是否已被移出「已同步」分组（纯本地，不影响「全部」）
  const excludedFromFolder = p.excludedChats.includes(String(chat.id))

  /** 点行弹窗确认后移出分组（只改本地分组显示，不碰 Telegram） */
  async function handleExcludeFromFolder() {
    const ok = await Dialog.confirm({
      title: "从「已同步」分组移出",
      message: "只移出本分组显示，不退出群；「全部」里仍然可见。确定移出？",
      confirmLabel: "移出",
    })
    if (!ok) return
    p.excludeChat(chat.id)
    const msg = "已移出「已同步」分组；「全部」里仍然可见"
    setFolderHint(msg)
    later(5000, () => setFolderHint(cur => (cur === msg ? "" : cur)))
  }

  const local = (p.stats?.chats || []).find((c: any) => c.chat_name === chatName)

  async function handleSync() {
    const res = await p.syncOne(chat)
    if (!mountedRef.current) return
    if (res) {
      setSyncRes(res)
      // 同步结果提示临时展示，5 秒后自动消失
      later(5000, () => setSyncRes((cur: any) => (cur === res ? null : cur)))
    }
  }

  async function handleSend() {
    const text = draft.trim()
    if (text === "" || sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    setSendHint(null)
    try {
      const res = await tg(
        "send_message",
        { chat: chatName, chat_id: chat.id, text },
        90
      )
      if (!mountedRef.current) return
      if (res.ok) {
        setDraft("")
        const hint: { tone: "ok" | "warn" | "error"; text: string } = {
          tone: "ok",
          text:
            res.sent > 1
              ? `已发送 ${res.sent} 条（超长自动分段）`
              : `已发送到「${res.chat || chatName}」`,
        }
        setSendHint(hint)
        later(5000, () => setSendHint(cur => (cur?.text === hint.text ? null : cur)))
        if (showMsgs) loadLocalMessages()
        p.loadOverview({ quiet: true })
      } else {
        // BusyTimeout = 命令还在后台排队/执行（不是真失败），用警告色而非错误色
        const hint: { tone: "ok" | "warn" | "error"; text: string } = {
          tone: res.etype === "BusyTimeout" ? "warn" : "error",
          text: res.error || "发送失败",
        }
        setSendHint(hint)
        later(5000, () => setSendHint(cur => (cur?.text === hint.text ? null : cur)))
      }
    } finally {
      sendingRef.current = false
      if (mountedRef.current) setSending(false)
    }
  }

  /** 格式面板：把标签包住整段草稿，再点一次取消（光标定位不可控，故整段处理）。 */
  function flashFormatHint(msg: string) {
    setFormatHint(msg)
    later(5000, () => setFormatHint(cur => (cur === msg ? "" : cur)))
  }

  function applyWrap(f: FmtWrap) {
    if (draft.trim() === "") {
      flashFormatHint("先输入内容，再选格式")
      return
    }
    if (draft.startsWith(f.open) && draft.endsWith(f.close)) {
      setDraft(draft.slice(f.open.length, draft.length - f.close.length))
    } else {
      setDraft(f.open + draft + f.close)
    }
  }

  /** 链接：弹窗输入网址，整段变成可点链接；已是链接则取消。 */
  async function applyLink() {
    if (draft.trim() === "") {
      flashFormatHint("先输入内容，再选格式")
      return
    }
    if (draft.startsWith('<a href="') && draft.endsWith("</a>")) {
      const gt = draft.indexOf('">')
      if (gt > 0) {
        setDraft(draft.slice(gt + 2, draft.length - "</a>".length))
        return
      }
    }
    const input = await Dialog.prompt({
      title: "插入链接",
      message: "整段文字将变成可点击的链接",
      placeholder: "https://example.com",
      confirmLabel: "插入",
    })
    const url = (input || "").trim()
    if (url === "") return
    if (!mountedRef.current) return
    setDraft(`<a href="${url}">${draft}</a>`)
  }

  /** 日期：在末尾插入当前日期时间文本。 */
  function applyDate() {
    const d = new Date()
    const p2 = (n: number) => (n < 10 ? `0${n}` : String(n))
    const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
    setDraft(draft === "" || /\s$/.test(draft) ? draft + stamp : `${draft} ${stamp}`)
  }

  /** 撤回我最新发出的 N 条（Telegram 删除自己消息 = 对所有人撤回，不限时长）。 */
  async function handleRecall(n: number) {
    if (recalling) return
    setRecalling(true)
    setRecallHint("")
    try {
      const res = await tg(
        "delete_messages",
        { chat: chatName, chat_id: chat.id, limit: Math.min(n, 50) },
        60
      )
      if (!mountedRef.current) return
      if (res.ok) {
        const msg = `已撤回 ${res.deleted} 条（本地记录同步删除）`
        setRecallHint(msg)
        later(5000, () => setRecallHint(cur => (cur === msg ? "" : cur)))
        if (showMsgs) loadLocalMessages()
        p.loadOverview({ quiet: true })
      } else {
        const msg = res.error || "撤回失败"
        setRecallHint(msg)
        later(5000, () => setRecallHint(cur => (cur === msg ? "" : cur)))
      }
    } finally {
      if (mountedRef.current) setRecalling(false)
    }
  }

  /** 退出该会话（退群）：点行弹窗确认后执行。 */
  async function handleLeave() {
    if (leaving) return
    setLeaving(true)
    try {
      const res = await tg("leave_chat", { chat: chatName, chat_id: chat.id }, 60)
      if (!mountedRef.current) return
      if (res.ok) {
        const msg = `${res.action}；返回列表后将不再显示（本地消息记录仍保留）`
        setLeaveHint(msg)
        later(5000, () => setLeaveHint(cur => (cur === msg ? "" : cur)))
        p.loadChats()
      } else {
        const msg = res.error || "退出失败"
        setLeaveHint(msg)
        later(5000, () => setLeaveHint(cur => (cur === msg ? "" : cur)))
      }
    } finally {
      if (mountedRef.current) setLeaving(false)
    }
  }

  /** 永久删除自己创建的频道/群（不可恢复）：点行弹窗确认后执行。 */
  async function handleDestroy() {
    if (destroying) return
    setDestroying(true)
    try {
      const res = await tg("destroy_chat", { chat: chatName, chat_id: chat.id }, 60)
      if (!mountedRef.current) return
      if (res.ok) {
        const msg = `${res.action}，不可恢复；返回列表后将不再显示`
        setDestroyHint(msg)
        later(5000, () => setDestroyHint(cur => (cur === msg ? "" : cur)))
        p.loadChats()
      } else {
        const msg = res.error || "删除失败"
        setDestroyHint(msg)
        later(5000, () => setDestroyHint(cur => (cur === msg ? "" : cur)))
      }
    } finally {
      if (mountedRef.current) setDestroying(false)
    }
  }

  async function loadLocalMessages(opts?: { retried?: boolean }) {
    if (msgLoading) return
    setMsgLoading(true)
    setMsgError("")
    try {
      let res = await tg("recent", { chat: chatName, hours: 168, limit: 50 }, 60)
      // 本地库还没有这个会话 → 后端降级返回 needs_sync：自动先同步一次再重读。
      // 旧版这里直接弹「本地库中没有会话…」，体感就是“必须先发一条消息才能查看/同步”。
      if (res.ok && res.needs_sync && !opts?.retried) {
        const synced = await p.syncOne(chat)
        if (!mountedRef.current) return
        if (synced && synced.ok) {
          res = await tg("recent", { chat: chatName, hours: 168, limit: 50 }, 60)
        } else {
          setLocalMsgs([])
          setMsgError(
            `本地还没有该会话的消息，自动同步${
              synced ? `失败：${synced.error || "未知错误"}` : "未完成"
            }`
          )
          return
        }
      }
      if (!mountedRef.current) return
      if (!res.ok) {
        setMsgError(res.error || "读取失败")
        setLocalMsgs([])
      } else {
        setLocalMsgs(res.messages || [])
      }
    } finally {
      if (mountedRef.current) setMsgLoading(false)
    }
  }

  function toggleMessages() {
    const next = !showMsgs
    withAnimation(Animation.smooth({ duration: 0.3 }), () => setShowMsgs(next))
    if (next && localMsgs === null) loadLocalMessages()
  }

  async function handleDelete() {
    const ok = await Dialog.confirm({
      title: "清除本地记录",
      message: `删除「${chatName}」的本地消息记录？不影响 Telegram，之后可重新同步找回。`,
      confirmLabel: "清除",
    })
    if (!ok) return
    await p.doDeleteChat(chatName)
    if (!mountedRef.current) return
    setLocalMsgs(null)
    setShowMsgs(false)
    setSyncRes(null)
  }

  // 行内临时提示（发送结果 / 格式提示）：显示在输入行自己的空白处，不再另起一行
  const rowHintText = formatHint !== "" ? formatHint : sendHint ? sendHint.text : ""
  const rowHintTone: HintTone =
    formatHint !== "" ? "warn" : sendHint ? sendHint.tone : "info"

  // 最近消息**动态窗口**：高度随内容自适应（封顶 55% 屏高，超出内部滚动），
  // 紧跟「查看最近」行直接显示；原「刷新本地消息」行与行下独立 Hint 已删（提示收进窗口）
  const msgsScrollH = useMemo(() => {
    if (!showMsgs) return 0
    const avail = Device.screen.width - 56 // 窗口内边距 + 行距的保守近似
    let inner = estimateMsgsHeight(localMsgs ?? [], avail)
    if (msgLoading && (localMsgs === null || localMsgs.length === 0)) inner += 30
    if (msgError !== "") inner += 46 // 错误气泡（可能两行）
    return Math.round(Math.min(Math.max(inner, 60), Device.screen.height * 0.55 - 60))
  }, [showMsgs, localMsgs, msgLoading, msgError])

  return (
    <ZStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
    <List
      listStyle="plain"
      listRowInsets={{ top: 0, bottom: 0, leading: 16, trailing: 16 }}
      navigationTitle={chatName}
      navigationBarTitleDisplayMode="inline"
    >
      <Banners p={p} />

      <Section>
        <HStack spacing={12}>
          <Avatar name={chatName} size={52} src={chat.avatar} />
          <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Text font="title3" bold lineLimit={2}>
              {chatName}
            </Text>
            <Text font="caption" foregroundStyle="#8E8E93">
              {TYPE_LABEL[chat.type] || chat.type || "会话"}
              {chat.unread ? ` · 未读 ${chat.unread}` : ""}
            </Text>
            <Text font="caption" foregroundStyle={local ? "#34C759" : "#8E8E93"}>
              {local
                ? `本地已有 ${fmtNum(local.msg_count)} 条 · 最后 ${fmtTime(local.last_msg)}`
                : "尚未同步到本地"}
            </Text>
          </VStack>
        </HStack>

        {/* 输入 + 格式 + 发送同一行：输入框浅灰圆角底，右侧提示小字 + 胶囊按钮 */}
        <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "top" }}>
          <FieldBox>
            <TextField
              title="消息内容"
              prompt="输入要发送到本会话的内容…"
              value={draft}
              onChanged={setDraft}
              axis="vertical"
              lineLimit={{ min: 1, max: 6 }}
              frame={{ maxWidth: "infinity", alignment: "leading" }}
            />
          </FieldBox>
          {/* 临时提示嵌在行内空白处（字 13 与按钮字同级，固定宽度防压缩） */}
          {rowHintText !== "" ? (
            <Text
              font={13}
              fontWeight="medium"
              foregroundStyle={hintColor(rowHintTone)}
              lineLimit={1}
              frame={{ width: Math.min(150, labelWidth(rowHintText, 13) + 6) }}
            >
              {rowHintText}
            </Text>
          ) : null}
          <RowButton
            title="Aa"
            color={showFormats ? "#2AABEE" : "#8E8E93"}
            action={() => {
              withAnimation(Animation.smooth({ duration: 0.28 }), () =>
                setShowFormats(v => !v)
              )
              setFormatHint("")
            }}
          />
          <RowButton
            title={sending ? "发送中…" : "发送"}
            filled
            disabled={sending || draft.trim() === ""}
            action={handleSend}
          />
        </HStack>
        {/* 格式面板：与 Telegram 相同的十种格式，点一下包住整段，再点取消（展开带平滑动画） */}
        {showFormats ? (
          <VStack
            alignment="leading"
            spacing={6}
            frame={{ maxWidth: "infinity", alignment: "leading" }}
            transition={Transition.move("bottom").combined(Transition.opacity())}
          >
            <HStack spacing={6}>
              {FMT_ROW_1.slice(0, 4).map(f => (
                <RowButton key={f.label} title={f.label} action={() => applyWrap(f)} />
              ))}
            </HStack>
            <HStack spacing={6}>
              <RowButton title={FMT_ROW_1[4].label} action={() => applyWrap(FMT_ROW_1[4])} />
              <RowButton title="链接" action={applyLink} />
              <RowButton title="日期" action={applyDate} />
            </HStack>
            <HStack spacing={6}>
              {FMT_ROW_2.map(f => (
                <RowButton key={f.label} title={f.label} action={() => applyWrap(f)} />
              ))}
            </HStack>
          </VStack>
        ) : null}
        <SettingsRow
          icon="arrow.uturn.left"
          color="#FF9500"
          danger
          disabled={recalling}
          title={recalling ? "撤回中…" : "撤回我发出的"}
          value={`${recallCount} 条`}
          hint={recallHint !== "" ? recallHint : undefined}
          hintTone={recallHint.startsWith("已撤回") ? "ok" : "error"}
          action={async () => {
            if (recalling) return
            const v = await Dialog.prompt({
              title: "撤回我发出的消息",
              message: "删除你最新发出的 N 条（对所有人撤回，不可恢复，单次最多 50 条）",
              defaultValue: recallCount,
              keyboardType: "numberPad",
              confirmLabel: "撤回",
            })
            if (v === null) return
            const n = Math.round(Number(v))
            if (!Number.isFinite(n) || n < 1) {
              const msg = "请输入要撤回的条数（≥1）"
              setRecallHint(msg)
              later(5000, () => setRecallHint(cur => (cur === msg ? "" : cur)))
              return
            }
            setRecallCount(String(n))
            await handleRecall(n)
          }}
        />
        <SettingsRow
          icon="arrow.triangle.2.circlepath"
          color="#34C759"
          chevron={false}
          disabled={p.busy !== null}
          title={p.busy ? "同步中…" : "同步消息"}
          hint={
            syncRes
              ? syncRes.ok
                ? `新增 ${fmtNum(syncRes.added)} 条`
                : `同步失败：${syncRes.error || "未知错误"}`
              : undefined
          }
          hintTone={syncRes && !syncRes.ok ? "error" : "ok"}
          action={handleSync}
          trailing={p.busy ? <ProgressView /> : undefined}
        />

        <AiActionsSection
          p={p}
          chat={chat}
          res={aiRes}
          setRes={patchAi}
          openSheet={() => setAiSheet(true)}
        />

        <SettingsRow
          icon="text.alignleft"
          color="#5856D6"
          chevron={false}
          title={showMsgs ? "收起最近消息" : "查看最近 50 条"}
          // 加载中也可随时收起（读取在后台继续，不锁行）
          action={toggleMessages}
          trailing={msgLoading ? <ProgressView /> : undefined}
        />
        {showMsgs ? (
          <VStack
            alignment="leading"
            spacing={10}
            padding={10}
            frame={{ maxWidth: "infinity", alignment: "leading" }}
            background={<RoundedRectangle fill="#F5F6F8" cornerRadius={12} />}
            transition={Transition.move("bottom").combined(Transition.opacity())}
          >
            <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Text
                font="caption"
                fontWeight="semibold"
                foregroundStyle="#8E8E93"
                lineLimit={1}
                frame={{ maxWidth: "infinity", alignment: "leading" }}
              >
                {msgLoading
                  ? "读取本地消息…"
                  : msgError !== ""
                    ? "读取失败"
                    : `最近消息 · 本地 ${(localMsgs ?? []).length} 条`}
              </Text>
              {msgLoading ? <ProgressView /> : null}
            </HStack>
            <ScrollView axes="vertical" frame={{ maxWidth: "infinity", height: msgsScrollH }}>
              <VStack
                alignment="leading"
                spacing={10}
                frame={{ maxWidth: "infinity", alignment: "leading" }}
              >
                {msgError !== "" ? <Hint tone="error" text={msgError} /> : null}
                {msgError === "" && !msgLoading && localMsgs !== null && localMsgs.length === 0 ? (
                  <Hint tone="muted" text="近 7 天没有本地消息，先点上方「同步消息」" />
                ) : null}
                {msgLoading && localMsgs === null ? (
                  <Hint tone="info" spinner text="正在读取本地消息…" />
                ) : null}
                {(localMsgs ?? []).map((m: any, i: number) => (
                  <MsgRow
                    key={`${m.id ?? i}`}
                    m={m}
                    onOpenUrl={url => Safari.openURL(url)}
                  />
                ))}
              </VStack>
            </ScrollView>
          </VStack>
        ) : null}

        <SettingsRow
          icon="trash"
          color="#FF3B30"
          danger
          disabled={!local || p.busy !== null}
          title={local ? "清除该群本地记录" : "没有可清除的本地记录"}
          action={handleDelete}
        />

        <SettingsRow
          icon={excludedFromFolder ? "arrow.counterclockwise" : "folder.badge.minus"}
          color={excludedFromFolder ? "#34C759" : "#FF9500"}
          title={excludedFromFolder ? "恢复到「已同步」分组" : "从「已同步」分组移出"}
          hint={folderHint !== "" ? folderHint : undefined}
          hintTone={folderHint.startsWith("已移出") ? "warn" : "ok"}
          action={async () => {
            if (excludedFromFolder) {
              p.restoreChat(chat.id)
              const msg = "已恢复到「已同步」分组"
              setFolderHint(msg)
              later(5000, () => setFolderHint(cur => (cur === msg ? "" : cur)))
            } else {
              await handleExcludeFromFolder()
            }
          }}
        />

        {/* 移出记录管理（原在首页列表底部，2026-10-05 移入详情页）：
            有移出记录才显示；恢复/清空各一行，点行弹窗确认 */}
        {p.excludedChats.length > 0 ? (
          <>
            <SettingsRow
              icon="arrow.counterclockwise"
              color="#34C759"
              title="恢复移出记录"
              value={String(p.excludedChats.length)}
              action={async () => {
                const n = p.excludedChats.length
                const ok = await Dialog.confirm({
                  title: "恢复移出记录",
                  message: `把 ${n} 个被移出的会话全部恢复到「已同步」分组？`,
                  confirmLabel: "恢复",
                })
                if (!ok) return
                p.restoreExcluded()
                const msg = `已恢复 ${n} 个会话到「已同步」分组`
                setFolderHint(msg)
                later(5000, () => setFolderHint(cur => (cur === msg ? "" : cur)))
              }}
            />
            <SettingsRow
              icon="trash"
              color="#FF3B30"
              danger
              title="清空移出记录"
              value={String(p.excludedChats.length)}
              action={async () => {
                const ok = await Dialog.confirm({
                  title: "清空移出记录",
                  message:
                    "删除本地存储的移出记录（被移出的会话会回到「已同步」分组）？",
                  confirmLabel: "清空",
                })
                if (!ok) return
                p.clearExcludedRecords()
                const msg = "已清空移出记录（存储数据已删除）"
                setFolderHint(msg)
                later(5000, () => setFolderHint(cur => (cur === msg ? "" : cur)))
              }}
            />
          </>
        ) : null}

        {/* 批量退出 / 删除（群组频道管理）：上移到两个单会话危险操作之前，
            「退出该会话 / 永久删除」保持在卡片最末尾 */}
        <BulkLeaveSection p={p} />

        <SettingsRow
          icon="arrow.uturn.left"
          color="#8E8E93"
          danger
          disabled={leaving || p.busy !== null}
          title={leaving ? "退出中…" : "退出该会话（退群）"}
          hint={leaveHint !== "" ? leaveHint : undefined}
          hintTone={leaveHint.startsWith("已") ? "ok" : "error"}
          action={async () => {
            if (leaving || p.busy !== null) return
            const ok = await Dialog.confirm({
              title: "退出该会话",
              message: `退出「${chatName}」？返回列表后将不再显示（本地消息记录仍保留）。`,
              confirmLabel: "退出",
            })
            if (ok) await handleLeave()
          }}
        />

        <SettingsRow
          icon="trash"
          color="#FF3B30"
          danger
          disabled={destroying || p.busy !== null}
          title={destroying ? "删除中…" : "永久删除（仅创建者）"}
          hint={destroyHint !== "" ? destroyHint : undefined}
          hintTone={destroyHint.startsWith("已") ? "ok" : "error"}
          action={async () => {
            if (destroying || p.busy !== null) return
            const ok = await Dialog.confirm({
              title: "永久删除",
              message: `永久删除「${chatName}」（仅创建者可操作），不可恢复！`,
              confirmLabel: "删除",
            })
            if (ok) await handleDestroy()
          }}
        />
      </Section>
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
        <ResultSheet
          res={aiRes}
          setRes={patchAi}
          onClose={() => setAiSheet(false)}
          chat={chat}
          p={p}
        />
      </ZStack>
    ) : null}
    </ZStack>
  )
}
