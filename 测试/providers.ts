import { modelKey } from "./types"
import type { Model, Provider } from "./types"

/**
 * 渠道清单的唯一来源：`Assistant.getProviders()`。
 *
 * 为什么不再读 `.scripting/agent-custom-*.json`：
 * 1. 那两个文件是历史镜像，不是应用的实时配置。`agent-custom-models.json` 已经
 *    多日没有更新（仍保留着早就删掉的内置模型与 seededBuiltInIDs），
 *    `agent-custom-providers.json` 里也可能残留被删除 / 被替换的旧渠道。
 *    用户删掉模型、换掉分组后，页面依旧会把这些残留读出来，正是原来的 bug。
 * 2. `getProviders()` 每次调用都返回当前真正可用的账号（providerID / name /
 *    provider / modelId / models），含内置渠道已选的模型，删除即消失。
 * 3. 因此也不再需要用“无效 modelId 探测是否配置了 API key”的旁路判定——
 *    没有添加的渠道根本不会出现在这个列表里。
 */

const BUILTIN_LABELS: Record<string, string> = {
  openai: "OpenAI",
  gemini: "Gemini",
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
  grok: "Grok",
}

type JSONRecord = Record<string, unknown>
function isRecord(value: unknown): value is JSONRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function modelIDs(value: unknown): string[] {
  if (!isRecord(value)) return []
  // 排序保证同一条配置每次读出的清单顺序一致，刷新时才能可靠地判断“没变”。
  return Object.keys(value).filter(id => id.trim().length > 0).sort()
}

export type CustomProvider = { id: string; name: string; models: string[] }
export type BuiltinProvider = { id: string; name: string; provider: Provider; models: string[] }

export type ProviderSnapshot = {
  custom: CustomProvider[]
  builtin: BuiltinProvider[]
}

/** 解析 `Assistant.getProviders()` 的返回值：只认真正配置了模型的账号。 */
export function parseProviderInfos(infos: unknown): ProviderSnapshot {
  const custom: CustomProvider[] = []
  const builtin: BuiltinProvider[] = []
  if (!Array.isArray(infos)) return { custom, builtin }
  for (const item of infos) {
    if (!isRecord(item)) continue
    const id = typeof item.providerID === "string" ? item.providerID : ""
    const rawName = typeof item.name === "string" ? item.name.trim() : ""
    const models = modelIDs(item.models)
    // 没有模型就没什么可测的，空分组只会造成“明明删了还在”的错觉。
    if (!models.length) continue
    const provider = item.provider
    if (typeof provider === "string") {
      const label = BUILTIN_LABELS[provider] ?? rawName
      if (!label) continue
      builtin.push({ id, name: label, provider: provider as Provider, models })
      continue
    }
    if (!isRecord(provider)) continue
    const name = typeof provider.custom === "string" ? provider.custom.trim() : ""
    if (!name) continue
    custom.push({ id, name, models })
  }
  return { custom, builtin }
}

// 上一次成功读取的清单：单次读取失败（例如页面刚起来、宿主还在初始化）时
// 继续显示已有内容，而不是瞬间清空列表。
let lastSnapshot: ProviderSnapshot | null = null

// 只有宿主完全没有 getProviders（旧版本）时才退回读历史镜像，
// 且只用于自定义渠道——内置模型的历史镜像已经过时，宁可少列也不列错。
function readLegacyCustom(): CustomProvider[] {
  try {
    if (!FileManager.isiCloudEnabled) return []
    const path = FileManager.iCloudDocumentsDirectory + "/.scripting/agent-custom-providers.json"
    if (!FileManager.existsSync(path)) return []
    const items = JSON.parse(FileManager.readAsStringSync(path))
    if (!Array.isArray(items)) return []
    const result: CustomProvider[] = []
    for (const item of items) {
      if (!isRecord(item) || typeof item.name !== "string" || !item.name.trim()) continue
      const models = modelIDs(item.modelInfos)
      if (models.length) result.push({ id: typeof item.providerID === "string" ? item.providerID : "", name: item.name, models })
    }
    return result
  } catch (_) {
    return []
  }
}

/**
 * 读取当前已添加的渠道与模型。每次进页面、回到前台、定时刷新、以及每次发起
 * 检测前都会调用，因此删除模型 / 替换分组之后列表会立即跟着变。
 */
export async function loadProviders(): Promise<ProviderSnapshot> {
  if (typeof Assistant !== "undefined" && typeof Assistant.getProviders === "function") {
    try {
      const snapshot = parseProviderInfos(await Assistant.getProviders())
      lastSnapshot = snapshot
      return snapshot
    } catch (_) {
      // 读取失败保留上一次结果；真的没有可用清单时才回退到历史镜像。
      if (lastSnapshot) return lastSnapshot
    }
  }
  const fallback: ProviderSnapshot = { custom: readLegacyCustom(), builtin: [] }
  if (fallback.custom.length) lastSnapshot = fallback
  return fallback
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
