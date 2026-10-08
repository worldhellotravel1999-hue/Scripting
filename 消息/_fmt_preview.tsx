// 临时：单独渲染格式面板的小号 chip（RowButton small）验证尺寸
import { HStack, VStack, Text } from "scripting"
import { RowButton } from "./components"

const ROW_1 = ["引用", "遮罩", "粗体", "斜体"]
const ROW_1B = ["等宽"]
const ROW_2 = ["删除线", "下划线", "代码"]
const noop = () => {}

export default function FmtPreview() {
  return (
    <VStack
      alignment="leading"
      spacing={6}
      padding={16}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
    >
      <Text font="caption" foregroundStyle="#8E8E93">
        格式面板（小号 chip）
      </Text>
      <HStack spacing={6}>
        {ROW_1.map(f => (
          <RowButton key={f} small title={f} action={noop} />
        ))}
      </HStack>
      <HStack spacing={6}>
        {ROW_1B.map(f => (
          <RowButton key={f} small title={f} action={noop} />
        ))}
        <RowButton small title="链接" action={noop} />
        <RowButton small title="日期" action={noop} />
      </HStack>
      <HStack spacing={6}>
        {ROW_2.map(f => (
          <RowButton key={f} small title={f} action={noop} />
        ))}
      </HStack>
    </VStack>
  )
}
