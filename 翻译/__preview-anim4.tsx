import { HStack, ScrollView, Text, VStack } from "scripting"
import { AnimText } from "./views/anim-text"

export default function Preview() {
  return (
    <ScrollView>
      <VStack spacing={20} padding={16} alignment="leading">
        <Text>单个 AnimText：</Text>
        <AnimText font="title3" fontWeight="semibold" anim="interpolate" dur={0.35}>中文（简体）</AnimText>
        <Text>第二个 AnimText：</Text>
        <AnimText font="title3" fontWeight="semibold" anim="interpolate" dur={0.35}>英语</AnimText>
        <Text>HStack 中的 AnimText：</Text>
        <HStack spacing={8}>
          <AnimText font="title3" fontWeight="semibold" anim="interpolate" dur={0.35}>日语</AnimText>
          <Text>右侧</Text>
        </HStack>
        <Text>正文 AnimText：</Text>
        <AnimText anim="interpolate" dur={0.4} lineSpacing={4}>敏捷的棕色狐狸跃过懒狗。</AnimText>
      </VStack>
    </ScrollView>
  )
}
