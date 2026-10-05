// TGClient 的 AI 功能界面：
//  - AiActionsSection：群详情页（作为详情页整页单卡片里的若干行，无分组标题）——
//    点一下动作行即分析该群消息；内置 3 个动作 + 自定义动作（名称 + 提示词，可增删）。
//  - AiGlobalSection：工具页——跨会话的「我的今日发言 / 今日消息汇总」。
// AI 模型固定使用 Scripting 内置默认智能助手，不提供任何切换模型入口；
// 界面上不展示任何提示词/说明文案，提示词均为本脚本自写或用户自己填写。

import {
  HStack,
  Picker,
  ProgressView,
  RoundedRectangle,
  Section,
  Text,
  TextField,
  VStack,
  useEffect,
  useRef,
  useState,
} from "scripting"
import { tg } from "./api"
import {
  WINDOW_LABELS,
  type AiAction,
  type AiMode,
  allAiActions,
  buildActionRequest,
  buildAiRequest,
  buildInstructRequest,
  buildTranscript,
  type AiActionBlock,
  ACTION_START,
  MODE_LABELS,
  createStreamFlusher,
  maskActionsForDisplay,
  parseActionBlocks,
  requestAiStream,
} from "./ai"
import type { PanelCtx } from "./ctx"
import { FieldBox, Hint, RowButton, SettingsRow } from "./components"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type Phase = "idle" | "loading" | "streaming" | "done" | "error"

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

/**
 * 共用的分析结果卡片：浅灰圆角面板 + 分块排版（标题/列表/段落各自间距、
 * 行距宽松），下方一排行内小按钮（复制 / 发送 / 重新分析）。
 */
export function OutputBox({
  phase,
  output,
  errorMsg,
  copyHint,
  heading,
  onCopy,
  onRetry,
  retryTitle,
  onSend,
  sendTitle,
  sending,
}: {
  phase: Phase
  output: string
  errorMsg: string
  copyHint: string
  /** 卡片头部：如 “内容摘要 · 今天” */
  heading: string
  onCopy: () => void
  onRetry: () => void
  retryTitle: string
  /** 传入则显示「发送」按钮（把当前结果发到目标会话） */
  onSend?: () => void
  sendTitle?: string
  sending?: boolean
}) {
  const running = phase === "loading" || phase === "streaming"
  const blocks = output !== "" ? parseBlocks(output) : []
  return (
    <VStack alignment="leading" spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      {phase === "loading" ? <Hint tone="info" spinner text="正在读取消息记录…" /> : null}
      {phase === "streaming" ? <Hint tone="info" spinner text="AI 生成中…" /> : null}
      {phase === "error" ? <Hint tone="error" text={errorMsg} /> : null}
      {blocks.length > 0 ? (
        <VStack
          alignment="leading"
          spacing={6}
          padding={{ horizontal: 14, vertical: 12 }}
          frame={{ maxWidth: "infinity", alignment: "leading" }}
          background={<RoundedRectangle fill="#F2F2F7" cornerRadius={12} />}
        >
          <Text font="caption" fontWeight="semibold" foregroundStyle="#8E8E93">
            {heading}
          </Text>
          {blocks.map((b, i) => (
            <Text
              key={i}
              font={b.kind === "heading" ? 16 : 15}
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
      ) : null}
      {blocks.length > 0 ? (
        <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <RowButton title="复制" action={onCopy} />
          {onSend ? (
            <RowButton
              title={sending ? "发送中…" : sendTitle || "发送"}
              color="#34C759"
              filled
              disabled={sending || running}
              action={onSend}
            />
          ) : null}
          <RowButton
            title={running ? "生成中…" : retryTitle}
            color="#FF9500"
            disabled={running}
            action={onRetry}
          />
        </HStack>
      ) : null}
      {blocks.length > 0 && copyHint !== "" ? (
        <Hint tone={copyHint.startsWith("已") ? "ok" : "error"} text={copyHint} />
      ) : null}
    </VStack>
  )
}

function useCopyHelper() {
  const [copyHint, setCopyHint] = useState("")
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  const copy = (text: string) => {
    if (!text.trim()) return
    Clipboard.copyText(text)
      .then(() => {
        if (!mountedRef.current) return
        setCopyHint("已复制")
        setTimeout(() => mountedRef.current && setCopyHint(""), 3000)
      })
      .catch(() => mountedRef.current && setCopyHint("复制失败"))
  }
  return { copyHint, copy, mountedRef }
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

export function AiActionsSection({ p, chat }: { p: PanelCtx; chat: any }) {
  const [win, setWin] = useState("today")
  const [phase, setPhase] = useState<Phase>("idle")
  const [output, setOutput] = useState("")
  const [errorMsg, setErrorMsg] = useState("")
  const [runningId, setRunningId] = useState("")
  const [showForm, setShowForm] = useState(false)
  const [newName, setNewName] = useState("")
  const [newPrompt, setNewPrompt] = useState("")
  const [formHint, setFormHint] = useState("")
  const [sending, setSending] = useState(false)
  const [sendHint, setSendHint] = useState("")
  const [askText, setAskText] = useState("")
  const [showAsk, setShowAsk] = useState(false)
  /** 最近一次分析的卡片标题与重试入口（动作分析与自由提问共用结果卡片） */
  const [lastRun, setLastRun] = useState<{
    heading: string
    retry: () => void
  } | null>(null)
  const { copyHint, copy, mountedRef } = useCopyHelper()

  const running = phase === "loading" || phase === "streaming"
  const actions = allAiActions(p.aiSettings)

  /** 把当前分析结果直接发到本会话（以登录账号发出）。 */
  async function sendOutput() {
    if (output.trim() === "" || sending) return
    setSending(true)
    setSendHint("")
    try {
      const res = await tg(
        "send_message",
        { chat: chat.name || String(chat.id), chat_id: chat.id, text: output },
        90
      )
      if (!mountedRef.current) return
      setSendHint(res.ok ? "已发送 ✓" : res.error || "发送失败")
      if (res.ok) p.loadOverview()
    } finally {
      if (mountedRef.current) {
        setSending(false)
        setTimeout(() => mountedRef.current && setSendHint(""), 5000)
      }
    }
  }

  /** 读取当前时间范围内的本群消息并整理成可分析文本。 */
  async function fetchTranscript(maxChars = 16000): Promise<string> {
    const res =
      win === "today"
        ? await tg("today", { chat: chat.name || String(chat.id), limit: 3000 }, 90)
        : await tg(
            "recent",
            { chat: chat.name || String(chat.id), hours: Number(win), limit: 1500 },
            90,
          )
    if (!res.ok) throw new Error(res.error || "读取消息失败")
    const messages = res.messages || []
    if (messages.length === 0)
      throw new Error("本地还没有该群的消息，先点上方「同步消息」")
    const { text } = buildTranscript(messages, { showSender: true, maxChars })
    if (text.trim() === "") throw new Error("该范围内没有可分析的文本内容")
    return text
  }

  /** 统一执行入口：读记录 → 流式生成 → 卡片展示（动作分析与自由提问共用）。 */
  async function runStream(
    makeRequest: (transcript: string) => { systemPrompt: string; userContent: string },
    meta: { heading: string; retry: () => void },
    runId: string,
  ) {
    if (running) return
    setPhase("loading")
    setRunningId(runId)
    setLastRun(meta)
    setOutput("")
    setErrorMsg("")
    const flusher = createStreamFlusher(text => {
      if (mountedRef.current) setOutput(text)
    })
    try {
      const transcript = await fetchTranscript()
      const request = makeRequest(transcript)
      setPhase("streaming")
      const stream = await requestAiStream(request.systemPrompt, request.userContent)
      let buffered = ""
      for await (const chunk of stream) {
        if (!mountedRef.current) break
        if (chunk.type === "text") {
          buffered += chunk.content
          flusher.schedule(buffered)
        }
      }
      flusher.cancel()
      if (!mountedRef.current) return
      setOutput(buffered)
      setPhase("done")
    } catch (e) {
      flusher.cancel()
      if (!mountedRef.current) return
      setErrorMsg(errorMessage(e))
      setPhase("error")
    } finally {
      if (mountedRef.current) setRunningId("")
    }
  }

  function runAction(action: AiAction) {
    const windowLabel = WINDOW_LABELS[win] ?? win
    const meta = { scope: `会话「${chat.name || chat.id}」`, window: windowLabel }
    void runStream(
      transcript => buildActionRequest(action, transcript, meta),
      { heading: `${action.name} · ${windowLabel}`, retry: () => runAction(action) },
      action.id,
    )
  }

  /** 自由提问：AI 判断要发消息时输出动作块，客户端真实执行后再让 AI 汇报结果。 */
  async function runAsk() {
    const ask = askText.trim()
    if (ask === "" || running) return
    const windowLabel = WINDOW_LABELS[win] ?? win
    const meta = { scope: `会话「${chat.name || chat.id}」`, window: windowLabel }
    setPhase("loading")
    setRunningId("ask")
    setShowAsk(false) // 开始执行后收起输入行，结果卡片接结果（askText 保留供重试）
    setLastRun({ heading: `自由提问 · ${windowLabel}`, retry: () => runAsk() })
    setOutput("")
    setErrorMsg("")
    const flusher = createStreamFlusher(text => {
      if (mountedRef.current) setOutput(text)
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
      setPhase("streaming")
      const stream = await requestAiStream(first.systemPrompt, first.userContent)
      let raw = ""
      for await (const chunk of stream) {
        if (!mountedRef.current) break
        if (chunk.type === "text") {
          raw += chunk.content
          // 流式期间把动作块原文藏起来，用户只看得到自然语言部分
          flusher.schedule(maskActionsForDisplay(raw))
        }
      }
      flusher.cancel()
      if (!mountedRef.current) return
      const { actions, clean } = parseActionBlocks(raw)
      if (actions.length === 0) {
        if (raw.includes(ACTION_START)) {
          // 有动作标记但解析不出（JSON 损坏）：报错让用户重试，不展示原文
          setErrorMsg("AI 输出的动作格式无法解析，请点「重新生成」重试")
          setPhase("error")
          return
        }
        // 纯回答：直接展示
        setOutput(raw.trim())
        setPhase("done")
        return
      }
      // 执行动作（按会话分组、每组一次批量发送），随后本地生成汇报——
      // 不再跑第二轮 AI 汇报，反馈时间少一整轮模型延迟
      setOutput("")
      const report = await runActions(actions)
      if (!mountedRef.current) return
      setOutput(clean ? `${clean}\n\n${report}` : report)
      setPhase("done")
    } catch (e) {
      flusher.cancel()
      if (!mountedRef.current) return
      setErrorMsg(errorMessage(e))
      setPhase("error")
    } finally {
      if (mountedRef.current) setRunningId("")
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

  function saveAction() {
    const name = newName.trim()
    const prompt = newPrompt.trim()
    if (name === "" || prompt === "") {
      const msg = "名称和提示词都要填"
      setFormHint(msg)
      setTimeout(() => setFormHint(cur => (cur === msg ? "" : cur)), 5000)
      return
    }
    p.setAiSettings({
      ...p.aiSettings,
      customActions: [
        ...p.aiSettings.customActions,
        { id: String(Date.now()), name, prompt },
      ],
    })
    setNewName("")
    setNewPrompt("")
    const msg = "已保存，点它即可分析"
    setFormHint(msg)
    // 保存提示临时展示，5 秒后自动消失
    setTimeout(() => setFormHint(cur => (cur === msg ? "" : cur)), 5000)
    setShowForm(false)
  }

  function removeAction(id: string) {
    p.setAiSettings({
      ...p.aiSettings,
      customActions: p.aiSettings.customActions.filter(a => a.id !== id),
    })
  }

  return (
    <>
      <Picker
        title="时间范围"
        value={win}
        onChanged={(v: string) => {
          setWin(v)
          setPhase("idle")
          setOutput("")
        }}
        pickerStyle="segmented"
      >
        <Text tag="today">今天</Text>
        <Text tag="24">近 24 小时</Text>
        <Text tag="168">近 7 天</Text>
      </Picker>

      {actions.map(action => {
        const isCustom = p.aiSettings.customActions.some(a => a.id === action.id)
        const row = (
          <SettingsRow
            icon="sparkles"
            color={isCustom ? "#8E8E93" : "#2AABEE"}
            chevron={!isCustom}
            title={action.name}
            action={() => !running && runAction(action)}
            trailing={runningId === action.id ? <ProgressView /> : undefined}
          />
        )
        return isCustom ? (
          <HStack key={action.id} spacing={0} frame={{ maxWidth: "infinity" }}>
            {row}
            <RowButton
              title="删除"
              color="#FF3B30"
              action={() => removeAction(action.id)}
            />
          </HStack>
        ) : (
          row
        )
      })}

      {/* 自由提问：平时一行按钮，点开才展开输入（与「添加分析动作」同交互） */}
      {!showAsk ? (
        <SettingsRow
          icon="questionmark.circle"
          color="#2AABEE"
          chevron={false}
          title="自由提问 / 发送指令"
          action={() => setShowAsk(true)}
        />
      ) : (
        <VStack
          alignment="leading"
          spacing={8}
          frame={{ maxWidth: "infinity", alignment: "leading" }}
        >
          <FieldBox>
            <TextField
              title="自由提问"
              prompt="输入任意问题或指令，AI 结合本群记录作答 / 执行发送…"
              value={askText}
              onChanged={setAskText}
              axis="vertical"
              lineLimit={{ min: 1, max: 4 }}
              frame={{ maxWidth: "infinity", alignment: "leading" }}
            />
          </FieldBox>
          <HStack spacing={10}>
            <RowButton
              title={runningId === "ask" ? "生成中…" : "提问"}
              filled
              disabled={running || askText.trim() === ""}
              action={runAsk}
            />
            <RowButton title="收起" color="#8E8E93" action={() => setShowAsk(false)} />
          </HStack>
        </VStack>
      )}

      {/* 分析结果卡片：紧跟动作行展示，不再在屏幕底部冒一行字 */}
      {phase !== "idle" || output !== "" ? (
        <OutputBox
          heading={lastRun ? lastRun.heading : "分析结果"}
          phase={phase}
          output={output}
          errorMsg={errorMsg}
          copyHint={sendHint !== "" ? sendHint : copyHint}
          onCopy={() => copy(output)}
          onRetry={() => lastRun && lastRun.retry()}
          retryTitle="重新生成"
          onSend={sendOutput}
          sendTitle="发到本会话"
          sending={sending}
        />
      ) : null}

      {!showForm ? (
        <SettingsRow
          icon="plus.circle"
          color="#34C759"
          chevron={false}
          title="添加分析动作"
          action={() => {
            setShowForm(true)
            setFormHint("")
          }}
        />
      ) : (
        <VStack
          alignment="leading"
          spacing={8}
          frame={{ maxWidth: "infinity", alignment: "leading" }}
        >
          <FieldBox>
            <TextField
              title="动作名称，如：与我有关"
              value={newName}
              onChanged={setNewName}
              frame={{ maxWidth: "infinity" }}
            />
          </FieldBox>
          <FieldBox>
            <TextField
              title="提示词：希望 AI 怎样分析"
              prompt="用简体中文输出…（只基于记录作答，不要编造）"
              value={newPrompt}
              onChanged={setNewPrompt}
              frame={{ maxWidth: "infinity" }}
            />
          </FieldBox>
          <HStack spacing={10}>
            <RowButton title="保存" color="#34C759" filled action={saveAction} />
            <RowButton
              title="取消"
              color="#8E8E93"
              action={() => {
                setShowForm(false)
                setNewName("")
                setNewPrompt("")
                setFormHint("")
              }}
            />
          </HStack>
        </VStack>
      )}
      {formHint !== "" ? (
        <Hint tone={formHint.startsWith("已") ? "ok" : "error"} text={formHint} />
      ) : null}
    </>
  )
}

// ── 工具页：跨会话的全局 AI 汇总 ─────────────────────────────────────────────

export function AiGlobalSection({ p }: { p: PanelCtx }) {
  const [mode, setMode] = useState<AiMode>("mine")
  const [win, setWin] = useState("today")
  const [phase, setPhase] = useState<Phase>("idle")
  const [output, setOutput] = useState("")
  const [errorMsg, setErrorMsg] = useState("")
  const { copyHint, copy, mountedRef } = useCopyHelper()

  async function runAnalysis() {
    if (phase === "loading" || phase === "streaming") return
    setPhase("loading")
    setOutput("")
    setErrorMsg("")
    const flusher = createStreamFlusher(text => {
      if (mountedRef.current) setOutput(text)
    })
    try {
      let messages: any[] = []
      let scope = ""
      let windowLabel = ""

      if (mode === "mine") {
        scope = "我今天在所有会话的发言"
        windowLabel = "今天"
        let me = p.status?.me
        if (!me?.id) {
          const st = await p.loadStatus("获取账号信息…")
          me = st?.me
        }
        if (!me?.id) throw new Error("无法获取账号信息，请先完成登录")
        const res = await tg("today", { limit: 3000 }, 90)
        if (!res.ok) throw new Error(res.error || "读取今日消息失败")
        messages = (res.messages || [])
          .filter((m: any) => m.sender_id === me.id || (me.name && m.sender_name === me.name))
          .sort((a: any, b: any) => String(a.timestamp).localeCompare(String(b.timestamp)))
      } else {
        scope = "所有已同步会话"
        windowLabel = WINDOW_LABELS[win] ?? win
        const res =
          win === "today"
            ? await tg("today", { limit: 3000 }, 90)
            : await tg("recent", { hours: Number(win), limit: 1500 }, 90)
        if (!res.ok) throw new Error(res.error || "读取消息失败")
        messages = res.messages || []
      }

      if (messages.length === 0)
        throw new Error("该范围内没有消息，可先到群详情页同步或换个时间范围")

      const { text } = buildTranscript(
        messages,
        mode === "mine"
          ? { showChat: true, showSender: false, maxChars: 12000 }
          : { showChat: true, showSender: true, maxChars: 16000 }
      )
      if (text.trim() === "") throw new Error("该范围内没有可分析的文本内容")

      const request = buildAiRequest(mode, text, { scope, window: windowLabel })
      setPhase("streaming")
      const stream = await requestAiStream(request.systemPrompt, request.userContent)
      let buffered = ""
      for await (const chunk of stream) {
        if (!mountedRef.current) break
        if (chunk.type === "text") {
          buffered += chunk.content
          flusher.schedule(buffered)
        }
      }
      flusher.cancel()
      if (!mountedRef.current) return
      setOutput(buffered)
      setPhase("done")
    } catch (e) {
      flusher.cancel()
      if (!mountedRef.current) return
      setErrorMsg(errorMessage(e))
      setPhase("error")
    }
  }

  const running = phase === "loading" || phase === "streaming"

  return (
    <Section title="AI 汇总分析">
      <Hint tone="info" text="跨会话的全局视角；分析单个群请点进群详情。" />
      <Picker
        title="分析对象"
        value={mode}
        onChanged={(v: string) => {
          setMode(v as AiMode)
          setPhase("idle")
          setOutput("")
        }}
        pickerStyle="segmented"
      >
        <Text tag="mine">我的发言</Text>
        <Text tag="all">今日汇总</Text>
      </Picker>
      {mode === "all" ? (
        <Picker
          title="时间范围"
          value={win}
          onChanged={(v: string) => {
            setWin(v)
            setPhase("idle")
            setOutput("")
          }}
        >
          <Text tag="today">今天</Text>
          <Text tag="6">近 6 小时</Text>
          <Text tag="24">近 24 小时</Text>
          <Text tag="168">近 7 天</Text>
        </Picker>
      ) : null}
      <SettingsRow
        icon="sparkles"
        color="#2AABEE"
        chevron={false}
        disabled={running}
        title={running ? "分析中…" : "开始 AI 分析"}
        action={runAnalysis}
        trailing={running ? <ProgressView /> : undefined}
      />
      {phase !== "idle" || output !== "" ? (
        <OutputBox
          heading={`${MODE_LABELS[mode]}${
            mode === "all" ? ` · ${WINDOW_LABELS[win] ?? win}` : ""
          }`}
          phase={phase}
          output={output}
          errorMsg={errorMsg}
          copyHint={copyHint}
          onCopy={() => copy(output)}
          onRetry={runAnalysis}
          retryTitle="重新分析"
        />
      ) : null}
    </Section>
  )
}