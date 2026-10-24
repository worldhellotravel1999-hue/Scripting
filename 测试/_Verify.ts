// 离线回归检查：不联网、不发任何请求，只验证纯函数行为与 README 声明一致。
// 运行：scripting-ts run _Verify.ts（末尾汇总打印 FAIL 数量，全部通过才输出“全部通过”）。
import { Script } from "scripting"
import { replyVerdict } from "./probe"
import { identifyBrand } from "./brands"
import { configuredTargets, flattenModels, parseProviderInfos } from "./providers"
import { addSample, latencyBase, rewardTopThree, scoreOf } from "./scoring"
import { TIMEOUT_MS } from "./types"
import type { History } from "./types"

let failed = 0
let passed = 0
function check(label: string, actual: unknown, expected: unknown) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  if (same) {
    passed++
    console.log(`ok   ${label}`)
  } else {
    failed++
    console.log(`FAIL ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
  }
}
function checkTrue(label: string, condition: boolean) {
  check(label, condition, true)
}

// ── 回复判定：大小写、装饰符、句点；流式只认前缀，完整回复才定案 ──
check("完整 OK", replyVerdict("OK", true), true)
check("OK 带句点", replyVerdict("OK.", true), true)
check("OKAY 带引号", replyVerdict('"okay!"', true), true)
check("**OK** 装饰符", replyVerdict("**OK**", true), true)
check("流式阶段继续等", replyVerdict("OK"), null)
check("流式单字母继续等", replyVerdict("O"), null)
check("流式非前缀即失败", replyVerdict("hello"), false)
check("完整错误正文不算成功", replyVerdict("OK but then an error", true), false)
check("空回复不算成功", replyVerdict("", true), false)

// ── 耗时打分 ──
check("1000ms 满档", Math.round(latencyBase(1000)), 90)
check("3000ms 锚点", Math.round(latencyBase(3000)), 90)
checkTrue("4500ms 落在 85—90 之间", latencyBase(4500) > 84.9 && latencyBase(4500) < 90)
checkTrue("耗时单调不增", latencyBase(6000) < latencyBase(5500))
check("超时记 0", latencyBase(TIMEOUT_MS + 1), 0)
check("负数记 0", latencyBase(-5), 0)
check("非有限值记 0", latencyBase(NaN), 0)

// ── scoreOf：失败/超时 0 分、过期仍计分、无记录 null、结果补齐 ──
const now = Date.now()
check("最新失败 0 分", scoreOf("k1", { k1: [{ ok: false, ms: 1200, at: now }] }, now)?.value, 0)
check("超时样本 0 分", scoreOf("k2", { k2: [{ ok: true, ms: TIMEOUT_MS + 1, at: now }] }, now)?.value, 0)
const old = now - 31 * 60 * 1000
const past = scoreOf("k3", { k3: [{ ok: true, ms: 800, at: old }] }, now)
check("过期窗口仍计分", past?.value, 90)
check("过期标记 stale", past?.stale, true)
check("无记录返回 null", scoreOf("none", {}, now), null)
check("缺时间戳旧结果标过期", scoreOf("k4", { k4: [{ ok: true, ms: 1000, at: 0 }] }, now), { value: 90, stale: true, count: 1, ok: true })
check("最新结果可补齐评分输入", scoreOf("k5", {}, now, { ok: true, ms: 500, at: now })?.value, 90)

// ── 样本上限与前三奖励 ──
let history: History = {}
for (let i = 0; i < 12; i++) history = addSample(history, "cap", { ok: true, ms: 100, at: i })
check("每模型只留 10 个样本", history.cap?.length, 10)

const ranked = rewardTopThree(
  {
    a: [{ ok: true, ms: 100, at: 5 }],
    b: [{ ok: true, ms: 200, at: 5 }],
    c: [{ ok: true, ms: 300, at: 5 }],
    d: [{ ok: true, ms: 400, at: 5 }],
  },
  [
    { key: "b", ms: 200, at: 5 },
    { key: "d", ms: 400, at: 5 },
    { key: "a", ms: 100, at: 5 },
    { key: "c", ms: 300, at: 5 },
  ],
)
check("第一名加 4 分", ranked.a?.[0]?.rank, 4)
check("第二名加 2.5 分", ranked.b?.[0]?.rank, 2.5)
check("第三名加 1.5 分", ranked.c?.[0]?.rank, 1.5)
check("第四名不加分", ranked.d?.[0]?.rank, undefined)

// ── 厂商识别（含记忆化后的返回值隔离） ──
check("gpt-4o → OpenAI", identifyBrand("gpt-4o").name, "OpenAI")
check("global:glm-5.3-flash → Zhipu AI", identifyBrand("global:glm-5.3-flash").name, "Zhipu AI")
check("global:hy4-preview → Tencent", identifyBrand("global:hy4-preview").name, "Tencent")
check("claude-sonnet-4 → Anthropic", identifyBrand("claude-sonnet-4").name, "Anthropic")
check("meta-llama-3.1 → Meta", identifyBrand("meta-llama-3.1-70b").name, "Meta")
check("llama-3.1-…-nemotron → NVIDIA", identifyBrand("llama-3.1-70b-nemotron").name, "NVIDIA")
check("llama-3.1-…-sonar → Perplexity", identifyBrand("llama-3.1-70b-sonar").name, "Perplexity")
check("未知自定义渠道 → 通用 AI", identifyBrand("mystery-model", "Workbuddy").name, "AI")
check("内置 provider 别名可用", identifyBrand("whatever", "deepseek").name, "DeepSeek")
const mutated = identifyBrand("gpt-4o")
mutated.name = "HACKED"
check("返回拷贝，调用方改不到缓存", identifyBrand("gpt-4o").name, "OpenAI")

// ── 渠道清单：只取 Assistant.getProviders() 的真实账号，删掉即消失 ──
const snapshot = parseProviderInfos([
  { providerID: "p1", name: "KCNE", provider: { custom: "KCNE" }, modelId: "m1", models: { m1: {}, m2: {} } },
  { providerID: "p2", name: "空渠道", provider: { custom: "empty" }, modelId: "", models: {} },
  { providerID: "p3", name: "DeepSeek", provider: "deepseek", modelId: "deepseek-flash", models: { "deepseek-flash": {} } },
  { providerID: "p4", name: "Grok", provider: "grok", modelId: "grok-4.7", models: { "grok-4.7": {} } },
  { providerID: "p5", provider: { custom: "" }, models: { m3: {} } },
  "junk",
  { providerID: "p6", name: "坏渠道", provider: { custom: 7 }, models: { m4: {} } },
])
check("自定义：只收有模型的字符串名渠道", snapshot.custom.map(c => c.name), ["KCNE"])
check("自定义模型清单", snapshot.custom[0]?.models, ["m1", "m2"])
check("内置：按 provider 映射显示名", snapshot.builtin.map(b => b.name), ["DeepSeek", "Grok"])
check("内置：保留 providerID 以便去重", snapshot.builtin[0]?.id, "p3")
check("零模型渠道不显示", snapshot.custom.some(c => c.name === "空渠道"), false)
check("非字符串名/非法 provider 不进清单", snapshot.custom.length + snapshot.builtin.length, 3)
check("空输入安全", parseProviderInfos(null), { custom: [], builtin: [] })

const flattened = flattenModels(snapshot)
check("flatten：自定义在前、key 唯一", flattened.map(m => m.key), [
  "c/KCNE/m1",
  "c/KCNE/m2",
  "b/DeepSeek/deepseek-flash",
  "b/Grok/grok-4.7",
])
check("内置渠道带类型化 provider", flattened.find(m => m.group === "Grok")?.provider, "grok")
check(
  "configuredTargets 只保留当前已配置的",
  configuredTargets(flattened.filter(m => m.group === "KCNE"), flattened).map(m => m.key),
  ["c/KCNE/m1", "c/KCNE/m2"],
)
check(
  "configuredTargets 拦截已删除模型",
  configuredTargets([{ key: "c/gone/x", id: "x", group: "gone", builtin: false, provider: { custom: "gone" } }], flattened),
  [],
)

if (failed) {
  const summary = `${failed} 项离线回归检查失败`
  console.log(summary)
  Script.exit(summary)
} else {
  const summary = `全部离线回归检查通过（${passed} 项）`
  console.log(summary)
  Script.exit(summary)
}
