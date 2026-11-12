import {
  Button,
  HStack,
  Image,
  ScrollView,
  DragGesture,
  useEffect,
  useMemo,
  RoundedRectangle,
  Text,
  VStack,
  ZStack,
  useState,
  useRef,
} from "scripting"
import {
  clearTranslationHistory,
  getTranslationHistory,
  removeTranslationHistoryItem,
  type TranslationHistoryItem,
} from "../core/search-history"
import { AppStoreIcon } from "./app-store"
import { guard } from "../core/guarded"

/** 翻译记录面板：嵌入在搜索框下方，点击记录重新翻译，点叉号单条删除；
 *  右滑任意记录露出清空历史和记录数量。 */
/** 少量记录按内容收缩，超过 300pt 时在面板内滚动。 */
const HISTORY_INLINE_MAX = 5
const HISTORY_MAX_HEIGHT = 300
const HISTORY_ACTION_REVEAL_WIDTH = 112
const HISTORY_ACTION_CIRCLE_SIZE = 36
const CIRCLE_GRAY_BG = { light: "rgba(142, 142, 147, 0.22)", dark: "rgba(142, 142, 147, 0.28)" } as const

/** 单条记录行：图标 + 名称/开发者·时间 + 删除按钮。 */
function HistoryRow(props: {
  item: TranslationHistoryItem
  index: number
  foregroundStyle: any
  onPick: (item: TranslationHistoryItem) => void
  onRemove: (item: TranslationHistoryItem) => void
  count: number
  onClearAll: () => void
  isOpen: boolean
  onOpenChange: (isOpen: boolean) => void
}) {
  const item = props.item
  // 面板随父级重渲染时逐行重算 formatTime（内部 new Date ×2~3）；记录数少但
  // 正是清单点名的模式，按行 memo 掉。
  const timeLabel = useMemo(() => formatTime(item.recordedAt), [item.recordedAt])
  const ignoreTapsUntil = useRef(0)
  const swipeGesture = DragGesture({ minDistance: 12, coordinateSpace: "global" })
    .onChanged(guard((value) => {
      const dx = value?.translation?.width
      const dy = value?.translation?.height
      if (typeof dx !== "number" || typeof dy !== "number" || !Number.isFinite(dx) || !Number.isFinite(dy)) return
      // Only a clearly horizontal swipe changes the row; vertical drags remain scrolls.
      if (Math.abs(dx) < 32 || Math.abs(dx) <= Math.abs(dy) * 1.5) return
      ignoreTapsUntil.current = Date.now() + 350
      if (dx > 0 && !props.isOpen) props.onOpenChange(true)
      if (dx < 0 && props.isOpen) props.onOpenChange(false)
    }, "history-row-swipe-changed"))
    .onEnded(guard((value) => {
      const dx = value?.translation?.width
      const dy = value?.translation?.height
      if (typeof dx === "number" && typeof dy === "number" && Number.isFinite(dx) && Number.isFinite(dy)
        && Math.abs(dx) >= 32 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        ignoreTapsUntil.current = Date.now() + 350
      }
    }, "history-row-swipe-ended"))
  const canTap = () => Date.now() >= ignoreTapsUntil.current

  return (
    <ZStack
      alignment="leading"
      frame={{ maxWidth: "infinity" }}
      contentShape="rect"
      clipShape={{ type: "rect", cornerRadius: 0 }}
      simultaneousGesture={swipeGesture}
    >
      {props.isOpen ? <HStack
        spacing={10}
        padding={{ horizontal: 10, vertical: 7 }}
        background={{
          style: { light: "rgba(255,255,255,0.85)", dark: "rgba(28,28,30,0.85)" },
          shape: "capsule",
        }}
        shadow={{ color: "rgba(0,0,0,0.12)", radius: 14, y: 4 }}
      >
        <Button buttonStyle="borderless" action={props.onClearAll} help="清空历史记录">
          <Image
            systemName="square"
            foregroundStyle={{ light: "#000000", dark: "#FFFFFF" }}
            font="title3"
            frame={{ width: HISTORY_ACTION_CIRCLE_SIZE, height: HISTORY_ACTION_CIRCLE_SIZE, alignment: "center" as any }}
            background={{ style: CIRCLE_GRAY_BG, shape: "circle" }}
          />
        </Button>
        <ZStack
          frame={{ width: HISTORY_ACTION_CIRCLE_SIZE, height: HISTORY_ACTION_CIRCLE_SIZE, alignment: "center" as any }}
          background={{ style: CIRCLE_GRAY_BG, shape: "circle" }}
          help={`${props.count} 条历史记录`}
        >
          <Image
            systemName="square"
            foregroundStyle={{ light: "#000000", dark: "#FFFFFF" }}
            font="title3"
          />
          <Text
            font={10}
            fontWeight="semibold"
            foregroundStyle={{ light: "#000000", dark: "#FFFFFF" }}
            lineLimit={1}
          >
            {String(props.count)}
          </Text>
        </ZStack>
      </HStack> : null}
      <VStack spacing={0} frame={{ maxWidth: "infinity" }}>
        <HStack
          spacing={12}
          padding={{ horizontal: 10, vertical: 8 }}
          frame={{ maxWidth: "infinity" }}
          contentShape="rect"
          background={<RoundedRectangle fill={{ light: "#F5F5F7", dark: "#2C2C2E" }} cornerRadius={16} />}
          clipShape={{ type: "rect", cornerRadius: 16, style: "continuous" }}
          offset={{ x: props.isOpen ? HISTORY_ACTION_REVEAL_WIDTH : 0, y: 0 }}
          animation={{ animation: Animation.easeOut(0.55), value: props.isOpen }}
        >
          <HStack
            spacing={12}
            frame={{ maxWidth: "infinity" }}
            contentShape="rect"
            onTapGesture={() => { if (canTap()) props.onPick(item) }}
          >
            <AppStoreIcon
              imageUrl={item.artworkUrl}
              size={40}
              foregroundStyle={props.foregroundStyle}
            />
            <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
              <Text font="body" fontWeight="semibold" lineLimit={1}>{item.trackName || "未知应用"}</Text>
              <Text font="caption" foregroundStyle="tertiaryLabel" lineLimit={1}>
                {item.artistName || "—"}{` · ${timeLabel}`}
              </Text>
            </VStack>
          </HStack>
          <Button
            buttonStyle="borderless"
            action={() => { if (canTap()) props.onRemove(item) }}
          >
            <Image
              systemName="xmark.circle.fill"
              foregroundStyle={{ light: "rgba(255,59,48,0.55)", dark: "rgba(255,69,58,0.60)" }}
              font="title3"
            />
          </Button>
        </HStack>
      </VStack>
    </ZStack>
  )
}

export function TranslationHistoryPanel(props: {
  foregroundStyle: any
  historyCount?: number
  /** 点击一条记录：由页面把该应用重新加入已选列表并滚动定位。 */
  onPick: (item: TranslationHistoryItem) => void
  /** 记录数变化（删除/清空）时回传最新条数，供搜索区同步显隐。 */
  onCountChanged?: (count: number) => void
}) {
  const [items, setItems] = useState<TranslationHistoryItem[]>(() => getTranslationHistory())
  const [openRowId, setOpenRowId] = useState<string | null>(null)

  useEffect(() => {
    setItems(getTranslationHistory())
  }, [props.historyCount])

  function removeItem(item: TranslationHistoryItem) {
    removeTranslationHistoryItem(item.appid)
    const next = getTranslationHistory()
    setItems(next)
    setOpenRowId(null)
    props.onCountChanged?.(next.length)
  }

  function clearAll() {
    clearTranslationHistory()
    setItems([])
    setOpenRowId(null)
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
      count={items.length}
      onClearAll={clearAll}
      isOpen={openRowId === item.appid}
      onOpenChange={(isOpen) => setOpenRowId(isOpen ? item.appid : null)}
    />
  )

  return (
    <VStack
      alignment="leading"
      spacing={6}
      frame={{ maxWidth: "infinity", alignment: "leading" as any }}
    >
      {items.length > 0 ? items.length <= HISTORY_INLINE_MAX ? (
        <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
          {items.map(renderRow)}
        </VStack>
      ) : (
        <ScrollView axes="vertical" frame={{ maxWidth: "infinity", height: HISTORY_MAX_HEIGHT }}>
          <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
            {items.map(renderRow)}
          </VStack>
        </ScrollView>
      ) : null}
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
