export const PAGE_MODULES = [
  "overview", "location", "attributes", "ippure", "cloudflare", "proxycheck",
  "leak", "network", "media", "ai", "settings",
] as const

export type PageModuleID = typeof PAGE_MODULES[number]
export type PageModule = { id: PageModuleID }
const ORDER_KEY = "report-ip.page.module-order.v1"
const known = new Set<string>(PAGE_MODULES)

/** 保留已知分区的相对顺序；忽略损坏项，并在末尾补上以后新增的分区。 */
export function normalizeModuleOrder(value: unknown): PageModuleID[] {
  const saved = Array.isArray(value) ? value : []
  const result: PageModuleID[] = []
  const seen = new Set<string>()
  for (const id of [...saved, ...PAGE_MODULES]) {
    if (typeof id !== "string" || !known.has(id) || seen.has(id)) continue
    seen.add(id)
    result.push(id as PageModuleID)
  }
  return result
}

/** 当前可见集合：用户隐藏模式与数据条件隐藏都不改变完整保存顺序。 */
export function visibleModuleOrder(
  order: readonly PageModuleID[], manual: boolean, available: readonly PageModuleID[] = PAGE_MODULES,
): PageModuleID[] {
  const availableSet = new Set(available)
  return normalizeModuleOrder(order).filter(id => availableSet.has(id)
    && (!manual || (id !== "media" && id !== "ai")))
}

export function getModuleOrder(): PageModuleID[] {
  try {
    const saved = Storage.get<unknown>(ORDER_KEY)
    return normalizeModuleOrder(typeof saved === "string" ? JSON.parse(saved) : saved)
  } catch { return [...PAGE_MODULES] }
}

export function saveModuleOrder(order: readonly PageModuleID[]): boolean {
  try { return Storage.set(ORDER_KEY, normalizeModuleOrder(order)) }
  catch { return false }
}

/** newOffset 是移动前集合的插入位置，向下移动时扣除已移出的前置项。 */
export function moveModuleOrder(
  order: readonly PageModuleID[], visible: readonly PageModuleID[], indices: readonly number[], newOffset: number,
): PageModuleID[] {
  const current = normalizeModuleOrder(order)
  const visibleSet = new Set(visible)
  const shown = current.filter(id => visibleSet.has(id))
  if (!Number.isInteger(newOffset) || newOffset < 0 || newOffset > shown.length) return current
  const sources = [...new Set(indices)].sort((a, b) => a - b)
  if (!sources.length || sources.some(index => !Number.isInteger(index) || index < 0 || index >= shown.length)) {
    return current
  }
  const sourceSet = new Set(sources)
  const moving = sources.map(index => shown[index])
  const remaining = shown.filter((_, index) => !sourceSet.has(index))
  const destination = newOffset - sources.filter(index => index < newOffset).length
  remaining.splice(destination, 0, ...moving)
  let index = 0
  // 手动查询暂时隐藏媒体/AI；拖动可见分区时保留隐藏分区的存储位置。
  return current.map(id => visibleSet.has(id) ? remaining[index++] : id)
}

