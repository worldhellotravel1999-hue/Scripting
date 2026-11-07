// 临时：设置页 busy 状态预览（复现「点刷新全部后右上角表现」）
import { SettingsScreen } from "./settings"
import type { PanelCtx } from "./ctx"

const noop: any = () => {}

export default function SettingsBusyPreview() {
  const p: PanelCtx = {
    busy: "增量刷新中（会话间隔 1 秒）…",
    chats: [],
    chatsLoading: false,
    chatScope: "all",
    chatSearch: "",
    listLimit: 50,
    refreshLimit: "500",
    refreshChatsCount: "10",
    syncChat: "",
    delChat: "",
    status: { network_error: false },
    loadChats: noop,
    doRefresh: noop,
    doSyncOne: noop,
    doDeleteChat: noop,
    setListLimit: noop,
    setRefreshLimit: noop,
    setRefreshChatsCount: noop,
    setSyncChat: noop,
    setDelChat: noop,
    push: noop,
    dismiss: noop,
  } as any
  return <SettingsScreen p={p} />
}
