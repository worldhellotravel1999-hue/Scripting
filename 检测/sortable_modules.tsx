import { ReorderableForEach, VStack, useEffect, useObservable, useRef } from "scripting"
import type { VirtualNode } from "scripting"
import { PAGE_MODULES, getModuleOrder, moveModuleOrder, saveModuleOrder, visibleModuleOrder } from "./utils/module_order"
import type { PageModule, PageModuleID } from "./utils/module_order"

export type PageModuleViews = Record<PageModuleID, VirtualNode | null>

/** 保持连续面板；兼容长按排序，避开 iOS 27 原生拖拽 payload 断言。 */
export function SortableModules({ modules, manual, initialOrder, onOrderChange }: {
  modules: PageModuleViews; manual: boolean
  initialOrder?: PageModuleID[]; onOrderChange?: (order: PageModuleID[]) => void
}) {
  const order = useObservable(() => initialOrder || getModuleOrder())
  const active = useObservable<PageModule | null>(null)
  const available = PAGE_MODULES.filter(id => modules[id] != null)
  // 同一轮渲染就移除空分区，不等待 effect 才同步另一份列表。
  const shown = visibleModuleOrder(order.value, manual, available)
  const items: PageModule[] = shown.map(id => ({ id }))
  const visibility = `${manual}|${available.join("|")}`
  // 提交后才能代表“当前布局”；渲染期赋值会让守卫恒等，永远拦不住旧拖拽会话。
  const committedVisibility = useRef(visibility)

  // 只依赖可用项签名，避免内容更新或排序本身重置拖拽。
  useEffect(() => {
    committedVisibility.current = visibility
    active.setValue(null)
  }, [visibility])

  function commit(next: PageModuleID[]) {
    if (next.every((id, index) => id === order.value[index])) return
    // 可见项由完整顺序推导；隐藏项始终保留原存储槽位。
    order.setValue(next)
    if (onOrderChange) onOrderChange(next)
    else if (!saveModuleOrder(next)) console.log("[IP检测] 分区顺序未能保存")
  }

  function move(indices: number[], newOffset: number) {
    // 可见集合刚改变时，拒绝旧拖拽会话按旧索引提交。
    if (visibility !== committedVisibility.current) return
    commit(moveModuleOrder(order.value, shown, indices, newOffset))
  }
  function build(item: PageModule) {
    return <VStack key={item.id} spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      {modules[item.id]}
    </VStack>
  }

  return <VStack spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }}
    animation={{ animation: Animation.snappy({ duration: 0.22 }), value: order.value.join("|") }}>
    <ReorderableForEach active={active} data={items} onMove={move} builder={build} />
  </VStack>
}
