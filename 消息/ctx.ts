import type { AiSettings } from "./ai"
import type { TgResult } from "./api"

/**
 * 各页面共享的上下文：全部业务状态与处理函数由根组件 view.tsx 持有，
 * 页面本身无副作用（AI 流式输出等页面级状态由页面自己管理）。
 *
 * 导航采用 NavigationStack + path 字符串路由（见 view.tsx）：
 *  - 根页：会话列表
 *  - "chat:<id>" → 群详情
 *  - PAGE_TOOLS / PAGE_SETTINGS → 工具 / 设置
 */

export const PAGE_TOOLS = "tools"
export const PAGE_SETTINGS = "settings"
export const PAGE_ACCOUNT = "account"
export const chatPage = (id: string | number) => `chat:${id}`

/** 注册表账号条目（status.accounts / account_* 命令返回） */
export type AccountInfo = {
  sid: string
  phone?: string
  name?: string
  username?: string
  user_id?: number
  /** 是否当前激活账号 */
  current?: boolean
  /** 本地是否还有登录密钥 */
  has_session?: boolean
}

export type PanelCtx = {
  busy: string | null
  error: string | null
  notice: string | null
  dismiss: () => void
  /** 手动开/关进度横幅（页面内不走 run() 的长任务用，如首页批量删除） */
  beginBusy: (label: string) => void
  endBusy: () => void
  /** 压入一个页面（见上方路由常量） */
  push: (page: string) => void

  status: any
  authorized: boolean
  loadStatus: (label?: string) => Promise<any>

  // 多账号（学 IPA-Tool：底部“账号”页签 + 顶栏快速切换菜单）
  /** 注册表账号列表（含 current/has_session 标记） */
  accounts: AccountInfo[]
  /** 当前账号 sid */
  accountSid: string
  /** 是否处于“添加账号”登录中途（登录页据此出“取消”） */
  addingAccount: boolean
  /** 切换到另一账号（重置会话缓存/统计并重拉状态与列表） */
  switchAccount: (sid: string) => Promise<void>
  /** 开一个新账号 slot 并进入登录页（已有登录态不受影响） */
  beginAddAccount: () => Promise<void>
  /** 取消“添加账号”，回到之前的账号 */
  cancelAddAccount: () => Promise<void>
  /** 移除非当前账号（删本机会话与登录态，需前端确认） */
  removeAccount: (sid: string) => Promise<void>

  stats: any
  /** 最近 7 天消息量（hour 粒度原始行；lastChat 存在时只统计该会话，前端按本地日期合并） */
  timeline: any[]
  /** 读取本地统计+时间线；quiet=true 不占 busy 进度（后台补刷用） */
  loadOverview: (options?: { quiet?: boolean }) => Promise<void>

  // 会话列表
  chats: any[] | null
  /** 会话列表正在拉取（静默预拉时也置真，用于首页空态提示） */
  chatsLoading: boolean
  chatScope: string
  setChatScope: (v: string) => void
  chatSearch: string
  setChatSearch: (v: string) => void
  listLimit: number
  setListLimit: (v: number) => void
  /** 暗色（整屏压暗蒙版）：首页第 3 行小按钮切换，根视图盖全屏 */
  dim: boolean
  setDim: (v: boolean) => void
  /** 「已同步」分组中被移出的会话 id（纯本地过滤，「全部」仍显示） */
  excludedChats: string[]
  /** 把会话移出该分组（本地，不碰 Telegram） */
  excludeChat: (id: any) => void
  /** 详情页单独恢复某一个被移出的会话 */
  restoreChat: (id: any) => void
  /** 拉取会话列表（silent=后台静默刷新，不占进度且失败保留缓存）；并发调用自动合并 */
  loadChats: (options?: { silent?: boolean }) => Promise<void>
  /** 同步单个会话，返回原始结果（详情页自行展示） */
  syncOne: (chat: any) => Promise<TgResult | null>

  // 工具页：消息分布（本群/今日/最近，柱状图） / 排行 / 概览（均只看最后点开的会话）
  msgMode: string
  setMsgMode: (v: string) => void
  /** 最后点开的会话（工具页三个工具的统计对象，点会话行即写入缓存） */
  lastChat: { id: any; name: string } | null
  rememberChat: (c: any) => void
  recentHours: string
  setRecentHours: (v: string) => void
  /** 消息分布柱状图数据：timeline 的 hour 粒度原始行（{period, msg_count}），null=未查询 */
  msgBars: any[] | null
  loadMsgChart: (mode: string) => Promise<void>
  rankHours: string
  setRankHours: (v: string) => void
  /** 发言排行（只统计最后点开的会话） */
  ranking: any[] | null
  loadRanking: () => Promise<void>

  // 设置页：同步
  refreshLimit: string
  setRefreshLimit: (v: string) => void
  refreshChatsCount: string
  setRefreshChatsCount: (v: string) => void
  /** 增量刷新已同步会话（不返回结果提示：只有行内转圈，失败时错误横幅在顶部） */
  doRefresh: () => Promise<{ total: number; chats: number; capped: number } | null>
  syncChat: string
  setSyncChat: (v: string) => void
  syncOneLimit: string
  setSyncOneLimit: (v: string) => void
  /** 同步单个会话（不传 name 时用 syncChat 输入值；弹窗流程直接传 name） */
  doSyncOne: (name?: string) => Promise<void>

  // 设置页：凭证与数据
  delChat: string
  setDelChat: (v: string) => void
  apiId: string
  setApiId: (v: string) => void
  apiHash: string
  setApiHash: (v: string) => void
  /** 保存自定义 API 凭证（登录页也用同一个；已配置则更新） */
  saveApi: () => Promise<boolean>
  clearApi: () => Promise<void>
  /** 传 name 则删除该会话本地记录；不传则用 delChat 输入框的值 */
  doDeleteChat: (name?: string) => Promise<void>
  doLogout: () => Promise<void>

  aiSettings: AiSettings
  setAiSettings: (next: AiSettings) => void
}
