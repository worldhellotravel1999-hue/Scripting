// 临时验证：自绘底部标签栏（tabbar.tsx）的透明圆环描边、彩色图标、文字配色
// 是否按预期渲染——ImageRenderer 出图落盘后人工判读（preview 截图对本地图片不可靠）。
import { ImageRenderer, Script, VStack } from "scripting"
import { TabBar } from "./tabbar"

const OUT =
  "/private/var/mobile/Containers/Shared/AppGroup/4738D233-4544-420D-B861-DB1DE0563BBC/.tg-hub/_shot_tabbar.png"

async function main() {
  try {
    // 上：选中「会话」；下：选中「设置」——一次看全两种状态
    const node = (
      <VStack spacing={0} frame={{ width: 440 }} background="#FFFFFF">
        <TabBar value="chats" onChanged={() => {}} />
        <TabBar value="settings" onChanged={() => {}} />
      </VStack>
    )
    const img = await ImageRenderer.toUIImage(node, { scale: 3 })
    const b64 = img.toPNGBase64String()
    const data = b64 ? Data.fromBase64String(b64) : null
    if (data) {
      await FileManager.writeAsData(OUT, data)
      console.log("wrote", OUT, img.width, img.height)
    } else {
      console.log("png base64 failed")
    }
  } catch (e) {
    console.log("ERR", String(e))
  }
  Script.exit()
}

main()
