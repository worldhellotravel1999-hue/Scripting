import type { History, Model, Results, Sample } from "./types"
import { modelKey } from "./types"

export function readHistory(): History {
  try {
    const value = Storage.get<History>("scoreHistMap")
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    const clean: History = {}
    for (const [key, list] of Object.entries(value)) {
      if (Array.isArray(list)) clean[key] = list.filter((s: Sample) => s && typeof s.ok === "boolean" && Number.isFinite(s.ms) && Number.isFinite(s.at)).slice(0, 10)
    }
    return clean
  } catch (_) { return {} }
}

export function readResults(): Results {
  try {
    const saved = Storage.get<any[]>("lastSpeedResult")
    const results: Results = {}
    if (Array.isArray(saved)) {
      for (const item of saved) {
        if (!item || !["ok", "fail"].includes(item.state) || !Number.isFinite(item.ms)) continue
        results[modelKey(item.builtin === true, item.group, item.model)] = {
          ok: item.state === "ok", ms: item.ms, at: Number(item.at) || 0,
        }
      }
    }
    return results
  } catch (_) { return {} }
}

export function saveRecords(models: Model[], history: History, results: Results): void {
  try {
    Storage.set("scoreHistMap", history)
  } catch (_) {
    // 记录写入失败不应中断当前检测或结果揭晓。
  }
  try {
    const previous = Storage.get<any[]>("lastSpeedResult")
    const merged = new Map<string, any>()
    if (Array.isArray(previous)) {
      for (const item of previous) {
        if (!item || typeof item !== "object") continue
        merged.set(modelKey(item.builtin === true, item.group, item.model), item)
      }
    }
    for (const model of models) {
      const result = results[model.key]
      if (!result) continue
      merged.set(model.key, {
        builtin: model.builtin, group: model.group, model: model.id,
        state: result.ok ? "ok" : "fail", ms: result.ms, at: result.at,
      })
    }
    Storage.set("lastSpeedResult", [...merged.values()])
  } catch (_) {
    // 本地存储暂时不可用时，内存中的结果仍然继续显示。
  }
}

export function removeTranslationPreference(): void {
  try {
    Storage.remove("translateEngine")
    const saved = Storage.get<any[]>("lastSpeedResult")
    if (Array.isArray(saved) && saved.some(item => item && typeof item === "object" && "translated" in item)) {
      Storage.set("lastSpeedResult", saved.map(item => {
        if (!item || typeof item !== "object") return item
        const { translated: removed, ...result } = item
        return result
      }))
    }
  } catch (_) {
    // 旧缓存暂时不可访问也允许打开页面。
  }
}
