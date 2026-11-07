// 临时验证：详情页「同步消息」行的行内临时提示（同步进行中显示
// 「同步「群名」…」hint + 转圈，结束后换成结果提示）——ImageRenderer 出图落盘判读。
import { ImageRenderer, ProgressView, Script, VStack } from "scripting"
import { SettingsRow } from "./components"

const OUT =
  "/private/var/mobile/Containers/Shared/AppGroup/4738D233-4544-420D-B861-DB1DE0563BBC/.tg-hub/_shot_sync.png"

async function main() {
  try {
    const node = (
      <VStack spacing={10} padding={16} frame={{ width: 340 }} background="#F2F2F7">
        {/* 同步进行中：行内 hint = 「同步「大自自自白」…」+ 转圈 */}
        <SettingsRow
          icon="arrow.triangle.2.circlepath"
          color="#34C759"
          chevron={false}
          title="同步中…"
          hint="同步「大自自自白」…"
          hintTone="info"
          hintMax={120}
          trailing={<ProgressView />}
        />
        {/* 同步结束：结果提示 5 秒 */}
        <SettingsRow
          icon="arrow.triangle.2.circlepath"
          color="#34C759"
          chevron={false}
          title="同步消息"
          hint="新增 1,204 条"
          hintTone="ok"
        />
        {/* 很长的群名（hint 封顶 150 宽，超长省略） */}
        <SettingsRow
          icon="arrow.triangle.2.circlepath"
          color="#34C759"
          chevron={false}
          title="同步中…"
          hint="同步「一个非常非常非常长的群组名称测试」…"
          hintTone="info"
          hintMax={120}
          trailing={<ProgressView />}
        />
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
