// 临时：预览设置页（mock PanelCtx），确认新增的机器人签到行能正常 build
import { SettingsScreen } from "./settings"
import type { PanelCtx } from "./ctx"

const noop: any = () => {}

export default function SettingsPreview() {
  const p: PanelCtx = {
    busy: null,
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
