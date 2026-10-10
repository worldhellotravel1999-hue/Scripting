import { Navigation, Script } from "scripting"
import { HomeView } from "./views/home"

async function run() {
  try {
    await Navigation.present({ element: <HomeView /> })
    Script.exit()
  } catch (reason) {
    // 主入口现在前台运行；若系统仍拒绝呈现（例如旧构建或异常宿主），
    // 给出提示而不是静默结束。图片意图由 intent.tsx 处理。
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
