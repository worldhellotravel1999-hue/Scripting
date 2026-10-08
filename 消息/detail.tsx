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
  TextField,
  Text,
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
import { loadPrompt, promptInput, savePrompt } from "./prompt"

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
 * **行内小字**（显示在对应按钮行自己的空白处），不再在行下另起气泡。
 * 2026-10-07 四次改版：「查看最近消息」也改**页面内浮层弹窗**（不再从卡片下
 * 拉长展开），弹窗内可**选择查看条数**（50/100/200/500/自定义，写入缓存）；
 * 撤回条数等数字输入统一记忆上次值（prompt.ts）。
 */

/**
 * 批量退出 / 批量删除自己创建的频道群（预览用 p.chats，执行走 bulk_leave 命令）。
 * 2026-10-06 终版：整块平时只收成一行「群组频道管理」，点开后按逻辑步进切换。
 * 2026-10-07 改版：展开后的选项改为**纵向逐行向下排列**（不再横向一行挤几个），
 * 每个选项都是一条与界面一致的 SettingsRow 行（48×48 渐变图标块 + 标题 + 右箭头）：
 *   收起 → [返回] [退出] [删除我创建] → [返回] [全部] [群组] [频道]
 *        → [返回] + 执行行（先弹「名称包含」筛选输入，再弹执行确认）。
 * 每步首行的「返回」退回上一步，可一路退回收起态；
 * 执行成功自动收起回「群组频道管理」，结果小字行内显示 5 秒。
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

  const matches = useMemo(
    () => filterChats(keyword, op, scope),
    [p.chats, keyword, op, scope],
  )
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
        // 成功 = 自动收起回单按钮，结果小字显示在收起行上 5 秒；
        // 同时清掉关键词：收起行不显示筛选词，留着会让下次进入按旧词过滤
        setStep("idle")
        setKeyword("")
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

  /** 退回上一步：与界面一致的行样式（灰色 chevron 图标块），每步置顶一行 */
  const backRow = (to: "idle" | "op" | "scope") => (
    <SettingsRow
      icon="chevron.left"
      color="#8E8E93"
      chevron={false}
      title="返回"
      action={() => {
        setHint("")
        setStep(to)
      }}
    />
  )

  // 展开后每个选项各占一行、纵向向下排列（各自是 List 行，间距/内边距由 List
  // 统一绘制，与上下其它行对齐）；图标走 SettingsRow 的 48×48 渐变块，与界面一致。
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
        {backRow("idle")}
        <SettingsRow
          icon="arrow.uturn.left"
          color="#FF9500"
          title="退出"
          action={() => {
            setOp("leave")
            setHint("")
            setStep("scope")
          }}
        />
        <SettingsRow
          icon="trash"
          color="#FF3B30"
          danger
          title="删除我创建"
          action={() => {
            setOp("delete")
            setHint("")
            setStep("scope")
          }}
        />
      </>
    )
  }

  if (step === "scope") {
    return (
      <>
        {backRow("op")}
        <SettingsRow
          icon="line.3.horizontal"
          color="#2AABEE"
          title="全部"
          action={() => {
            setScope("all")
            setHint("")
            setStep("run")
          }}
        />
        <SettingsRow
          icon="person.3.fill"
          color="#2AABEE"
          title="群组"
          action={() => {
            setScope("group")
            setHint("")
            setStep("run")
          }}
        />
        <SettingsRow
          icon="antenna.radiowaves.left.and.right"
          color="#2AABEE"
          title="频道"
          action={() => {
            setScope("channel")
            setHint("")
            setStep("run")
          }}
        />
      </>
    )
  }

  // 执行行：上方一行「返回」可退回范围排 → 一路退回收起态；
  // 点行先弹「名称包含」筛选（0 匹配也能进来改关键词，避免死路），再弹执行确认
  return (
    <>
      {backRow("scope")}
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
            // 第 1 弹：名称包含筛选（取消 = 退回范围排，再点返回可改操作）
            const v = await promptInput("bulkKeyword", {
              title: "名称包含",
              message: `筛选要批量${verb}的会话名（当前匹配 ${matches.length} 个），留空 = 全部`,
              defaultValue: keyword,
              placeholder: "留空 = 全部",
              confirmLabel: "确定",
            })
            if (v === null) {
              if (!mountedRef.current) return
              setStep("scope")
              return
            }
            if (!mountedRef.current) return
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
            else if (mountedRef.current) setStep("scope")
          }}
          trailing={running ? <ProgressView /> : undefined}
        />
    </>
  )
}

/** 「查看最近消息」弹窗的可选条数（点选即按新条数重读，并写入缓存） */
const MSG_LIMITS = [50, 100, 200, 500]

/** 上次选择的查看条数（无记忆 → 50） */
function loadMsgLimit(): number {
  const v = Number(loadPrompt("recentLimit"))
  return Number.isFinite(v) && v >= 1 ? Math.round(v) : 50
}

// ── 文本格式面板（仿 Telegram 输入框格式栏）：点按钮把对应 HTML 标签包住整段草稿，
// 再点一次同按钮取消；发送时后端按 HTML 解析成 Telegram 格式实体。

type FmtWrap = { label: string; icon: string; open: string; close: string }

/**
 * 草稿里是否存在**配对**的该标签（不看层级）。
 * 以前用 startsWith/endsWith 只认最外层：先点引用再点粗体后，草稿是
 * `<blockquote><b>x</b></blockquote>`，再点粗体不满足 startsWith → 又包一层，
 * 永远取消不掉内层（“再点一次取消”的承诺对嵌套格式失效）。
 */
function hasWrap(text: string, open: string, close: string): boolean {
  const i = text.indexOf(open)
  return i !== -1 && text.indexOf(close, i + open.length) !== -1
}

const FMT_ROW_1: FmtWrap[] = [
  { label: "引用", icon: "quote.opening", open: "<blockquote>", close: "</blockquote>" },
  { label: "遮罩", icon: "eye.slash", open: '<span class="tg-spoiler">', close: "</span>" },
  { label: "粗体", icon: "bold", open: "<b>", close: "</b>" },
  { label: "斜体", icon: "italic", open: "<i>", close: "</i>" },
  { label: "等宽", icon: "chevron.left.forwardslash.chevron.right", open: "<code>", close: "</code>" },
]

const FMT_ROW_2: FmtWrap[] = [
  { label: "删除线", icon: "strikethrough", open: "<s>", close: "</s>" },
  { label: "下划线", icon: "underline", open: "<u>", close: "</u>" },
  { label: "代码", icon: "curlybraces", open: "<pre>", close: "</pre>" },
]

// ── 浮层格式宫格：两行各 5 个（引用遮罩粗体斜体等宽 / 删除线下划线代码链接日期），
// 每格 = 图标 + 文字，格宽按行内个数均分卡宽，行行排满不留缺口。
type FmtGridItem =
  | { kind: "wrap"; f: FmtWrap }
  | { kind: "link" }
  | { kind: "date" }

const FMT_GRID_ROWS: FmtGridItem[][] = [
  FMT_ROW_1.map(f => ({ kind: "wrap" as const, f })),
  [
    ...FMT_ROW_2.map(f => ({ kind: "wrap" as const, f })),
    { kind: "link" } as FmtGridItem,
    { kind: "date" } as FmtGridItem,
  ],
]

/** 宫格间距（行内格与格） */
const FMT_GAP = 6
/** 浮层卡片宽 / 内容宽（减左右 padding 14） */
const COMPOSER_W = Device.screen.width - 36
const FMT_CONTENT_W = COMPOSER_W - 28
/** 格宽 = 该行内容宽均分 n 格（减间距）：每行都排满 */
const fmtCellW = (n: number) => (FMT_CONTENT_W - FMT_GAP * (n - 1)) / n

// ── 格式宫格开合记忆：无记忆默认展开；开/关一次就记住，下次打开浮层沿用上次选择
const FORMATS_KEY = "tgclient.composer.formatsOpen"

function loadFormatsOpen(): boolean {
  try {
    const v = Storage.get<unknown>(FORMATS_KEY)
    if (typeof v === "boolean") return v
    if (typeof v === "string") return v !== "0"
  } catch {}
  return true
}

function saveFormatsOpen(open: boolean): void {
  try {
    Storage.set(FORMATS_KEY, open ? "1" : "0")
  } catch {}
}

/**
 * 格式格（仿 Telegram 格式面板）：占满格宽的浅灰椭圆钮 + 图标居中，
 * 格子下方灰色小字标签；选中态实心蓝反白。固定宽防压缩、行内均分排满。
 */
function FmtCell({
  icon,
  label,
  width,
  active,
  action,
}: {
  icon: string
  label: string
  width: number
  active: boolean
  action: () => void
}) {
  return (
    <VStack
      spacing={6}
      alignment="center"
      frame={{ width, alignment: "center" }}
      onTapGesture={action}
    >
      <ZStack
        alignment="center"
        frame={{ width, height: 46 }}
      >
        <RoundedRectangle
          fill={active ? "#2AABEE" : "#EDEFF2"}
          cornerRadius={23}
          frame={{ width, height: 46 }}
        />
        <Image
          systemName={icon}
          foregroundStyle={active ? "#FFFFFF" : "#6B7078"}
          frame={{ width: 20, height: 20 }}
        />
      </ZStack>
      <Text
        font="footnote"
        fontWeight="medium"
        foregroundStyle={active ? "#1E93D6" : "#8E8E93"}
        lineLimit={1}
      >
        {label}
      </Text>
    </VStack>
  )
}

/**
 * 输入消息对话浮层卡片（导出供预览 harness 直接内联渲染）：
 * 标题行（字数 + 关闭）→ 自适应输入行（内嵌「格式」胶囊 + 发送钮）
 * → 行内提示 → 格式宫格（点胶囊展开/收起，两行×5 等宽排满）。
 * 卡片高度自适应内容（不设固定 height）。
 */
export function ComposerCard({
  draft,
  setDraft,
  sending,
  hintText,
  hintTone,
  onWrap,
  onLink,
  onDate,
  onSend,
  onClose,
  initialFormats = true,
}: {
  draft: string
  setDraft: (v: string) => void
  sending: boolean
  hintText: string
  hintTone: HintTone
  onWrap: (f: FmtWrap) => void
  onLink: () => void
  onDate: () => void
  onSend: () => void
  onClose: () => void
  /** 预览用：指定初始开合（不传 = 读上次记忆，默认展开） */
  initialFormats?: boolean
}) {
  // 默认展开 + 记忆上次开合；initialFormats 仅预览用，不写记忆
  const [showFormats, setShowFormats] = useState(() =>
    initialFormats !== undefined ? initialFormats : loadFormatsOpen(),
  )
  const toggleFormats = () =>
    setShowFormats(prev => {
      const next = !prev
      if (initialFormats === undefined) saveFormatsOpen(next)
      return next
    })
  return (
    <VStack
      alignment="leading"
      spacing={10}
      padding={{ horizontal: 14, top: 12, bottom: 14 }}
      frame={{ width: COMPOSER_W, alignment: "leading" }}
      background={<RoundedRectangle fill="#FFFFFF" cornerRadius={20} />}
      shadow={{ color: "rgba(0,0,0,0.18)", radius: 18, y: 8 }}
    >
      <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Text
          font="headline"
          fontWeight="bold"
          lineLimit={1}
          frame={{ maxWidth: "infinity", alignment: "leading" }}
        >
          输入消息对话
        </Text>
        {draft.trim() !== "" ? (
          <Text font="caption2" foregroundStyle="#8E8E93">
            {draft.trim().length} 字
          </Text>
        ) : null}
        <RowButton small title="关闭" color="#8E8E93" action={onClose} />
      </HStack>

      {/* 输入行：自适应高度；左侧「格式」胶囊开关 + 多行输入 + 发送钮（Telegram 同款） */}
      <HStack
        spacing={8}
        alignment="bottom"
        padding={{ horizontal: 8, vertical: 6 }}
        frame={{ maxWidth: "infinity" }}
        background={<RoundedRectangle fill="#F1F3F6" cornerRadius={18} />}
      >
        {/* 格式胶囊：收起态入口，展开时反白高亮 */}
        <HStack
          spacing={4}
          padding={{ horizontal: 8, vertical: 5 }}
          frame={{ minHeight: 26 }}
          background={
            <RoundedRectangle
              fill={showFormats ? "#2AABEE" : "#E4E7EB"}
              cornerRadius={13}
            />
          }
          onTapGesture={toggleFormats}
        >
          <Image
            systemName="text.alignleft"
            foregroundStyle={showFormats ? "#FFFFFF" : "#5B616B"}
            frame={{ width: 14, height: 14 }}
          />
          <Text
            font={11}
            fontWeight="semibold"
            foregroundStyle={showFormats ? "#FFFFFF" : "#5B616B"}
            lineLimit={1}
          >
            格式
          </Text>
        </HStack>

        <TextField
          title="输入要发送到本会话的内容…"
          value={draft}
          onChanged={setDraft}
          axis="vertical"
          autofocus
          lineLimit={{ min: 1, max: 8 }}
          frame={{ maxWidth: "infinity" }}
        />
        <ZStack
          alignment="center"
          frame={{ width: 30, height: 30 }}
          onTapGesture={sending || draft.trim() === "" ? undefined : onSend}
        >
          <RoundedRectangle
            fill={sending || draft.trim() === "" ? "#C9D3DC" : "#2AABEE"}
            cornerRadius={15}
            frame={{ width: 30, height: 30 }}
          />
          {sending ? (
            <Image systemName="hourglass" foregroundStyle="#FFFFFF" frame={{ width: 13, height: 13 }} />
          ) : (
            <Image
              systemName="arrow.up"
              foregroundStyle="#FFFFFF"
              frame={{ width: 15, height: 15 }}
            />
          )}
        </ZStack>
      </HStack>

      {hintText !== "" ? <Hint tone={hintTone} text={hintText} /> : null}

      {/* 格式宫格（仿 Telegram 格式面板）：默认展开，点输入行「格式」胶囊收起/展开；
          两行×5 占满格宽的椭圆钮（行行排满）；
          已包裹的格式高亮，再点取消（链接/日期为插入型不反色） */}
      {showFormats ? (
        <VStack
          alignment="leading"
          spacing={12}
          padding={{ top: 2 }}
          frame={{ maxWidth: "infinity", alignment: "leading" }}
        >
          {FMT_GRID_ROWS.map((row, ri) => (
            <HStack
              key={`fmt-row-${ri}`}
              spacing={FMT_GAP}
              frame={{ maxWidth: "infinity", alignment: "leading" }}
            >
              {row.map(item =>
                item.kind === "wrap" ? (
                  <FmtCell
                    key={item.f.label}
                    icon={item.f.icon}
                    label={item.f.label}
                    width={fmtCellW(row.length)}
                    active={hasWrap(draft, item.f.open, item.f.close)}
                    action={() => onWrap(item.f)}
                  />
                ) : item.kind === "link" ? (
                  <FmtCell
                    key="链接"
                    icon="link"
                    label="链接"
                    width={fmtCellW(row.length)}
                    active={hasWrap(draft, '<a href="', "</a>")}
                    action={onLink}
                  />
                ) : (
                  <FmtCell
                    key="日期"
                    icon="calendar"
                    label="日期"
                    width={fmtCellW(row.length)}
                    active={false}
                    action={onDate}
                  />
                )
              )}
            </HStack>
          ))}
        </VStack>
      ) : null}
    </VStack>
  )
}

export function ChatDetailScreen({ p, chat }: { p: PanelCtx; chat: any }) {
  const chatName: string = chat.name || String(chat.id)
  const [syncRes, setSyncRes] = useState<any>(null)
  const [localMsgs, setLocalMsgs] = useState<any[] | null>(null)
  const [msgError, setMsgError] = useState("")
  const [msgLoading, setMsgLoading] = useState(false)
  const [showMsgs, setShowMsgs] = useState(false)
  /** 查看条数（弹窗内可选，写入缓存） */
  const [msgLimit, setMsgLimit] = useState(loadMsgLimit)
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [sendHint, setSendHint] = useState<{
    tone: "ok" | "warn" | "error"
    text: string
  } | null>(null)
  const [recallCount, setRecallCount] = useState(() => loadPrompt("recallCount") ?? "2")
  const [recalling, setRecalling] = useState(false)
  const [recallHint, setRecallHint] = useState("")
  const [leaving, setLeaving] = useState(false)
  const [leaveHint, setLeaveHint] = useState("")
  const [destroying, setDestroying] = useState(false)
  const [destroyHint, setDestroyHint] = useState("")
  const [folderHint, setFolderHint] = useState("")
  const [composerOpen, setComposerOpen] = useState(false)
  const [formatHint, setFormatHint] = useState("")
  // 发送防重入：sending 是 state，双击窗口内读到的还是旧值，用 ref 兑底
  const sendingRef = useRef(false)
  // 同步防重入：同步行靠 p.busy 置灰，但 busy 是 state，双击窗口内还是旧值
  const syncingRef = useRef(false)
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

  // 消息窗口是否开着：同步/发送/撤回的回调是发起时那次渲染的闭包，
  // 直接读 showMsgs 可能是旧值（弹窗刚开、同步早就在飞 → 回调里判 false
  // 不重读，窗口停在旧数据）；ref 每渲染同步，回调读到的永远是当前值。
  const showMsgsRef = useRef(false)
  showMsgsRef.current = showMsgs
  // 消息读取序号：切条数的显式重读不被进行中的读取挡掉（见 loadLocalMessages），
  // 但旧一轮（尤其是 needs_sync 后的二轮读）不许把新结果覆盖回去——
  // 否则会出现“芯片显示 100、列表却是 50 条数据”的乱序覆盖。
  const msgSeqRef = useRef(0)
  // 读取被进行中的读取挡下时记一笔，当前读完自动补一次（不丢刷新）
  const msgRefreshPending = useRef(false)
  // 发送时的草稿快照对照：发送看门狗预算可达上百年秒，期间用户可能关掉又
  // 重开输入框打了新内容，回调里若无脑 setDraft("") 会把新草稿清掉
  const draftRef = useRef("")
  draftRef.current = draft

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

  // 本地会话统计行（memo：draft 每次键盘输入都会重渲染整页，
  // 会话表查找没必要跟着重算）
  const local = useMemo(
    () => (p.stats?.chats || []).find((c: any) => c.chat_name === chatName) || null,
    [p.stats, chatName],
  )
  // 是否真正在「已同步」分组内：本地有记录且未被移出（移出记录会挡住后续同步的会话）
  const inSyncedGroup = !!local && !excludedFromFolder

  // 同步进行中的行内提示（「同步「群名」…」）：不再在页顶 Banners 弹一条，
  // 改显示在「同步消息」这一行的 hint 里，随同步结束自动被结果提示接管（5 秒消失）
  const syncBusy = p.busy && p.busy.startsWith("同步「") ? p.busy : null

  async function handleSync() {
    if (syncingRef.current) return
    syncingRef.current = true
    try {
      const res = await p.syncOne(chat)
      if (!mountedRef.current) return
      if (res) {
        setSyncRes(res)
        // 同步结果提示临时展示，5 秒后自动消失
        later(5000, () => setSyncRes((cur: any) => (cur === res ? null : cur)))
        // 消息窗口开着 → 同步成功后重读，否则用户看的还是旧记录
        if (res.ok && showMsgsRef.current) loadLocalMessages()
        // 显式同步 = 想让它进分组：若之前留有「移出」记录则一并清掉，
        // 否则明明已同步，「已同步」筛选下却永远看不到这个群
        if (res.ok && excludedFromFolder) {
          p.restoreChat(chat.id)
          const msg = "已恢复到「已同步」分组"
          setFolderHint(msg)
          later(5000, () => setFolderHint(cur => (cur === msg ? "" : cur)))
        }
      }
    } finally {
      syncingRef.current = false
    }
  }

  async function handleSend() {
    const sentDraft = draft // 本次发送的草稿快照（回调里对照是否被改过）
    const text = sentDraft.trim()
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
        // 草稿没被改过才清空/收起：发送期间用户重新输入的内容不能被旧回调抹掉
        if (draftRef.current === sentDraft) {
          setDraft("")
          setComposerOpen(false) // 发送成功 = 弹窗自动收起，结果小字显示在输入行上
        }
        const hint: { tone: "ok" | "warn" | "error"; text: string } = {
          tone: "ok",
          text:
            res.sent > 1
              ? `已发送 ${res.sent} 条（超长自动分段）`
              : `已发送到「${res.chat || chatName}」`,
        }
        setSendHint(hint)
        later(5000, () => setSendHint(cur => (cur?.text === hint.text ? null : cur)))
        if (showMsgsRef.current) loadLocalMessages()
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

  /** 点行打开输入浮层：输入 / 格式 / 发送 全部在弹窗内完成（不用先确认再找按钮） */
  function editDraft() {
    setFormatHint("")
    setComposerOpen(true)
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
    // 配对查找（hasWrap）而不是 startsWith/endsWith：嵌套格式下也能找到
    // 该标签并删掉它那一对（取消内层），否则只会反复外包一层
    const i = draft.indexOf(f.open)
    const j = i === -1 ? -1 : draft.indexOf(f.close, i + f.open.length)
    if (i !== -1 && j !== -1) {
      setDraft(draft.slice(0, i) + draft.slice(i + f.open.length, j) + draft.slice(j + f.close.length))
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
    // 内层/嵌套也能取消（同 applyWrap）：找到第一对 <a …>…</a> 并删掉
    const i = draft.indexOf('<a href="')
    if (i !== -1) {
      const gt = draft.indexOf('">', i)
      if (gt !== -1) {
        const j = draft.indexOf("</a>", gt)
        if (j !== -1) {
          setDraft(draft.slice(0, i) + draft.slice(gt + 2, j) + draft.slice(j + 4))
          return
        }
      }
    }
    const input = await promptInput("linkUrl", {
      title: "插入链接",
      message: "整段文字将变成可点击的链接",
      placeholder: "https://example.com",
      confirmLabel: "插入",
    })
    let url = (input || "").trim()
    if (url === "") return
    if (!mountedRef.current) return
    // 校验/净化：没有协议头补 https://；引号与尖括号会直接拼出破坏性 HTML
    // （<a href="a"b">），后端配平失败会让整条发送报错
    url = url.replace(/["'<>]/g, "")
    if (url === "") return
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`
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
        if (showMsgsRef.current) loadLocalMessages()
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

  async function loadLocalMessages(opts?: { retried?: boolean; limit?: number }) {
    // 带指定条数的重读（弹窗里切条数）不被进行中的读取挡掉，否则切了不生效；
    // 普通重读撞上进行中的读取 → 记 pending，当前读完自动补一次
    if (msgLoading && opts?.limit === undefined) {
      msgRefreshPending.current = true
      return
    }
    const seq = ++msgSeqRef.current
    const limit = opts?.limit ?? msgLimit
    setMsgLoading(true)
    setMsgError("")
    try {
      let res = await tg("recent", { chat: chatName, hours: 168, limit }, 60)
      if (msgSeqRef.current !== seq || !mountedRef.current) return
      // 本地库还没有这个会话 → 后端降级返回 needs_sync：自动先同步一次再重读。
      // 旧版这里直接弹「本地库中没有会话…」，体感就是“必须先发一条消息才能查看/同步”。
      if (res.ok && res.needs_sync && !opts?.retried) {
        const synced = await p.syncOne(chat)
        if (msgSeqRef.current !== seq || !mountedRef.current) return
        if (synced && synced.ok) {
          res = await tg("recent", { chat: chatName, hours: 168, limit }, 60)
        } else {
          // 不写入 []：保持 localMsgs === null，下次点开还能重试；
          // 写 [] 会让 toggleMessages 认为“已读完”而永远不再拉。
          setMsgError(
            `本地还没有该会话的消息，自动同步${
              synced ? `失败：${synced.error || "未知错误"}` : "未完成"
            }`
          )
          return
        }
      }
      if (msgSeqRef.current !== seq || !mountedRef.current) return
      if (!res.ok) {
        // 读取失败：只报错，不把已有内容清成 []——
        // 首次失败保持 null 才能在下次点开时重试，已有旧数据也保留
        setMsgError(res.error || "读取失败")
      } else if (res.needs_sync) {
        // 带 retried 的重读（切条数）也会命中未同步：同样不许写 []，
        // 否则 localMsgs 不再是 null，本页永远失去自动同步/重读机会
        setMsgError("本地还没有该会话的消息：先点上方「同步消息」或发一条消息")
      } else {
        setMsgError("")
        setLocalMsgs(res.messages || [])
      }
    } finally {
      if (msgSeqRef.current === seq && mountedRef.current) {
        setMsgLoading(false)
        if (msgRefreshPending.current) {
          msgRefreshPending.current = false
          loadLocalMessages()
        }
      }
    }
  }

  function toggleMessages() {
    withAnimation(Animation.smooth({ duration: 0.3 }), () => setShowMsgs(true))
    if (localMsgs === null) loadLocalMessages()
  }

  /** 弹窗内切换查看条数：写入缓存并按新条数重读 */
  async function changeMsgLimit(n: number) {
    setMsgLimit(n)
    savePrompt("recentLimit", String(n))
    await loadLocalMessages({ limit: n, retried: true })
  }

  /** 弹窗内「自定义」条数：弹窗输入（同样记忆上次输入） */
  async function customMsgLimit() {
    const v = await promptInput("recentLimit", {
      title: "查看条数",
      message: "输入要查看的最近消息条数（1 ~ 5000）",
      defaultValue: String(msgLimit),
      keyboardType: "numberPad",
      confirmLabel: "查看",
    })
    if (v === null) return
    if (!mountedRef.current) return
    const raw = Math.round(Number(v))
    if (!Number.isFinite(raw) || raw < 1) return
    const n = Math.min(raw, 5000)
    savePrompt("recentLimit", String(n)) // 归一化后覆盖记忆
    setMsgLimit(n)
    await loadLocalMessages({ limit: n, retried: true })
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

  // 最近消息弹窗高度：固定 62% 屏高，内容内部滚动（页面内浮层，见文件末尾）
  const msgsPopupH = Math.round(Device.screen.height * 0.62)

  return (
    <ZStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
    <List
      listStyle="plain"
      listRowSpacing={10}
      listRowInsets={{ top: 0, bottom: 0, leading: 16, trailing: 16 }}
      navigationTitle={chatName}
      navigationBarTitleDisplayMode="inline"
    >
      <Banners p={p} hideBusy={label => label.startsWith("同步「")} />

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

        {/* 输入消息对话行：与下方按钮同款白卡+渐变图标，点行打开输入浮层（弹窗内含
            输入框（内嵌「格式」胶囊 + 发送钮），发送成功自动收起）；
            行上小字预览当前草稿与发送结果 */}
        <SettingsRow
          icon="bubble.left.fill"
          color="#2AABEE"
          title="输入消息对话"
          hint={
            rowHintText !== ""
              ? rowHintText
              : draft.trim() !== ""
                ? draft.trim()
                : undefined
          }
          hintTone={rowHintText !== "" ? rowHintTone : "muted"}
          action={editDraft}
        />
        <SettingsRow
          icon="arrow.uturn.left"
          color="#FF9500"
          danger
          disabled={recalling}
          title={recalling ? "撤回中…" : "撤回我发出的"}
          value={`${recallCount} 条`}
          hint={recallHint !== "" ? recallHint : undefined}
          hintTone={recallHint.startsWith("已撤回") ? "ok" : "error"}
          hintMax={110}
          action={async () => {
            if (recalling) return
            const v = await promptInput("recallCount", {
              title: "撤回我发出的消息",
              message: "删除你最新发出的 N 条（对所有人撤回，不可恢复，单次最多 50 条）",
              defaultValue: recallCount,
              keyboardType: "numberPad",
              confirmLabel: "撤回",
            })
            if (v === null) return
            if (!mountedRef.current) return
            const raw = Math.round(Number(v))
            if (!Number.isFinite(raw) || raw < 1) {
              const msg = "请输入要撤回的条数（≥1）"
              setRecallHint(msg)
              later(5000, () => setRecallHint(cur => (cur === msg ? "" : cur)))
              return
            }
            // 先钳到 50 再存/显示：后端 handleRecall 只真撤 Math.min(n, 50)，
            // 以前行上显示「80 条」实际只撤 50，显示与行为不一致
            const n = Math.min(raw, 50)
            savePrompt("recallCount", String(n)) // 记住本次输入，下次默认就是它
            setRecallCount(String(n))
            await handleRecall(n)
          }}
        />
        <SettingsRow
          icon="arrow.triangle.2.circlepath"
          color="#34C759"
          chevron={false}
          disabled={p.busy !== null}
          title={syncBusy ? "同步中…" : "同步消息"}
          hint={
            syncBusy
              ? syncBusy
              : syncRes
                ? syncRes.ok
                  ? `新增 ${fmtNum(syncRes.added)} 条`
                  : `同步失败：${syncRes.error || "未知错误"}`
                : undefined
          }
          hintTone={syncBusy ? "info" : syncRes && !syncRes.ok ? "error" : "ok"}
          // 转圈同行占位：hint 封顶收窄，标题「同步中…」不被挤成一个字
          hintMax={120}
          action={handleSync}
          trailing={syncBusy ? <ProgressView /> : undefined}
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
          title="查看最近消息"
          value={`${msgLimit} 条`}
          // 点行打开页面内浮层弹窗（条数在弹窗里选，写入缓存）
          action={toggleMessages}
          trailing={msgLoading ? <ProgressView /> : undefined}
        />

        <SettingsRow
          icon="trash"
          color="#FF3B30"
          danger
          disabled={!local || p.busy !== null}
          title={local ? "清除该群本地记录" : "没有可清除的本地记录"}
          action={handleDelete}
        />

        <SettingsRow
          icon={
            excludedFromFolder
              ? "arrow.counterclockwise"
              : inSyncedGroup
                ? "folder.badge.minus"
                : "folder"
          }
          color={excludedFromFolder ? "#34C759" : inSyncedGroup ? "#FF9500" : "#8E8E93"}
          // 三态：在分组内 → 移出；有移出记录 → 恢复；未同步过 → 置灰（根本不在分组里，
          // 原先统一显示「移出」会误留移出记录，导致以后同步了也不进分组）
          disabled={!inSyncedGroup && !excludedFromFolder}
          title={
            excludedFromFolder
              ? "恢复到「已同步」分组"
              : inSyncedGroup
                ? "从「已同步」分组移出"
                : "未加入「已同步」分组"
          }
          value={!inSyncedGroup && !excludedFromFolder ? "先同步消息" : undefined}
          hint={folderHint !== "" ? folderHint : undefined}
          hintTone={folderHint.startsWith("已移出") ? "warn" : "ok"}
          action={async () => {
            if (excludedFromFolder) {
              p.restoreChat(chat.id)
              const msg = local
                ? "已恢复到「已同步」分组"
                : "已清除移出记录；同步消息后即进入分组"
              setFolderHint(msg)
              later(5000, () => setFolderHint(cur => (cur === msg ? "" : cur)))
            } else {
              await handleExcludeFromFolder()
            }
          }}
        />

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
          pageAlive={() => mountedRef.current}
        />
      </ZStack>
    ) : null}
    {/* 查看最近消息弹窗：页面内浮层（遮罩 + 居中卡片），不再从卡片下拉长展开；
        弹窗内可选查看条数（50/100/200/500/自定义，写入缓存），点遮罩/「关闭」收起 */}
    {showMsgs ? (
      <ZStack alignment="center" frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
        <Rectangle
          fill="rgba(0,0,0,0.32)"
          frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
          onTapGesture={() => setShowMsgs(false)}
        />
        <VStack
          alignment="leading"
          spacing={12}
          padding={{ horizontal: 16, top: 16, bottom: 18 }}
          frame={{ width: Device.screen.width - 36, height: msgsPopupH, alignment: "leading" }}
          background={<RoundedRectangle fill="#FFFFFF" cornerRadius={18} />}
          shadow={{ color: "rgba(0,0,0,0.18)", radius: 18, y: 8 }}
        >
          <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Text
              font="title3"
              fontWeight="bold"
              lineLimit={1}
              frame={{ maxWidth: "infinity", alignment: "leading" }}
            >
              {msgLoading
                ? "读取本地消息…"
                : msgError !== ""
                  ? "读取失败"
                  : `最近消息 · ${(localMsgs ?? []).length} 条`}
            </Text>
            {msgLoading ? <ProgressView /> : null}
            <RowButton title="关闭" color="#8E8E93" action={() => setShowMsgs(false)} />
          </HStack>

          {/* 条数选择：点选即按新条数重读并写入缓存 */}
          <HStack spacing={6} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            {MSG_LIMITS.map(n => (
              <RowButton
                key={n}
                title={String(n)}
                color={msgLimit === n ? "#2AABEE" : "#8E8E93"}
                filled={msgLimit === n}
                action={() => changeMsgLimit(n)}
              />
            ))}
            <RowButton title="自定义" color="#8E8E93" action={customMsgLimit} />
          </HStack>

          <ScrollView axes="vertical" frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
            <VStack
              alignment="leading"
              spacing={10}
              frame={{ maxWidth: "infinity", alignment: "leading" }}
            >
              {msgError !== "" ? <Hint tone="error" text={msgError} /> : null}
              {msgError === "" && !msgLoading && localMsgs !== null && localMsgs.length === 0 ? (
                <Hint tone="muted" text="近 7 天没有本地消息，先在本页点「同步消息」" />
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
      </ZStack>
    ) : null}
    {/* 输入消息对话浮层：输入行内嵌「格式」胶囊 + 发送钮，格式宫格点胶囊展开；
        格式格子 = 图标+文字、每行等宽排满卡宽；发送在最下方全宽；
        发送成功自动收起，点遮罩/「关闭」收起但保留草稿 */}
    {composerOpen ? (
      <ZStack alignment="center" frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
        <Rectangle
          fill="rgba(0,0,0,0.32)"
          frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
          onTapGesture={() => setComposerOpen(false)}
        />
        <ComposerCard
          draft={draft}
          setDraft={setDraft}
          sending={sending}
          hintText={rowHintText}
          hintTone={rowHintTone}
          onWrap={applyWrap}
          onLink={applyLink}
          onDate={applyDate}
          onSend={handleSend}
          onClose={() => setComposerOpen(false)}
        />
      </ZStack>
    ) : null}
    </ZStack>
  )
}
