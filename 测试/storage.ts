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
  const allowed = models.length ? new Set(models.map(model => model.key)) : null
  try {
    if (allowed) {
      const clean: History = {}
      for (const [key, list] of Object.entries(history)) if (allowed.has(key)) clean[key] = list
      Storage.set("scoreHistMap", clean)
    } else {
      Storage.set("scoreHistMap", history)
    }
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
    // 只保留当前仍在 Scripting 配置里的模型：已删除的模型连同它的分数一起消失，
    // 避免旧条目越积越多（以及日后同名重建时看到上一轮的历史）。
    if (allowed) {
      for (const key of [...merged.keys()]) if (!allowed.has(key)) merged.delete(key)
    }
    Storage.set("lastSpeedResult", [...merged.values()])
  } catch (_) {
    // 本地存储暂时不可用时，内存中的结果仍然继续显示。
  }
}

export function readSideBySide(): boolean {
  try {
    return Storage.get<boolean>("sideBySide") === true
  } catch (_) { return false }
}

/**
 * 清掉已不在配置里的模型的旧记录：删掉的模型不应该留下分数，
 * 也不应该在日后同名重建时把上一轮的红/绿状态带回来。
 * 模型清单为空时不动（可能是宿主还没读出来）。
 */
export function pruneRecords(models: Model[]): void {
  if (!models.length) return
  const allowed = new Set(models.map(model => model.key))
  try {
    const history = Storage.get<History>("scoreHistMap")
    if (history && typeof history === "object" && !Array.isArray(history)) {
      const kept: History = {}
      let dropped = 0
      for (const [key, list] of Object.entries(history)) {
        if (allowed.has(key)) kept[key] = list
        else dropped++
      }
      if (dropped) Storage.set("scoreHistMap", kept)
    }
  } catch (_) {
    // 清理失败不影响页面，旧记录依旧不会渲染。
  }
  try {
    const saved = Storage.get<any[]>("lastSpeedResult")
    if (Array.isArray(saved)) {
      const kept = saved.filter(item => item && typeof item === "object" && allowed.has(modelKey(item.builtin === true, item.group, item.model)))
      if (kept.length !== saved.length) Storage.set("lastSpeedResult", kept)
    }
  } catch (_) {
    // 同上。
  }
}

export function saveSideBySide(value: boolean): void {
  try {
    Storage.set("sideBySide", value)
  } catch (_) {
    // 布局偏好写入失败不影响本次切换，只是下次打开回到默认单列。
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
