import {
  Navigation,
  NavigationStack,
  Tab,
  TabView,
  ZStack,
  useEffect,
  useRef,
  useState,
  useObservable,
} from "scripting"
import { fmtNum, tg, type TgResult } from "./api"
import { loadAiSettings, saveAiSettings, type AiSettings } from "./ai"
import { LaunchScreen, LoginScreen } from "./login"
import { ChatsScreen } from "./chats"
import { ToolsScreen } from "./tools"
import { SettingsScreen } from "./settings"
import { PAGE_SETTINGS, PAGE_TOOLS, type PanelCtx } from "./ctx"

// ── 会话列表本地缓存 ────────────────────────────────────────────────────────
// 进入脚本先渲染缓存（秒开）；仅当缓存超过 CHATS_TTL_MS 才后台静默刷新一次。
// 手动点刷新、退群/删群后的重拉仍走带进度的显式拉取。
const CHATS_CACHE_KEY = "tgclient.chats.cache"
const CHATS_TTL_MS = 5 * 60 * 1000

type ChatsCache = { at: number; chats: any[] }

function loadCachedChats(): any[] | null {
  try {
    const cache = Storage.get<ChatsCache>(CHATS_CACHE_KEY)
    if (cache && Array.isArray(cache.chats) && cache.chats.length > 0) return cache.chats
  } catch {}
  return null
}

// ── 首页“显示条数”持久化 ──────────────────────────────────────────────────
// 设置页输入数字并点“写入缓存”后落盘，重启脚本不再回到默认 50。
const LIST_LIMIT_KEY = "tgclient.listLimit"

function loadListLimit(): number {
  try {
    const n = Math.floor(Number(Storage.get<unknown>(LIST_LIMIT_KEY)))
    if (Number.isFinite(n) && n >= 1) return n
  } catch {}
  return 50
}

// ── 首页范围筛选持久化 ────────────────────────────────────────────────────
// 「全部 / 已同步」切换后重启脚本不回默认。
const CHAT_SCOPE_KEY = "tgclient.chatScope"

function loadChatScope(): string {
  try {
    const v = Storage.get<unknown>(CHAT_SCOPE_KEY)
    if (v === "all" || v === "gsync") return v
  } catch {}
  return "all"
}

// ── 「已同步」分组的本地移出记录 ──────────────────────────────────────
// 详情页「移出」按钮只动本地分组，不碰 Telegram：会话在「全部」里照常显示。
const FOLDER_EXCLUDE_KEY = "tgclient.folder.excluded"

function loadExcludedChats(): string[] {
  try {
    const v = Storage.get<unknown>(FOLDER_EXCLUDE_KEY)
    if (Array.isArray(v)) return v.map(x => String(x))
  } catch {}
  return []
}

/**
 * TG Hub 根视图。
 *
 * 布局（2026-10-04 三次修订：去底部 Tab，一切从简）：
 *  1. 冷启动品牌遮罩（LaunchScreen，与登录页同排版）
 *  2. 未登录 → 全屏品牌登录页（LoginScreen：大标题 + 单一主按钮 + 分步表单）
 *  3. 已登录 → 单一 NavigationStack + path 字符串路由：
 *     根 = 会话列表（搜索 + 点群进详情），"chat:<id>" / "tools" / "settings" 压栈。
 * 业务逻辑与 tg-hub 命令调用完全保持原样。
 */

function View() {
  const dismiss = Navigation.useDismiss()
  const mountedRef = useRef(true)
  // 临时提示（错误 8s / 通知 5s）的计时器：用 ref 手动管理，
  // 卸载时一并清掉，避免异步回调在组件销毁后还去 setState。
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (errorTimer.current !== null) clearTimeout(errorTimer.current)
      if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
    }
  }, [])

  // 路由：NavigationStack + path 字符串（空数组 = 根页会话列表；
  // "chat:<id>" 见 ctx.ts）。导航页签用原生 TabView（与 Pix-Scripting 同一插件），
  // p.push 对 tools/settings 页签自动切 Tab，对 chat:* 压入会话栈。
  const path = useObservable<string[]>([])
  const tab = useObservable<string>("chats")
  const push = (page: string) => {
    if (page === PAGE_TOOLS) {
      tab.setValue("tools")
      return
    }
    if (page === PAGE_SETTINGS) {
      tab.setValue("settings")
      return
    }
    // 群详情永远落到「会话」页签自己的栈上
    tab.setValue("chats")
    path.setValue([...path.value, page])
  }

  const [busy, setBusy] = useState<string | null>(null)
  // busy 用计数管理：并发加载不会互相把转圈提前清掉（也不会卡死在非空）
  const busyCount = useRef(0)
  const beginBusy = (label: string) => {
    busyCount.current += 1
    setBusy(label)
  }
  const endBusy = () => {
    busyCount.current = Math.max(0, busyCount.current - 1)
    if (busyCount.current === 0) setBusy(null)
  }
  const [errorState, setErrorState] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // 所有提示都是临时的：错误横幅 8 秒后自动消失（下一次操作仍会重新触发）。
  // 必须用 ref 计时器而不是依赖 [error] 的 effect：**重复设置同一条错误文案时
  // state 身份没变、effect 不会重跑**，旧计时器会把新错误提前清掉。
  const setError = (msg: string | null) => {
    if (errorTimer.current !== null) {
      clearTimeout(errorTimer.current)
      errorTimer.current = null
    }
    setErrorState(msg)
    if (msg !== null) {
      errorTimer.current = setTimeout(() => {
        errorTimer.current = null
        if (mountedRef.current) setErrorState(null)
      }, 8000)
    }
  }

  // 登录
  const [status, setStatus] = useState<any>(null)
  const [phone, setPhone] = useState("")
  const [code, setCode] = useState("")
  const [password, setPassword] = useState("")
  const [codeSent, setCodeSent] = useState(false)
  const [needPassword, setNeedPassword] = useState(false)
  // API 凭证分步（公共凭证已删除）："id" → 只出 API ID 一行，"hash" → 只出 Hash 一行，
  // null → 手机号流程；每步都能返回上一步（见 login.tsx）。
  const [apiPhase, setApiPhase] = useState<"id" | "hash" | null>(null)

  // 概览
  const [stats, setStats] = useState<any>(null)
  const [timeline, setTimeline] = useState<any[]>([])

  // 会话列表（初始化即读本地缓存，进入脚本不用等网络拉取）
  const [chats, setChats] = useState<any[] | null>(() => loadCachedChats())
  const [chatScope, setChatScopeState] = useState(loadChatScope)
  const [chatSearch, setChatSearchState] = useState("")
  // 显示条数：初始化即读缓存（重启脚本不回 50），写入时同步落盘
  const [listLimit, setListLimitState] = useState(loadListLimit)
  const setListLimit = (v: number) => {
    setListLimitState(v)
    try {
      Storage.set(LIST_LIMIT_KEY, v)
    } catch {}
  }
  // 切筛选/搜索保留用户设置的显示条数（由设置页“显示条数”钳制在会话总数内）；
  // 筛选同时落盘，重启脚本保持上次选择
  const setChatScope = (v: string) => {
    setChatScopeState(v)
    try {
      Storage.set(CHAT_SCOPE_KEY, v)
    } catch {}
  }
  const setChatSearch = (v: string) => setChatSearchState(v)

  // 分组里被手动移出的会话（纯本地，重启脚本仍生效；「全部」不受影响）
  const [excludedChats, setExcludedChats] = useState<string[]>(loadExcludedChats)
  const excludeChat = (id: any) => {
    const sid = String(id)
    if (excludedChats.includes(sid)) return
    const next = [...excludedChats, sid]
    setExcludedChats(next)
    try {
      Storage.set(FOLDER_EXCLUDE_KEY, next)
    } catch {}
  }
  const restoreExcluded = () => {
    setExcludedChats([])
    try {
      Storage.set(FOLDER_EXCLUDE_KEY, [])
    } catch {}
  }
  // 详情页单个恢复：把某一个会话放回「已同步」分组
  const restoreChat = (id: any) => {
    const sid = String(id)
    if (!excludedChats.includes(sid)) return
    const next = excludedChats.filter(x => x !== sid)
    setExcludedChats(next)
    try {
      Storage.set(FOLDER_EXCLUDE_KEY, next)
    } catch {}
  }
  // 清空移出记录：直接删存储键（被移出的会话会回到分组），避免数据越积越多
  const clearExcludedRecords = () => {
    setExcludedChats([])
    try {
      Storage.remove(FOLDER_EXCLUDE_KEY)
    } catch {}
  }

  // 消息
  const [msgMode, setMsgMode] = useState("recent")
  const [query, setQuery] = useState("")
  const [msgHours, setMsgHours] = useState("24")
  const [recentHours, setRecentHours] = useState("24")
  const [messages, setMessages] = useState<any[] | null>(null)

  // 排行
  const [rankHours, setRankHours] = useState("24")
  const [ranking, setRanking] = useState<any[] | null>(null)

  // 同步
  const [refreshLimit, setRefreshLimit] = useState("500")
  const [refreshChatsCount, setRefreshChatsCount] = useState("20")
  const [syncChat, setSyncChat] = useState("")
  const [syncOneLimit, setSyncOneLimit] = useState("1000")
  const [syncResult, setSyncResult] = useState<any>(null)

  // 设置
  const [delChat, setDelChat] = useState("")
  const [apiId, setApiId] = useState("")
  const [apiHash, setApiHash] = useState("")

  // AI 分析配置（只存自定义动作；AI 固定用 Scripting 内置默认智能助手）
  const [aiSettings, setAiSettingsState] = useState<AiSettings>(() => loadAiSettings())
  const setAiSettings = (next: AiSettings) => {
    saveAiSettings(next)
    setAiSettingsState(next)
  }

  // 冷启动遮罩：状态与概览加载完毕、且至少展示 900ms（看门狗 3.5s 保底不卡死）
  const [booted, setBooted] = useState(false)

  const run = async (cmd: string, args: any = {}, timeout = 120, label = "处理中…") => {
    // 先收起键盘再刷新列表：否则键盘窗口的“保存密码”浮层与列表重排抢 present，
    // iOS 会在控制台刷 "Keyboard cannot present view controllers" 警告。
    Keyboard.hide()
    beginBusy(label)
    setError(null)
    try {
      const res = await tg(cmd, args, timeout)
      if (!res.ok) setError(res.error || "未知错误")
      return res
    } finally {
      endBusy()
    }
  }

  const flash = (msg: string) => {
    if (noticeTimer.current !== null) {
      clearTimeout(noticeTimer.current)
      noticeTimer.current = null
    }
    if (!mountedRef.current) return
    setNotice(msg)
    // 新通知接管旧计时器（旧的那条不再单独计时），卸载后不再回调
    noticeTimer.current = setTimeout(() => {
      noticeTimer.current = null
      if (mountedRef.current) setNotice(cur => (cur === msg ? null : cur))
    }, 5000)
  }

  const loadStatus = async (label = "检查连接…") => {
    const res = await run("status", {}, 60, label)
    if (res.ok) {
      setStatus(res)
      // 登录检测新机制的两种特殊结果：只有服务端明确注销才要求重新登录；
      // 网络不可用时保持本地登录态（不误踢回登录页）。
      if (res.revoked) flash("登录已失效（服务器注销了本会话），请重新登录")
      else if (res.offline) flash("暂时连不上 Telegram，已按本地登录状态继续")
    }
    return res
  }

  /**
   * 读取本地统计 + 时间线。
   * quiet=true：不占 busy 进度（发消息 / 撤回 / AI 发送后的后台补刷用，
   * 不该在页面上闪一下“读取时间线…”转圈）；工具页的显式刷新仍带进度。
   */
  const loadOverview = async (options?: { quiet?: boolean }) => {
    const quiet = options?.quiet === true
    const s = await tg("stats", {}, 30)
    if (s.ok) setStats(s)
    else setError(s.error || "读取本地统计失败")
    if (!quiet) beginBusy("读取时间线…")
    try {
      const t = await tg("timeline", { hours: 168, granularity: "day" }, 30)
      if (t.ok) setTimeline(t.rows || [])
      else setError(t.error || "读取时间线失败")
    } finally {
      if (!quiet) endBusy()
    }
  }

  /**
   * 拉取会话列表并写入本地缓存。
   * silent=true：不占 busy 进度、失败时保留旧缓存（进入脚本后的后台静默刷新用）。
   * **在途去重**：启动预拉 / 进入页面的检查 / 手动下拉刷新可能撞在一起，
   * 合并成同一次请求——list_chats 要遍历 300+ dialogs（~3s），重复拉纯浪费，
   * 且两次结果先后落缓存会互相覆盖。
   */
  const chatsReqRef = useRef<Promise<void> | null>(null)
  const [chatsLoading, setChatsLoading] = useState(false)
  const loadChats = (options?: { silent?: boolean }): Promise<void> => {
    const inflight = chatsReqRef.current
    if (inflight) return inflight
    const silent = options?.silent === true
    const task = (async () => {
      setChatsLoading(true)
      try {
        const res = silent
          ? await tg("list_chats", {}, 90)
          : await run("list_chats", {}, 90, "拉取会话列表…")
        if (res.ok) {
          const list = res.chats || []
          setChats(list)
          try {
            Storage.set(CHATS_CACHE_KEY, { at: Date.now(), chats: list })
          } catch {}
        }
      } catch (e) {
        console.log("loadChats failed:", e)
      } finally {
        setChatsLoading(false)
      }
    })()
    chatsReqRef.current = task
    const done = () => {
      if (chatsReqRef.current === task) chatsReqRef.current = null
    }
    task.then(done, done)
    return task
  }

  const loadMessages = async (mode: string) => {
    let res: any
    if (mode === "search") {
      if (!query.trim()) {
        setError("请输入关键词")
        return
      }
      res = await run(
        "search",
        {
          keyword: query.trim(),
          hours: msgHours === "all" ? null : Number(msgHours),
          limit: 50,
        },
        30,
        "搜索本地库…"
      )
    } else if (mode === "today") {
      res = await run("today", { limit: 50 }, 30, "读取今日消息…")
    } else {
      res = await run(
        "recent",
        { hours: Number(recentHours) || 24, limit: 50 },
        30,
        "读取最近消息…"
      )
    }
    if (res && res.ok) setMessages((res.messages || []).slice(0, 50))
  }

  const loadRanking = async () => {
    const res = await run(
      "top_senders",
      { hours: rankHours === "all" ? null : Number(rankHours), limit: 30 },
      30,
      "统计发言排行…"
    )
    if (res.ok) setRanking(res.rows || [])
  }

  const syncOne = async (chat: any): Promise<TgResult | null> => {
    const res = await run(
      "sync",
      { chat: chat.name || String(chat.id), limit: Number(syncOneLimit) || 1000 },
      600,
      `同步「${chat.name || chat.id}」…`
    )
    if (res.ok) {
      flash(`「${chat.name || chat.id}」新增 ${fmtNum(res.added)} 条`)
      const s = await tg("stats", {}, 30)
      if (s.ok) setStats(s)
    }
    return res
  }

  const doRefresh = async () => {
    const res = await run(
      "refresh",
      {
        limit_per_chat: Number(refreshLimit) || 500,
        max_chats: Number(refreshChatsCount) || 20,
        delay: 1,
      },
      900,
      "增量刷新中（会话间隔 1 秒）…"
    )
    if (res.ok) {
      const rows = Object.entries(res.chats || {}).filter(([, v]: any) => v > 0)
      const capped: string[] = res.capped || []
      const summary = { total: res.total, rows, capped, at: new Date().toISOString() }
      setSyncResult(summary)
      // 「上次刷新」提示临时展示，5 秒后自动消失
      setTimeout(() => setSyncResult((cur: any) => (cur === summary ? null : cur)), 5000)
      flash(
        capped.length
          ? `刷新完成，新增 ${fmtNum(res.total)} 条（${capped.length} 个会话首次同步按 500 条截断）`
          : `刷新完成，共新增 ${fmtNum(res.total)} 条`
      )
      const s = await tg("stats", {}, 30)
      if (s.ok) setStats(s)
    }
  }

  const saveApi = async (): Promise<boolean> => {
    const id = apiId.trim()
    const hash = apiHash.trim()
    if (!id || !hash) {
      setError("API ID 与 API Hash 都要填写（my.telegram.org 创建应用后获取）")
      return false
    }
    if (!/^\d+$/.test(id)) {
      setError("API ID 是纯数字")
      return false
    }
    if (!/^[0-9a-fA-F]{32}$/.test(hash)) {
      setError("API Hash 应为32 位十六进制字符串")
      return false
    }
    const res = await run("set_api", { api_id: id, api_hash: hash }, 30, "保存凭证…")
    if (!res.ok) return false
    flash(res.message || "已保存")
    await loadStatus("检查凭证状态…")
    return true
  }

  const clearApi = async () => {
    const res = await run("set_api", { api_id: "", api_hash: "" }, 30, "清除凭证…")
    if (res.ok) {
      flash(res.message || "已清除")
      await loadStatus("检查凭证状态…")
    }
  }

  const doSyncOne = async (nameArg?: string) => {
    const name = (nameArg ?? syncChat).trim()
    if (!name) {
      setError("请输入会话名或用户名")
      return
    }
    const res = await run(
      "sync",
      { chat: name, limit: Number(syncOneLimit) || 1000 },
      600,
      "同步中…"
    )
    if (res.ok) {
      const summary = { total: res.added, rows: [[name, res.added]], at: new Date().toISOString() }
      setSyncResult(summary)
      setTimeout(() => setSyncResult((cur: any) => (cur === summary ? null : cur)), 5000)
      flash(`「${name}」新增 ${fmtNum(res.added)} 条`)
      const s = await tg("stats", {}, 30)
      if (s.ok) setStats(s)
    }
  }

  const sendCode = async () => {
    const p = phone.trim()
    if (!p) {
      setError("请输入手机号，国际格式，如 +8613800138000")
      return
    }
    const res = await run("send_code", { phone: p }, 60, "发送验证码…")
    if (res.ok) {
      if (res.already) {
        setCodeSent(false)
        flash("该账号已登录")
        await loadStatus()
      } else {
        setCodeSent(true)
        setNeedPassword(false)
        flash(`验证码已发送（${res.sent_type || "短信"}）`)
      }
    }
  }

  const doSignIn = async () => {
    if (!code.trim()) {
      setError("请输入验证码")
      return
    }
    const res = await run("sign_in", { phone: phone.trim(), code: code.trim() }, 60, "登录中…")
    if (res.ok) {
      if (res.need_password) {
        setNeedPassword(true)
        setError(null)
        return
      }
      setCodeSent(false)
      setCode("")
      flash(`登录成功：${res.me?.name || res.me?.username || ""}`)
      await loadStatus()
      await loadOverview()
    }
  }

  const doPassword = async () => {
    if (!password) {
      setError("请输入两步验证密码")
      return
    }
    const res = await run("password", { password }, 60, "验证两步密码…")
    if (res.ok) {
      setPassword("")
      setNeedPassword(false)
      flash(`登录成功：${res.me?.name || res.me?.username || ""}`)
      await loadStatus()
      await loadOverview()
    }
  }

  /** 登录页「更换手机号 / 返回」 */
  const restartLogin = () => {
    setCodeSent(false)
    setNeedPassword(false)
    setCode("")
    setPassword("")
    setError(null)
  }

  // ── 凭证分步导航（一行一步，可返回） ────────────────────────────────
  const nextFromApiId = () => {
    const v = apiId.trim()
    if (!v) {
      setError("请填写 API ID（my.telegram.org 上的 api_id）")
      return
    }
    if (!/^\d+$/.test(v)) {
      setError("API ID 是纯数字")
      return
    }
    setError(null)
    setApiPhase("hash")
  }

  const backToApiId = () => {
    setError(null)
    setApiPhase("id")
  }

  /** 手机号步骤返回去改凭证（已配置 → 回 Hash 那行；没配置 → 回 API ID 那行） */
  const backToApi = () => {
    restartLogin()
    setApiPhase(status?.has_api === false ? "id" : "hash")
  }

  /** 凭证本来就在（只是点进来修改）→ 直接回手机号步骤，不必重新保存 */
  const skipToPhone = () => {
    setError(null)
    setApiPhase(null)
  }

  /** 凭证两行都填完 → 落盘并进入手机号步骤 */
  const submitApi = async () => {
    const ok = await saveApi()
    if (!ok) return
    setError(null)
    setApiPhase(null)
  }

  const doLogout = async () => {
    const res = await run("logout", {}, 60, "退出登录…")
    if (res.ok) {
      Storage.remove(CHATS_CACHE_KEY)
      flash("已退出登录（仅本机，不影响手机等其他设备）")
      setCodeSent(false)
      setNeedPassword(false)
      setStatus((s: any) => ({ ...s, authorized: false, me: null, local_session: false }))
    }
  }

  const doDeleteChat = async (name?: string) => {
    const target = (name ?? delChat).trim()
    if (!target) {
      setError("请输入要删除的会话名")
      return
    }
    const res = await run("delete_chat", { chat: target }, 30, "删除本地记录…")
    if (res.ok) {
      flash(`已删除「${target}」的 ${fmtNum(res.removed)} 条本地记录`)
      setDelChat("")
      const s = await tg("stats", {}, 30)
      if (s.ok) setStats(s)
    }
  }

  // 首次进入：品牌遮罩期间读状态 + 概览（最短 900ms，看门狗 3.5s 保底）
  useEffect(() => {
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      if (mountedRef.current) setBooted(true)
    }
    const watchdog = setTimeout(finish, 3500)
    const start = Date.now()
    ;(async () => {
      try {
        // 两条都是本地/联网的独立请求，并行跑：状态检查（联网探测）与概览
        // （纯本地 SQLite，毫秒级）没有依赖关系。
        await Promise.all([loadStatus(), loadOverview({ quiet: true })])
      } catch {}
      setTimeout(finish, Math.max(0, 900 - (Date.now() - start)))
    })()
    return () => clearTimeout(watchdog)
  }, [])

  // 启动即预拉会话列表：status（联网探测）与 list_chats（遍历 300+ dialogs，
  // ~3s）是两条互相独立的秒级网络请求，串行等 status 回来才开拉会白等一截。
  // **必须静默**：此刻还不知道登录态，走 run() 的话未登录时会把“尚未登录”
  // 错误横幅弹到登录页表单上（silent 失败不产生任何 UI，由下面的 effect 兑底重试）。
  useEffect(() => {
    if (chats === null) loadChats({ silent: true })
    return
  }, [])

  // 进入脚本：优先用本地缓存秒开会话列表。
  // 无缓存 → 显式拉一次；有缓存但超过 5 分钟 → 后台静默刷新（不闪进度、失败保留缓存）。
  useEffect(() => {
    if (!booted || !status?.authorized) return
    if (chats === null) {
      // 预拉还在飞 → 让它自己完成（下面靠 chatsLoading 展示加载态），
      // 不重复拉；已经结束且失败 → 带进度重拉一次，失败才有错误横幅。
      if (!chatsReqRef.current) loadChats()
      return
    }
    const cache = Storage.get<ChatsCache>(CHATS_CACHE_KEY)
    if (!cache || Date.now() - Number(cache.at || 0) > CHATS_TTL_MS) {
      loadChats({ silent: true })
    }
  }, [booted, status, chats])

  const authorized = !!status?.authorized

  // 进登录页 → 从 API ID 那步开始（每次登录都重新填自己的凭证，一行一步、可返回）；
  // 已在设置页保存过凭证的可以用「直接使用已保存的凭证」跳过。
  // 用 ref 只在“进入登录页”时初始化一次，避免每次 status 刷新把输入清空。
  const apiPhaseTouchedRef = useRef(false)
  useEffect(() => {
    if (authorized) {
      setApiPhase(null)
      apiPhaseTouchedRef.current = false
      return
    }
    if (apiPhaseTouchedRef.current) return
    apiPhaseTouchedRef.current = true
    setApiId("")
    setApiHash("")
    setApiPhase("id")
  }, [status, authorized])

  const panelCtx: PanelCtx = {
    busy,
    error: errorState,
    notice,
    dismiss,
    push,
    status,
    authorized,
    loadStatus,
    stats,
    timeline,
    loadOverview,
    chats,
    chatsLoading,
    chatScope,
    setChatScope,
    chatSearch,
    setChatSearch,
    listLimit,
    setListLimit,
    excludedChats,
    excludeChat,
    restoreExcluded,
    restoreChat,
    clearExcludedRecords,
    loadChats,
    syncOne,
    msgMode,
    setMsgMode,
    query,
    setQuery,
    msgHours,
    setMsgHours,
    recentHours,
    setRecentHours,
    messages,
    loadMessages,
    rankHours,
    setRankHours,
    ranking,
    loadRanking,
    refreshLimit,
    setRefreshLimit,
    refreshChatsCount,
    setRefreshChatsCount,
    syncChat,
    setSyncChat,
    syncOneLimit,
    setSyncOneLimit,
    syncResult,
    doRefresh,
    doSyncOne,
    delChat,
    setDelChat,
    apiId,
    setApiId,
    apiHash,
    setApiHash,
    saveApi,
    clearApi,
    doDeleteChat,
    doLogout,
    aiSettings,
    setAiSettings,
  }

  return (
    <ZStack
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      ignoresSafeArea={true}
      background="systemBackground"
      preferredColorScheme="light"
    >
      {!booted ? (
        <LaunchScreen text="正在检查连接…" />
      ) : !authorized ? (
        <NavigationStack>
          <LoginScreen
            busy={busy}
            error={errorState}
            phone={phone}
            setPhone={setPhone}
            code={code}
            setCode={setCode}
            password={password}
            setPassword={setPassword}
            codeSent={codeSent}
            needPassword={needPassword}
            apiPhase={apiPhase}
            apiId={apiId}
            setApiId={setApiId}
            apiHash={apiHash}
            setApiHash={setApiHash}
            nextFromApiId={nextFromApiId}
            submitApi={submitApi}
            backToApiId={backToApiId}
            backToApi={backToApi}
            canSkipToPhone={status?.has_api === true}
            skipToPhone={skipToPhone}
            sendCode={sendCode}
            doSignIn={doSignIn}
            doPassword={doPassword}
            restart={restartLogin}
            dismiss={dismiss}
          />
        </NavigationStack>
      ) : (
        <TabView selection={tab} tint="#2AABEE">
          {/* ⚠️ Tab 必须是 TabView 的显式直接子节点（不用 .map），否则外壳可能空白 */}
          <Tab title="会话" systemImage="bubble.left.and.bubble.right.fill" value="chats">
            <NavigationStack path={path}>
              <ChatsScreen p={panelCtx} />
            </NavigationStack>
          </Tab>
          <Tab title="工具" systemImage="chart.bar.fill" value="tools">
            <NavigationStack>
              <ToolsScreen p={panelCtx} />
            </NavigationStack>
          </Tab>
          <Tab title="设置" systemImage="gearshape.fill" value="settings">
            <NavigationStack>
              <SettingsScreen p={panelCtx} />
            </NavigationStack>
          </Tab>
        </TabView>
      )}
    </ZStack>
  )
}

export default View
