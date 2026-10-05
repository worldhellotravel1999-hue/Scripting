import { Navigation, Script } from "scripting"
import { tg } from "./api"
import View from "./view"

async function run() {
  try {
    await Navigation.present(<View />)
  } catch (e) {
    console.log("TG Hub present failed:", e)
  } finally {
    // 页面关闭或异常都释放实例，避免脚本挂起/内存泄漏。
    // 先关闭 tg-hub 的常驻 Telegram 连接（不留后台连接），再退出脚本。
    try {
      await tg("shutdown", {}, 15)
    } catch (e) {
      console.log("tg-hub shutdown failed:", e)
    }
    Script.exit()
  }
}

run()
