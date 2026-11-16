import { ScrollView, VStack } from "scripting"
import { SpeedPanel } from "../speed_section"
import { PAGE_BG, SURFACE } from "../theme"

/** 测速面板预览：不发起请求，只呈现待开始／上次结果的静态外观。 */
export default function PreviewSpeed({ kind = "Wi-Fi 接口", dark = false }: { kind?: string; dark?: boolean }) {
  return <ScrollView background={PAGE_BG} preferredColorScheme={dark ? "dark" : "light"}>
    <VStack spacing={0} padding={{ horizontal: 12, top: 12, bottom: 20 }}
      frame={{ maxWidth: 760 }} background={SURFACE}>
      <SpeedPanel kind={kind} />
    </VStack>
  </ScrollView>
}
