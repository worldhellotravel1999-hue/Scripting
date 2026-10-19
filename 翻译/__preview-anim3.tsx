import { HStack, ScrollView, Text, VStack } from "scripting"
import { AnimText } from "./views/anim-text"

const TARGET = "敏捷的棕色狐狸跃过懒狗。"

function Row(props: { label: string; children?: any }) {
  return (
    <VStack spacing={6} alignment="leading">
      <Text font="caption" foregroundStyle="systemRed">{props.label}</Text>
      {props.children}
    </VStack>
  )
}

export default function Preview() {
  return (
    <ScrollView>
      <VStack spacing={20} padding={16} alignment="leading">
        <Row label="A HStack + frame28 + 内层HStack">
          <HStack spacing={8}>
            <HStack spacing={2} frame={{ height: 28, alignment: "leading" as any }}>
              <AnimText font="title3" fontWeight="semibold" anim="interpolate" dur={0.35}>A标题</AnimText>
            </HStack>
            <Text>X</Text>
          </HStack>
        </Row>
        <Row label="B HStack 直接放 AnimText">
          <HStack spacing={8}>
            <AnimText font="title3" fontWeight="semibold" anim="interpolate" dur={0.35}>B标题</AnimText>
            <Text>X</Text>
          </HStack>
        </Row>
        <Row label="C 内层HStack frame28 + 普通Text">
          <HStack spacing={8}>
            <HStack spacing={2} frame={{ height: 28, alignment: "leading" as any }}>
              <Text font="title3" fontWeight="semibold">C标题</Text>
            </HStack>
            <Text>X</Text>
          </HStack>
        </Row>
        <Row label="D AnimText 单独">
          <AnimText font="title3" fontWeight="semibold" anim="interpolate" dur={0.35}>D标题</AnimText>
        </Row>
        <Row label="E AnimText numericText">
          <AnimText font="title3" fontWeight="semibold">E标题</AnimText>
        </Row>
        <Row label="F AnimText interpolate 正文">
          <AnimText anim="interpolate" dur={0.4} lineSpacing={4}>{TARGET}</AnimText>
        </Row>
        <Row label="G 普通 Text 正文">
          <Text font="body" lineSpacing={4}>{TARGET}</Text>
        </Row>
      </VStack>
    </ScrollView>
  )
}
