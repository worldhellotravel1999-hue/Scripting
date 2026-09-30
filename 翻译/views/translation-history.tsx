import {
  Button,
  HStack,
  Image,
  RoundedRectangle,
  ScrollView,
  Spacer,
  Text,
  VStack,
  useState,
} from "scripting"
import {
  clearTranslationHistory,
  getTranslationHistory,
  removeTranslationHistoryItem,
  type TranslationHistoryItem,
} from "../core/search-history"
import { AnimatedSection } from "./animated-section"
import { AppStoreIcon } from "./app-store"

/** 翻译记录面板：列出最近翻译过的应用（最新在前）。
 *  点击记录 → 通过 onPick 重新定位/重选该应用进行翻译；
 *  点「删除」单条移除；底部胶囊工具条：清空（trash）+ 完成（checkmark）。 */
/** 记录不超过该条数时不套内滚容器：列表按内容收缩，底部工具条紧跟最后一条记录，避免卡片下部大片留白割裂（5×56+4×2=288 ≤ 300，行为与旧内滚一致）。 */
const HISTORY_INLINE_MAX = 5

/** 单条记录行：图标 + 名称/开发者·时间 + 删除按钮。 */
function HistoryRow(props: {
  item: TranslationHistoryItem
  index: number
  foregroundStyle: any
  onPick: (item: TranslationHistoryItem) => void
  onRemove: (item: TranslationHistoryItem) => void
}) {
  const item = props.item
  return (
    <AnimatedSection index={props.index}>
      <HStack
        spacing={12}
        padding={{ horizontal: 10, vertical: 8 }}
        frame={{ maxWidth: "infinity" }}
        contentShape="rect"
        background={<RoundedRectangle fill={{ light: "rgba(120,120,128,0.07)", dark: "rgba(120,120,128,0.12)" }} cornerRadius={16} />}
        clipShape={{ type: "rect", cornerRadius: 16, style: "continuous" }}
        onTapGesture={() => props.onPick(item)}
      >
        <AppStoreIcon
          imageUrl={item.artworkUrl}
          size={40}
          foregroundStyle={props.foregroundStyle}
        />
        <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
          <Text font="body" fontWeight="semibold" lineLimit={1}>{item.trackName || "未知应用"}</Text>
          <Text font="caption" foregroundStyle="tertiaryLabel" lineLimit={1}>
            {item.artistName || "—"}{` · ${formatTime(item.recordedAt)}`}
          </Text>
        </VStack>
        <Button
          buttonStyle="borderless"
          action={() => props.onRemove(item)}
        >
          <Image
            systemName="xmark.circle.fill"
            foregroundStyle={{ light: "rgba(255,59,48,0.55)", dark: "rgba(255,69,58,0.60)" }}
            font="title3"
          />
        </Button>
      </HStack>
    </AnimatedSection>
  )
}

export function TranslationHistoryPanel(props: {
  foregroundStyle: any
  /** 点击一条记录：由页面把该应用重新加入已选列表并滚动定位。 */
  onPick: (item: TranslationHistoryItem) => void
  /** 关闭面板（点空白/完成时由页面处理，这里只负责记录操作）。 */
  onRequestClose?: () => void
  /** 记录数变化（删除/清空）时回传最新条数，供页面隐藏记录按钮/收起面板。 */
  onCountChanged?: (count: number) => void
}) {
  const [items, setItems] = useState<TranslationHistoryItem[]>(() => getTranslationHistory())

  function removeItem(item: TranslationHistoryItem) {
    removeTranslationHistoryItem(item.appid)
    const next = getTranslationHistory()
    setItems(next)
    props.onCountChanged?.(next.length)
  }

  function clearAll() {
    clearTranslationHistory()
    setItems([])
    props.onCountChanged?.(0)
  }

  const renderRow = (item: TranslationHistoryItem, index: number) => (
    <HistoryRow
      key={item.appid}
      item={item}
      index={index}
      foregroundStyle={props.foregroundStyle}
      onPick={props.onPick}
      onRemove={removeItem}
    />
  )

  return (
    <VStack
      alignment="leading"
      spacing={12}
      padding={{ horizontal: 18, vertical: 16 }}
      frame={{ maxWidth: "infinity", alignment: "leading" as any }}
      background={<RoundedRectangle fill={{ light: "#FFFFFF", dark: "#1C1C1E" }} cornerRadius={24} />}
      clipShape={{ type: "rect", cornerRadius: 24, style: "continuous" }}
    >
      {items.length === 0 ? null : items.length <= HISTORY_INLINE_MAX ? (
        <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
          {items.map(renderRow)}
        </VStack>
      ) : (
        <ScrollView
          axes="vertical"
          frame={{ maxWidth: "infinity", height: 300 }}
        >
          <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
            {items.map(renderRow)}
          </VStack>
        </ScrollView>
      )}

      {/* 底部胶囊工具条：与主页面底部菜单栏同款（大胶囊缩小 20%，按钮不变），记录数居中夹在两按钮之间 */}
      <HStack spacing={14} padding={{ horizontal: 18, vertical: 13 }} frame={{ maxWidth: "infinity", alignment: "center" as any }}>
        <HStack
          spacing={14}
          padding={{ horizontal: 18, vertical: 13 }}
          background={{
            style: { light: "rgba(255,255,255,0.85)", dark: "rgba(28,28,30,0.85)" },
            shape: "capsule",
          }}
          shadow={{ color: "rgba(0,0,0,0.12)", radius: 14, y: 4 }}
        >
          <Button
            buttonStyle="borderless"
            disabled={items.length === 0}
            action={clearAll}
          >
            <Image
              systemName="xmark"
              font={14}
              foregroundStyle={items.length > 0
                ? { light: "#000000", dark: "#FFFFFF" }
                : { light: "rgba(0,0,0,0.35)", dark: "rgba(255,255,255,0.35)" }}
              frame={{ width: 29, height: 29 }}
              background={{ style: { light: "rgba(142, 142, 147, 0.22)", dark: "rgba(142, 142, 147, 0.28)" }, shape: "circle" }}
            />
          </Button>
          {/* 记录数居中夹在两按钮之间（同款圆形灰底） */}
          <Text
            font="caption"
            fontWeight="semibold"
            foregroundStyle={items.length > 0
              ? { light: "#000000", dark: "#FFFFFF" }
              : { light: "rgba(0,0,0,0.35)", dark: "rgba(255,255,255,0.35)" }}
            frame={{ width: 29, height: 29, alignment: "center" as any }}
            background={{ style: { light: "rgba(142, 142, 147, 0.22)", dark: "rgba(142, 142, 147, 0.28)" }, shape: "circle" }}
          >
            {String(items.length)}
          </Text>
          {props.onRequestClose ? (
            <Button buttonStyle="borderless" action={props.onRequestClose}>
              <Image
                systemName="checkmark"
                font={14}
                foregroundStyle={{ light: "#000000", dark: "#FFFFFF" }}
                frame={{ width: 29, height: 29 }}
                background={{ style: { light: "rgba(142, 142, 147, 0.22)", dark: "rgba(142, 142, 147, 0.28)" }, shape: "circle" }}
              />
            </Button>
          ) : null}
        </HStack>
      </HStack>
    </VStack>
  )
}

function formatTime(ts: number): string {
  if (!ts) return ""
  try {
    const date = new Date(ts)
    const now = new Date()
    const sameDay = date.getFullYear() === now.getFullYear()
      && date.getMonth() === now.getMonth()
      && date.getDate() === now.getDate()
    const pad = (value: number) => String(value).padStart(2, "0")
    const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`
    if (sameDay) return `今天 ${hm}`
    const yesterday = new Date(now.getTime() - 86400000)
    const isYesterday = date.getFullYear() === yesterday.getFullYear()
      && date.getMonth() === yesterday.getMonth()
      && date.getDate() === yesterday.getDate()
    if (isYesterday) return `昨天 ${hm}`
    return `${date.getMonth() + 1}/${date.getDate()}`
  } catch {
    return ""
  }
}
