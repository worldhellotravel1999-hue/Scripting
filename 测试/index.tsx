import { Navigation, Script } from "scripting"
import RankingPage from "./RankingPage"
import { removeTranslationPreference } from "./storage"

// 全部代码为普通 TypeScript / TSX 模块，可直接查看和编辑。
// 无加密载荷、动态求值、远程代码或自动覆盖更新。
async function main() {
  removeTranslationPreference()
  await Navigation.present(<RankingPage />)
  Script.exit()
}

main()
