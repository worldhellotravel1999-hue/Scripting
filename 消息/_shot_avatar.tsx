// 临时验证：SettingsRow iconSrc 的圆角裁剪（clipShape rect cornerRadius 12）
// 是否与下方渐变图标块同风格；ImageRenderer 出图落盘后人工判读。
import { ImageRenderer, Script, VStack } from "scripting"
import { SettingsRow } from "./components"

// FileManager / ImageRenderer / Data 是全局命名空间，不从 "scripting" 导出

const AVATAR =
  "/private/var/mobile/Containers/Shared/AppGroup/4738D233-4544-420D-B861-DB1DE0563BBC/.tg-hub/avatars/5864136484271623403.jpg"
const OUT =
  "/private/var/mobile/Containers/Shared/AppGroup/4738D233-4544-420D-B861-DB1DE0563BBC/.tg-hub/_shot_avatar.png"

async function main() {
  try {
    const exists = await FileManager.exists(AVATAR)
    console.log("avatar exists:", exists)
    const node = (
      <VStack
        spacing={10}
        padding={16}
        frame={{ width: 340 }}
        background="#F2F2F7"
      >
        <SettingsRow
          icon="person.crop.circle"
          iconSrc={AVATAR}
          title="Maybe"
          hint="+86 447542578217"
          value="当前"
          chevron={false}
        />
        <SettingsRow
          icon="person.crop.circle"
          color="#2AABEE"
          title="登录状态"
          value="已登录"
          chevron={false}
        />
        <SettingsRow icon="trash" color="#FF3B30" title="清除该群本地记录" danger chevron={false} />
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
