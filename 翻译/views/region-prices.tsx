import {
  Button,
  HStack,
  Image,
  Menu,
  Picker,
  ProgressView,
  Spacer,
  Text,
  VStack,
  useEffect,
  useState,
} from "scripting"
import {
  PRICE_COLUMN_TITLE_FONT,
  PRICE_ROW_FONT,
  PRICE_ROW_META_FONT,
  PriceHistorySection,
} from "./price-history"
import { prewarmPriceHistory } from "../core/price-history"
import { AnimText } from "./anim-text"
import { GlassBadge } from "./glass-badge"
import {
  DEFAULT_REGION_CODES,
  getRegionPrices,
  REGION_CATALOG,
  type InAppPrice,
  type RegionPrice,
} from "../core/pricing"

const PRICE_REGIONS_KEY = "lingo_price_regions_v1"

/** 搜索与分享页共用上次选择的三个地区，按原行顺序恢复。 */
function readPriceRegions(): string[] {
  try {
    const saved = Storage.get<unknown>(PRICE_REGIONS_KEY, { shared: true })
    if (Array.isArray(saved)
      && saved.length === DEFAULT_REGION_CODES.length
      && saved.every((code) => typeof code === "string"
        && REGION_CATALOG.some((region) => region.code === code))
      && new Set(saved).size === saved.length) {
      return [...saved] as string[]
    }
  } catch {}
  return [...DEFAULT_REGION_CODES]
}

function savePriceRegions(codes: string[]) {
  try {
    Storage.set(PRICE_REGIONS_KEY, codes, { shared: true })
  } catch {}
}

export function PriceRow(props: {
  appid: string
  item: RegionPrice
  regionCodes: string[]
  onChanged: (code: string) => void
  expanded: boolean
  onExpandedChanged: (expanded: boolean) => void
  foregroundStyle?: any
}) {
  const item = props.item
  // 本体价一到就分发启动该地区历史请求，不等下方历史列挂载。
  useEffect(() => {
    if (!item.unavailable && item.formatted !== "" && !item.loading) {
      prewarmPriceHistory(props.appid, item.region)
    }
  }, [props.appid, item.region, item.formatted, item.unavailable, item.loading])
  /** 点击价格/徽章弹出的国家选择菜单（全部国家可选） */
  const regionPicker = (
    <Picker
      title="选择国家或区域"
      value={item.region.toLowerCase()}
      onChanged={props.onChanged}
    >
      {REGION_CATALOG.map((region) => (
        <Text key={region.code} tag={region.code}>{region.name}</Text>
      ))}
    </Picker>
  )
  /** 包住价格区的菜单：点击右侧价格即弹国家列表 */
  const priceMenu = (
    <Menu label={<LocalPrice formatted={item.formatted} cny={item.cny} emphasis foregroundStyle={props.foregroundStyle} />}>
      {regionPicker}
    </Menu>
  )
  const unavailableMenu = (
    <Menu
      label={
        <GlassBadge style="neutral">
          <AnimText font="caption" anim="interpolate">不可用</AnimText>
        </GlassBadge>
      }
    >
      {regionPicker}
    </Menu>
  )
  const inAppSection = (
    <InAppSection
      items={item.inAppPurchases}
      error={item.inAppError}
      loading={item.inAppLoading}
      expanded={props.expanded}
      onExpandedChanged={props.onExpandedChanged}
      foregroundStyle={props.foregroundStyle}
    />
  )

  /** 顶部通栏：左侧地区名、右侧当前价格；两列价格信息在其下并排，左右等宽。 */
  const header = (
    <HStack spacing={10} alignment="firstTextBaseline" frame={{ maxWidth: "infinity", alignment: "leading" }}>
      <Text font={PRICE_ROW_FONT} fontWeight="semibold" foregroundStyle={props.foregroundStyle}>{item.name}</Text>
      <Spacer />
      {item.unavailable || item.formatted === "" ? unavailableMenu : priceMenu}
    </HStack>
  )

  if (item.loading) {
    return (
      <HStack spacing={10} padding={{ vertical: 6 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Text font={PRICE_ROW_FONT} fontWeight="semibold" foregroundStyle={props.foregroundStyle}>{item.name}</Text>
        <Spacer />
        <ProgressView />
      </HStack>
    )
  }

  return (
    <VStack
      alignment="leading"
      spacing={9}
      padding={{ vertical: 6 }}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
      textSelection={false}
    >
      {header}
      <HStack alignment="top" spacing={14} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        {item.unavailable || item.formatted === "" ? null : (
          <PriceHistorySection
            key={`${props.appid}-${item.region}`}
            appid={props.appid}
            regionCode={item.region}
            foregroundStyle={props.foregroundStyle}
          />
        )}
        {inAppSection}
      </HStack>
    </VStack>
  )
}

function LocalPrice(props: { formatted: string; cny: string | null; emphasis?: boolean; foregroundStyle?: any }) {
  const mainFont = PRICE_ROW_FONT
  const mainWeight = props.emphasis ? "semibold" : undefined
  return props.cny ? (
    <VStack alignment="trailing" spacing={2}>
      <AnimText font={mainFont} fontWeight={mainWeight} foregroundStyle={props.foregroundStyle} anim="numericText" dur={0.4}>{props.cny}</AnimText>
      <AnimText font={PRICE_ROW_META_FONT} foregroundStyle={props.foregroundStyle || "secondaryLabel"} anim="numericText" dur={0.45}>{props.formatted}</AnimText>
    </VStack>
  ) : (
    <AnimText font={mainFont} fontWeight={mainWeight} foregroundStyle={props.foregroundStyle} anim="numericText" dur={0.4}>{props.formatted}</AnimText>
  )
}

/** 单条内购：名称一行、人民币价 · 地区货币价一行，与价格历史行字号行距一一对应。 */
function InAppRow(props: { item: InAppPrice; foregroundStyle?: any }) {
  return (
    <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      <Text font={PRICE_ROW_FONT} foregroundStyle={props.foregroundStyle}
        fixedSize={{ horizontal: false, vertical: true }}>{props.item.name}</Text>
      <Text font={PRICE_ROW_META_FONT} foregroundStyle="secondaryLabel" monospacedDigit
        fixedSize={{ horizontal: false, vertical: true }}>
        {props.item.cny ? `${props.item.cny} · ${props.item.formatted}` : props.item.formatted}
      </Text>
    </VStack>
  )
}

/**
 * 内购列：标题与「价格历史」列共用 PRICE_COLUMN_TITLE_FONT，点整行展开，
 * 有内购时才显示折叠箭头；列宽与左列相同，整体左右对齐。
 */
function InAppSection(props: {
  items: InAppPrice[]
  error?: string
  loading?: boolean
  expanded: boolean
  onExpandedChanged: (expanded: boolean) => void
  foregroundStyle?: any
}) {
  const count = props.items.length
  const title = props.loading ? "App 内购买 · 查询中" : props.error ? "App 内购买 · 查询失败" : count
    ? `App 内购买 · ${count}`
    : "App 内购买 · 无"
  const titleText = (
    <Text font={PRICE_COLUMN_TITLE_FONT} fontWeight="medium" foregroundStyle="secondaryLabel">{title}</Text>
  )
  return (
    <VStack alignment="leading" spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      {count ? <Button buttonStyle="plain" action={() => props.onExpandedChanged(!props.expanded)}>
        <HStack spacing={4} alignment="firstTextBaseline">
          {titleText}
          <Image
            systemName={props.expanded ? "chevron.up" : "chevron.down"}
            font={PRICE_ROW_META_FONT}
            foregroundStyle="tertiaryLabel"
            contentTransition="symbolEffect"
            symbolEffect={{ effect: "bounce", value: true }}
          />
        </HStack>
      </Button> : titleText}
      {props.loading ? <ProgressView /> : count ? (props.expanded ? <VStack alignment="leading" spacing={9} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        {props.items.map((item, index) => (
          <InAppRow key={`${item.name}-${index}`} item={item} foregroundStyle={props.foregroundStyle} />
        ))}
      </VStack> : null) : (
        <Text font={PRICE_ROW_META_FONT} foregroundStyle="secondaryLabel" fixedSize={{ horizontal: false, vertical: true }}>
          {props.error || "商店页面未提供内购价格。"}
        </Text>
      )}
    </VStack>
  )
}

/**
 * 内嵌头部卡的价格按钮：显示美区人民币价，
 * 点击展开完整多区价格列表；展开后箭头朝上，再点收起。
 */
export function PriceToggle(props: {
  appid: string
  expanded: boolean
  onToggle: () => void
  foregroundStyle?: any
}) {
  const { prices: loaded } = useRegionPriceList(props.appid, ["us"])
  const prices = loaded ?? undefined

  const primary = prices?.find((item) => item.region.toLowerCase() === "us")
    ?? prices?.[0]

  return (
    <HStack
      spacing={6}
      padding={{ horizontal: 10, vertical: 6 }}
      background={{ style: { light: "rgba(120,120,128,0.12)", dark: "rgba(120,120,128,0.18)" }, shape: "capsule" }}
      clipShape="capsule"
      onTapGesture={props.onToggle}
    >
      <AnimText font="subheadline" fontWeight="semibold" foregroundStyle={props.foregroundStyle} anim="numericText" dur={0.4}>
        {primary?.unavailable || !primary?.cny
          ? (primary?.formatted || "价格")
          : primary.cny}
      </AnimText>
      <Image
        systemName={props.expanded ? "chevron.up" : "chevron.down"}
        font="caption2"
        foregroundStyle={props.foregroundStyle || "secondaryLabel"}
        contentTransition="symbolEffect"
        symbolEffect={{ effect: "bounce", value: true }}
      />
    </HStack>
  )
}
/** 取完整多区价格列表，供各入口的价格胶囊（展开态）共用 */
export function useRegionPriceList(appid: string, regionCodes: string[] = DEFAULT_REGION_CODES) {
  const regionSignature = regionCodes.join(",")
  const [prices, setPrices] = useState<RegionPrice[] | null>(null)
  const [error, setError] = useState("")
  const [token, setToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setPrices(null)
      setError("")
      try {
        const result = await getRegionPrices(appid, regionCodes, (next) => {
          if (!cancelled) setPrices(next)
        })
        if (!cancelled) setPrices(result)
      } catch (reason) {
        if (!cancelled) {
          setPrices(null)
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [appid, regionSignature, token])

  return { prices, error, retry: () => setToken((value) => value + 1) }
}

/**
 * 紧凑展开态价格列表：与分享链接视图的 RegionPriceList 相同的价格行
 * （多区 + 内购明细），仅去掉外围衬垫与底部提示，适合嵌在头部卡内。
 */
export function MultiRegionCompactList(props: { appid: string; foregroundStyle?: any }) {
  const [regionCodes, setRegionCodes] = useState<string[]>(readPriceRegions)
  const [prices, setPrices] = useState<RegionPrice[] | null>(null)
  // 内购默认展开（2.4.29 起）：有内购的行直接展示明细，不再默认折叠；用户仍可点标题手动收起。
  const [expandedRows, setExpandedRows] = useState<boolean[]>(() => DEFAULT_REGION_CODES.map(() => true))
  const [error, setError] = useState("")
  const [token, setToken] = useState(0)
  const regionSignature = regionCodes.join(",")

  useEffect(() => {
    let cancelled = false
    async function load() {
      setPrices(null)
      setError("")
      try {
        const result = await getRegionPrices(props.appid, regionCodes, (next) => {
          if (!cancelled) setPrices(next)
        })
        if (!cancelled) setPrices(result)
      } catch (reason) {
        if (!cancelled) {
          setPrices(null)
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [props.appid, regionSignature, token])

  function replaceRegion(index: number, code: string) {
    if (!REGION_CATALOG.some((region) => region.code === code)) return
    if (regionCodes[index] === code || regionCodes.includes(code)) return
    const next = [...regionCodes]
    next[index] = code
    savePriceRegions(next)
    setRegionCodes(next)
  }

  if (error) {
    return (
      <HStack spacing={8}>
        <Image systemName="exclamationmark.triangle" foregroundStyle="systemOrange" />
        <Text font="caption" foregroundStyle={props.foregroundStyle || "secondaryLabel"}>{error}</Text>
        <Button
          title="重试"
          systemImage="arrow.clockwise"
          buttonStyle="plain"
          action={() => setToken((value) => value + 1)}
        />
      </HStack>
    )
  }

  if (!prices) return <ProgressView />

  return (
    <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
      {prices.map((item, index) => (
        <PriceRow
          key={`price-row-${index}`}
          appid={props.appid}
          item={item}
          regionCodes={regionCodes}
          expanded={expandedRows[index] ?? true}
          onExpandedChanged={(expanded) => {
            setExpandedRows((current) => {
              const next = [...current]
              next[index] = expanded
              return next
            })
          }}
          onChanged={(code) => replaceRegion(index, code)}
          foregroundStyle={props.foregroundStyle}
        />
      ))}
    </VStack>
  )
}

/** 展开态的完整多区价格列表（原格式） */
export function RegionPriceList(props: { appid: string; foregroundStyle?: any }) {
  const [regionCodes, setRegionCodes] = useState<string[]>(readPriceRegions)
  const [prices, setPrices] = useState<RegionPrice[] | null>(null)
  const [expandedRows, setExpandedRows] = useState<boolean[]>(() => DEFAULT_REGION_CODES.map(() => true))
  const [error, setError] = useState("")
  const [token, setToken] = useState(0)

  const regionSignature = regionCodes.join(",")

  useEffect(() => {
    let cancelled = false
    async function load() {
      setPrices(null)
      setError("")
      try {
        const result = await getRegionPrices(props.appid, regionCodes, (next) => {
          if (!cancelled) setPrices(next)
        })
        if (!cancelled) setPrices(result)
      } catch (reason) {
        if (!cancelled) {
          setPrices(null)
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [props.appid, regionSignature, token])

  function replaceRegion(index: number, code: string) {
    if (!REGION_CATALOG.some((region) => region.code === code)) return
    if (regionCodes[index] === code || regionCodes.includes(code)) return
    const next = [...regionCodes]
    next[index] = code
    savePriceRegions(next)
    setRegionCodes(next)
  }

  if (error) {
    return (
      <VStack alignment="leading" spacing={8}>
        <HStack spacing={8}>
          <GlassBadge style="warning">
            <AnimText font="caption" anim="interpolate">查询价格失败</AnimText>
          </GlassBadge>
          <Spacer />
          <Button
            title="重试"
            systemImage="arrow.clockwise"
            buttonStyle="plain"
            action={() => setToken((value) => value + 1)}
          />
        </HStack>
        <HStack spacing={8}>
          <Image systemName="exclamationmark.triangle" foregroundStyle="systemOrange" />
          <Text foregroundStyle={props.foregroundStyle || "secondaryLabel"}>{error}</Text>
        </HStack>
      </VStack>
    )
  }

  if (!prices) {
    return <ProgressView />
  }

  return (
    <VStack alignment="leading" spacing={2}>
      {prices.map((item, index) => (
        <PriceRow
          key={`price-row-${index}`}
          appid={props.appid}
          item={item}
          regionCodes={regionCodes}
          expanded={expandedRows[index] ?? true}
          onExpandedChanged={(expanded) => {
            setExpandedRows((current) => {
              const next = [...current]
              next[index] = expanded
              return next
            })
          }}
          onChanged={(code) => replaceRegion(index, code)}
          foregroundStyle={props.foregroundStyle}
        />
      ))}
    </VStack>
  )
}
