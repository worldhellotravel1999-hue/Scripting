import { Navigation, Script } from "scripting"
import IPPage from "./page"

async function run() {
  try {
    await Navigation.present(<IPPage />)
  } catch (error) {
    console.error("[IP检测] 页面呈现失败", error)
  } finally {
    Script.exit()
  }
}
void run()
