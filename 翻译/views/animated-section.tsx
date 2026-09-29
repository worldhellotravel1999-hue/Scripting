import { VStack, useEffect, useState } from "scripting"

/**
 * AnimatedSection — 区块级联入场动画包装。
 * 内容就绪后按 delay 依次淡入 + 上滑，配合 Animation.spring 有轻盈的入场感。
 */
export function AnimatedSection(props: {
  index: number
  children?: any
}) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), 60 + props.index * 90)
    return () => clearTimeout(timer)
  }, [])

  return (
    <VStack
      alignment="leading"
      spacing={0}
      frame={{ maxWidth: "infinity", alignment: "leading" as any }}
      opacity={shown ? 1 : 0}
      offset={{ x: 0, y: shown ? 0 : 18 }}
      animation={{ animation: Animation.spring({ response: 0.5, dampingFraction: 0.85 }), value: shown }}
    >
      {props.children}
    </VStack>
  )
}
