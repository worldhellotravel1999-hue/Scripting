// 临时：mock PanelCtx 预览首页会话卡片（搜索置顶 + 前三行右侧小按钮）
import { ChatsScreen } from "./chats"
import type { PanelCtx } from "./ctx"

const now = Date.now() / 1000
const day = 86400

const chats = [
  { id: 1001, name: "Swift 交流群", type: "group", preview: "那个 API 我试过了，可以直接用", date: new Date(now * 1000 - 600).toISOString(), unread: 3 },
  { id: 1002, name: "iOS 开发者周报", type: "channel", preview: "本周精选：SwiftUI 新组件详解", date: new Date(now * 1000 - 7200).toISOString(), unread: 12 },
  { id: 1003, name: "Alice", type: "user", preview: "明天见！", date: new Date(now * 1000 - 86400 - 3600).toISOString().replace("Z", ""), unread: 0 },
  { id: 1004, name: "Project Alpha · 长名字测试群", type: "group", preview: "构建通过了", date: new Date(now * 1000 - 3 * day).toISOString(), unread: 0 },
  { id: 1005, name: "机器人助手", type: "bot", preview: "", date: null, unread: 1 },
]

const stats = {
  chats: [
    { chat_name: "Swift 交流群", msg_count: 320 },
    { chat_name: "iOS 开发者周报", msg_count: 48 },
    { chat_name: "Alice", msg_count: 12 },
  ],
}

const noop: any = () => {}

export default function ChatsPreview() {
  const p: PanelCtx = {
    busy: null,
    chats,
    chatsLoading: false,
    chatScope: "all",
    chatSearch: "",
    dim: false,
    setDim: noop,
    excludedChats: [],
    listLimit: 50,
    stats,
    setChatScope: noop,
    setChatSearch: noop,
    loadChats: noop,
    push: noop,
    dismiss: noop,
    accounts: [{ sid: "default", name: "默认账号", label: "默认账号" }],
    accountSid: "default",
    switchAccount: noop,
  } as any
  return <ChatsScreen p={p} />
}
