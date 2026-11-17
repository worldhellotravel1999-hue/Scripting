import { Navigation, Script } from "scripting"
import IPPage from "./page"
import { flushWidgetReload } from "./utils/widget_reload"

async function run() {
  try {
    await Navigation.present(<IPPage />)
  } catch (error) {
    console.error("[IP检测] 页面呈现失败", error)
  } finally {
    try { await flushWidgetReload() }
    finally { Script.exit() }
  }
}
void run()
