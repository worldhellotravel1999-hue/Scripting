import {
  Button,
  Capsule,
  HStack,
  Image,
  Rectangle,
  Text,
  VStack,
  useEffect,
  useObservable,
  useState,
} from "scripting"
import { FontError, deleteFont, importFont, selectFont, useFontSettings } from "../core/fonts"
import type { FontRole, ImportedFont } from "../core/fonts"
import { safeTimeout } from "../core/guarded"

/*
  顶栏字体入口是三级下钻：

    1. 「Translate」玻璃胶囊
    2. 点开 → 「OT」「TT」「FNT」「RET」：OT/TT 进该角色的操作行，
       FNT 把整排换成横向字体条
    3. 点「OT」/「TT」→ 该角色的图标行：返回、文件导入、系统字体

  二级/三级只在点开后占用顶栏位置，不点开就不显示。
  字体动作成功后只从三级退回二级，顶栏不会自动收回「Translate」胶囊；
  只有点二级的「RET」才收起。

  FNT 不再向下弹浮层：点开后 OT/TT/FNT/RET 整排消失，字体胶囊在同一行
  横向逐颗出现。点开某个字体时其它字体暂时收起，这颗胶囊只加宽显示完整名，
  原文/译文胶囊再依次向右滑出；点角色动作应用，再点当前角色恢复系统字体，
  长按字体胶囊删除。字体条没有返回键：点页面空白处由 home 的透明点击层
  退回 OT/TT/FNT/RET。其余行为保持不变。

  入场动画属于每一级：Translate 点开后的 OT/TT/FNT/RET、角色操作行、
  字体条都用同一套 Reveal 逐颗出现，不再出现「只有 FNT 才有动画」的割裂。

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
function onFontActionSucceeded(listener: () => void): () => void {
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
  FNT 浮层里的字体钮和原文/译文钮都做成和顶栏 FNT 一样的横向胶囊：
  高度 42pt、宽度约 54pt。字体钮收起时只显示末两位汉字，点开后在高度不变
  的前提下把宽度长开，露出完整字体名。
*/
const FONT_PILL_WIDTH = 54

// 浮层按钮在纯色页面上也保留可见的胶囊边界。
const FONT_MENU_CAPSULE = {
  background: {
    style: { light: "rgba(255,255,255,0.88)", dark: "rgba(44,44,46,0.92)" } as const,
    shape: "capsule" as const,
  },
  overlay: {
    alignment: "center" as const,
    content: (
      <Capsule
        stroke={{
          shapeStyle: { light: "rgba(0,0,0,0.12)", dark: "rgba(255,255,255,0.18)" },
          strokeStyle: { lineWidth: 0.5 },
        }}
        allowsHitTesting={false}
      />
    ),
  },
  shadow: { color: "rgba(0,0,0,0.08)" as const, radius: 3, y: 1 },
}

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
 * 标签下可带一行小字中文注释（caption），总高度仍锁在 GLASS_DIAMETER，
 * 顶栏排版不受影响。
 */
// 展开后完整字体名占的内容宽度；左右 12pt 内边距加上后总宽 132。
const EXPANDED_NAME_WIDTH = 108
// 角色按钮从字体胶囊后面滑出来，动作要慢一点、软一点。
const ROLE_SPRING = Animation.spring({ response: 0.52, dampingFraction: 0.8 })
// 胶囊先长开一点，第一颗按钮再出现；第二颗等第一颗基本落定后再出来。
const FIRST_ROLE_DELAY_MS = 130
const ROLE_STAGGER_MS = 200
// 顶栏整排切换的弹簧，以及各级按钮逐颗出现的节奏。
// FNT 字体条、点开后的 OT/TT/FNT/RET、角色操作行都共用这一组参数。
const STRIP_SPRING = Animation.spring({ response: 0.42, dampingFraction: 0.86 })
const STRIP_STAGGER_MS = 70
// 字体胶囊在宽度上长开的动画。
const EXPAND_SPRING = Animation.spring({ response: 0.36, dampingFraction: 0.84 })

/** 收起时胶囊里只放字体名的最后两个字；名称本来就短时原样显示。 */
function shortFontName(name: string): string {
  const chars = Array.from(name.trim())
  return chars.length <= 2 ? chars.join("") : chars.slice(-2).join("")
}

function TextCapsule({ label, caption }: { label: string; caption?: string }) {
  return (
    <VStack
      spacing={0}
      frame={{ height: GLASS_DIAMETER }}
      padding={{ horizontal: 12 }}
      glassEffect
    >
      <Text font={17} foregroundStyle="label">
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

type FontGroup = { name: string; fonts: ImportedFont[] }

/** 同一个名称只保留一行；重复导入的同名字体在显示时合并。 */
function groupFonts(fonts: ImportedFont[]): FontGroup[] {
  const groups = new Map<string, ImportedFont[]>()
  for (const font of fonts) {
    const existing = groups.get(font.name)
    if (existing) existing.push(font)
    else groups.set(font.name, [font])
  }
  return Array.from(groups.entries()).map(([name, items]) => ({ name, fonts: items }))
}

/** 长按删除一个名称下的全部记录，避免留下看不见的同名副本。 */
function removeFontGroup(group: FontGroup): void {
  scheduleAction(`delete:${group.name}`, async () => {
    let lastError: unknown = null
    for (const font of group.fonts) {
      try {
        await deleteFont("source", font)
      } catch (error) {
        lastError = error
      }
    }
    if (lastError) throw lastError
  })
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
      <Reveal delayMs={0}>
        <Button action={onBack} {...PLAIN}>
          <GlassIcon systemName="chevron.left" />
        </Button>
      </Reveal>
      <Reveal delayMs={STRIP_STAGGER_MS}>
        <Button action={() => scheduleAction(importKey, () => importFont(role))} {...PLAIN}>
          <GlassIcon systemName={isBusy(importKey) ? "hourglass" : "square.and.arrow.down"} />
        </Button>
      </Reveal>
      <Reveal delayMs={STRIP_STAGGER_MS * 2}>
        <Button action={() => scheduleAction(systemKey, () => selectFont(role, null), 0)} {...PLAIN}>
          <GlassIcon systemName="text.line.3.summary" />
        </Button>
      </Reveal>
    </HStack>
  )
}

/**
 * 顶栏字体入口。
 *
 * 未展开时是一颗「Translate」玻璃胶囊；点按后胶囊消失，摊出「OT」「TT」
 * 「FNT」「RET」；再点「OT」/「TT」进入第三级图标行。
 * 点「FNT」后整排换成横向字体条（FontStrip）：OT/TT/FNT/RET 消失，
 * 字体胶囊在同一行里逐颗出现，不再向下弹出浮层。
 * 字体动作成功后只从三级退回二级（OT/TT/FNT 行），方便继续选另一边；
 * 只有点「RET」才收回成胶囊。取消导入或失败则停在原处。
 */
export function TypefaceMenu({
  showingFonts,
  onShowingFontsChange,
}: {
  showingFonts: boolean
  onShowingFontsChange: (value: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [role, setRole] = useState<FontRole | null>(null)
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
  if (showingFonts) {
    // 不提供返回键：点页面空白处由 home 的透明点击层退回这一排。
    return <FontStrip />
  }
  if (role) {
    return <RoleActions role={role} onBack={() => setRole(null)} />
  }
  // 与 FNT 字体条同一节奏：点开 Translate 后 OT/TT/FNT/RET 逐颗滑出，
  // 而不是整排瞬间出现。每一级重新挂载时都会重放，返回或退出字体模式
  // 也一样有动画。
  return (
    <HStack spacing={8}>
      <Reveal delayMs={0}>
        <Button
          action={() => {
            setRole("source")
          }}
          {...PLAIN}
        >
          <TextCapsule label="OT" caption="原文" />
        </Button>
      </Reveal>
      <Reveal delayMs={STRIP_STAGGER_MS}>
        <Button
          action={() => {
            setRole("target")
          }}
          {...PLAIN}
        >
          <TextCapsule label="TT" caption="译文" />
        </Button>
      </Reveal>
      <Reveal delayMs={STRIP_STAGGER_MS * 2}>
        <Button
          action={() => {
            try {
              withAnimation(STRIP_SPRING, () => onShowingFontsChange(true))
            } catch {
              onShowingFontsChange(true)
            }
          }}
          {...PLAIN}
        >
          <TextCapsule label="FNT" caption="字体" />
        </Button>
      </Reveal>
      <Reveal delayMs={STRIP_STAGGER_MS * 3}>
        <Button
          action={() => {
            onShowingFontsChange(false)
            setRole(null)
            setOpen(false)
          }}
          {...PLAIN}
        >
          <TextCapsule label="RET" caption="返回" />
        </Button>
      </Reveal>
    </HStack>
  )
}

/**
 * 胶囊按钮里的一张纸：纸面直接写「原文」或「译文」，
 * 下面两道短横当作正文。整张纸随选中状态换成蓝色。
 */
function PaperGlyph({ translated, active }: { translated: boolean; active: boolean }) {
  const ink = active ? "systemBlue" : "label"
  const rule = active ? "systemBlue" : "secondaryLabel"
  return (
    <VStack
      alignment="leading"
      spacing={1.5}
      frame={{ width: 26, height: 28 }}
      padding={{ horizontal: 3, vertical: 3.5 }}
      background={{
        // 纸面比胶囊底更亮一点，像一张压在玻璃上的白纸。
        style: { light: "rgba(255,255,255,0.98)", dark: "rgba(255,255,255,0.16)" } as const,
        shape: { type: "rect", cornerRadius: 3, style: "continuous" },
      }}
      border={{
        style: { light: "rgba(0,0,0,0.20)", dark: "rgba(255,255,255,0.30)" } as const,
        width: 0.8,
      }}
      shadow={{ color: "rgba(0,0,0,0.10)", radius: 1, y: 0.5 }}
    >
      <Text
        font={9.5}
        fontWeight="semibold"
        foregroundStyle={ink}
        lineLimit={1}
        minScaleFactor={0.7}
        allowsTightening
      >
        {translated ? "译文" : "原文"}
      </Text>
      <Rectangle fill={rule} opacity={0.85} frame={{ width: 16, height: 1 }} />
      <Rectangle fill={rule} opacity={0.6} frame={{ width: 11, height: 1 }} />
    </VStack>
  )
}

/** 原文 / 译文各是一颗和顶栏同高的胶囊，里面放一张对应的纸。 */
function RoleAction({
  role,
  active,
  onSelect,
}: {
  role: FontRole
  active: boolean
  onSelect: () => void
}) {
  const translated = role === "target"
  const label = translated ? "译文" : "原文"
  return (
    <Button
      buttonStyle="plain"
      action={onSelect}
      accessibilityLabel={`${label}字体${active ? "，已选中，再次点按恢复系统字体" : "，点按应用"}`}
    >
      <VStack
        alignment="center"
        spacing={0}
        frame={{ width: FONT_PILL_WIDTH, height: GLASS_DIAMETER }}
        glassEffect
        // 与顶栏同高的横向胶囊，内部放一张纸。
        {...FONT_MENU_CAPSULE}
        contentShape="capsule"
      >
        <PaperGlyph translated={translated} active={active} />
      </VStack>
    </Button>
  )
}

/** 挂载后把出场进度推到 1；delayMs 用来让多个元素依次出现。 */
function useRevealProgress(delayMs: number, animation: Animation = ROLE_SPRING): number {
  const progress = useObservable(0)
  useEffect(() => {
    const timer = safeTimeout(() => {
      try {
        const pending = withAnimation(animation, () => { progress.setValue(1) })
        if (pending && typeof (pending as any).catch === "function") void (pending as any).catch(() => {})
      } catch {
        try { progress.setValue(1) } catch {}
      }
    }, delayMs)
    return () => clearTimeout(timer)
  }, [])
  return progress.value
}

/**
 * 顶栏按钮的出场：从左边滑出并放大到正常尺寸。
 * 布局宽度由父级 withAnimation 负责插值，这里只负责透明度和位移，
 * 同一排按钮就能依次出现而不是同时弹出。
 */
function Reveal({ delayMs, children }: { delayMs: number; children: any }) {
  const progress = useRevealProgress(delayMs)
  return (
    <HStack
      spacing={0}
      opacity={progress}
      offset={{ x: -14 * (1 - progress), y: 0 }}
      scaleEffect={{
        x: 0.72 + 0.28 * progress,
        y: 0.72 + 0.28 * progress,
        anchor: { x: 0, y: 0.5 },
      }}
      animation={{ animation: ROLE_SPRING, value: progress }}
    >
      {children}
    </HStack>
  )
}

/**
 * 顶栏横向字体条：点 FNT 后原地替换 OT/TT/FNT/RET 那一排，不再从下方弹浮层。
 * 每颗字体胶囊按 70ms 的间隔依次浮现。点开某个字体时，
 * 其它字体暂时收起，这颗胶囊只加宽显示完整名，原文/译文再依次滑出。
 */
export function FontStrip() {
  const settings = useFontSettings()
  const groups = groupFonts(settings.fonts)
  const [expandedName, setExpandedName] = useState<string | null>(null)

  function toggleExpanded(name: string) {
    const next = expandedName === name ? null : name
    try {
      withAnimation(EXPAND_SPRING, () => setExpandedName(next))
    } catch {
      setExpandedName(next)
    }
  }

  const visibleGroups = expandedName == null
    ? groups
    : groups.filter(group => group.name === expandedName)

  return (
    <HStack spacing={8}>
      {groups.length === 0 ? (
        <Reveal delayMs={0}>
          <TextCapsule label={settings.error ? "读取失败" : "暂无字体"} />
        </Reveal>
      ) : null}
      {visibleGroups.map((group, index) => {
        const usedBySource = settings.source?.name === group.name
        const usedByTarget = settings.target?.name === group.name
        const representative = group.fonts.find(font =>
          font.id === settings.source?.id || font.id === settings.target?.id
        ) ?? group.fonts[0]
        return (
          <Reveal key={group.name} delayMs={index * STRIP_STAGGER_MS}>
            <FontRow
              group={group}
              expanded={expandedName === group.name}
              sourceActive={usedBySource}
              targetActive={usedByTarget}
              onToggle={() => toggleExpanded(group.name)}
              onSource={() => toggleFont("source", representative, usedBySource)}
              onTarget={() => toggleFont("target", representative, usedByTarget)}
            />
          </Reveal>
        )
      })}
    </HStack>
  )
}

/**
 * 一行字体：收起时是一颗写着末两位汉字的短胶囊；点开后只在宽度上长开，
 * 露出完整字体名，原文、译文两颗纸图标胶囊再依次向右滑出。
 */
function FontRow({
  group,
  expanded,
  sourceActive,
  targetActive,
  onToggle,
  onSource,
  onTarget,
}: {
  group: FontGroup
  expanded: boolean
  sourceActive: boolean
  targetActive: boolean
  onToggle: () => void
  onSource: () => void
  onTarget: () => void
}) {
  return (
    <HStack spacing={8} alignment="center">
      <Button
        buttonStyle="plain"
        action={onToggle}
        accessibilityLabel={expanded ? `收起字体「${group.name}」` : `展开字体「${group.name}」`}
      >
        <VStack
          alignment="center"
          spacing={0}
          frame={expanded
            ? { width: EXPANDED_NAME_WIDTH, height: GLASS_DIAMETER }
            : { width: FONT_PILL_WIDTH, height: GLASS_DIAMETER }}
          padding={{ horizontal: expanded ? 12 : 0 }}
          glassEffect
          {...FONT_MENU_CAPSULE}
          contentShape="capsule"
          contextMenu={{
            menuItems: (
              <Button
                title={`删除「${group.name}」`}
                systemImage="trash"
                role="destructive"
                action={() => removeFontGroup(group)}
              />
            ),
          }}
        >
          <Text
            font={16}
            lineLimit={1}
            truncationMode="tail"
            minScaleFactor={0.8}
            allowsTightening
            foregroundStyle="label"
          >
            {expanded ? group.name : shortFontName(group.name)}
          </Text>
        </VStack>
      </Button>
      {expanded ? (
        <>
          <Reveal delayMs={FIRST_ROLE_DELAY_MS}>
            <RoleAction role="source" active={sourceActive} onSelect={onSource} />
          </Reveal>
          <Reveal delayMs={FIRST_ROLE_DELAY_MS + ROLE_STAGGER_MS}>
            <RoleAction role="target" active={targetActive} onSelect={onTarget} />
          </Reveal>
        </>
      ) : null}
    </HStack>
  )
}
