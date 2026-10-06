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
export const chatPage = (id: string | number) => `chat:${id}`

export type PanelCtx = {
  busy: string | null
  error: string | null
  notice: string | null
  dismiss: () => void
  /** 压入一个页面（见上方路由常量） */
  push: (page: string) => void

  status: any
  authorized: boolean
  loadStatus: (label?: string) => Promise<any>

  stats: any
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
  /** 「已同步」分组中被移出的会话 id（纯本地过滤，「全部」仍显示） */
  excludedChats: string[]
  /** 把会话移出该分组（本地，不碰 Telegram） */
  excludeChat: (id: any) => void
  /** 一键恢复分组里所有被移出的会话 */
  restoreExcluded: () => void
  /** 详情页单独恢复某一个被移出的会话 */
  restoreChat: (id: any) => void
  /** 清空移出记录（删存储键，被移出的会话回到分组） */
  clearExcludedRecords: () => void
  /** 拉取会话列表（silent=后台静默刷新，不占进度且失败保留缓存）；并发调用自动合并 */
  loadChats: (options?: { silent?: boolean }) => Promise<void>
  /** 同步单个会话，返回原始结果（详情页自行展示） */
  syncOne: (chat: any) => Promise<TgResult | null>

  // 工具页：消息查询 / 排行 / 概览
  msgMode: string
  setMsgMode: (v: string) => void
  query: string
  setQuery: (v: string) => void
  msgHours: string
  setMsgHours: (v: string) => void
  recentHours: string
  setRecentHours: (v: string) => void
  messages: any[] | null
  loadMessages: (mode: string) => Promise<void>
  rankHours: string
  setRankHours: (v: string) => void
  ranking: any[] | null
  loadRanking: () => Promise<void>

  // 设置页：同步
  refreshLimit: string
  setRefreshLimit: (v: string) => void
  refreshChatsCount: string
  setRefreshChatsCount: (v: string) => void
  syncResult: any
  doRefresh: () => Promise<void>
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
