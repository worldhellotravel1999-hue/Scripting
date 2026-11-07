import {
  Button,
  Circle,
  HStack,
  Image,
  Rectangle,
  RoundedRectangle,
  Text,
  VStack,
  ZStack,
} from "scripting"
import { ACCENT } from "./components"
import { rowIconAssetPath } from "./rowicons"

/**
 * 自绘底部标签栏（替代系统 TabView 的标签栏）。
 *
 * 2026-10-12 改版诉求：四个按钮**缩小**、外面套**透明圆环**、图标换成**贴合本 UI 的
 * 新图标**——系统 TabView 的标签栏尺寸/样式完全不可定制，故整条栏自绘：
 *  · 结构：顶部分隔细线 + 四等分按钮（透明圆环 + 彩色图标 + 文字）；
 *  · 圆环：fill="clear"（纯透明）+ 描边，选中态描边/文字用 Telegram 蓝 ACCENT，
 *    未选中用中性灰；描边宽度用 strokeStyle 指定；
 *  · 图标：沿用本 UI 各行在用的彩色素材（assets/rowicons/*.png），
 *    与设置行/详情行的图标语言一致，比系统单色 SF Symbol 更“本 UI”；
 *  · 底部 padding 20：根视图 ignoresSafeArea 后子视图拿不到 home indicator 的
 *    safe area（实测 insets 全 0），这条留白是自己给的，保证圆环不压小黑条。
 *
 * 定位靠父级的 `safeAreaInset.bottom` 挂载（见 view.tsx）：
 * 内容区高度会自动扣掉本栏高度，等价原生标签栏的占位行为。
 *
 * 收起特效（2026-10-12 移植自 Vesper 的 tabBarMinimizeBehavior="onScrollDown"）：
 * 各页 List 下滑浏览时通过 p.onListScroll 上报偏移（view.tsx 判定方向），本栏
 * 交叉淡出为一枚悬浮白胶囊（只留圆环图标）并把整栏底色转透明。两态常驻同层、
 * 容器高度恒定（= 展开态高度）——纯视觉特效，内容区占位与展开态排版零变化。
 * 恢复条件与原生一致：滑回列表顶端，或切换页签。
 */

export type TabKey = "chats" | "tools" | "account" | "settings"

/** 四个页签：key = TabView 时代的 value，icon = assets/rowicons 素材 key */
const ITEMS: { key: TabKey; label: string; icon: string }[] = [
  { key: "chats", label: "会话", icon: "chat" },
  { key: "tools", label: "工具", icon: "toolbox" },
  { key: "account", label: "账号", icon: "person" },
  { key: "settings", label: "设置", icon: "gear" },
]

const RING = 28 // 圆环直径（系统标签栏图标约 25pt，这里图标+环整体更小巧）
const ICON = 20 // 图标渲染尺寸（素材自带留白，视觉约 17~18pt）
const RING_OFF = "#D8DBE1" // 未选中描边
const LABEL_OFF = "#8E8E93" // 未选中文字（与全站次级文字同色）

/**
 * 页签常驻挂载容器（等价原生 TabView 的状态保活）：
 * 非当前页 opacity 0 + 关命中测试 + 压到下层，切页不丢各页内部状态。
 */
export function TabPane({ active, children }: { active: boolean; children: any }) {
  return (
    <ZStack
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      opacity={active ? 1 : 0}
      allowsHitTesting={active}
      zIndex={active ? 1 : 0}
    >
      {children}
    </ZStack>
  )
}

/** 圆环+彩色图标（展开栏与收起胶囊共用；文字标签只在展开态显示） */
function TabRing({ icon, active }: { icon: string; active: boolean }) {
  const anim = Animation.smooth({ duration: 0.24 })
  const path = rowIconAssetPath("", icon)
  return (
    <ZStack alignment="center" frame={{ width: RING, height: RING }}>
      {/* 透明圆环：fill clear（不填色）+ 描边；选中态换色并微微加粗 */}
      <Circle
        fill="clear"
        stroke={{
          shapeStyle: active ? ACCENT : RING_OFF,
          strokeStyle: { lineWidth: active ? 1.7 : 1.3 },
        }}
        frame={{ width: RING, height: RING }}
        animation={{ animation: anim, value: active }}
      />
      {path !== null ? (
        <Image filePath={path} resizable scaleToFill frame={{ width: ICON, height: ICON }} />
      ) : (
        // 素材缺失兜底：画个圆点，绝不让空 filePath 渲出空白按钮
        <Circle fill={active ? ACCENT : RING_OFF} frame={{ width: 8, height: 8 }} />
      )}
    </ZStack>
  )
}

export function TabBar({
  value,
  onChanged,
  minimized = false,
}: {
  value: string
  onChanged: (key: string) => void
  /** 下滑浏览时收起为悬浮胶囊（各页 List 滚动驱动，见文件头注释） */
  minimized?: boolean
}) {
  const anim = Animation.smooth({ duration: 0.26 })
  return (
    <VStack
      spacing={0}
      frame={{ maxWidth: "infinity" }}
      background={minimized ? "clear" : "#FFFFFF"}
      animation={{ animation: anim, value: minimized }}
    >
      {/* 顶部分隔细线（贴合系统标签栏的 hairline 观感；收起时淡出） */}
      <Rectangle
        fill="#E9EBEF"
        frame={{ maxWidth: "infinity", height: 0.7 }}
        opacity={minimized ? 0 : 1}
      />
      {/* 两态常驻同层交叉淡入淡出：展开态排版与改造前逐像素一致，
          且容器高度恒定（= 展开态高度）——收起是纯视觉特效，零布局跳动 */}
      <ZStack alignment="bottom" frame={{ maxWidth: "infinity" }}>
        {/* 展开态整栏（原样保留；收起时仅淡出、关命中） */}
        <HStack
          alignment="top"
          spacing={0}
          padding={{ horizontal: 6, top: 8, bottom: 20 }}
          frame={{ maxWidth: "infinity" }}
          opacity={minimized ? 0 : 1}
          allowsHitTesting={!minimized}
          animation={{ animation: anim, value: minimized }}
        >
          {ITEMS.map(it => {
            const active = it.key === value
            return (
              <Button
                key={it.key}
                buttonStyle="plain"
                frame={{ maxWidth: "infinity" }}
                action={() => {
                  if (!active) onChanged(it.key)
                }}
              >
                <VStack
                  alignment="center"
                  spacing={3}
                  frame={{ maxWidth: "infinity" }}
                >
                  <TabRing icon={it.icon} active={active} />
                  <Text
                    font={10}
                    fontWeight={active ? "semibold" : "medium"}
                    foregroundStyle={active ? ACCENT : LABEL_OFF}
                    lineLimit={1}
                    animation={{ animation: anim, value: active }}
                  >
                    {it.label}
                  </Text>
                </VStack>
              </Button>
            )
          })}
        </HStack>

        {/* 收起态：悬浮白胶囊（只留圆环图标），上浮悬于 home indicator 之上 */}
        <HStack
          spacing={2}
          padding={{ horizontal: 14, vertical: 9 }}
          background={<RoundedRectangle fill="#FFFFFF" cornerRadius={24} />}
          shadow={{ color: "#B8BCC4", radius: 6, x: 0, y: 3 }}
          offset={{ x: 0, y: -16 }}
          opacity={minimized ? 1 : 0}
          allowsHitTesting={minimized}
          animation={{ animation: anim, value: minimized }}
        >
          {ITEMS.map(it => {
            const active = it.key === value
            return (
              <Button
                key={it.key}
                buttonStyle="plain"
                frame={{ width: 40, height: 36 }}
                action={() => {
                  if (!active) onChanged(it.key)
                }}
              >
                <TabRing icon={it.icon} active={active} />
              </Button>
            )
          })}
        </HStack>
      </ZStack>
    </VStack>
  )
}
