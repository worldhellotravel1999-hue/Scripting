import { ScrollView, Text, VStack } from "scripting"
import { AnimText } from "./views/anim-text"

const CHINESE = "敏捷的棕色狐狸跃过懒狗。这句话用来展示系统翻译卡片中语言标题与正文之间的间距。"
const ENGLISH = "The quick brown fox jumps over the lazy dog. This sentence demonstrates spacing."

export default function Preview() {
  return (
    <ScrollView>
      <VStack spacing={24} padding={16} alignment="leading">
        <VStack spacing={12} alignment="leading">
          <AnimText font="title3" fontWeight="semibold" anim="interpolate" dur={0.35}>
            中文（简体）
          </AnimText>
          <Text font="body" lineSpacing={4} textSelection>{CHINESE}</Text>
        </VStack>
        <VStack spacing={12} alignment="leading">
          <Text font="title3" fontWeight="semibold">英语</Text>
          <Text font="body" lineSpacing={4}>{ENGLISH}</Text>
        </VStack>
        <Text>AnimText 结束</Text>
      </VStack>
    </ScrollView>
  )
}
