// TGClient 的 AI 功能界面：
//  - AiActionsSection：群详情页（作为详情页整页单卡片里的若干行，无分组标题）——
//    点一下动作行即分析该群消息；内置 3 个动作 + 自定义动作（名称 + 提示词，可增删）。
//  - 工具页的 AiGlobalSection（跨会话 AI 汇总）已于 2026-10-06 移除：工具页改为图表展示，
//    不再做 AI 汇总统计；ResultSheet / EMPTY_AI_RESULT 仍被 detail.tsx（详情页结果浮层）使用。
// AI 模型固定使用 Scripting 内置默认智能助手，不提供任何切换模型入口；
// 界面上不展示任何提示词/说明文案，提示词均为本脚本自写或用户自己填写。
// 2026-10-06 改版：**分析/提问结果一律用 ResultWindow 临时窗口展示**（页面内
// 浮层：点遮罩/关闭即可收起，背后不再弹全屏 sheet 二级页），菜单列表里不再
// 内嵌结果卡片；同时移除「重新生成 / 重新分析」
// ——结果本就随页面重开清空，重跑=回列表再点一次动作行，弹窗里只留复制/发送。

import {
  Device,
  HStack,
  Picker,
  ProgressView,
  ScrollView,
  Section,
  Text,
  VStack,
  ZStack,
  RoundedRectangle,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "scripting"
import { tg } from "./api"
import {
  WINDOW_LABELS,
  type AiAction,
  allAiActions,
  buildActionRequest,
  buildInstructRequest,
  buildTranscript,
  type AiActionBlock,
  ACTION_START,
  createStreamFlusher,
  maskActionsForDisplay,
  parseActionBlocks,
  requestAiStream,
} from "./ai"
import type { PanelCtx } from "./ctx"
import { Hint, RowButton, SettingsRow, labelWidth, type HintTone } from "./components"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type Phase = "idle" | "loading" | "streaming" | "done" | "error"

/** 分析结果的轻量排版：把 Markdown 式输出拆成标题 / 列表 / 段落块，分别排版。 */
type Block = { kind: "heading" | "bullet" | "para"; text: string }

function parseBlocks(src: string): Block[] {
  const blocks: Block[] = []
  const push = (kind: Block["kind"], text: string) => {
    const last = blocks[blocks.length - 1]
    // 相同类型的行合并成一块（标题除外，标题逐条独立留白）
    if (last && last.kind === kind && kind !== "heading") last.text += `\n${text}`
    else blocks.push({ kind, text })
  }
  for (const raw of src.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim()
    if (line === "") continue // 空行只作块间分隔，不渲染
    const mdHeading = line.match(/^#{1,6}\s+(.+?)\s*#*$/)
    if (mdHeading) {
      push("heading", mdHeading[1])
      continue
    }
    const boldLine = line.match(/^\*\*(.+?)\*\*[:：]?$/)
    if (boldLine) {
      push("heading", boldLine[1])
      continue
    }
    const numbered = line.match(/^(\d+)[.、)]\s+(.*)$/)
    if (numbered) {
      push("bullet", `${numbered[1]}. ${numbered[2]}`)
      continue
    }
    const bullet = line.match(/^[-*•]\s+(.*)$/)
    if (bullet) {
      push("bullet", `• ${bullet[1]}`)
      continue
    }
    // 段落：去掉行内 **强调** 标记（不支持行内混排，避免满屏星号）
    push("para", line.replace(/\*\*(.+?)\*\*/g, "$1"))
  }
  return blocks
}

// ── 分析结果临时窗口：所有 AI 结果统一在这里展示 ─────────────────────

/** AI 结果状态：由详情页 / 工具页屏幕持有（页面浮层展示），动作区写入。 */
export type AiResult = {
  phase: Phase
  output: string
  errorMsg: string
  /** 弹窗标题，如 “内容摘要 · 今天” */
  heading: string
  /** true = 自由提问轮次：提问时已确认，结果不再提供「发到本会话」 */
  isAsk: boolean
  sending: boolean
  /** 发送结果临时提示（5s 清除） */
  sendHint: string
  /** 复制结果临时提示（3s 清除） */
  copyHint: string
}

export const EMPTY_AI_RESULT: AiResult = {
  phase: "idle",
  output: "",
  errorMsg: "",
  heading: "",
  isAsk: false,
  sending: false,
  sendHint: "",
  copyHint: "",
}

/** setRes 形态：直接 patch，或按最新状态计算（清提示前先比对旧值） */
export type AiResultPatch = Partial<AiResult> | ((r: AiResult) => Partial<AiResult>)
export type SetAiResult = (patch: AiResultPatch) => void

/**
 * 行高估算（用于“内容多大弹窗多大”的自适应临时窗口）：
 * 文本宽度用 labelWidth（CJK=字号、西文 0.6×）；行高 ≈ 字号×1.3，
 * 行间再加 lineSpacing 6（仅 n-1 处）。
 */
function estTextHeight(text: string, font: number, availWidth: number): number {
  let lines = 0
  for (const seg of text.split("\n")) {
    lines += Math.max(1, Math.ceil(labelWidth(seg, font) / Math.max(60, availWidth)))
  }
  return lines * font * 1.3 + Math.max(0, lines - 1) * 6
}

/**
 * 分析结果**临时窗口**卡片（页面内浮层，不走系统 sheet，背后不再有全屏二级页）。
 * · 列表里不再内嵌结果卡片——结果只在窗口里看，页面重开即空白；
 * · **没有重新生成 / 重新分析**：重跑 = 关掉窗口回列表再点一次动作行；
 * · **生成中也可随时关闭**（点遮罩/关闭都行，后台继续跑；动作行再点即重开）；
 * · **窗口尺寸随内容自适应**：分析出多少内容就撑多大（宽=屏宽-64，高封顶
 *   60% 屏高，超出内部滚动）；
 * · 只留 复制 / 发到本会话 / 关闭，临时提示也只出现在窗口内。
 */
export function ResultSheet({
  res,
  setRes,
  onClose,
  chat,
  p,
}: {
  res: AiResult
  setRes: SetAiResult
  onClose: () => void
  /** 传入 = 群详情页：显示「发到本会话」 */
  chat?: any
  /** 发送成功后静默补刷统计 */
  p?: PanelCtx
}) {
  const { phase, output, errorMsg, heading, isAsk, sending } = res
  const running = phase === "loading" || phase === "streaming"
  // 卸载守卫：复制/发送的 await 与计时器回来时页面可能已退出，直接 setState 会崩
  const mountedRef = useMounted()
  // 解析只跟输出文本有关：busy 等无关状态引起的重渲染不重跑分块
  const blocks = useMemo(() => (output !== "" ? parseBlocks(output) : []), [output])
  const hint = res.sendHint !== "" ? res.sendHint : res.copyHint
  const hintTone: HintTone =
    hint.startsWith("已") || hint.startsWith("✅") ? "ok" : "error"
  // 窗口高度随内容自适应：估正文+状态气泡+按钮行+提示的总高 → “内容多大、窗多大”
  const windowHeight = useMemo(() => {
    const cardW = Device.screen.width - 64 // 窗口卡片宽度（两侧留边）
    const avail = cardW - 32 // 卡片左右 padding
    let scroll = 0
    let kids = 0
    if (phase === "loading" || phase === "streaming") {
      scroll += 30 // 单行状态气泡
      kids++
    }
    if (phase === "error") {
      scroll += estTextHeight(errorMsg, 13, avail - 48) + 14 // 气泡上下 padding
      kids++
    }
    for (const b of blocks) {
      if (kids > 0) scroll += 8
      const font = b.kind === "heading" ? 17 : 15
      scroll += estTextHeight(b.text, font, avail) + (b.kind === "heading" ? 6 : 0)
      kids++
    }
    let h = 16 + 30 + 12 + scroll + 12 // 上 padding + 标题行 + 间距 + 滚动区 + 间距
    if (blocks.length > 0) h += 30 // 按钮行
    if (hint !== "") h += 12 + estTextHeight(hint, 13, avail - 48) + 14
    h += 18 // 下 padding
    // 封顶 60% 屏高（超长结果内部滚动），下限 170 避免缩成条状
    return Math.round(Math.min(Math.max(h, 170), Device.screen.height * 0.6))
  }, [phase, errorMsg, blocks, hint])

  async function copy() {
    const msg = "已复制"
    if (output.trim() === "") return
    try {
      await Clipboard.copyText(output)
      if (!mountedRef.current) return
      setRes({ copyHint: msg })
    } catch {
      if (!mountedRef.current) return
      setRes({ copyHint: "复制失败" })
      return
    }
    setTimeout(() => mountedRef.current && setRes(r => (r.copyHint === msg ? { copyHint: "" } : {})), 3000)
  }

  async function send() {
    if (!chat || sending || output.trim() === "") return
    setRes({ sending: true, sendHint: "" })
    const done = (msg: string) => {
      if (!mountedRef.current) return
      setRes({ sending: false, sendHint: msg })
      setTimeout(() => mountedRef.current && setRes(r => (r.sendHint === msg ? { sendHint: "" } : {})), 5000)
    }
    try {
      const ret = await tg(
        "send_message",
        { chat: chat.name || String(chat.id), chat_id: chat.id, text: output },
        90,
      )
      if (!mountedRef.current) return
      // 后台补刷统计：不该在页面上闪“读取时间线…”转圈
      if (ret.ok) p?.loadOverview({ quiet: true })
      done(ret.ok ? "已发送 ✓" : ret.error || "发送失败")
    } catch (e) {
      done(errorMessage(e))
    }
  }

  return (
    <VStack
      alignment="leading"
      spacing={12}
      padding={{ horizontal: 16, top: 16, bottom: 18 }}
      // 临时窗口卡片：宽固定屏宽-64，高度随内容自适应（随时可关，不锁生成中）
      frame={{
        width: Device.screen.width - 64,
        height: windowHeight,
        alignment: "leading",
      }}
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
          {heading !== "" ? heading : "分析结果"}
        </Text>
        {running ? <ProgressView /> : null}
        <RowButton title="关闭" color="#8E8E93" action={onClose} />
      </HStack>
      <ScrollView axes="vertical" frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
        <VStack alignment="leading" spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          {phase === "loading" ? <Hint tone="info" spinner text="正在读取消息记录…" /> : null}
          {phase === "streaming" ? <Hint tone="info" spinner text="AI 生成中…" /> : null}
          {phase === "error" ? <Hint tone="error" text={errorMsg} /> : null}
          {blocks.map((b, i) => (
            <Text
              key={i}
              font={b.kind === "heading" ? 17 : 15}
              fontWeight={b.kind === "heading" ? "semibold" : undefined}
              foregroundStyle={b.kind === "heading" ? "#000000" : "#1C1C1E"}
              lineSpacing={6}
              padding={b.kind === "heading" ? { top: 6 } : undefined}
              frame={{ maxWidth: "infinity", alignment: "leading" }}
            >
              {b.text}
            </Text>
          ))}
        </VStack>
      </ScrollView>
      <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        {blocks.length > 0 ? <RowButton title="复制" action={copy} /> : null}
        {chat !== undefined && !isAsk && blocks.length > 0 ? (
          <RowButton
            title={sending ? "发送中…" : "发到本会话"}
            color="#34C759"
            filled
            disabled={sending || running}
            action={send}
          />
        ) : null}
      </HStack>
      {hint !== "" ? <Hint tone={hintTone} text={hint} /> : null}
    </VStack>
  )
}

/** 组件卸载守卫：await / 流式回调回来时可能已退出，靠它拦住 setState。 */
function useMounted() {
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  return mountedRef
}

// ── 群详情页：一键 AI 分析 + 自定义动作 ──────────────────────────────────

/** 会话目录：给 AI 选 chat 参数用（名称 [@username]｜类型｜是否我创建｜id）。 */
function buildChatCatalog(chats: any[] | null): string {
  if (!chats || chats.length === 0) return "（会话列表未加载，请先返回列表刷新）"
  return chats
    .slice(0, 100)
    .map(
      (c: any) =>
        `${c.name || c.id}${c.username ? ` @${c.username}` : ""}｜${c.type || "?"}${
          c.creator ? "｜我创建" : ""
        }｜id:${c.id}`,
    )
    .join("\n")
}

export function AiActionsSection({
  p,
  chat,
  res,
  setRes,
  openSheet,
}: {
  p: PanelCtx
  chat: any
  /** 屏幕持有的结果状态（详情页页面浮层展示 ResultSheet） */
  res: AiResult
  setRes: SetAiResult
  /** 分析开始时打开结果弹窗 */
  openSheet: () => void
}) {
  const [win, setWin] = useState("today")
  const [runningId, setRunningId] = useState("")
  const [formHint, setFormHint] = useState("")
  const [askText, setAskText] = useState("")
  const mountedRef = useMounted()

  /**
   * 分析轮次守卫：
   *  · runningRef —— 连点不会起两轮（running 从渲染闭包读，双击窗口内拦不住）；
   *  · runSeqRef  —— 切换时间范围后旧流作废，它的分块/收尾不再写回界面。
   */
  const runningRef = useRef(false)
  const runSeqRef = useRef(0)
  const invalidateRun = () => {
    runSeqRef.current += 1
    runningRef.current = false
  }

  const running = res.phase === "loading" || res.phase === "streaming"
  const actions = allAiActions(p.aiSettings)

  /** 读取当前时间范围内的本群消息并整理成可分析文本。 */
  async function fetchTranscript(maxChars = 16000): Promise<string> {
    const readOnce = () =>
      win === "today"
        ? tg("today", { chat: chat.name || String(chat.id), limit: 3000 }, 90)
        : tg(
            "recent",
            { chat: chat.name || String(chat.id), hours: Number(win), limit: 1500 },
            90,
          )
    let res = await readOnce()
    // 本地库还没有这个会话 → 后端降级返回 needs_sync：自动先同步一次再重读。
    // 否则只能看到「先点同步」的报错，体感就是“必须先发一条消息才能分析”。
    if (res.ok && res.needs_sync) {
      const synced = await p.syncOne(chat)
      if (!synced || !synced.ok) {
        throw new Error(
          synced ? `自动同步失败：${synced.error || "未知错误"}` : "自动同步未完成，请稍后重试",
        )
      }
      res = await readOnce()
    }
    if (!res.ok) throw new Error(res.error || "读取消息失败")
    const messages = res.messages || []
    if (messages.length === 0)
      throw new Error("本地还没有该群的消息，先点上方「同步消息」")
    const { text } = buildTranscript(messages, { showSender: true, maxChars })
    if (text.trim() === "") throw new Error("该范围内没有可分析的文本内容")
    return text
  }

  /** 统一执行入口：读记录 → 流式生成 → 写入结果状态（弹窗展示）。 */
  async function runStream(
    makeRequest: (transcript: string) => { systemPrompt: string; userContent: string },
    meta: { heading: string },
    runId: string,
  ) {
    if (runningRef.current) return
    runningRef.current = true
    const seq = ++runSeqRef.current
    /** 本轮是否已被放弃（切了时间范围）或组件已卸载 */
    const stale = () => !mountedRef.current || seq !== runSeqRef.current
    setRes({ ...EMPTY_AI_RESULT, phase: "loading", heading: meta.heading })
    setRunningId(runId)
    openSheet()
    const flusher = createStreamFlusher(text => {
      if (!stale()) setRes({ output: text })
    })
    try {
      const transcript = await fetchTranscript()
      if (stale()) return
      const request = makeRequest(transcript)
      setRes({ phase: "streaming" })
      const stream = await requestAiStream(request.systemPrompt, request.userContent)
      let buffered = ""
      for await (const chunk of stream) {
        if (stale()) break
        if (chunk.type === "text") {
          buffered += chunk.content
          flusher.schedule(buffered)
        }
      }
      flusher.cancel()
      if (stale()) return
      setRes({ output: buffered, phase: "done" })
    } catch (e) {
      flusher.cancel()
      if (stale()) return
      setRes({ errorMsg: errorMessage(e), phase: "error" })
    } finally {
      flusher.cancel()
      if (seq === runSeqRef.current) {
        runningRef.current = false
        if (mountedRef.current) setRunningId("")
      }
    }
  }

  function runAction(action: AiAction) {
    const windowLabel = WINDOW_LABELS[win] ?? win
    const meta = { scope: `会话「${chat.name || chat.id}」`, window: windowLabel }
    void runStream(
      transcript => buildActionRequest(action, transcript, meta),
      { heading: `${action.name} · ${windowLabel}` },
      action.id,
    )
  }

  /** 自由提问：AI 判断要发消息时输出动作块，客户端真实执行后再让 AI 汇报结果。 */
  async function runAsk(textArg?: string) {
    const ask = (textArg ?? askText).trim()
    if (ask === "" || runningRef.current) return
    runningRef.current = true
    const seq = ++runSeqRef.current
    const stale = () => !mountedRef.current || seq !== runSeqRef.current
    const windowLabel = WINDOW_LABELS[win] ?? win
    const meta = { scope: `会话「${chat.name || chat.id}」`, window: windowLabel }
    setRes({ ...EMPTY_AI_RESULT, phase: "loading", heading: `自由提问 · ${windowLabel}`, isAsk: true })
    setRunningId("ask")
    openSheet()
    const flusher = createStreamFlusher(text => {
      if (!stale()) setRes({ output: text })
    })
    try {
      // 发送类指令不依赖本地记录：读不到记录时降级为空，不让纯发送指令被卡住；
      // 记录量压到 6000 字，减少第一轮 prefill 时间
      let transcript = ""
      try {
        transcript = await fetchTranscript(6000)
      } catch {
        transcript = "（本地暂无该会话的聊天记录）"
      }
      // 第一轮：AI 决定直接回答，还是输出发送动作块
      const first = buildInstructRequest(transcript, ask, {
        ...meta,
        catalog: buildChatCatalog(p.chats),
      })
      setRes({ phase: "streaming" })
      const stream = await requestAiStream(first.systemPrompt, first.userContent)
      let raw = ""
      for await (const chunk of stream) {
        if (stale()) break
        if (chunk.type === "text") {
          raw += chunk.content
          // 流式期间把动作块原文藏起来，用户只看得到自然语言部分
          flusher.schedule(maskActionsForDisplay(raw))
        }
      }
      flusher.cancel()
      if (stale()) return
      const { actions, clean } = parseActionBlocks(raw)
      if (actions.length === 0) {
        if (raw.includes(ACTION_START)) {
          // 有动作标记但解析不出（JSON 损坏）：报错，不展示原文（重跑=重发一次）
          setRes({ errorMsg: "AI 输出的动作格式无法解析，请重新发起一次", phase: "error" })
          return
        }
        // 纯回答：直接展示
        setRes({ output: raw.trim(), phase: "done" })
        return
      }
      // 执行动作（按会话分组、每组一次批量发送），随后本地生成汇报——
      // 不再跑第二轮 AI 汇报，反馈时间少一整轮模型延迟
      setRes({ output: "" })
      const report = await runActions(actions)
      if (stale()) return
      setRes({ output: clean ? `${clean}\n\n${report}` : report, phase: "done" })
    } catch (e) {
      flusher.cancel()
      if (stale()) return
      setRes({ errorMsg: errorMessage(e), phase: "error" })
    } finally {
      flusher.cancel()
      if (seq === runSeqRef.current) {
        runningRef.current = false
        if (mountedRef.current) setRunningId("")
      }
    }
  }

  /**
   * 批量执行 AI 输出的发送动作：按目标会话分组，每组一次 send_messages
   * （后端单连接循环发 + 0.15s 限速，远快于逐条 dispatch），返回本地拼好的汇报。
   */
  async function runActions(actions: AiActionBlock[]): Promise<string> {
    type Group = { chat: any; chatId: any; texts: string[] }
    const groups = new Map<string, Group>()
    for (const a of actions) {
      const nm = a.chat.trim()
      const target =
        nm === ""
          ? null
          : (p.chats || []).find(
              (c: any) => String(c.name || "").trim().toLowerCase() === nm.toLowerCase(),
            )
      const key = String(target?.id ?? nm)
      let g = groups.get(key)
      if (!g) {
        g = {
          chat: target?.name || nm || chat.name || String(chat.id),
          chatId: nm === "" ? chat.id : target?.id,
          texts: [],
        }
        groups.set(key, g)
      }
      g.texts.push(a.text)
    }

    let ok = 0
    let firstLabel = ""
    const failLines: string[] = []
    for (const g of groups.values()) {
      try {
        const res = await tg(
          "send_messages",
          { chat: g.chat, chat_id: g.chatId, texts: g.texts },
          180,
        )
        if (res.ok) {
          ok += res.sent || 0
          if (firstLabel === "") firstLabel = res.chat || g.chat
          for (const f of res.failed || []) {
            failLines.push(`第 ${Number(f.index) + 1} 条失败：${f.error}`)
          }
        } else {
          failLines.push(`发送到「${g.chat}」失败：${res.error || "未知错误"}`)
        }
      } catch (e) {
        failLines.push(`发送到「${g.chat}」失败：${errorMessage(e)}`)
      }
    }
    const head =
      failLines.length === 0
        ? groups.size > 1
          ? `✅ 已发送 ${ok} 条（${groups.size} 个会话）`
          : `✅ 已发送 ${ok} 条到「${firstLabel}」`
        : `已发送 ${ok}/${actions.length} 条`
    return [head, ...failLines].join("\n")
  }

  /** 定时提示：卸载后不再触发 setState */
  function flashFormHint(msg: string) {
    setFormHint(msg)
    setTimeout(() => mountedRef.current && setFormHint(cur => (cur === msg ? "" : cur)), 5000)
  }

  function saveAction(name: string, prompt: string) {
    p.setAiSettings({
      ...p.aiSettings,
      customActions: [
        ...p.aiSettings.customActions,
        { id: String(Date.now()), name, prompt },
      ],
    })
    flashFormHint("已保存，点它即可分析")
  }

  function removeAction(id: string) {
    p.setAiSettings({
      ...p.aiSettings,
      customActions: p.aiSettings.customActions.filter(a => a.id !== id),
    })
  }

  return (
    <>
      {/* 时间范围：点行弹小窗（actionSheet）选择，不再用整行宽的分段选择器 */}
      <SettingsRow
        icon="clock"
        color="#5856D6"
        title="时间范围"
        value={WINDOW_LABELS[win] ?? win}
        action={async () => {
          const idx = await Dialog.actionSheet({
            title: "分析的时间范围",
            cancelButton: true,
            actions: [{ label: "今天" }, { label: "近 24 小时" }, { label: "近 7 天" }],
          })
          if (idx === null) return
          const next = ["today", "24", "168"][idx]
          if (next === undefined || next === win) return
          // 换时间范围 = 放弃正在跑的那一轮，否则旧流的分块会盖到新选择上
          invalidateRun()
          setRunningId("")
          setWin(next)
          setRes(EMPTY_AI_RESULT)
        }}
      />

      {actions.map(action => {
        const isCustom = p.aiSettings.customActions.some(a => a.id === action.id)
        return (
          <SettingsRow
            key={action.id}
            icon="sparkles"
            color={isCustom ? "#8E8E93" : "#2AABEE"}
            chevron={!isCustom}
            title={action.name}
            // 分析进行中再点 = 重开结果弹窗（不重复起跑；生成中随时可关、随时回来看）
            action={() => (running ? openSheet() : runAction(action))}
            trailing={runningId === action.id ? <ProgressView /> : undefined}
            onLongPress={
              isCustom
                ? async () => {
                    if (running) return
                    const ok = await Dialog.confirm({
                      title: "删除自定义动作",
                      message: `删除「${action.name}」？删除后可重新添加。`,
                      confirmLabel: "删除",
                    })
                    if (ok) removeAction(action.id)
                  }
                : undefined
            }
          />
        )
      })}

      {/* 自由提问：点行弹窗输入，AI 结合本群记录作答 / 执行发送（askText 保留供重试）；
          生成状态直接显示在本行（标题 + 右侧转圈），结果在弹窗里看 */}
      <SettingsRow
        icon="questionmark.circle"
        color="#2AABEE"
        chevron={false}
        title={runningId === "ask" ? "自由提问…（生成中）" : "自由提问 / 发送指令"}
        trailing={runningId === "ask" ? <ProgressView /> : undefined}
        action={async () => {
          // 有分析在跑（含本动作）→ 直接重开结果弹窗，不弹输入框、不重复起跑
          if (running) {
            openSheet()
            return
          }
          const v = await Dialog.prompt({
            title: "自由提问 / 发送指令",
            message: "输入任意问题或指令，AI 结合本群记录作答；可要求向某个会话发送消息",
            defaultValue: askText,
            placeholder: "输入问题或指令",
            confirmLabel: "提问",
          })
          if (v === null || v.trim() === "") return
          setAskText(v.trim())
          await runAsk(v.trim())
        }}
      />

      {/* 分析结果在页面浮层临时窗口里展示，行内不插结果卡片 */}

      {/* 添加分析动作：两步弹窗（名称 → 提示词），行内不放表单，提示在本行显示 */}
      <SettingsRow
        icon="plus.circle"
        color="#34C759"
        chevron={false}
        title="添加分析动作"
        hint={formHint !== "" ? formHint : undefined}
        hintTone={formHint.startsWith("已") ? "ok" : "error"}
        action={async () => {
          if (running) return
          setFormHint("")
          const name = await Dialog.prompt({
            title: "添加分析动作（1/2）",
            message: "动作名称，如：与我有关",
            placeholder: "动作名称",
            confirmLabel: "下一步",
          })
          if (name === null) return
          if (name.trim() === "") {
            flashFormHint("请输入动作名称")
            return
          }
          const prompt = await Dialog.prompt({
            title: "添加分析动作（2/2）",
            message: "提示词：希望 AI 怎样分析（只基于记录作答，不要编造）",
            placeholder: "用简体中文输出…",
            confirmLabel: "保存",
          })
          if (prompt === null) return
          if (prompt.trim() === "") {
            flashFormHint("请输入提示词")
            return
          }
          saveAction(name.trim(), prompt.trim())
        }}
      />
    </>
  )
}

