import { Script } from "scripting"
import { PAGE_MODULES, moveModuleOrder, normalizeModuleOrder, visibleModuleOrder } from "../utils/module_order"
import type { PageModuleID } from "../utils/module_order"

const original: PageModuleID[] = [...PAGE_MODULES]
const manual = original.filter(id => id !== "media" && id !== "ai")
const failures: string[] = []
let passed = 0
function check(name: string, condition: boolean) {
  if (condition) passed++
  else failures.push(name)
}
function equal(a: readonly string[], b: readonly string[]) { return a.join("|") === b.join("|") }

const normalized = normalizeModuleOrder(["network", "location", "network", "unknown", null, 0])
check("异常顺序去重、过滤并补齐", equal(normalized, ["network", "location", ...original.filter(id => id !== "network" && id !== "location")]))
check("缺失缓存使用默认顺序", equal(normalizeModuleOrder(null), original))
check("从头移至尾", equal(moveModuleOrder(original, original, [0], original.length), [...original.slice(1), original[0]]))
check("从尾移至头", equal(moveModuleOrder(original, original, [original.length - 1], 0), [original[original.length - 1], ...original.slice(0, -1)]))
check("向下跨越目标", equal(moveModuleOrder(original, original, [1], 4), [original[0], original[2], original[3], original[1], ...original.slice(4)]))
check("向上跨越目标", equal(moveModuleOrder(original, original, [3], 1), [original[0], original[3], original[1], original[2], ...original.slice(4)]))
check("同位置不动", equal(moveModuleOrder(original, original, [1], 1), original) && equal(moveModuleOrder(original, original, [1], 2), original))
check("多项保持原相对顺序", equal(moveModuleOrder(original, original, [3, 1], 6), [original[0], original[2], original[4], original[5], original[1], original[3], ...original.slice(6)]))
check("无效位置不移动", equal(moveModuleOrder(original, original, [-1, 0], 2), original) && equal(moveModuleOrder(original, original, [0], 99), original))
const manualMoved = moveModuleOrder(original, manual, [0], manual.length)
check("手动模式隐藏分区保留位置", manualMoved.indexOf("media") === original.indexOf("media") && manualMoved.indexOf("ai") === original.indexOf("ai"))
check("手动模式可见分区顺序正确", equal(manualMoved.filter(id => id !== "media" && id !== "ai"), [...manual.slice(1), manual[0]]))
check("切回当前出口时隐藏分区恢复", equal(normalizeModuleOrder(manualMoved), manualMoved) && manualMoved.length === original.length)
const withoutScores = original.filter(id => id !== "ippure" && id !== "cloudflare")
check("无数据系数从可排序列表移除", equal(visibleModuleOrder(original, false, withoutScores), withoutScores))
check("手动隐藏与缺评分同时生效", equal(visibleModuleOrder(original, true, withoutScores), withoutScores.filter(id => id !== "media" && id !== "ai")))
const hiddenMoved = moveModuleOrder(original, withoutScores, [0], withoutScores.length)
check("缺评分时移动保留两个系数槽位", hiddenMoved.indexOf("ippure") === original.indexOf("ippure") && hiddenMoved.indexOf("cloudflare") === original.indexOf("cloudflare"))
check("重新取得评分按完整保存顺序恢复", equal(visibleModuleOrder(hiddenMoved, false), hiddenMoved))
check("单个系数恢复时另一个仍隐藏", equal(visibleModuleOrder(hiddenMoved, false, [...withoutScores, "ippure"]), hiddenMoved.filter(id => id !== "cloudflare")))
check("不改变输入数组", equal(original, PAGE_MODULES))
// 旧版本存过 "speed" 分区，测速并入网络诊断后应当只丢弃该项，其余顺序不变。
const legacy = ["overview", "network", "speed", "media", "ai", "settings"]
const migrated = normalizeModuleOrder(legacy)
check("旧顺序丢弃已合并的测速分区", !(migrated as string[]).includes("speed"))
check("迁移后保留旧顺序的其余相对位置",
  equal(migrated, [...legacy.filter(id => id !== "speed"), ...original.filter(id => !legacy.includes(id))]))
Script.exit({ passed, failed: failures.length, failures, offline: true })
