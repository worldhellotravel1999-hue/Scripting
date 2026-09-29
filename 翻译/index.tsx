import { Navigation, Script } from "scripting"
import { HomeView } from "./views/home"

async function run() {
  try {
    await Navigation.present({ element: <HomeView /> })
    Script.exit()
  } catch (reason) {
    // 后台（extension）环境不支持 Navigation.present：分享面板 / 快捷指令
    // 应分别走 translation_ui_provider.tsx 和 intent.tsx。这里给出可感知
    // 的反馈后退出，避免静默挂起或无提示失败。
    const message = reason instanceof Error ? reason.message : String(reason)
    try {
      await Dialog.alert({
        title: Script.name,
        message: `请在分享面板或快捷指令中使用本脚本（${message}）。`,
      })
    } catch {}
    Script.exit()
  }
}

void run().catch(async (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason)
  try {
    await Dialog.alert({ title: Script.name, message })
  } finally {
    Script.exit()
  }
})
