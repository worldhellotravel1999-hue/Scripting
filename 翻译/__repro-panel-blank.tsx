// 临时复现脚本：搜索页 swap + 价格展开 → 说明面板空白
// 用真实 TranslationCard 组件，定时器自动驱动时序（preview_ui 无法点击交互）
// 0.0s 初始（两面板展开、未 swap、价格收起）
// 1.0s swap 翻转（内容互换）
// 2.5s 价格面板展开（模拟用户点击价格区域）
import { ScrollView, Text, VStack, HStack, useEffect, useState } from "scripting"
import { TranslatedBlock } from "./views/translated-block"
import { MultiRegionCompactList } from "./views/region-prices"

const PANEL_SPRING = Animation.snappy({ duration: 0.42 })
const PANEL_TRANSITION = Transition.asymmetric(
  Transition.opacity().combined(Transition.offset({ x: 0, y: 14 })),
  Transition.opacity().combined(Transition.offset({ x: 0, y: 10 })),
).animation(PANEL_SPRING)

const RELEASE_NOTES = "Version 3.0.1: This update includes stability improvements and performance optimizations. We fixed several crashes reported by users and improved the overall reliability of the app."
const DESCRIPTION = "Things is a delightful and award-winning task manager. It keeps things simple while offering powerful features to help you organize your day, plan your week, and achieve your goals."

type Phase = "initial" | "swapped" | "price-open"

export default function ReproSwapPriceBlank() {
  const [swap, setSwap] = useState(false)
  const [priceOpen, setPriceOpen] = useState(false)
  const [phase, setPhase] = useState<Phase>("initial")
  const [log, setLog] = useState<string[]>(["0.0s 初始：两面板展开，未 swap，价格收起"])

  useEffect(() => {
    const t1 = setTimeout(() => {
      setSwap(true)
      setPhase("swapped")
      setLog((l) => [...l, "1.0s swap 翻转：说明内容互换"])
    }, 1000)
    const t2 = setTimeout(() => {
      setPriceOpen(true)
      setPhase("price-open")
      setLog((l) => [...l, "2.5s 价格面板展开"])
    }, 2500)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [])

  const expansionSignature = `${priceOpen ? 1 : 0}11`
  const layoutSignature = `sel|${expansionSignature}`

  return (
    <ScrollView>
      <VStack alignment="leading" spacing={14} padding={18}
        animation={{ animation: PANEL_SPRING, value: layoutSignature }}>
        <Text font="caption" foregroundStyle="secondaryLabel">阶段：{phase}</Text>
        <HStack spacing={8}>
          <Text font="body" fontWeight="semibold">Things 3</Text>
        </HStack>
        {priceOpen ? (
          <VStack alignment="leading" spacing={10} padding={{ horizontal: 4, vertical: 4 }} frame={{ maxWidth: "infinity", alignment: "leading" as any }} transition={PANEL_TRANSITION}>
            <Text font="caption" foregroundStyle="secondaryLabel">多区价格（人民币换算，点击价格可更换国家）</Text>
            <MultiRegionCompactList appid="1449300761" />
          </VStack>
        ) : null}
        {/* 更新槽（swap 后内容互换） */}
        <VStack alignment="leading" spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
          <VStack alignment="leading" spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" as any }} transition={PANEL_TRANSITION}>
            <TranslatedBlock
              id="repro-release-notes"
              content={swap ? DESCRIPTION : RELEASE_NOTES}
              emptyText="此版本未提供发布说明。"
              translationOnly
              preferSequential
            />
          </VStack>
        </VStack>
        {/* 说明槽（swap 后内容互换） */}
        <VStack alignment="leading" spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
          <VStack alignment="leading" spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" as any }} transition={PANEL_TRANSITION}>
            <TranslatedBlock
              id="repro-description"
              content={swap ? RELEASE_NOTES : DESCRIPTION}
              emptyText="App Store 未提供应用说明。"
              translationOnly
              preferSequential
            />
          </VStack>
        </VStack>
        <VStack alignment="leading" spacing={4} padding={{ top: 12 }}>
          {log.map((line) => <Text key={line} font="caption2" foregroundStyle="tertiaryLabel">{line}</Text>)}
        </VStack>
      </VStack>
    </ScrollView>
  )
}
