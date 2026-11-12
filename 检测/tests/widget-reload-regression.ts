import { Script, Widget } from "scripting"
import { flushWidgetReload, scheduleWidgetReload } from "../utils/widget_reload"

type Timer = ReturnType<typeof setTimeout>
type TimerCallback = Parameters<typeof setTimeout>[0]
const globalTimers = globalThis as unknown as { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout }
const savedSetTimeout = globalTimers.setTimeout
const savedClearTimeout = globalTimers.clearTimeout
const savedReload = Widget.reloadUserWidgets
let clock = 0, nextID = 0
const tasks = new Map<number, { at: number; run: () => void }>()
let reloads = 0
const failures: string[] = []
let passed = 0
const check = (name: string, condition: boolean) => condition ? passed++ : failures.push(name)
const advance = (to: number) => {
  while (true) {
    const next = [...tasks.entries()].filter(([, task]) => task.at <= to).sort((a, b) => a[1].at - b[1].at)[0]
    if (!next) break
    clock = next[1].at
    tasks.delete(next[0])
    next[1].run()
  }
  clock = to
}

async function run() {
  try {
    globalTimers.setTimeout = ((callback: TimerCallback, delay?: number) => {
      const id = ++nextID
      tasks.set(id, { at: clock + (delay || 0), run: () => { if (typeof callback === "function") callback() } })
      return id as unknown as Timer
    }) as typeof setTimeout
    globalTimers.clearTimeout = ((timer: Timer) => { tasks.delete(timer as unknown as number) }) as typeof clearTimeout
    Widget.reloadUserWidgets = () => { reloads++ }
    scheduleWidgetReload()
    let completed = false
    const flush = flushWidgetReload().then(() => { completed = true })
    advance(200)
    scheduleWidgetReload()
    advance(300)
    await Promise.resolve()
    check("新写入延后待处理刷新", reloads === 0 && !completed)
    advance(499)
    await Promise.resolve()
    check("最后一次写入未满延迟不刷新", reloads === 0 && !completed)
    advance(500)
    await flush
    check("合并写入只刷新一次", reloads === 1 && completed)
    await flushWidgetReload()
    check("无待处理操作时立即返回", reloads === 1)
    Widget.reloadUserWidgets = () => { reloads++; throw new Error("模拟失败") }
    scheduleWidgetReload()
    const failedFlush = flushWidgetReload()
    advance(800)
    await failedFlush
    check("刷新抛错也能结束退出等待", reloads === 2)
  } finally {
    globalTimers.setTimeout = savedSetTimeout
    globalTimers.clearTimeout = savedClearTimeout
    Widget.reloadUserWidgets = savedReload
  }
  Script.exit({ passed, failed: failures.length, failures, offline: true })
}
void run().catch(error => {
  globalTimers.setTimeout = savedSetTimeout
  globalTimers.clearTimeout = savedClearTimeout
  Widget.reloadUserWidgets = savedReload
  Script.exit({ failed: 1, failures: [String(error)] })
})
