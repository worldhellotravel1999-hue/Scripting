import { Text, VStack, ZStack } from "scripting"
import { AppRavenCollectionsPage } from "./views/appraven-collections"

export default function PreviewLoginV3() {
  return (
    <ZStack frame={{ width: 390, height: 560 }}>
      {/* 模拟分享页底色：验证登录页完全透明能看到底下内容 */}
      <VStack spacing={8} frame={{ width: 390, height: 560 }} padding={{ top: 120 }} background={{ light: "#FFF3E0", dark: "#1A1A2E" }}>
        <Text font="body" padding={{ horizontal: 24 }}>这是 App Store 分享页的翻译文字，应该能透过登录页看到</Text>
        <Text font="caption" foregroundStyle="secondaryLabel" padding={{ horizontal: 24 }}>Translated release notes text behind the sheet</Text>
      </VStack>
      <AppRavenCollectionsPage appid="123456789" appTitle="Preview App" onClose={() => {}} />
    </ZStack>
  )
}
