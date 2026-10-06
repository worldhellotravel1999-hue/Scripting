// 临时：mock PanelCtx 预览工具页布局
import { ToolsScreen } from "./tools"
import type { PanelCtx } from "./ctx"

const now = Date.now() / 1000
const day = 86400

const ranking = [
  { sender_id: 1, sender_name: "Alice", msg_count: 320, last_msg: now - 3600 },
  { sender_id: 2, sender_name: "张三", msg_count: 180, last_msg: now - 7200 },
  { sender_id: 3, sender_name: "Bob the Builder Long Name", msg_count: 95, last_msg: now - 8600 },
  { sender_id: 4, sender_name: "Carol", msg_count: 60, last_msg: now - 20000 },
  { sender_id: 5, sender_name: "Dave", msg_count: 30, last_msg: now - 50000 },
  { sender_id: 6, sender_name: "Eve", msg_count: 12, last_msg: now - 90000 },
  { sender_id: 7, sender_name: "Frank", msg_count: 8, last_msg: now - 120000 },
  { sender_id: 8, sender_name: "Grace", msg_count: 5, last_msg: now - 150000 },
  { sender_id: 9, sender_name: "Heidi", msg_count: 3, last_msg: now - 180000 },
]

const timeline = Array.from({ length: 7 }, (_, i) => ({
  period: new Date(now - (6 - i) * day).toISOString().slice(0, 10),
  msg_count: [40, 120, 90, 210, 160, 300, 240][i],
}))

const noop: any = () => {}

export default function ToolsPreview(props?: { initialTab?: "msg" | "rank" | "overview" }) {
  const p: PanelCtx = {
    busy: null,
    msgMode: "recent",
    query: "",
    msgHours: "24",
    recentHours: "24",
    setMsgMode: noop,
    setQuery: noop,
    setMsgHours: noop,
    setRecentHours: noop,
    messages: null,
    loadMessages: noop,
    rankHours: "24",
    setRankHours: noop,
    ranking,
    loadRanking: noop,
    stats: { total: 12345, chats: [{}, {}, {}] },
    timeline,
    loadOverview: noop,
    status: { me: { name: "我", username: "me_here", phone: "+86 138…" }, network_error: null },
    authorized: true,
    loadStatus: noop,
  } as any
  return <ToolsScreen p={p} initialTab={(props as any)?.initialTab ?? "rank"} />
}
