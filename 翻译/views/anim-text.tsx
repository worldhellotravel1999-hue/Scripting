import type { ContentTransition, TextProps } from "scripting"
import { Text, useEffect, useMemo, useState } from "scripting"

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
  const context = (children as unknown as string[]).join("").trim()
  useEffect(() => {
    setShow(true)
  }, [])

  return useMemo(
    () => (
      <Text
        {...textProps}
        contentTransition={anim}
        animation={{ animation: Animation.smooth({ duration: dur }), value: show ? context : "" }}
      >
        {show ? context : ""}
      </Text>
    ),
    [show, context, dur, (textProps as { foregroundStyle?: unknown }).foregroundStyle],
  )
}
