import { Script } from "scripting"
import { guard, safeTimeout } from "../core/guarded"

/**
 * 回归：锁定 core/guarded 的兜底行为。
 *
 * 背景（2026-10-18 本机实测，Scripting 运行时）：
 * - setTimeout 回调里的**同步**异常若未被捕获，会直接终止整个脚本（界面一起消失）；
 * - 同一异常被 try/catch 捕获后，脚本与后续定时器都照常运行；
 * - 未处理 Promise 拒绝、microtask 拒绝、async 函数内抛错只写日志，不退出。
 * 因此「点一下脚本就退出」的第一嫌疑就是这些裸定时器回调。
 *
 * 注意：本文件自己的断言必须用 throw 之外的方式报告（Script.exit），
 * 否则测试脚本自身抛错会掩盖被测行为。
 */

function assert(value: unknown, message: string) {
  if (!value) throw new Error(message)
}

async function main() {
  const sequence: string[] = []

  // 1) guard：同步抛错被吞掉并返回 undefined，调用方继续执行。
  const throwing = guard((value: string) => {
    sequence.push(`guard:${value}`)
    throw new Error("guard-probe")
  }, "guard-test")
  assert(throwing("a") === undefined, "guard 应吞掉同步异常并返回 undefined")
  assert(sequence.includes("guard:a"), "guard 应先执行原回调")

  // 2) safeTimeout：回调抛错后，后续定时器仍必须执行。
  //    若有人把 safeTimeout 改回裸 setTimeout，整个脚本会在此终止，下面的断言不会到达。
  safeTimeout(() => {
    sequence.push("first")
    throw new Error("timer-probe")
  }, 1)
  safeTimeout(() => { sequence.push("second") }, 40)

  await new Promise<void>((resolve) => setTimeout(resolve, 300))

  assert(sequence.includes("first"), "第一个定时器应执行")
  assert(sequence.includes("second"), "前一个定时器抛错后，后续定时器必须仍然执行")
  console.log("PASS: guarded callbacks keep the script alive")
  Script.exit("PASS")
}

void main().catch((error) => Script.exit(`FAIL: ${String(error)}`))
