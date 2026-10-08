import {
  List,
  ProgressView,
  Section,
  useEffect,
  useState,
  useRef,
} from "scripting"
import { fmtNum, tg } from "./api"
import { aiCheckinDecide, type CheckinMsg } from "./ai"
import { Banners, SettingsRow, type HintTone } from "./components"
import { type PanelCtx } from "./ctx"
import { promptInput, savePrompt } from "./prompt"

/**
 * 设置页：整页一张无题单卡（不分组、无分组标题，与首页/群详情同风格）。
 * 2026-10-05 改版：行内不再放「输入框 + 按钮」，改为**点整行（含彩色图标）
 * 弹 Dialog 输入/确认**，当前值以灰色 value 展示，说明文字全部收进弹窗
 * （点击才显示）。
 * 2026-10-06：5 秒操作结果提示改为**行内小字**（直接显示在本行空白处），
 * 不再在行下另起 Hint 气泡；重复的「上次刷新」提示行删除（顶部 Banners 已有）。
 * 2026-10-07：刷新结果提示（按钮行下的 Hint 气泡）整体删除——点刷新只剩行内转圈，
 * 不再显示任何结果/进度提示；顶栏右侧的刷新按钮也删除（忙碌时仅留转圈）。
 * 批量退出 / 删除在群详情页卡片末尾（见 detail.tsx::BulkLeaveSection）。
 */

/**
 * 加入群组：点行弹窗输入邀请链接（t.me/+xxx）或公开 @用户名，
 * 走后端 join_chat 命令（2026-10-05 改为弹窗交互，行内不再放输入框+按钮）。
 */
function JoinChatRow({ p }: { p: PanelCtx }) {
  const [joining, setJoining] = useState(false)
  const [hint, setHint] = useState<{ ok: boolean; text: string } | null>(null)
  // 卸载守卫：join() 是秒级网络请求，await 回来时行可能已随页面销毁；
  // hint 计时器也要在卸载时清掉，否则回调会对着已销毁组件 setState（闪退根源）。
  const mountedRef = useRef(true)
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (hintTimer.current !== null) clearTimeout(hintTimer.current)
    }
  }, [])

  function flashHint(h: { ok: boolean; text: string }) {
    if (!mountedRef.current) return
    setHint(h)
    if (hintTimer.current !== null) clearTimeout(hintTimer.current)
    hintTimer.current = setTimeout(() => {
      hintTimer.current = null
      if (mountedRef.current) setHint(cur => (cur?.text === h.text ? null : cur))
    }, 5000)
  }

  async function join(v: string) {
    if (joining) return
    setJoining(true)
    setHint(null)
    try {
      const res = await tg("join_chat", { chat: v }, 120)
      if (!mountedRef.current) return
      if (res.ok) {
        flashHint({ ok: true, text: `已加入「${res.chat}」` })
        p.loadChats()
      } else {
        flashHint({ ok: false, text: res.error || "加入失败" })
      }
    } finally {
      if (mountedRef.current) setJoining(false)
    }
  }

  return (
    <>
      <SettingsRow
        icon="plus.circle"
        color="#34C759"
        title={joining ? "加入中…" : "加入群组"}
        hint={hint ? hint.text : undefined}
        hintTone={hint ? (hint.ok ? "ok" : "error") : "info"}
        disabled={joining}
        action={async () => {
          if (joining) return
          const v = await promptInput("joinChat", {
            title: "加入群组",
            message: "输入邀请链接（t.me/+xxx）或公开 @用户名",
            placeholder: "@用户名 / 邀请链接",
            confirmLabel: "加入",
          })
          if (v === null || v.trim() === "") return
          await join(v.trim())
        }}
      />
    </>
  )
}

/**
 * 机器人签到（娱乐功能）：点行弹窗输入一个或多个机器人用户名（空格/逗号分隔），
 * 流程对每个机器人依次执行：
 *   后端发 /start 抓回复（文本 + 图片 + 内联按钮）→ AI 看图（读数字、认哪个是
 *   签到按钮）→ 后端按 AI 的决策模拟点击 → AI 再看结果判定成败 → 进度与反馈
 * 以行内 hint 小字临时渲染（完成后 8 秒自动消失）。
 * 不写死任何签到业务：按钮长什么样、点哪个、算不算成功，全由 AI 现场判断。
 */
function CheckinRow() {
  const [running, setRunning] = useState(false)
  const [hint, setHint] = useState<{ tone: HintTone; text: string } | null>(null)
  // 与 JoinChatRow 同款守卫：整个流程是秒级网络 + AI 请求，await 回来时行可能
  // 已随页面销毁；hint 计时器也要在卸载时清掉（否则对已销毁组件 setState）。
  const mountedRef = useRef(true)
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (hintTimer.current !== null) clearTimeout(hintTimer.current)
    }
  }, [])

  function flash(tone: HintTone, text: string, ms = 5000) {
    if (!mountedRef.current) return
    setHint({ tone, text })
    if (hintTimer.current !== null) clearTimeout(hintTimer.current)
    hintTimer.current = setTimeout(() => {
      hintTimer.current = null
      if (mountedRef.current) setHint(cur => (cur?.text === text ? null : cur))
    }, ms)
  }

  /** 传输层丢结果（Python.run 拿不到哨兵行）：这类失败通常命令已经执行完了。 */
  function isTransportError(etype?: string): boolean {
    return etype === "NoOutput" || etype === "JSException" || etype === "EncodeError"
  }

  /** 只读恢复：什么都不发，抓 after_id 之后的机器人消息（回包丢失/回复慢时兜底）。 */
  async function recover(bot: string, afterId: number, wait: number): Promise<CheckinMsg[]> {
    try {
      const r = await tg("bot_checkin_read", { chat: bot, after_id: afterId, wait }, 90)
      if (!r.ok) return []
      return ((r.messages || []) as CheckinMsg[]).filter(m => !m.out)
    } catch {
      return []
    }
  }

  /** 行内 hint 只有 ~140pt：长错误压成短语，完整文本留在 console + Storage。 */
  function shortError(e?: string): string {
    const s = String(e || "出错了")
    if (s.startsWith("tg-hub 无响应")) return "后端无响应"
    if (s.startsWith("AI 分析失败") || s.startsWith("AI 未返回")) return "AI 分析失败"
    if (s.includes("未返回") || s.includes("BusyTimeout")) return "超时，请重试"
    if (s.startsWith("前一条命令")) return "上条命令未完成"
    return s.length > 18 ? s.slice(0, 18) : s
  }

  /** 单个机器人的完整签到：probe → AI 决策 → act → AI 判定（最多 3 步）。 */
  async function runOne(
    bot: string,
    tag: string,
  ): Promise<{ ok: boolean; text: string }> {
    flash("info", `${tag} 发送 /start…`)
    let messages: CheckinMsg[] = []
    const probe = await tg("bot_checkin_probe", { chat: bot, text: "/start", wait: 12 }, 90)
    if (probe.ok) {
      messages = (probe.messages || []) as CheckinMsg[]
      if (messages.length === 0) {
        // 机器人回得慢（带图的菜单常 >6s）：不重发，只读 /start 之后的新消息再等 12s
        flash("info", `${tag} 等待回复…`)
        messages = await recover(bot, Number(probe.sent_id) || 0, 12)
        if (messages.length === 0) throw new Error("机器人 24 秒没有回复")
      }
    } else if (isTransportError(probe.etype)) {
      // /start 很可能已经发出去了，只是回包在传输层丢了 → 只读恢复，绝不重发
      flash("info", `${tag} 回包丢失，读取回复…`)
      messages = await recover(bot, 0, 12)
      if (messages.length === 0) throw new Error(shortError(probe.error))
    } else {
      throw new Error(probe.error || "发送 /start 失败")
    }

    let history = ""
    flash("info", `${tag} AI 看图分析…`)
    let decision = await aiCheckinDecide(messages, history)
    // 多步：点完（或发完文本）拿新回复再看一次，直到 AI 判出成败 / 无动作可做
    for (let step = 1; step <= 3 && decision.success === null && decision.act; step++) {
      const act = decision.act
      const label = act.kind === "click" ? `点「${act.label}」` : `发「${act.text}」`
      flash("info", `${tag} ${label}…`)
      history +=
        `${step}. ${decision.feedback}` +
        `${decision.numbers ? `（图里：${decision.numbers}）` : ""} → ${label}\n`
      const afterId = messages.reduce((mx, m) => Math.max(mx, m.id), 0)
      const res =
        act.kind === "click"
          ? await tg(
              "bot_checkin_act",
              { chat: bot, mode: "click", msg_id: act.msgId, data: act.data, after_id: afterId, wait: 6 },
              90,
            )
          : await tg("bot_checkin_act", { chat: bot, mode: "text", text: act.text, wait: 8 }, 90)
      // 点击的回包：alert 弹窗文案 / 失败原因（按钮过期、机器人超时等）
      let answer = (res.answer || null) as
        | { message?: string; url?: string; error?: string }
        | null
      let next: CheckinMsg[]
      if (res.ok) {
        next = (res.messages || []) as CheckinMsg[]
        if (next.length === 0 && !answer?.message) {
          flash("info", `${tag} 读取结果…`)
          next = await recover(bot, afterId, 8)
        }
      } else if (isTransportError(res.etype)) {
        // 点击很可能已经生效、只是回包丢了 → 只读恢复，绝不重复点
        flash("info", `${tag} 回包丢失，读取结果…`)
        answer = null
        next = await recover(bot, afterId, 8)
        if (next.length === 0) throw new Error(shortError(res.error))
      } else {
        throw new Error(res.error || `${label}失败`)
      }
      if (answer?.error) {
        if (next.length === 0) throw new Error(`点击失败：${answer.error}`)
        history += `点击未响应：${answer.error}\n`
      } else if (answer?.message) {
        history += `弹窗：${answer.message}\n`
      }
      const tail = next
        .map(m => (m.text || "").trim())
        .filter(Boolean)
        .slice(-2)
        .join(" / ")
      history += `回复：${tail.slice(0, 120) || "（无新消息）"}\n`
      if (next.length === 0) break
      messages = next
      flash("info", `${tag} AI 判定结果…`)
      decision = await aiCheckinDecide(messages, history)
    }
    const detail = [decision.feedback, decision.numbers ? `图中 ${decision.numbers}` : ""]
      .filter(Boolean)
      .join(" · ")
    return { ok: decision.success === true, text: detail || "无结果" }
  }

  async function run(v: string) {
    if (running) return
    const bots = Array.from(
      new Set(
        v
          .split(/[\s,，、;；\n]+/)
          .map(s => s.trim())
          .filter(s => s !== ""),
      ),
    )
    if (bots.length === 0) {
      flash("error", "请输入机器人用户名")
      return
    }
    setRunning(true)
    setHint(null)
    const total = bots.length
    let okN = 0
    let failN = 0
    let lastText = ""
    try {
      for (let i = 0; i < bots.length; i++) {
        if (!mountedRef.current) return
        const bot = bots[i]
        const tag = total > 1 ? `[${i + 1}/${total}] ` : ""
        try {
          const r = await runOne(bot, tag)
          if (r.ok) okN++
          else failN++
          lastText = r.text
          if (i < total - 1) {
            flash(r.ok ? "ok" : "error", `${tag}${bot} ${r.ok ? "成功" : "失败"}`)
          }
        } catch (e) {
          failN++
          const raw = e instanceof Error ? e.message : String(e)
          // 完整错误留底：console + Storage（行内 hint 只放得下十几个字）
          console.log(`[checkin] ${bot}:`, raw)
          try {
            Storage.set("tgclient.checkin.lastError", { at: Date.now(), bot, text: raw })
          } catch {
            // 存失败不影响主流程
          }
          lastText = shortError(raw)
          flash("error", `${tag}${bot} ${lastText}`)
        }
      }
      if (!mountedRef.current) return
      // 最终结果留在本行 8 秒：单个机器人直接给 AI 的反馈文案，多个则给计数
      const summary =
        total === 1
          ? (failN > 0 ? "✗ " : "✓ ") + lastText
          : `${okN}/${total} 成功${failN > 0 ? `，${failN} 失败` : ""}`
      flash(failN > 0 ? "error" : "ok", summary, 8000)
    } finally {
      if (mountedRef.current) setRunning(false)
    }
  }

  return (
    <SettingsRow
      icon="checkmark.circle"
      color="#34C759"
      title={running ? "机器人签到中…" : "机器人签到"}
      hint={hint ? hint.text : undefined}
      hintTone={hint ? hint.tone : "info"}
      hintMax={140}
      trailing={running ? <ProgressView /> : undefined}
      disabled={running}
      action={async () => {
        if (running) return
        const v = await promptInput("checkin", {
          title: "机器人签到",
          message:
            "输入机器人用户名，多个用空格或逗号隔开。会对每个发 /start，由 AI 看回复里的图片与按钮，判断哪个是签到按钮并模拟点击，结果在本行显示。",
          placeholder: "@机器人用户名",
          confirmLabel: "开始签到",
        })
        if (v === null || v.trim() === "") return
        await run(v)
      }}
    />
  )
}

/**
 * 「显示条数」行（属于单卡的一部分，不再自带分组标题）：
 * 点行弹窗输入数字 +「写入缓存」确认才落盘（重启脚本不回默认 50）。
 * 钳制：≥1 且不超过当前会话总数（会话未加载时不设上限）。
 */
function ListLimitRow({ p }: { p: PanelCtx }) {
  const total = (p.chats || []).length
  const [hint, setHint] = useState<{ tone: "ok" | "error"; text: string } | null>(null)
  const mountedRef = useRef(true)
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (hintTimer.current !== null) clearTimeout(hintTimer.current)
    }
  }, [])

  function flash(tone: "ok" | "error", msg: string) {
    if (!mountedRef.current) return
    setHint({ tone, text: msg })
    if (hintTimer.current !== null) clearTimeout(hintTimer.current)
    hintTimer.current = setTimeout(() => {
      hintTimer.current = null
      if (mountedRef.current) setHint(cur => (cur?.text === msg ? null : cur))
    }, 5000)
  }

  return (
    <>
      <SettingsRow
        icon="list.number"
        color="#2AABEE"
        title="显示条数"
        hint={hint ? hint.text : undefined}
        hintTone={hint ? hint.tone : "info"}
        value={String(Math.max(1, p.listLimit))}
        action={async () => {
          const v = await promptInput("listLimit", {
            title: "显示条数",
            message:
              total > 0
                ? `首页最多显示的会话条数（1 ~ ${total}），写入缓存后重启仍生效`
                : "首页最多显示的会话条数（≥1），写入缓存后重启仍生效",
            defaultValue: String(Math.max(1, p.listLimit)),
            keyboardType: "numberPad",
            confirmLabel: "写入缓存",
          })
          if (v === null) return
          // 只取数字再转：旧写法 `Number("12abc")` 得 NaN 会被静默改写成 1，
          // `Number("12.5")` 会把小数落盘；这里先剔除非数字再 floor。
          const digits = v.replace(/[^0-9]/g, "")
          if (digits === "") {
            flash("error", "请输入 ≥1 的数字")
            return
          }
          let n = Math.floor(Number(digits))
          if (!Number.isFinite(n) || n < 1) n = 1
          const capped = total > 0 && n > total
          if (capped) n = total
          savePrompt("listLimit", String(n)) // 归一化后覆盖记忆
          p.setListLimit(n) // 落盘（view.tsx 写入 Storage）
          flash(
            "ok",
            capped
              ? `已写入 ${fmtNum(n)} 条（按总数封顶）`
              : `已写入 ${fmtNum(n)} 条（重启仍生效）`,
          )
        }}
      />
    </>
  )
}

export function SettingsScreen({ p }: { p: PanelCtx }) {
  return (
    <List
      listStyle="plain"
      listRowSpacing={10}
      listRowInsets={{ top: 0, bottom: 0, leading: 16, trailing: 16 }}
      navigationTitle="设置"
      navigationBarTitleDisplayMode="inline"
      toolbar={{
        // 顶栏右侧的刷新按钮已删（2026-10-07）：忙碌时仅保留转圈
        topBarTrailing: p.busy ? <ProgressView /> : undefined,
      }}
    >
      <Banners p={p} hideBusy={label => label.startsWith("增量刷新")} />

      {/* 整页一张无题单卡：所有设置行连续排列，不分子卡、无分组标题 */}
      <Section>
        {/* 同步 */}
        <SettingsRow
          icon="arrow.clockwise"
          color="#34C759"
          chevron={false}
          disabled={p.busy !== null}
          title={p.busy ? "刷新中…" : "刷新全部已同步会话"}
          action={async () => {
            // 结果/进度提示已删（2026-10-07）：只有行内转圈，失败时错误横幅仍在顶部
            if (p.busy !== null) return
            await p.doRefresh()
          }}
          trailing={p.busy ? <ProgressView /> : undefined}
        />
        <SettingsRow
          icon="gauge"
          color="#5856D6"
          title="每会话最多条数"
          value={p.refreshLimit}
          action={async () => {
            const v = await promptInput("refreshLimit", {
              title: "每会话最多条数",
              message: "「刷新全部已同步会话」时，每个会话最多拉取的消息条数（写入缓存）",
              defaultValue: p.refreshLimit,
              keyboardType: "numberPad",
              confirmLabel: "写入缓存",
            })
            if (v === null) return
            // 钳制 ≥1：以前 "0" 会原样落盘（行上显示 0、后端 `|| 500` 又回
            // 默认值，显示与实际不一致）；与显示条数同一口径 floor + 下限。
            const digits = v.replace(/[^0-9]/g, "").slice(0, 6)
            if (digits !== "") {
              const n = String(Math.max(1, Math.floor(Number(digits))))
              savePrompt("refreshLimit", n)
              p.setRefreshLimit(n)
            }
          }}
        />
        <SettingsRow
          icon="list.number"
          color="#5856D6"
          title="本轮会话数上限"
          value={p.refreshChatsCount}
          action={async () => {
            const v = await promptInput("refreshChatsCount", {
              title: "本轮会话数上限",
              message: "「刷新全部已同步会话」本轮最多遍历的会话数量（写入缓存）",
              defaultValue: p.refreshChatsCount,
              keyboardType: "numberPad",
              confirmLabel: "写入缓存",
            })
            if (v === null) return
            // 同上：钳制 ≥1，避免 "0" 落盘后显示与实际不一致
            const digits = v.replace(/[^0-9]/g, "").slice(0, 6)
            if (digits !== "") {
              const n = String(Math.max(1, Math.floor(Number(digits))))
              savePrompt("refreshChatsCount", n)
              p.setRefreshChatsCount(n)
            }
          }}
        />
        <SettingsRow
          icon="magnifyingglass"
          color="#2AABEE"
          title="按名字同步"
          value={p.syncChat || undefined}
          action={async () => {
            if (p.busy !== null) return
            const v = await promptInput("syncChat", {
              title: "按名字同步",
              message: "同步单个会话的最近消息（@用户名或群名）",
              defaultValue: p.syncChat,
              placeholder: "@用户名 / 群名",
              confirmLabel: "同步",
            })
            if (v === null || v.trim() === "") return
            p.setSyncChat(v.trim())
            await p.doSyncOne(v.trim())
          }}
        />

        {/* 加入群组（邀请链接 / @用户名） */}
        <JoinChatRow p={p} />

        {/* 机器人签到（AI 看图模拟点击，娱乐功能） */}
        <CheckinRow />

        {/* 显示条数（写入缓存） */}
        <ListLimitRow p={p} />

        {/* 数据（账号相关行已全部迁到「账号」页签） */}
        <SettingsRow
          icon="wifi"
          color="#0A84FF"
          chevron={false}
          title="网络"
          value={p.status?.network_error ? "无法连接" : p.status ? "正常" : "检查中…"}
        />
        <SettingsRow
          icon="trash"
          color="#FF3B30"
          danger
          disabled={p.busy !== null}
          title="删除本地记录"
          value={p.delChat || undefined}
          action={async () => {
            if (p.busy !== null) return
            const v = await promptInput("delChat", {
              title: "删除本地记录",
              message: "输入要删除本地记录的会话名（仅本地数据库，不影响 Telegram）",
              defaultValue: p.delChat,
              placeholder: "群名",
              confirmLabel: "删除",
            })
            if (v === null || v.trim() === "") return
            p.setDelChat(v.trim())
            await p.doDeleteChat(v.trim())
          }}
        />
      </Section>
    </List>
  )
}
