import {
  Navigation,
  NavigationStack,
  Rectangle,
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
import { PAGE_ACCOUNT, PAGE_SETTINGS, PAGE_TOOLS, type AccountInfo, type PanelCtx } from "./ctx"
import { AccountScreen } from "./account"

// ── 会话列表本地缓存 ────────────────────────────────────────────────────────
// 进入脚本先渲染缓存（秒开）；仅当缓存超过 CHATS_TTL_MS 才后台静默刷新一次。
// 手动点刷新、退群/删群后的重拉仍走带进度的显式拉取。
const CHATS_CACHE_KEY = "tgclient.chats.cache"
const CHATS_TTL_MS = 5 * 60 * 1000

/** 账号列表里找指定 sid 的展示名（name → @username → phone → sid） */
function displayNameOf(accounts: any[] | undefined, sid: string): string {
  const a = (accounts || []).find(x => x && x.sid === sid)
  if (!a) return sid
  return a.name || (a.username ? `@${a.username}` : "") || a.phone || sid
}

type ChatsCache = { at: number; acct?: string; chats: any[] }

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
// 「全部 / 同步」切换后重启脚本不回默认。
const CHAT_SCOPE_KEY = "tgclient.chatScope"

function loadChatScope(): string {
  try {
    const v = Storage.get<unknown>(CHAT_SCOPE_KEY)
    if (v === "all" || v === "gsync") return v
  } catch {}
  return "all"
}

// ── 「刷新全部已同步会话」参数持久化 ────────────────────────────────
// 「每会话最多条数」（默认 500）/「本轮会话数上限」（默认 20）输入后落盘，
// 重启脚本不再回默认值。
const REFRESH_LIMIT_KEY = "tgclient.refreshLimit"
const REFRESH_CHATS_KEY = "tgclient.refreshChatsCount"

function loadCachedString(key: string, fallback: string): string {
  try {
    const v = Storage.get<unknown>(key)
    if (typeof v === "string" && v.trim() !== "") return v.trim()
    if (typeof v === "number" && Number.isFinite(v)) return String(v)
  } catch {}
  return fallback
}

// ── 最后点开的会话（工具页「本群」默认查看对象）──────────────────────
// 首页点开会话行即记住，工具页消息查询默认看它的群内消息。
const LAST_CHAT_KEY = "tgclient.lastChat"
type LastChat = { id: any; name: string }

function loadLastChat(): LastChat | null {
  try {
    const v = Storage.get<LastChat>(LAST_CHAT_KEY)
    if (v && v.name) return { id: v.id, name: String(v.name) }
  } catch {}
  return null
}

// ── 暗色（整屏压暗）持久化 ────────────────────────────────────────────
// 首页第 3 行「暗色」小按钮切换；重启脚本保持上次状态。
const DIM_KEY = "tgclient.dim"

function loadDim(): boolean {
  try {
    return Storage.get<unknown>(DIM_KEY) === true
  } catch {}
  return false
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
    if (page === PAGE_ACCOUNT) {
      tab.setValue("account")
      return
    }
    // 群详情永远落到「会话」页签自己的栈上
    tab.setValue("chats")
    // 防双击/重复入栈：栈顶已是同一页（如连点会话行）就忽略，
    // 否则会叠出两层同会话详情，返回要按两次
    const cur = path.value
    if (cur.length > 0 && cur[cur.length - 1] === page) return
    path.setValue([...cur, page])
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
  // 暗色（整屏压暗蒙版）：首页第 3 行小按钮切换，写入缓存重启保持
  const [dim, setDimState] = useState(loadDim)
  const setDim = (v: boolean) => {
    setDimState(v)
    try {
      Storage.set(DIM_KEY, v)
    } catch {}
  }

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

  // 消息分布（柱状图）：timeline 的 hour 粒度原始行，null=还没查询过
  const [msgMode, setMsgMode] = useState("chat") // 默认看「最后点开的会话」的群内消息
  const [recentHours, setRecentHours] = useState("24")
  const [msgBars, setMsgBars] = useState<any[] | null>(null)

  // 排行（只统计最后点开的会话）
  const [rankHours, setRankHours] = useState("24")
  const [ranking, setRanking] = useState<any[] | null>(null)

  // 同步（两个条数输入均写入缓存，重启不回默认）
  const [refreshLimit, setRefreshLimitRaw] = useState(() =>
    loadCachedString(REFRESH_LIMIT_KEY, "500"),
  )
  const setRefreshLimit = (v: string) => {
    setRefreshLimitRaw(v)
    try {
      Storage.set(REFRESH_LIMIT_KEY, v)
    } catch {}
  }
  const [refreshChatsCount, setRefreshChatsCountRaw] = useState(() =>
    loadCachedString(REFRESH_CHATS_KEY, "20"),
  )
  const setRefreshChatsCount = (v: string) => {
    setRefreshChatsCountRaw(v)
    try {
      Storage.set(REFRESH_CHATS_KEY, v)
    } catch {}
  }
  // 最后点开的会话：工具页「本群」查询对象（点会话行即写入缓存）
  const [lastChat, setLastChatState] = useState<LastChat | null>(loadLastChat)
  const rememberChat = (c: any) => {
    if (!c) return
    const next: LastChat = { id: c.id, name: String(c.name ?? c.id) }
    setLastChatState(next)
    try {
      Storage.set(LAST_CHAT_KEY, next)
    } catch {}
  }
  const [syncChat, setSyncChat] = useState("")
  const [syncOneLimit, setSyncOneLimit] = useState("1000")

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

  const applyStatus = (res: any) => {
    if (!res?.ok) return res
    setStatus(res)
    // 登录检测新机制的两种特殊结果：只有服务端明确注销才要求重新登录；
    // 网络不可用时保持本地登录态（不误踢回登录页）。
    if (res.revoked) flash("登录已失效（服务器注销了本会话），请重新登录")
    else if (res.offline) flash("暂时连不上 Telegram，已按本地登录状态继续")
    return res
  }

  const loadStatus = async (label = "检查连接…", options?: { quiet?: boolean }) => {
    // quiet：后台补跑复核时用（启动后联网复核登录态），不闪进度条
    const res = options?.quiet
      ? await tg("status", {}, 60)
      : await run("status", {}, 60, label)
    return applyStatus(res)
  }

  // ── 多账号（学 IPA-Tool：底部“账号”页签 + 顶栏快速切换菜单） ─────────
  const accounts: AccountInfo[] = status?.accounts || []
  const accountSid: string = status?.account_sid || "default"
  const addingAccount: boolean = !!status?.adding

  /** 账号切换/添加/退出后要作废的会话侧状态（统计在别的库，必须重拉） */
  const resetChatsScoped = () => {
    // 作废在途 list_chats：旧账号请求还在飞时切号，它回来会把旧列表
    // setChats 并写进缓存（串号）。代际+1 后旧任务结果一律丢弃。
    chatsGenRef.current += 1
    chatsReqRef.current = null
    setChats(null)
    setMsgBars(null)
    setRanking(null)
    setChatSearch("")
    path.setValue([]) // 弹栈：群详情属于旧账号
  }

  /** 切换到另一账号：后端换 session + 断旧连接，前端清缓存/重拉状态与列表 */
  const switchAccount = async (sid: string) => {
    if (busy !== null || sid === accountSid) return
    const res = await run("account_switch", { sid }, 60, "切换账号…")
    if (!res.ok) return
    try {
      Storage.remove(CHATS_CACHE_KEY)
    } catch {}
    // 先刷新 status 再清 chats：status 是缓存 acct 标记与拉取时机的依据，
    // 反过来会先用旧 sid 拉一轮再被校验打回（多一次浪费拉取）。
    // 全程不把 status 置 null（否则 authorized 瞬间变 false 会闪登录页）。
    await loadStatus("切换账号…")
    resetChatsScoped()
    setStats(null)
    setTimeline([])
    // 新账号的统计在另一库里，后台静默补拉；会话列表由 booted effect 接管
    loadOverview({ quiet: true }).catch(() => {})
    flash(`已切换到 ${displayNameOf(res.accounts, sid)}`)
  }

  /** 开一个新账号 slot 并进登录页（已有登录态不受影响，失败可取消回滚） */
  const beginAddAccount = async () => {
    if (busy !== null || addingAccount) return
    const ok = await Dialog.confirm({
      title: "添加账号",
      message: "将进入登录页（验证码/两步验证流程与首次登录相同）。登录成功后可在底部「账号」页随时切换；当前账号不受影响。",
      confirmLabel: "去登录",
    })
    if (!ok) return
    const res = await run("account_add_begin", {}, 60, "准备添加账号…")
    if (!res.ok) return
    // 不把 status 置 null（避免闪登录页/丢 accounts 列表）。
    // 先刷 status（authorized→false，登录页接管且 booted effect 停止拉取），
    // 再清数据 —— 顺序反过来会先对新 slot（无会话）发一轮 list_chats 白报错。
    setCodeSent(false)
    setNeedPassword(false)
    setCode("")
    setPassword("")
    setApiId("")
    setApiHash("")
    // 凭证已配置 → 直接跳手机号步（添加账号不该重填凭证）；否则从凭证步开始
    setApiPhase(status?.has_api === true ? null : "id")
    apiPhaseTouchedRef.current = true
    await loadStatus("检查连接…")
    resetChatsScoped()
    setStats(null)
    setTimeline([])
  }

  /** 取消“添加账号”：删新 slot，回到之前的账号 */
  const cancelAddAccount = async () => {
    if (busy !== null) return
    const res = await run("account_add_cancel", {}, 60, "取消添加…")
    if (!res.ok) return
    try {
      Storage.remove(CHATS_CACHE_KEY)
    } catch {}
    // 先回 status（authorized 恢复）再清数据，避免中间态闪登录页
    await loadStatus("检查连接…")
    resetChatsScoped()
    setStats(null)
    setTimeline([])
    loadOverview({ quiet: true }).catch(() => {})
    flash("已取消添加，回到原账号")
  }

  /** 移除非当前账号（前端已确认；仅删本机会话与登录态） */
  const removeAccount = async (sid: string) => {
    if (busy !== null) return
    const res = await run("account_remove", { sid }, 60, "移除账号…")
    if (!res.ok) return
    flash(`已移除「${displayNameOf(res.accounts, sid)}」的本机会话`)
    await loadStatus("刷新账号列表…", { quiet: true })
  }

  /**
   * 读取本地统计 + 时间线。
   * quiet=true：不占 busy 进度（发消息 / 撤回 / AI 发送后的后台补刷用，
   * 不该在页面上闪一下“读取时间线…”转圈）；工具页的显式刷新仍带进度。
   */
  const loadOverview = async (options?: { quiet?: boolean }) => {
    const quiet = options?.quiet === true
    if (!quiet) beginBusy("读取时间线…")
    try {
      // 两条命令**同步连续入队**（不在 stats 回来前 await）：tg 队列是串行的，
      // 若先等 stats 再入队 timeline，timeline 会排在启动预拉的 list_chats
      // （~5s）之后，把概览拖到看门狗之后才回来。
      // timeline 只统计最后点开的会话（hour 粒度，前端按本地日期合成“天”——
      // 直接用 day 粒度是按 UTC 分桶，跨天会偏 8 小时，图看着就不准）。
      const tlArgs: any = { hours: 168, granularity: "hour" }
      if (lastChat) tlArgs.chat = lastChat.name
      const [s, t] = await Promise.all([
        tg("stats", {}, 30),
        tg("timeline", tlArgs, 30),
      ])
      if (s.ok) setStats(s)
      else setError(s.error || "读取本地统计失败")
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
  // 会话拉取代际：切账号时 +1，旧代任务的结果/缓存写入/loading 收尾全部丢弃
  const chatsGenRef = useRef(0)
  const [chatsLoading, setChatsLoading] = useState(false)
  const loadChats = (options?: { silent?: boolean }): Promise<void> => {
    const inflight = chatsReqRef.current
    if (inflight) return inflight
    const silent = options?.silent === true
    const gen = chatsGenRef.current
    const task = (async () => {
      setChatsLoading(true)
      try {
        const res = silent
          ? await tg("list_chats", {}, 90)
          : await run("list_chats", {}, 90, "拉取会话列表…")
        if (gen !== chatsGenRef.current) return // 已切账号：丢弃旧账号结果
        if (res.ok) {
          const list = res.chats || []
          setChats(list)
          try {
            Storage.set(CHATS_CACHE_KEY, {
              at: Date.now(),
              acct: status?.account_sid || "default",
              chats: list,
            })
          } catch {}
        }
      } catch (e) {
        console.log("loadChats failed:", e)
      } finally {
        // 旧代任务不碰 loading（新代任务在飞，清了会把加载态提前关掉）
        if (gen === chatsGenRef.current) setChatsLoading(false)
      }
    })()
    chatsReqRef.current = task
    const done = () => {
      if (chatsReqRef.current === task) chatsReqRef.current = null
    }
    task.then(done, done)
    return task
  }

  /**
   * 消息分布（工具页柱状图）：取 timeline 的 hour 粒度原始行，
   * 由前端按本地时区分桶（缺桶补 0），不再返回逐条消息列表。
   *  - 「本群」：只统计最后点开的会话（本地库没有则自动同步一次再重读）
   *  - 「今日」：从本地零点起算（向上取整覆盖全天，超出的行前端丢弃）
   *  - 「最近」：全部会话，按上方选的时间范围
   */
  const loadMsgChart = async (mode: string) => {
    const hours = Math.max(1, Number(recentHours) || 24)
    const args: any = { hours, granularity: "hour" }
    if (mode === "chat") {
      const target = lastChat
      if (!target) {
        setError("还没有打开过会话（先在会话列表点开一个群）")
        return
      }
      args.chat = target.name
    } else if (mode === "today") {
      const now = Date.now()
      const midnight = new Date().setHours(0, 0, 0, 0)
      args.hours = Math.max(1, Math.ceil((now - midnight) / 3600000))
    }
    let res: any = await run("timeline", args, 60, "统计消息分布…")
    // 本地库还没有该会话 → 先自动同步一次再重读（与详情页一致）
    if (res && res.ok && res.needs_sync && mode === "chat") {
      const target = lastChat
      const chat = target
        ? (chats || []).find(
            (c: any) =>
              String(c.id) === String(target.id) || String(c.name) === target.name,
          )
        : null
      const synced = chat ? await syncOne(chat) : null
      if (synced && synced.ok) res = await tg("timeline", args, 60)
      else {
        setError("本地还没有该会话的消息，自动同步未完成")
        return
      }
    }
    if (res && res.ok) setMsgBars(res.rows || [])
  }

  const loadRanking = async () => {
    if (!lastChat) return // 只统计最后点开的会话（没点开过 → 工具页出空态提示）
    const res = await run(
      "top_senders",
      {
        chat: lastChat.name,
        hours: rankHours === "all" ? null : Number(rankHours),
        limit: 30,
      },
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

  /** 全量刷新已同步会话：不返回页面提示（设置页只有行内转圈，失败时错误横幅在顶部） */
  const doRefresh = async (): Promise<{
    total: number
    chats: number
    capped: number
  } | null> => {
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
    if (!res.ok) return null
    const rows = Object.entries(res.chats || {}).filter(([, v]: any) => v > 0)
    const capped: string[] = res.capped || []
    const s = await tg("stats", {}, 30)
    if (s.ok) setStats(s)
    return { total: res.total || 0, chats: rows.length, capped: capped.length }
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
      flash(`「${name}」新增 ${fmtNum(res.added)} 条`)
      const s = await tg("stats", {}, 30)
      if (s.ok) setStats(s)
    }
  }

  const sendCode = async () => {
    if (busy !== null) return // 防双击连发两条 send_code（易触发 Telegram 限流）
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
    if (busy !== null) return
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
    if (busy !== null) return
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
      resetChatsScoped()
      setStats(null)
      setTimeline([])
      if (res.switched_to) {
        // 还有其他账号 → 后端已自动切过去，刷新后直接落在那个账号
        flash("已退出当前账号，已切换到其他账号")
        await loadStatus("检查连接…")
        loadOverview({ quiet: true }).catch(() => {})
      } else {
        flash("已退出登录（仅本机，不影响手机等其他设备）")
        setCodeSent(false)
        setNeedPassword(false)
        setStatus((s: any) => ({ ...s, authorized: false, me: null, local_session: false, accounts: [], account_sid: "default", adding: false }))
      }
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
        // 1) 概览（本地 SQLite，毫秒级）**同步先行入队**，确保 timeline
        //    排在启动预拉的 list_chats（~5s）之前；
        // 2) status 走 local 快路径（只查本地密钥/登录缓存，不联网，
        //    毫秒级），不再被冷连接的 ~2.6s 探测拖住启动遮罩。
        const overviewP = loadOverview({ quiet: true })
        const local: any = await tg("status", { local: true }, 60)
        if (local?.ok && local.local_only) {
          // 本地快路径命中：直接判定登录态进主界面，
          // 联网复核（revoked/offline）由后台静默补跑，不闪进度。
          applyStatus(local)
          loadStatus("检查连接…", { quiet: true }).catch(() => {})
        } else {
          // 未命中本地快路径（无本地密钥）时，local 调用本身就是
          // 完整探测（need_api / 离线等），直接用它的结果；
          // 调用异常才退回常规 loadStatus。
          if (local?.ok) applyStatus(local)
          else await loadStatus()
        }
        overviewP.catch(() => {})
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
  // 多账号：缓存带 acct 标记，与当前账号不符（切换后重启）→ 丢弃重拉，不串号。
  useEffect(() => {
    if (!booted || !status?.authorized) return
    const sid = status?.account_sid || "default"
    if (chats === null) {
      // 预拉还在飞 → 让它自己完成（下面靠 chatsLoading 展示加载态），
      // 不重复拉；已经结束且失败 → 带进度重拉一次，失败才有错误横幅。
      if (!chatsReqRef.current) loadChats()
      return
    }
    const cache = Storage.get<ChatsCache>(CHATS_CACHE_KEY)
    if (cache && cache.acct && cache.acct !== sid) {
      try {
        Storage.remove(CHATS_CACHE_KEY)
      } catch {}
      setChats(null) // 触发下方重拉（效果重跑 → chats===null 分支）
      return
    }
    if (!cache || Date.now() - Number(cache.at || 0) > CHATS_TTL_MS) {
      loadChats({ silent: true })
    }
  }, [booted, status, chats])

  const authorized = !!status?.authorized

  // 进登录页入口（含“添加账号/切到失效账号重登”）：
  // 已配置凭证 → 直接进手机号步（不再每次先见 API ID 步再点“直接使用已保存的凭证”；
  // 手机号步仍可点「修改 API 凭证」回改）；未配置 → 从 API ID 步开始。
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
    setApiPhase(status?.has_api === true ? null : "id")
  }, [status, authorized])

  const panelCtx: PanelCtx = {
    busy,
    error: errorState,
    notice,
    dismiss,
    beginBusy,
    endBusy,
    push,
    status,
    authorized,
    loadStatus,
    accounts,
    accountSid,
    addingAccount,
    switchAccount,
    beginAddAccount,
    cancelAddAccount,
    removeAccount,
    stats,
    timeline,
    loadOverview,
    chats,
    chatsLoading,
    chatScope,
    setChatScope,
    chatSearch,
    setChatSearch,
    dim,
    setDim,
    listLimit,
    setListLimit,
    excludedChats,
    excludeChat,
    restoreChat,
    loadChats,
    syncOne,
    msgMode,
    setMsgMode,
    lastChat,
    rememberChat,
    recentHours,
    setRecentHours,
    msgBars,
    loadMsgChart,
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
            adding={addingAccount}
            onCancelAdd={cancelAddAccount}
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
          <Tab title="账号" systemImage="person" value="account">
            <NavigationStack>
              <AccountScreen p={panelCtx} />
            </NavigationStack>
          </Tab>
          <Tab title="设置" systemImage="gearshape.fill" value="settings">
            <NavigationStack>
              <SettingsScreen p={panelCtx} />
            </NavigationStack>
          </Tab>
        </TabView>
      )}

      {/* 暗色蒙版：整屏（含导航栏/页签栏）压暗一层；allowsHitTesting=false
          保证蒙上后页面照常可点，再按第 3 行「暗色」按钮即恢复 */}
      {dim && booted && authorized ? (
        <Rectangle
          fill="rgba(0,0,0,0.55)"
          frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
          ignoresSafeArea={true}
          allowsHitTesting={false}
        />
      ) : null}
    </ZStack>
  )
}

export default View
