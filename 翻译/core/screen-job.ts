import { translateScreenOverlay, type ScreenOverlayResult } from "./screen-overlay"

let active: Promise<ScreenOverlayResult> | null = null

/**
 * 同一次分享内共享同一份「OCR → 翻译 → 覆盖渲染」工作：
 * 结果页挂载即订阅它（页面立即可见、原图打底 + 加载态），
 * intent 在页面关闭后取同一个 Promise 收尾返回纯文本。
 *
 * 2026-10-19：改成在 **present 的同时**启动（两者并行），不再等页面挂载后
 * 才开工。旧版「先 await 完整管线再 present」会让整个扩展长时间无响应，
 * 那是要求不阻塞首帧；而「不 await 的开始阶段并行」既保住了首帧，
 * 又省掉了分享扩展里 present → 挂载 → useEffect 的整段串行等待，
 * 这才是「主界面 1 秒、分享入口 4~5 秒」的差值来源。
 */
function launchScreenTranslation(image: UIImage): Promise<ScreenOverlayResult> {
  const job = translateScreenOverlay(image).catch((reason) => {
    if (active === job) active = null
    throw reason
  })
  active = job
  return job
}

/**
 * 主界面「更多（四个点）→ 系统相册」入口专用：无条件开一份新工作。
 * 进程常驻的主 App 里 `active` 会残留上一次已完成的任务，若复用
 * startScreenTranslation 会让第二次选图立刻显示上一张的结果，
 * 所以相册入口必须先 begin 再呈现结果页（结果页挂载后拿到的就是这份）。
 */
export function beginScreenTranslation(image: UIImage): Promise<ScreenOverlayResult> {
  return launchScreenTranslation(image)
}

export function startScreenTranslation(image: UIImage): Promise<ScreenOverlayResult> {
  return active ?? launchScreenTranslation(image)
}

export function activeScreenTranslation(): Promise<ScreenOverlayResult> | null {
  return active
}
