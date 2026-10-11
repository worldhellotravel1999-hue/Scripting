import { translateScreenOverlay, type ScreenOverlayResult } from "./screen-overlay"

let active: Promise<ScreenOverlayResult> | null = null

/**
 * 同一次分享内共享同一份「OCR → 翻译 → 覆盖渲染」工作：
 * 结果页挂载即订阅它（页面立即可见、原图打底 + 加载态），
 * intent 在页面关闭后取同一个 Promise 收尾返回纯文本。
 * 分享扩展宿主对「present 之前长时间重活」不友好（先跑完整条管线
 * 再呈现曾表现为整个扩展无响应），因此工作必须在呈现之后进行。
 */
export function startScreenTranslation(image: UIImage): Promise<ScreenOverlayResult> {
  if (!active) {
    active = translateScreenOverlay(image).catch((reason) => {
      active = null
      throw reason
    })
  }
  return active
}

export function activeScreenTranslation(): Promise<ScreenOverlayResult> | null {
  return active
}
