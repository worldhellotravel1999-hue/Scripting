/**
 * 回调兜底：Scripting 运行时里，`setTimeout` 回调 / 原生事件回调中的**同步**异常
 * 会直接终止整个脚本（2026-10-18 实测：未处理的 Promise 拒绝、microtask 拒绝、
 * async 函数内抛错都只写日志不退出；只有定时器回调里同步抛出会让脚本消失，
 * 界面一起不见）。被 try/catch 包裹的同一异常则完全安全。
 *
 * 本文件把这些「一次异常就整页消失」的回调统一包一层。
 * 注意：catch 分支里绝不能调用 console.error / console.log —— 本运行时里
 * console 失败时会再次抛出，把兜底本身变成新的崩溃点。
 */

/** 包一个同步回调：抛错时静默返回 undefined，不影响后续代码与其它定时器。 */
export function guard<T extends (...args: any[]) => any>(fn: T, _label = "callback"): T {
  const wrapped = ((...args: Parameters<T>) => {
    try {
      return fn(...args)
    } catch {
      return undefined
    }
  }) as T
  return wrapped
}

/**
 * `setTimeout` 的兜底版：回调内同步抛错不再终止脚本。
 * 返回值可直接交给 `clearTimeout`。
 */
export function safeTimeout(handler: () => void, delay?: number): ReturnType<typeof setTimeout> {
  return setTimeout(guard(handler), delay)
}

/**
 * 在定时器 / 原生回调里触发一次动画或滚动：`withAnimation` 同步抛错、
 * 其 body 抛错、返回 Promise 拒绝，任一情况都不外泄。
 */
export function safeAnimate(body: () => void, fallback?: () => void): void {
  try {
    const pending = withAnimation(body)
    if (pending && typeof (pending as Promise<void>).catch === "function") {
      void (pending as Promise<void>).catch(() => {
        if (!fallback) return
        try { fallback() } catch {}
      })
    }
  } catch {
    if (!fallback) return
    try { fallback() } catch {}
  }
}
