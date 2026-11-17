import { Widget } from "scripting"

// Storage.set 在后台落盘；合并短时间内的写入，再请求小组件读取。
const RELOAD_DELAY_MS = 300
let timer: ReturnType<typeof setTimeout> | null = null
let pending = false
let completion: Promise<void> | null = null
let finish: (() => void) | null = null

function reload() {
  timer = null
  if (!pending) return
  pending = false
  try { Widget.reloadUserWidgets() }
  catch (error) { console.log("[IP检测] 小组件刷新失败", String(error)) }
  finally {
    const resolve = finish
    finish = null
    completion = null
    resolve?.()
  }
}

export function scheduleWidgetReload() {
  if (!pending) completion = new Promise<void>(resolve => { finish = resolve })
  pending = true
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(reload, RELOAD_DELAY_MS)
}

/** 页面关闭后，脚本退出前等待最后一次写入并请求重载。 */
export async function flushWidgetReload() {
  while (completion) await completion
}
