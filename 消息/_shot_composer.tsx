// 临时验证：ComposerCard 新版（格式胶囊内嵌输入行 + Telegram 风格式面板）排版；
// preview 截图滞后/错位，改用 ImageRenderer 出图落盘人工判读。
import { ImageRenderer, Script, VStack } from "scripting"
import { ComposerCard } from "./detail"

const OUT =
  "/private/var/mobile/Containers/Shared/AppGroup/4738D233-4544-420D-B861-DB1DE0563BBC/.tg-hub/_shot_composer_v6.png"

async function main() {
  try {
    const node = (
      <VStack
        spacing={20}
        padding={20}
        frame={{ width: 400 }}
        background="#F2F2F7"
      >
        <ComposerCard
          draft="<b>大家好，这是一段测试文字</b>"
          setDraft={() => {}}
          sending={false}
          hintText="已发送到「Swift 交流群」"
          hintTone="ok"
          onWrap={() => {}}
          onLink={() => {}}
          onDate={() => {}}
          onSend={() => {}}
          onClose={() => {}}
          initialFormats
        />
        <ComposerCard
          draft=""
          setDraft={() => {}}
          sending={true}
          hintText=""
          hintTone="info"
          onWrap={() => {}}
          onLink={() => {}}
          onDate={() => {}}
          onSend={() => {}}
          onClose={() => {}}
          initialFormats={false}
        />
      </VStack>
    )
    const img = await ImageRenderer.toUIImage(node, { scale: 2 })
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
