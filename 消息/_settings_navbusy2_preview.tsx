// 临时：验证设置页 busy 时顶栏不再出现转圈（v2，换名避免 preview 陈旧产物）
import { NavigationStack } from "scripting"
import { SettingsScreen } from "./settings"
import type { PanelCtx } from "./ctx"

const noop: any = () => {}

export default function SettingsNavBusyPreview2() {
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
  return (
    <NavigationStack>
      <SettingsScreen p={p} />
    </NavigationStack>
  )
}
