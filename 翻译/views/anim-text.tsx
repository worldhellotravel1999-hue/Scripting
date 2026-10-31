import type { ContentTransition, TextProps } from "scripting"
import { Text, useEffect, useState } from "scripting"

/**
 * AnimText — 带内容过渡动画的文本（取自 IPA-Tool-3.0）。
 * 挂载后文本从空值平滑浮现；内容变化时按 anim 指定的方式过渡。
 */
export function AnimText({
  children,
  anim = "numericText",
  dur = 0.3,
  ...textProps
}: TextProps & {
  children: Extract<TextProps, { children: any }>["children"]
  anim?: ContentTransition
  dur?: number
}) {
  const [show, setShow] = useState(false)
  const context = (Array.isArray(children) ? children : [children]).join("").trim()
  useEffect(() => {
    setShow(true)
  }, [])

  // 不用 useMemo：依赖数组无法安全覆盖 rest props 的所有字段，
  // 漏项会导致样式 prop 变化时仍渲染旧元素（曾只追踪 foregroundStyle）。
  return (
    <Text
      {...textProps}
      contentTransition={anim}
      animation={{ animation: Animation.smooth({ duration: dur }), value: show ? context : "" }}
    >
      {show ? context : ""}
    </Text>
  )
}
