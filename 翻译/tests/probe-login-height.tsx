// 诊断：AppRaven 登录页内容高度 vs 弹窗 detent（固定 420pt，见 app-store.tsx LOGIN_SHEET_DETENT）。
// 历史数据（2026-09-30）：登录表单本体 ~362-374pt（含 1 个已保存账号行时预览实测 ~357pt），
// 旧 detent 0.36 分数折算远小于此 → Cookie 行往下被裁；现已改 ScrollView + 固定 420pt。
// 注意：ImageRenderer 对含 ScrollView 的根节点读数不完全等于内容高度，最终以 preview 截图为准。
// 运行：scripting-ts run tests/probe-login-height.tsx
import { ImageRenderer, Script, Device, VStack } from "scripting"
import { AppRavenCollectionsPage } from "../views/appraven-collections"

async function measure(name: string, element: any, scale = 1) {
  try {
    const img = await ImageRenderer.toUIImage(element, { scale })
    console.log(`${name}@${scale}: width=${img.width} height=${img.height}`)
  } catch (error) {
    console.log(`${name}@${scale}: ERROR ${String(error)}`)
  }
}

async function main() {
  console.log(`screen: ${Device.screen.width}x${Device.screen.height} scale=${Device.screen.scale}`)
  console.log(`detent: 420pt fixed`)

  // 登录页根（未登录态，隔离存储）：固定宽度、放开高度 → 读内容真实高度
  const page = (
    <VStack spacing={0} frame={{ width: 390 }}>
      <AppRavenCollectionsPage appid="123456789" />
    </VStack>
  )
  await measure("loginPage", page, 1)
  await measure("loginPage", page, 3)

  // 校准：ImageRenderer 是否如实反映 spacing/padding
  const calib = (
    <VStack spacing={8} padding={{ horizontal: 0, vertical: 20 }} frame={{ width: 390 }}>
      <VStack frame={{ maxWidth: "infinity", height: 50 }} />
      <VStack frame={{ maxWidth: "infinity", height: 50 }} />
      <VStack frame={{ maxWidth: "infinity", height: 50 }} />
      <VStack frame={{ maxWidth: "infinity", height: 50 }} />
    </VStack>
  )
  await measure("calib(expect 272)", calib, 1)

  Script.exit("probe done")
}

void main()
