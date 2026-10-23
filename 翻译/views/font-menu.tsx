import { Button, HStack, Image, Menu, Text, VStack, useEffect, useState } from "scripting"
import { FontError, deleteFont, importFont, selectFont, useFontSettings } from "../core/fonts"
import type { FontRole, ImportedFont } from "../core/fonts"
import { safeTimeout } from "../core/guarded"

/*
  顶栏字体入口是三级下钻：

    1. 「Translate」玻璃胶囊
    2. 点开 → 「OT」「TT」「FNT」…「RET」：OT/TT 进该角色的操作行，
       每颗 FNT = 一份已导入字体（只支持长按，长按选应用到 OT 还是 TT）
    3. 点「OT」/「TT」→ 该角色的图标行：返回、文件导入、系统字体

  二级/三级只在点开后占用顶栏位置，不点开就不显示。
  字体动作成功后只从三级退回二级，顶栏不会自动收回「Translate」胶囊；
  只有点二级的「RET」才收起。

  视觉约定：整排一律是同一块中性玻璃 + label 色图标/文字，不用强调色着色；
  按下去的瞬时高亮也关掉（plain），避免出现一块蓝色跟旁边不搭。
*/

// 当前正在执行的字体动作。key 形如 `source:import`、`source:font:<id>`。
let pendingKey: string | null = null
// 同一时间只放行一个动作，防止连点叠加。
let actionPending = false
const pendingSubscribers = new Set<() => void>()

// 动作成功后在三级操作行退回二级字体列表；失败/取消则停在原处便于重试。
// 注意：这里不再把整条顶栏收回「Translate」——选完字体仍要能继续选另一边。
let autoBackToRoles = false
const successSubscribers = new Set<() => void>()

/*
  选中系统字体这类「一瞬就完成」的动作，沙漏会在几十毫秒内消失，看起来像没反应。
  所以每个动作的加载图标至少保留这么久，再结束忙碌状态。
*/
const MIN_BUSY_MS = 450

function notifyPending() {
  for (const subscriber of Array.from(pendingSubscribers)) {
    try { subscriber() } catch {}
  }
}

function setPendingKey(key: string | null) {
  pendingKey = key
  notifyPending()
}

function notifySuccess() {
  for (const subscriber of Array.from(successSubscribers)) {
    try { subscriber() } catch {}
  }
}

/** 订阅「字体动作成功」；返回退订函数。 */
export function onFontActionSucceeded(listener: () => void): () => void {
  successSubscribers.add(listener)
  return () => { successSubscribers.delete(listener) }
}

function scheduleAction(key: string, action: () => void | Promise<unknown>, minBusyMs = MIN_BUSY_MS): void {
  if (actionPending) return
  actionPending = true
  setPendingKey(key)
  safeTimeout(() => {
    void (async () => {
      const startedAt = Date.now()
      let succeeded = false
      try {
        await action()
        succeeded = true
      } catch (error) {
        try {
          await Dialog.alert({
            title: "字体设置失败",
            message: error instanceof FontError ? error.message : "无法完成字体设置，请稍后重试。",
          })
        } catch {
          // Some background hosts cannot alert; still release the action lock.
          console.error("字体设置失败，当前宿主无法显示提示。")
        }
      }
      // 让沙漏图标有机会被看到，再结束忙碌状态（图标不变的动作传 0）。
      const remaining = minBusyMs - (Date.now() - startedAt)
      if (remaining > 0) await new Promise<void>(resolve => setTimeout(resolve, remaining))
      if (succeeded) {
        autoBackToRoles = true
        notifySuccess()
      }
      actionPending = false
      setPendingKey(null)
    })()
  }, 200)
}

/*
  顶栏玻璃圆：直径固定为 42pt，图形按字号绘制后居中放进圆里。
  不再用「图片 frame 24×24 + padding 撑圆」那套——text.line.* 这类宽扁符号的
  描边比方形图标宽，套 24 的框会被缩放/溢出，看上去就跟旁边不对齐了。
*/
const GLASS_DIAMETER = 42

/*
  同一个字号下各个 SF Symbol 的墨迹尺寸差得很多（实测 pointSize=100 时的墨迹比例）：

    chevron.left                      宽 0.48 × 高 0.85
    square.and.arrow.down             宽 0.87 × 高 1.05
    text.line.3.summary               宽 1.11 × 高 0.99
    hourglass                         宽 0.57 × 高 0.90

  同字号下 text.line.3.summary 也偏大，按实测比例单独定字号，把整排视觉大小拉平。
*/
const GLYPH_FONT_SIZE: Record<string, number> = {
  "text.line.3.summary": 18,
  hourglass: 22,
}
const GLYPH_FONT_DEFAULT = 20

/*
  除了字号，符号自带的「图像盒」也不是按墨迹居中的。用 ImageRenderer 把
  42pt 圆里的实际渲染结果渲成位图量过（相对圆心，单位 pt）：

    square.and.arrow.down  顶 -9.67  底 11.67
    text.line.3.summary@18 顶 -5.00  底 13.00（下移 4pt 时）

  所以 text.line.3.summary 底边比旁边的导入图标高，看起来就是“没对齐”。
  这里把它往下推到实底边 14.0，比导入图标低一截。
*/
const GLYPH_OFFSET: Record<string, { x: number; y: number }> = {
  "text.line.3.summary": { x: 0, y: 5.0 },
}

/** 顶栏里的一颗玻璃圆图标。 */
function GlassIcon({ systemName }: { systemName: string }) {
  return (
    <VStack
      frame={{ width: GLASS_DIAMETER, height: GLASS_DIAMETER }}
      glassEffect="circle"
    >
      <Image
        systemName={systemName}
        foregroundStyle="label"
        font={GLYPH_FONT_SIZE[systemName] ?? GLYPH_FONT_DEFAULT}
        offset={GLYPH_OFFSET[systemName] ?? { x: 0, y: 0 }}
      />
    </VStack>
  )
}

/**
 * 顶栏里的一颗文字胶囊，高度与玻璃圆对齐。
 *
 * caption 是可选的第二行小字（只在二级菜单用：OT / TT / FNT / RET 下面跟中文）。
 */
function TextCapsule(
  { label, caption, emphasized = false, pointSize = 17 }: {
    label: string
    caption?: string
    emphasized?: boolean
    pointSize?: number
  },
) {
  return (
    <VStack
      spacing={0}
      frame={{ height: GLASS_DIAMETER }}
      padding={{ horizontal: 12 }}
      glassEffect
    >
      <Text
        font={caption ? pointSize - 2 : pointSize}
        fontWeight={emphasized ? "semibold" : "regular"}
        foregroundStyle="label"
      >
        {label}
      </Text>
      {caption ? (
        <Text font={9} foregroundStyle="secondaryLabel">
          {caption}
        </Text>
      ) : null}
    </VStack>
  )
}

// 顶栏里所有按钮都用 plain：不额外着色，也不在按下时闪一块蓝。
const PLAIN = { buttonStyle: "plain" as const }

/** 把一份已导入字体应用到指定角色；成功后只退回二级，顶栏保持展开。 */
function applyFont(role: FontRole, font: ImportedFont): void {
  scheduleAction(`font:${role}:${font.id}`, () => selectFont(role, font), 0)
}

/**
 * 再次选中已生效的那一边 = 取消：恢复该角色的系统字体。
 * active 由菜单渲染时根据当前设置算好，避免异步读存储。
 */
function toggleFont(role: FontRole, font: ImportedFont, active: boolean): void {
  if (!active) {
    applyFont(role, font)
    return
  }
  scheduleAction(`font:${role}:clear`, () => selectFont(role, null), 0)
}

/** 删除字体（两个角色都会一起解除绑定）。 */
function removeFont(font: ImportedFont): void {
  scheduleAction(`delete:${font.id}`, () => deleteFont("source", font))
}

/**
 * 第三级：一个角色（原文 / 译文）的字体操作行。
 *
 * ← 回第二级；⤓ 文件导入；☷ 系统字体（图标固定，不随执行状态变化）。
 */
export function RoleActions({ role, onBack }: { role: FontRole; onBack: () => void }) {
  const [pending, setPending] = useState(pendingKey)
  useEffect(() => {
    const refresh = () => setPending(pendingKey)
    pendingSubscribers.add(refresh)
    refresh()
    return () => { pendingSubscribers.delete(refresh) }
  }, [])
  const isBusy = (key: string) => pending === key

  const importKey = `${role}:import`
  const systemKey = `${role}:system`
  return (
    <HStack spacing={8}>
      <Button action={onBack} {...PLAIN}>
        <GlassIcon systemName="chevron.left" />
      </Button>
      <Button action={() => scheduleAction(importKey, () => importFont(role))} {...PLAIN}>
        <GlassIcon systemName={isBusy(importKey) ? "hourglass" : "square.and.arrow.down"} />
      </Button>
      <Button action={() => scheduleAction(systemKey, () => selectFont(role, null), 0)} {...PLAIN}>
        <GlassIcon systemName="text.line.3.summary" />
      </Button>
    </HStack>
  )
}

/**
 * 顶栏字体入口。
 *
 * 未展开时是一颗「Translate」玻璃胶囊；点按后胶囊消失，摊出「OT」「TT」
 * 两颗文字胶囊和一颗「RET」收回胶囊；再点「OT」/「TT」进入第三级图标行。
 * 字体动作成功后只从第三级退回二级（OT/TT/FNT 行），方便继续选另一边；
 * 只有点「RET」才收回成胶囊。取消导入或失败则停在原处。
 */
export function TypefaceMenu() {
  const [open, setOpen] = useState(false)
  const [role, setRole] = useState<FontRole | null>(null)
  const settings = useFontSettings()
  useEffect(() => {
    const backToRoles = () => {
      if (!autoBackToRoles) return
      autoBackToRoles = false
      // 只退一级：绝不再把整条顶栏收回「Translate」胶囊。
      setRole(null)
    }
    return onFontActionSucceeded(backToRoles)
  }, [])

  if (!open) {
    return (
      <Button action={() => setOpen(true)} {...PLAIN}>
        <TextCapsule label="Translate" />
      </Button>
    )
  }
  if (role) {
    return <RoleActions role={role} onBack={() => setRole(null)} />
  }
  return (
    <HStack spacing={8}>
      <Button action={() => setRole("source")} {...PLAIN}>
        <TextCapsule label="OT" caption="原文" />
      </Button>
      <Button action={() => setRole("target")} {...PLAIN}>
        <TextCapsule label="TT" caption="译文" />
      </Button>
      {settings.fonts.map(font => {
        // 勾号放在弹出的菜单项里：哪一边正在用这款字体，那一项就打勾。
        const usedBySource = settings.source?.id === font.id
        const usedByTarget = settings.target?.id === font.id
        return (
          <Menu key={font.id} label={<TextCapsule label="FNT" caption="字体" />}>
            <Button
              title={`${font.name} → OT`}
              systemImage={usedBySource ? "checkmark" : "character"}
              action={() => toggleFont("source", font, usedBySource)}
            />
            <Button
              title={`${font.name} → TT`}
              systemImage={usedByTarget ? "checkmark" : "character.bubble"}
              action={() => toggleFont("target", font, usedByTarget)}
            />
            <Button title={`删除「${font.name}」`} systemImage="trash" role="destructive" action={() => removeFont(font)} />
          </Menu>
        )
      })}
      <Button action={() => { setRole(null); setOpen(false) }} {...PLAIN}>
        <TextCapsule label="RET" caption="返回" />
      </Button>
    </HStack>
  )
}
