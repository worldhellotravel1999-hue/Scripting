import { HStack, ScrollView, Text, VStack } from "scripting"
import { AnimText } from "./views/anim-text"

const TARGET = "敏捷的棕色狐狸跃过懒狗。这句话用来展示系统翻译卡片中语言标题与正文之间的间距。"

export default function Preview() {
  return (
    <ScrollView>
      <VStack spacing={24} padding={16} alignment="leading">
        <VStack spacing={12} alignment="leading">
          <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
            <HStack spacing={2} frame={{ height: 28, alignment: "leading" as any }}>
              <AnimText font="title3" fontWeight="semibold" anim="interpolate" dur={0.35}>
                中文（简体）
              </AnimText>
            </HStack>
            <Text>喇叭</Text>
          </HStack>
          <Text font="body">{TARGET}</Text>
        </VStack>
        <VStack spacing={12} alignment="leading">
          <HStack spacing={2} frame={{ height: 28, alignment: "leading" as any }}>
            <Text font="title3" fontWeight="semibold">中文（简体）</Text>
          </HStack>
          <Text font="body">{TARGET}</Text>
        </VStack>
      </VStack>
    </ScrollView>
  )
}
