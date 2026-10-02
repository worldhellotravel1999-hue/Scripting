import { modelKey } from "./types"

const BUILTIN_LABELS: Record<string, string> = {
  "openai.custom.models": "OpenAI",
  "gemini.custom.models": "Gemini",
  "anthropic.custom.models": "Anthropic",
  "deepseek.custom.models": "DeepSeek",
  "openrouter.custom.models": "OpenRouter",
}

// provider 名（如 "deepseek"）与上面清单键的对应关系。
const BUILTIN_PROVIDER_NAMES = Object.keys(BUILTIN_LABELS).map(key => key.split(".")[0])

import type { Model, Provider } from "./types"

type JSONRecord = Record<string, unknown>
function isRecord(value: unknown): value is JSONRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function modelIDs(value: unknown): string[] {
  if (!isRecord(value)) return []
  return Object.keys(value).filter(id => id.trim().length > 0 && isRecord(value[id]))
}

type CustomProvider = { name: string; models: string[] }

export type ProviderSnapshot = {
  custom: CustomProvider[]
  builtin: Array<{ name: string; provider: Provider; models: string[] }>
}

function readJSON(path: string): any | null {
  try {
    if (!FileManager.existsSync(path)) return null
    return JSON.parse(FileManager.readAsStringSync(path))
  } catch (_) {
    return null
  }
}

// 只认用户登记的条目。currentModelId 可能残留已删除模型，不能补进清单。
// 内置渠道必须由用户真正添加（配置了 API key）才出现；只按模型清单猜会把
// 未添加的预置渠道也列进来，用户明确要求“没有添加就不显示”。
export function parseProviders(providerItems: unknown, builtinJSON: unknown, flags: BuiltinFlags = {}): ProviderSnapshot {
  const custom: CustomProvider[] = []
  const builtin: ProviderSnapshot["builtin"] = []
  if (Array.isArray(providerItems)) {
    for (const item of providerItems) {
      if (!isRecord(item) || typeof item.name !== "string" || !item.name.trim()) continue
      const models = modelIDs(item.modelInfos)
      if (models.length) custom.push({ name: item.name, models })
    }
  }
  if (isRecord(builtinJSON) && isRecord(builtinJSON.models)) {
    const seeds = isRecord(builtinJSON.seededBuiltInIDs) ? builtinJSON.seededBuiltInIDs : {}
    for (const [key, name] of Object.entries(BUILTIN_LABELS)) {
      const provider = key.split(".")[0]
      const seeded = Array.isArray(seeds[key]) ? (seeds[key] as unknown[]).filter((id): id is string => typeof id === "string") : []
      const listed = modelIDs(builtinJSON.models[key])
      // 用户直接登记过的模型一律保留；否则必须已配置 API key 才算“已添加”。
      const userAdded = listed.some(id => !seeded.includes(id))
      if (flags[provider] !== true && !userAdded) continue
      // 应用侧清单被清空时（例如 DeepSeek 选过模型后被重置）退回内置目录，
      // 否则已添加的渠道会一个模型都没有、无法参与排名。
      const models = listed.length ? listed : seeded
      if (models.length) builtin.push({ name, provider: provider as Provider, models })
    }
  }
  return { custom, builtin }
}

// ── 内置渠道“是否已配置 API key”探测 ───────────────────────────────
// 用一个必定不存在的 modelId 发起调用：未配置的渠道会在本地直接抛
// “the selected api provider has no configured API key”（实测约 20ms，不联网）；
// 已配置的渠道会走到模型校验，抛“未找到 X 模型”或真正建立请求。
// 两类错误可区分，且未配置渠道零网络开销。
export type BuiltinFlags = Record<string, boolean>

const PROBE_MODEL_ID = "__scripting_builtin_probe__.invalid"
let builtinFlags: BuiltinFlags | null = null
let probing: Promise<BuiltinFlags> | null = null
const flagListeners = new Set<(flags: BuiltinFlags) => void>()

export function builtinFlagsNow(): BuiltinFlags {
  return builtinFlags ?? {}
}

export function onBuiltinFlags(listener: (flags: BuiltinFlags) => void): () => void {
  flagListeners.add(listener)
  if (builtinFlags) listener(builtinFlags)
  return () => flagListeners.delete(listener)
}

async function probeOne(name: string): Promise<boolean> {
  try {
    const stream = await Assistant.requestStreaming({
      provider: name as Provider,
      modelId: PROBE_MODEL_ID,
      messages: [{ role: "user", content: "probe" }],
    })
    // 极少数情况下模型校验放行了：立即取消，不读取任何内容。
    void stream.getReader().cancel().catch(() => {})
    return true
  } catch (error) {
    const message = String((error as Error)?.message ?? "")
    if (!message) return false
    return !/no configured API key/i.test(message)
  }
}

export function probeBuiltinFlags(): Promise<BuiltinFlags> {
  if (builtinFlags) return Promise.resolve(builtinFlags)
  if (probing) return probing
  if (typeof Assistant === "undefined" || typeof Assistant.requestStreaming !== "function") {
    return Promise.resolve(builtinFlags ?? {})
  }
  probing = Promise.all(BUILTIN_PROVIDER_NAMES.map(async name => [name, await probeOne(name)] as const))
    .then(entries => {
      const next: BuiltinFlags = {}
      for (const [name, configured] of entries) next[name] = configured
      builtinFlags = next
      for (const listener of flagListeners) listener(next)
      return next
    })
    .catch(() => builtinFlags ?? {})
    .finally(() => { probing = null })
  return probing
}

export function loadProviders(): ProviderSnapshot {
  if (!FileManager.isiCloudEnabled) return { custom: [], builtin: [] }
  const root = FileManager.iCloudDocumentsDirectory + "/.scripting"
  return parseProviders(
    readJSON(root + "/agent-custom-providers.json"),
    readJSON(root + "/agent-custom-models.json"),
    builtinFlagsNow(),
  )
}

export function flattenModels(snapshot: ProviderSnapshot): Model[] {
  const result: Model[] = []
  for (const group of snapshot.custom) {
    for (const id of group.models) {
      result.push({ key: modelKey(false, group.name, id), id, group: group.name, builtin: false, provider: { custom: group.name } })
    }
  }
  for (const group of snapshot.builtin) {
    for (const id of group.models) {
      result.push({ key: modelKey(true, group.name, id), id, group: group.name, builtin: true, provider: group.provider })
    }
  }
  return [...new Map(result.map(model => [model.key, model])).values()]
}

export function configuredTargets(targets: Model[], configured: Model[]): Model[] {
  const wanted = new Set(targets.map(model => model.key))
  // 返回配置中的规范对象，调用方不能借同一个 key 替换请求 provider/modelId。
  return configured.filter(model => wanted.has(model.key))
}
