import { Script } from "scripting"
import { createSystemTranslationEngine, SystemTranslationWaitError } from "../core/system_engine"

const passed: string[] = []
function assert(value: unknown, message: string) { if (!value) throw new Error(message) }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10))
const request = { sourceText: "Hello", sourceLanguageCode: "auto", targetLanguageCode: "zh-Hans" }
const capture = <T,>(task: Promise<T>) => task.then((value) => ({ value, error: undefined as unknown }), (error: unknown) => ({ value: undefined, error }))
let offset = 0
const realNow = Date.now
Date.now = () => realNow() + offset

async function run() {
  let options: any
  const immediate = createSystemTranslationEngine({
    translate: async (value: any) => { options = value; return "你好" },
    translateBatch: async (value: any) => { options = value; return value.texts.map(() => "译文") },
  } as Translation)
  assert((await immediate.translate(request)).translatedText === "你好", "single")
  assert(!("source" in options) && options.target === "zh", "language options")
  assert((await immediate.translateBatch(request, ["a", "b"])).translatedText === "译文译文", "batch order")
  passed.push("单句/批量输出及自动源语言")

  const active = deferred<string[]>()
  let calls = 0
  const slow = createSystemTranslationEngine({ translateBatch: () => { calls++; return active.promise } } as unknown as Translation)
  const first = capture(slow.translateBatch(request, ["a"]))
  let cancelled = false
  const removed = capture(immediate.translateBatch({ ...request, isCancelled: () => cancelled }, ["b"]))
  const last = capture(immediate.translateBatch(request, ["c"]))
  cancelled = true
  active.resolve(["完成"])
  assert((await first).value?.translatedText === "完成", "first result")
  assert((await removed).error instanceof Error, "cancel rejected")
  assert((await last).value?.translatedText === "译文", "wake passed to live waiter")
  passed.push("取消等待者不吞掉后续唤醒")

  const hanging = deferred<string[]>()
  let nativeCalls = 0
  const blocked = createSystemTranslationEngine({ translateBatch: () => { nativeCalls++; return hanging.promise } } as unknown as Translation)
  const timed = capture(blocked.translateBatch(request, ["a"]))
  const queued = capture(blocked.translateBatch(request, ["b"]))
  offset += 121_000
  assert((await timed).error instanceof SystemTranslationWaitError, "native timeout")
  assert((await queued).error instanceof SystemTranslationWaitError, "queue timeout")
  assert(nativeCalls === 1, "timeout must retain native lock")
  passed.push("原生/排队超时都有明确错误且未重叠调用")
  const following = capture(immediate.translateBatch(request, ["c"]))
  await tick()
  hanging.resolve(["迟到译文"])
  assert((await following).value?.translatedText === "译文", "recover after actual native completion")
  assert(nativeCalls === 1, "expired waiter did not run")
  passed.push("迟到结果释放原生锁，过期队列不再执行")

  const cancelledNative = deferred<string[]>()
  let ownerRemoved = false
  const owned = createSystemTranslationEngine({ translateBatch: () => cancelledNative.promise } as unknown as Translation)
  const ownedTask = capture(owned.translateBatch({ ...request, isCancelled: () => ownerRemoved }, ["a"]))
  ownerRemoved = true
  assert((await ownedTask).error instanceof SystemTranslationWaitError, "active cancellation")
  const afterRemoval = capture(immediate.translateBatch(request, ["b"]))
  cancelledNative.reject(new Error("late native failure"))
  assert((await afterRemoval).value?.translatedText === "译文", "late rejection releases lock")
  passed.push("删除运行中任务与迟到失败均不阻断后续任务")

  const invalid = createSystemTranslationEngine({ translateBatch: async () => [] } as unknown as Translation)
  assert((await capture(invalid.translateBatch(request, ["a"]))).error instanceof Error, "partial batch failure")
  assert((await immediate.translate(request)).translatedText === "你好", "failure releases lock")
  passed.push("不完整批量结果报错后仍可继续翻译")
  return passed
}
run().then((result) => {
  Date.now = realNow
  console.log(JSON.stringify({ passed: result }))
  Script.exit({ passed: result })
}, (reason) => {
  Date.now = realNow
  console.log(String(reason))
  Script.exit({ failed: String(reason), passed })
})
