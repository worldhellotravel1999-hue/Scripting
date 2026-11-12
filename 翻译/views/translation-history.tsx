import {
  Button,
  HStack,
  Image,
  ScrollView,
  useEffect,
  useMemo,
  RoundedRectangle,
  Text,
  VStack,
  useState,
} from "scripting"
import {
  getTranslationHistory,
  removeTranslationHistoryItem,
  type TranslationHistoryItem,
} from "../core/search-history"
import { AppStoreIcon } from "./app-store"
/** 翻译记录面板：嵌入在搜索框下方，点击记录重新翻译，点叉号单条删除；
 *  全部清空由底部搜索按钮长按完成。 */
/** 少量记录按内容收缩，超过 300pt 时在面板内滚动。 */
const HISTORY_INLINE_MAX = 5
const HISTORY_MAX_HEIGHT = 300

/** 单条记录行：图标 + 名称/开发者·时间 + 删除按钮。 */
function HistoryRow(props: {
  item: TranslationHistoryItem
  index: number
  foregroundStyle: any
  onPick: (item: TranslationHistoryItem) => void
  onRemove: (item: TranslationHistoryItem) => void
}) {
  const item = props.item
  // 面板随父级重渲染时逐行重算 formatTime（内部 new Date ×2~3）；记录数少但
  // 正是清单点名的模式，按行 memo 掉。
  const timeLabel = useMemo(() => formatTime(item.recordedAt), [item.recordedAt])

  return (
    <VStack spacing={0} frame={{ maxWidth: "infinity" }}>
      <HStack
        spacing={12}
        padding={{ horizontal: 10, vertical: 8 }}
        frame={{ maxWidth: "infinity" }}
        contentShape="rect"
        background={<RoundedRectangle fill={{ light: "#F5F5F7", dark: "#2C2C2E" }} cornerRadius={16} />}
        clipShape={{ type: "rect", cornerRadius: 16, style: "continuous" }}
      >
        <HStack
          spacing={12}
          frame={{ maxWidth: "infinity" }}
          contentShape="rect"
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
                {item.artistName || "—"}{` · ${timeLabel}`}
              </Text>
            </VStack>
          </HStack>
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
    </VStack>
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

  useEffect(() => {
    setItems(getTranslationHistory())
  }, [props.historyCount])

  function removeItem(item: TranslationHistoryItem) {
    removeTranslationHistoryItem(item.appid)
    const next = getTranslationHistory()
    setItems(next)
    props.onCountChanged?.(next.length)
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
