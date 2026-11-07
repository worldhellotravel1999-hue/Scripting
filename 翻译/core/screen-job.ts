import { translateScreenOverlay, type ScreenOverlayResult } from "./screen-overlay"

type ActiveScreenJob = {
  promise: Promise<ScreenOverlayResult>
  settled: boolean
  claimed: boolean
}

let active: ActiveScreenJob | null = null

/**
 * 同一次分享内共享一份「OCR → 翻译 → 覆盖渲染」工作：
 * 结果页挂载时认领并订阅 Promise；任务结束后清掉全局引用，避免长期持有大图。
 * intent 保留自己的 Promise，在页面关闭后仍可返回纯文本。
 *
 * 2026-10-19：改成在 **present 的同时**启动（两者并行），不再等页面挂载后
 * 才开工。旧版「先 await 完整管线再 present」会让整个扩展长时间无响应，
 * 那是要求不阻塞首帧；而「不 await 的开始阶段并行」既保住了首帧，
 * 又省掉了分享扩展里 present → 挂载 → useEffect 的整段串行等待，
 * 这才是「主界面 1 秒、分享入口 4~5 秒」的差值来源。
 */
function launchScreenTranslation(image: UIImage): ActiveScreenJob {
  const job: ActiveScreenJob = {
    promise: translateScreenOverlay(image),
    settled: false,
    claimed: false,
  }
  active = job
  void job.promise.then(
    () => finishScreenJob(job),
    () => finishScreenJob(job),
  )
  return job
}

function finishScreenJob(job: ActiveScreenJob) {
  job.settled = true
  if (active === job && job.claimed) active = null
}

/**
 * 主界面「更多（四个点）→ 系统相册」入口专用：无条件开一份新工作。
 * 相册入口必须先 begin 再呈现结果页，让结果页认领这次新工作；新选图始终覆盖
 * 先前尚未被结果页认领的任务。
 */
export function beginScreenTranslation(image: UIImage): Promise<ScreenOverlayResult> {
  return launchScreenTranslation(image).promise
}

export function startScreenTranslation(image: UIImage): Promise<ScreenOverlayResult> {
  const job = active ?? launchScreenTranslation(image)
  job.claimed = true
  if (job.settled && active === job) active = null
  return job.promise
}

/** Release a task when the result view could not be presented or its caller is done. */
export function releaseScreenTranslation(promise: Promise<ScreenOverlayResult>) {
  if (active?.promise === promise) active = null
}
