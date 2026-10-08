// 临时：内联渲染 ComposerCard（浮层卡片）以截图核对排版
import { VStack } from "scripting"
import { ComposerCard } from "./detail"

export default function ComposerPreview() {
  return (
    <VStack spacing={20} padding={20} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
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
}
