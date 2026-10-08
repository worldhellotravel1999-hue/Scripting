// 临时：mock PanelCtx 预览群详情输入行（输入对话按钮 + 小号格式 chip）
import { ChatDetailScreen } from "./detail"
import type { PanelCtx } from "./ctx"

const noop: any = () => {}

export default function DetailPreview() {
  const p: PanelCtx = {
    busy: null,
    chats: [],
    chatsLoading: false,
    chatScope: "all",
    chatSearch: "",
    dim: false,
    setDim: noop,
    excludedChats: [],
    listLimit: 50,
    stats: { chats: [{ chat_name: "Swift 交流群", msg_count: 320 }] },
    setChatScope: noop,
    setChatSearch: noop,
    loadChats: noop,
    push: noop,
    dismiss: noop,
    accounts: [{ sid: "default", name: "默认账号", label: "默认账号" }],
    accountSid: "default",
    switchAccount: noop,
    syncOne: noop,
    doDeleteChat: noop,
    excludeChat: noop,
    restoreChat: noop,
    loadOverview: noop,
    ai: { actions: [] },
    aiSettings: { customActions: [] },
    runAiAction: noop,
  } as any
  const chat = {
    id: 1001,
    name: "Swift 交流群",
    type: "group",
    unread: 3,
    avatar: "",
  }
  return <ChatDetailScreen p={p} chat={chat} />
}
