// TGClient 的 AI 分析支撑：
//  1. AI 请求直接走 Scripting App 内置的默认智能助手（Assistant.requestStreaming 不指定
//     provider/modelId，即跟随 App「智能助手」的默认服务商与模型）；不提供任何切换模型入口。
//  2. 消息记录整理成文本 + 分析提示词（提示词全部为本脚本自写，未采用任何外部提示词）。

// ── AI 设置（只存用户自定义动作）────────────────────────────────────────────────

export type AiSettings = {
  /** 用户自定义的 AI 分析动作（内置动作不入库，见 BUILTIN_ACTIONS） */
  customActions: AiAction[]
}

const SETTINGS_KEY = "tgclient.ai.settings"

const DEFAULT_AI_SETTINGS: AiSettings = {
  customActions: [],
}

function normalizeAiSettings(value: unknown): AiSettings {
  const stored =
    value != null && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<AiSettings>)
      : undefined
  const customActions = Array.isArray(stored?.customActions)
    ? stored.customActions.filter(
        action =>
          typeof action?.id === "string" &&
          typeof action?.name === "string" &&
          action.name.trim() !== "" &&
          typeof action?.prompt === "string" &&
          action.prompt.trim() !== "",
      )
    : []
  return { customActions }
}

export function loadAiSettings(): AiSettings {
  return normalizeAiSettings(Storage.get<unknown>(SETTINGS_KEY))
}

export function saveAiSettings(settings: AiSettings): void {
  Storage.set(SETTINGS_KEY, normalizeAiSettings(settings))
}

/**
 * 流式请求：直接使用 Scripting 内置默认 AI（不指定服务商/模型，
 * 跟随 App「智能助手」配置）。必须以方法调用形式触发。
 */
export function requestAiStream(systemPrompt: string, userContent: string) {
  return Assistant.requestStreaming({
    systemPrompt,
    messages: [{ role: "user", content: userContent }],
  })
}

// ── 流式输出节流刷新 ─────────────────────────────────────────────────────────

export type StreamFlusher = {
  schedule(text: string): void
  flush(): void
  cancel(): void
}

// 首屏约 300 字跟随每个流式 chunk 更新；越过首屏后再按长度降低刷新频率。
const STREAM_EAGER_LENGTH = 300

function renderInterval(length: number): number {
  if (length < 1000) return 200
  if (length < 3000) return 350
  return 500
}

export function createStreamFlusher(onUpdate: (text: string) => void): StreamFlusher {
  let latest = ""
  let renderedLength = 0
  let timer: any = null
  const flush = () => {
    renderedLength = latest.length
    onUpdate(latest)
  }
  return {
    schedule(text) {
      latest = text
      if (text.length <= STREAM_EAGER_LENGTH || renderedLength < STREAM_EAGER_LENGTH) {
        flush()
        return
      }
      if (timer !== null) return
      timer = setTimeout(() => {
        timer = null
        flush()
      }, renderInterval(latest.length))
    },
    flush,
    cancel() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}

// ── 消息记录 → 文本 ──────────────────────────────────────────────────────────

export type AiMode = "mine" | "group" | "all"

const pad = (n: number) => (n < 10 ? `0${n}` : String(n))

function localStamp(iso?: string | null): string {
  if (!iso) return "??:??"
  const d = new Date(iso)
  if (isNaN(d.getTime())) return "??:??"
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export type TranscriptOptions = {
  /** 每条消息正文的最大字符数 */
  perMessageLimit?: number
  /** 整段记录的最大字符数；超出时丢弃最早的记录并标注省略条数 */
  maxChars?: number
  /** 是否带会话名（跨会话分析时需要） */
  showChat?: boolean
  /** 是否带发送者（分析他人发言时需要） */
  showSender?: boolean
}

/**
 * 把本地库消息整理成按时间正序的对话记录文本。
 * 超出总长度上限时保留较新的部分，并在开头注明被省略的条数。
 */
export function buildTranscript(
  messages: any[],
  options: TranscriptOptions = {},
): { text: string; used: number; omitted: number } {
  const perMessageLimit = options.perMessageLimit ?? 300
  const maxChars = options.maxChars ?? 16000
  const showChat = options.showChat ?? false
  const showSender = options.showSender ?? true

  const lines: string[] = []
  for (const m of messages) {
    const content = String(m?.content ?? "").replace(/\s+/g, " ").trim()
    if (content === "") continue
    const body = content.length > perMessageLimit
      ? `${content.slice(0, perMessageLimit)}…`
      : content
    const parts = [`[${localStamp(m.timestamp)}]`]
    if (showChat && m.chat_name) parts.push(`${m.chat_name} ·`)
    if (showSender) parts.push(`${m.sender_name || "未知"}：`)
    parts.push(body)
    lines.push(parts.join(" "))
  }

  // 超出总长度上限时从头部（较早）丢弃，保留较新的记录——
  // 总结场景里最新的对话才是重点。
  let omitted = 0
  let total = lines.reduce((sum, line) => sum + line.length + 1, 0)
  while (lines.length > 1 && total > maxChars) {
    total -= lines.shift()!.length + 1
    omitted += 1
  }
  const header = omitted > 0 ? `（较早的 ${omitted} 条记录超出长度上限，已省略）\n\n` : ""
  return { text: header + lines.join("\n"), used: lines.length, omitted }
}

// ── 分析提示词（本脚本自写）────────────────────────────────────────────────

const GROUP_ANALYSIS_PROMPT =
  "你是 Telegram 群聊内容分析助手。根据用户提供的群聊记录（按时间排序），用简体中文输出分析：" +
  "1. 主要话题与讨论脉络；2. 出现的重要结论、决定或情报；3. 活跃成员及其立场或角色；" +
  "4. 值得跟进的事项或潜在风险。只基于记录内容作答，不要编造，分点简洁输出。"

const MY_TODAY_PROMPT =
  "你是个人消息复盘助手。根据我今天在 Telegram 各会话的发言记录，用简体中文总结：" +
  "1. 我参与了哪些话题、在哪些会话发言；2. 我表达的主要观点、结论或承诺；" +
  "3. 他人对我的回应或尚未闭环的讨论；4. 值得跟进的事项。" +
  "只基于记录内容作答，不要编造，分点简洁输出。"

const ALL_TODAY_PROMPT =
  "你是 Telegram 消息摘要助手。根据提供的消息记录（可能跨多个会话），用简体中文输出：" +
  "1. 各会话要点（会话名 + 一两句概括）；2. 全局热点、重要通知或决定；" +
  "3. 与我相关的内容（@我、向我提问或需要我处理的事）。" +
  "只基于记录内容作答，不要编造，分点简洁输出。"

export const MODE_LABELS: Record<AiMode, string> = {
  mine: "我的今日发言",
  group: "群聊内容分析",
  all: "今日消息汇总",
}

export const WINDOW_LABELS: Record<string, string> = {
  today: "今天",
  "6": "近 6 小时",
  "24": "近 24 小时",
  "168": "近 7 天",
}

/** 组装一次分析请求的系统提示与用户内容。 */
export function buildAiRequest(
  mode: AiMode,
  transcript: string,
  meta: { scope: string; window: string },
): { systemPrompt: string; userContent: string } {
  const systemPrompt =
    mode === "group" ? GROUP_ANALYSIS_PROMPT
    : mode === "mine" ? MY_TODAY_PROMPT
    : ALL_TODAY_PROMPT
  const userContent = [
    `分析范围：${meta.scope}`,
    `时间范围：${meta.window}`,
    "",
    "<chat_records>",
    transcript,
    "</chat_records>",
  ].join("\n")
  return { systemPrompt, userContent }
}

// ── 分析动作（群详情页一键触发；内置 + 用户自定义）────────────────────────────

/** 一个 AI 分析动作 = 名称 + 提示词模板（提示词由用户自己填写，内置的均为自写）。 */
export type AiAction = {
  id: string
  name: string
  prompt: string
}

/** 内置动作：固定存在、不可删除，不入 Storage。 */
export const BUILTIN_ACTIONS: AiAction[] = [
  { id: "summary", name: "内容摘要", prompt: GROUP_ANALYSIS_PROMPT },
  {
    id: "intel",
    name: "情报与结论",
    prompt:
      "你是 Telegram 群聊情报提取助手。根据提供的群聊记录，用简体中文提取：" +
      "1. 出现的可用资源、链接、工具或渠道；2. 明确的结论与决定；" +
      "3. 关键数字（价格、日期、配置等）及其上下文。" +
      "只输出记录中真实出现的内容，按条列出并标注大致时间，不要编造。",
  },
  {
    id: "followup",
    name: "待办与风险",
    prompt:
      "你是任务跟进助手。根据提供的群聊记录，用简体中文列出：" +
      "1. 有人提出但尚未看到回应的请求、提问或待办；2. 出现的分歧、抱怨或潜在风险；" +
      "3. 值得继续关注的话题。只基于记录内容作答，分点简洁输出。",
  },
]

/** 全部可用动作：内置在前，用户自定义在后。 */
export function allAiActions(settings: AiSettings): AiAction[] {
  return [...BUILTIN_ACTIONS, ...settings.customActions]
}

/** 组装单个动作的分析请求：systemPrompt 直接用动作的提示词。 */
export function buildActionRequest(
  action: AiAction,
  transcript: string,
  meta: { scope: string; window: string },
): { systemPrompt: string; userContent: string } {
  const userContent = [
    `分析范围：${meta.scope}`,
    `时间范围：${meta.window}`,
    "",
    "<chat_records>",
    transcript,
    "</chat_records>",
  ].join("\n")
  return { systemPrompt: action.prompt, userContent }
}

// ── 操作指令（AI 判断需发消息时输出动作块，客户端执行后二轮汇报）──────────

export const ACTION_START = "[[ACTION]]"
export const ACTION_END = "[[/ACTION]]"

const INSTRUCT_PROMPT =
  "你是 Telegram 客户端内的操作助手，可以执行「发送消息」操作。根据用户指令判断：" +
  "1. 若用户要求发消息（如“发送/发到/告诉/发 N 条…”），只输出动作块，不要输出任何其他文字，格式：" +
  `${ACTION_START}{"chat":"会话名","text":"消息内容"}${ACTION_END}` +
  "；2. 要发多条就按顺序输出多个动作块，每块都必须同时包含开头 [[ACTION]] 和结尾 [[/ACTION]]，缺一不可，例如：" +
  `${ACTION_START}{"chat":"会话A","text":"第一条"}${ACTION_END}\n` +
  `${ACTION_START}{"chat":"会话A","text":"第二条"}${ACTION_END}` +
  "；3. chat 目标按优先级选：a) 用户提到的 @用户名 就原样写进 chat（如“给 @alice 发” → chat 为 @alice，即使不在可用会话里也能发）；" +
  "b) 可用会话列表里的会话名或 id；c) 用户没点名任何目标时才发到当前会话；" +
  "4. 要分别发给多个人时，每个目标一个动作块（chat 各不相同，text 按要求各写）；" +
  "5. 只是提问/需要结合聊天记录回答时，直接用简体中文文字回答，不输出动作块；" +
  "6. 动作块必须是合法 JSON（UTF-8 中文可直接写），text 内不要出现 [[ACTION]] 字样；" +
  "7. 用户要求消息带格式时，把 HTML 标签直接写进 text：" +
  "遮罩 <span class=\"tg-spoiler\">文本</span>、粗体 <b>文本</b>、斜体 <i>文本</i>、等宽 <code>文本</code>、" +
  "删除线 <s>文本</s>、下划线 <u>文本</u>、代码块 <pre>文本</pre>、" +
  "链接 <a href=\"网址\">文字</a>、引用 <blockquote>文本</blockquote>。" +
  "8. 用户对多条消息分别提出不同要求时（如“第一条带遮罩、第二条粗体”），必须逐条落实到对应动作块的 text：" +
  `第一条 → text 为 <span class=\"tg-spoiler\">1</span>，第二条 → text 为 <b>1</b>，其余按要求补齐，没要求的写纯文本。` +
  "9. 用户已在客户端弹窗里点确认下发过指令：要发送就直接输出动作块让客户端执行，" +
  "绝不要在文字回复里再问“确认发送吗/是否继续/需要我发送吗”之类，禁止要求二次确认。"

export type AiActionBlock = { chat: string; text: string }

/**
 * 从 AI 回复里解析出动作块（可多个），clean 为去掉动作块后的文本。
 * 鲁棒实现：不依赖 [[/ACTION]] 闭合（模型常漏），从 [[ACTION]] 后做花括号配对
 * 提取 JSON（跳过字符串内的花括号/引号，支持 pretty-print 多行），闭合标记有则吞掉。
 */
export function parseActionBlocks(src: string): {
  actions: AiActionBlock[]
  clean: string
} {
  const actions: AiActionBlock[] = []
  let out = ""
  let i = 0
  while (i < src.length) {
    const at = src.indexOf(ACTION_START, i)
    if (at < 0) {
      out += src.slice(i)
      break
    }
    out += src.slice(i, at)
    let j = at + ACTION_START.length
    while (j < src.length && /\s/.test(src[j])) j++
    if (src[j] !== "{") {
      i = at + ACTION_START.length // 标记后没有 JSON，丢掉标记继续
      continue
    }
    // 花括号配对（处理 JSON 字符串与转义）
    let depth = 0
    let k = j
    let inStr = false
    let esc = false
    let closed = false
    for (; k < src.length; k++) {
      const ch = src[k]
      if (inStr) {
        if (esc) esc = false
        else if (ch === "\\") esc = true
        else if (ch === '"') inStr = false
      } else if (ch === '"') inStr = true
      else if (ch === "{") depth++
      else if (ch === "}") {
        depth--
        if (depth === 0) {
          k++
          closed = true
          break
        }
      }
    }
    if (!closed) {
      i = at + ACTION_START.length // JSON 被截断，丢掉这个残块
      continue
    }
    i = k
    if (src.startsWith(ACTION_END, i)) i += ACTION_END.length // 有闭合则吞掉
    try {
      const obj = JSON.parse(src.slice(j, k))
      if (obj && typeof obj.text === "string") {
        actions.push({
          chat: typeof obj.chat === "string" ? obj.chat.trim() : "",
          text: obj.text,
        })
      }
    } catch {
      // 非法 JSON 忽略
    }
  }
  return { actions, clean: out.trim() }
}

/** 流式显示用：把已出现的动作块（含未闭合的尾部）藏起来，避免原文漏给用户。 */
export function maskActionsForDisplay(src: string): string {
  const segs = src.split(ACTION_START)
  let out = segs[0]
  for (let idx = 1; idx < segs.length; idx++) {
    const end = segs[idx].indexOf(ACTION_END)
    out += end >= 0 ? segs[idx].slice(end + ACTION_END.length) : ""
  }
  return out.trim()
}

/** 组装操作指令请求：带会话目录与聊天记录，AI 据此决定回答还是执行。 */
export function buildInstructRequest(
  transcript: string,
  instruction: string,
  meta: { scope: string; window: string; catalog: string },
): { systemPrompt: string; userContent: string } {
  const userContent = [
    `当前会话：${meta.scope}`,
    `时间范围：${meta.window}`,
    "",
    "可用会话（格式：名称｜类型｜是否我创建｜id）：",
    meta.catalog,
    "",
    "用户指令：",
    instruction,
    "",
    "<chat_records>",
    transcript,
    "</chat_records>",
  ].join("\n")
  return { systemPrompt: INSTRUCT_PROMPT, userContent }
}
