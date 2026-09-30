import {
  Button,
  Circle,
  HStack,
  Image,
  LinearGradient,
  Navigation,
  NavigationStack,
  ProgressView,
  RoundedRectangle,
  ZStack,
  ScrollView,
  ScrollViewReader,
  ScrollViewProxy,
  Spacer,
  Text,
  TextField,
  VStack,
  useEffect,
  useRef,
  useState,
} from "scripting"
import {
  getAppInfo,
  appStoreTextSlots,
  parseAppStoreURL,
  searchAppStore,
  type AppStoreIdentity,
  type AppStoreInfo,
  type AppStoreSearchResult,
} from "../core/appstore"
import {
  addTranslationHistory,
  getTranslationHistory,
  type TranslationHistoryItem,
} from "../core/search-history"
import { EmptyState } from "./common"
import { PriceToggle, RegionPriceList, MultiRegionCompactList } from "./region-prices"
import { VersionBadgeMenu } from "./version-history"
import type { AppVersionNotes } from "../core/versions"
import { TranslatedBlock } from "./translated-block"
import { AnimText } from "./anim-text"
import { AnimatedSection } from "./animated-section"
import { AnimTextGlassBadge, GlassBadge, getGlassBadgeTokens } from "./glass-badge"
import { IconPill, IconDownloadPanel, LinkBadgeButton } from "./icon-download"
import { TranslationHistoryPanel } from "./translation-history"
import { AppRavenCollectionsPage } from "./appraven-collections"
import { isAppRavenLoggedOut } from "../core/appraven"


const TEXT_GRADIENT_STORAGE_KEY = "lingo_appstore_text_gradient_v1"
const APP_STORE_SYMBOL = "appstore.fill"
const APP_ICON_SIZE = 56
const APP_ICON_RADIUS = 14
const SEARCH_ICON_SIZE = APP_ICON_SIZE
const TEXT_GRADIENTS: LinearGradient[] = [
  { colors: ["#243B55", "#667EEA"], startPoint: "topLeading", endPoint: "bottomTrailing" },
  { colors: ["#0F766E", "#38BDF8"], startPoint: "topLeading", endPoint: "bottomTrailing" },
  { colors: ["#7C3AED", "#EC4899"], startPoint: "topLeading", endPoint: "bottomTrailing" },
  { colors: ["#B45309", "#F59E0B"], startPoint: "topLeading", endPoint: "bottomTrailing" },
  { colors: ["#BE123C", "#FB7185"], startPoint: "topLeading", endPoint: "bottomTrailing" },
  { colors: ["#166534", "#84CC16"], startPoint: "topLeading", endPoint: "bottomTrailing" },
  { colors: ["#1D4ED8", "#22D3EE"], startPoint: "topLeading", endPoint: "bottomTrailing" },
  { colors: ["#4338CA", "#A78BFA"], startPoint: "topLeading", endPoint: "bottomTrailing" },
  { colors: ["#334155", "#CBD5E1"], startPoint: "topLeading", endPoint: "bottomTrailing" },
]

const TEXT_GRADIENT_COLORS: [string, string][] = [
  ["#243B55", "#667EEA"], ["#0F766E", "#38BDF8"], ["#7C3AED", "#EC4899"],
  ["#B45309", "#F59E0B"], ["#BE123C", "#FB7185"], ["#166534", "#84CC16"],
  ["#1D4ED8", "#22D3EE"], ["#4338CA", "#A78BFA"], ["#334155", "#CBD5E1"],
]
function nextGradient(index: number) {
  return (index + 1) % TEXT_GRADIENTS.length
}

/** 展开/收起弹簧：系统 snappy 曲线，驱动面板出入场、下方内容回流和箭头旋转。 */
const PANEL_SPRING = Animation.snappy({ duration: 0.42 })
/** 面板出入场过渡：展开时淡入并从下方 14pt 轻浮上来，收起时淡出并向上 10pt 离场。 */
const PANEL_TRANSITION = Transition.asymmetric(
  Transition.opacity().combined(Transition.offset({ x: 0, y: 14 })),
  Transition.opacity().combined(Transition.offset({ x: 0, y: 10 })),
).animation(PANEL_SPRING)
/** 单个已选应用块的出入场过渡：加入时淡入浮起；删除时向右侧删除按钮方向滑出、轻微缩小并淡出。 */
const APP_BLOCK_TRANSITION = Transition.asymmetric(
  Transition.opacity().combined(Transition.offset({ x: 0, y: 14 })),
  Transition.opacity().combined(Transition.offset({ x: 28, y: 0 })).combined(Transition.scale(0.96)),
).animation(PANEL_SPRING)


/** 一键重置胶囊：淡青色（teal），比 Link 徽章稍大，点击收起该应用全部展开面板。
 *  胶囊底色/描边换成与「更新/说明/图标」胶囊同款淡黑灰（仅底色，文字和圆点仍青色）；
 *  静止状态始终显示青色「Reset」；点击后才显示反馈（同 Link「已复制」）：
 *  有展开面板 → 重置 + 绿色「已重置」；全部已收起 → 灰色「不重置」，均 1.2s 后还原。 */
function ResetBadgeButton(props: { hasExpanded: boolean; onTap: () => void; foregroundStyle?: any }) {
  /** 反馈态：done=已重置（绿），noop=不重置（灰），idle=静止 Reset */
  const [feedback, setFeedback] = useState<"done" | "noop" | null>(null)
  useEffect(() => {
    if (!feedback) return
    const timer = setTimeout(() => setFeedback(null), 1200)
    return () => clearTimeout(timer)
  }, [feedback])

  const tokens = getGlassBadgeTokens(feedback === "noop" ? "neutral" : "teal")
  const label = feedback === "done" ? "已重置" : feedback === "noop" ? "不重置" : "Reset"
  // 静止态淡灰文字（同下排按钮）；仅反馈态保留彩色：成功绿、无操作灰
  const color = feedback === "done" ? "#34c759" : feedback === "noop" ? "secondaryLabel" : (props.foregroundStyle || "secondaryLabel")
  const dotColor = feedback === "done" ? "#34c759" : tokens.tint

  return (
    <Button
      buttonStyle="plain"
      action={() => {
        if (props.hasExpanded) {
          props.onTap()
          setFeedback("done")
        } else {
          setFeedback("noop")
        }
      }}
    >
      <HStack
        spacing={6}
        padding={{ horizontal: 13, vertical: 6.5 }}
        background={{ style: { light: "rgba(0,0,0,0.05)", dark: "rgba(0,0,0,0.22)" }, shape: "capsule" }}
        clipShape="capsule"
      >
        <Circle fill={dotColor} frame={{ width: 6, height: 6 }} />
        <Text font="footnote" fontWeight="medium" foregroundStyle={color}>{label}</Text>
      </HStack>
    </Button>
  )
}

function AppStoreIcon(props: {
  imageUrl?: string
  size?: number
  foregroundStyle?: any
  onTap?: () => void
}) {
  const size = props.size ?? APP_ICON_SIZE
  const radius = Math.round(size * APP_ICON_RADIUS / APP_ICON_SIZE)
  if (props.imageUrl) {
    return (
      <Image
        imageUrl={props.imageUrl}
        resizable
        aspectRatio={{ contentMode: "fit" }}
        frame={{ width: size, height: size }}
        clipShape={{ type: "rect", cornerRadius: radius, style: "continuous" }}
        placeholder={
          <Image
            systemName={APP_STORE_SYMBOL}
            font={Math.round(size * 0.56)}
            foregroundStyle={props.foregroundStyle}
            frame={{ width: size, height: size }}
          />
        }
        onTapGesture={props.onTap}
        shadow={{ color: "rgba(0,0,0,0.12)", radius: 5, y: 2 }}
      />
    )
  }
  return (
    <Image
      systemName={APP_STORE_SYMBOL}
      font={Math.round(size * 0.56)}
      foregroundStyle={props.foregroundStyle}
      frame={{ width: size, height: size }}
      onTapGesture={props.onTap}
    />
  )
}

export { AppStoreIcon }

/** 下载水印图标：应用图标右下角叠一个纯文字「Down」（无胶囊背景，仅轻阴影保证可读），
 *  点击整个图标跳转 App Store 下载页；跳转失败文字短暂变红。 */
function DownIconBadge(props: {
  imageUrl?: string
  size: number
  foregroundStyle?: any
  url: string | null | undefined
  fallbackUrl?: string
}) {
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!failed) return
    const timer = setTimeout(() => setFailed(false), 1200)
    return () => clearTimeout(timer)
  }, [failed])

  async function open() {
    const link = props.url || props.fallbackUrl || ""
    if (!link) {
      setFailed(true)
      return
    }
    try {
      const ok = await Safari.openURL(link)
      if (ok) {
        try { HapticFeedback.lightImpact() } catch {}
      } else {
        setFailed(true)
      }
    } catch {
      setFailed(true)
    }
  }

  return (
    <ZStack onTapGesture={() => { void open() }}>
      <AppStoreIcon
        imageUrl={props.imageUrl}
        size={props.size}
        foregroundStyle={props.foregroundStyle}
      />
      <Text
        font="caption"
        fontWeight="semibold"
        foregroundStyle={failed ? "#FF3B30" : (props.foregroundStyle || "secondaryLabel")}
        shadow={{ color: "rgba(0,0,0,0.45)", radius: 1.5, y: 0.5 }}
        offset={{ x: props.size * 0.13, y: props.size * 0.13 }}
      >
        Down
      </Text>
    </ZStack>
  )
}

function CardDivider() {
  return (
    <RoundedRectangle
      fill="rgba(120, 120, 128, 0.14)"
      cornerRadius={0.5}
      frame={{ maxWidth: "infinity", height: 0.5 }}
      padding={{ horizontal: 16 }}
    />
  )
}

/** 合集弹窗默认高度（pt，>1 的数字 = 固定点数，不随宿主容器比例缩放）：
 *  登录表单本体实测 ~357pt（头图 67 + 已保存账号行 + 三行输入框 + 页内距），
 *  每多一个已保存账号再 +~55pt。Cookie 行默认隐藏（轻点登录页左上角老鹰图标显示、再点隐藏、长按登录），
 *  隐藏时下方多出的空白是透明背景不影响观感；显示后内容仍在 420pt 内。
 *  旧值 0.36 分数在分享宿主里折算高度远小于此，把 Cookie 行往下全部裁掉且无处滚动；
 *  固定 420pt 装得下表单本体 + 2 个账号，更多账号/长 Cookie 由登录表单内部 ScrollView 滚动兜底。 */
const LOGIN_SHEET_DETENT = 420

/**
 * 分享页头部评分星星合集入口：无背景无圆点的原生排版，点击星星弹跳后弹出合集窗口。
 * 默认固定 420pt（贴合登录表单，表单内部超出可滚动）；合集页顶部全屏按钮点一次全屏、再点缩回。
 */
function RatingCollectionsButton(props: {
  rating: number
  ratingCount: string
  foregroundStyle: any
  appid: string
  appTitle: string
  artworkUrl?: string
  /** 搜索页 Reset 行用的紧凑形态：只渲染小星星 + 灰色圆环（不显示评分/评价数）。 */
  compact?: boolean
}) {
  const [tick, setTick] = useState(0)
  const [isPresented, setIsPresented] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [loggedIn, setLoggedIn] = useState(() => {
    try { return !isAppRavenLoggedOut() } catch { return false }
  })
  return (
    <Button
      buttonStyle="plain"
      action={() => {
        setTick(value => value + 1)
        setFullscreen(false)
        setIsPresented(true)
      }}
      sheet={{
        isPresented,
        onChanged: presented => setIsPresented(presented),
        content: (
          <VStack
            spacing={0}
            frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
            presentationBackground="clear"
            presentationDetents={fullscreen && loggedIn ? ["large"] : [LOGIN_SHEET_DETENT]}
            presentationDragIndicator="visible"
          >
            <AppRavenCollectionsPage
              appid={props.appid}
              appTitle={props.appTitle}
              artworkUrl={props.artworkUrl}
              foregroundStyle={props.foregroundStyle}
              onClose={() => setIsPresented(false)}
              onLoginStateChange={state => {
                setLoggedIn(state)
                if (!state) setFullscreen(false)
              }}
              fullscreen={fullscreen}
              onToggleFullscreen={() => setFullscreen(value => !value)}
            />
          </VStack>
        ),
      }}
    >
      {props.compact ? (
        <ZStack frame={{ width: 24, height: 24 }}>
          <Circle
            stroke={{
              shapeStyle: { light: "rgba(142,142,147,0.55)", dark: "rgba(142,142,147,0.65)" } as any,
              strokeStyle: { lineWidth: 1.5 },
            }}
            frame={{ width: 24, height: 24 }}
          />
          <Image
            systemName="star.fill"
            font="caption2"
            foregroundStyle={{ light: "rgba(142,142,147,1)", dark: "rgba(142,142,147,1)" }}
            contentTransition="symbolEffect"
            symbolEffect={{ effect: "bounce", value: tick }}
          />
        </ZStack>
      ) : (
        <HStack spacing={4}>
          <Image
            systemName="star.fill"
            font="caption2"
            foregroundStyle="systemYellow"
            contentTransition="symbolEffect"
            symbolEffect={{ effect: "bounce", value: tick }}
          />
          <AnimText font="caption" fontWeight="semibold" anim="numericText" foregroundStyle={props.foregroundStyle}>
            {props.rating.toFixed(1)}
          </AnimText>
          {props.ratingCount ? (
            <AnimText font="caption" foregroundStyle="tertiaryLabel" anim="numericText">
              {`(${props.ratingCount})`}
            </AnimText>
          ) : null}
        </HStack>
      )}
    </Button>
  )
}

/** 应用头部：图标 + 动效标题 + 徽章行 + 价格胶囊（偏中右侧） */
function AppHeader(props: {
  info: AppStoreInfo
  appid: string
  region: string
  /** 徽章显示的版本号；查看历史说明时与所选版本一致。 */
  displayVersion?: string
  onSelectNotes: (entry: AppVersionNotes) => void
  priceExpanded: boolean
  onTogglePrice: () => void
  onChangeTextGradient: () => void
  onResetTextGradient: () => void
  foregroundStyle: any
}) {
  const info = props.info
  const iconUrl = info.artworkUrl512 || info.artworkUrl100
  const ratingCount = typeof info.userRatingCount === "number"
    ? info.userRatingCount.toLocaleString()
    : ""

  return (
    <VStack
      alignment="leading"
      spacing={14}
      padding={{ horizontal: 16, vertical: 20 }}
      frame={{ maxWidth: "infinity", alignment: "leading" as any }}
    >
      <HStack spacing={14} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
        <AppStoreIcon
          imageUrl={iconUrl}
          size={APP_ICON_SIZE}
          foregroundStyle={props.foregroundStyle}
          onTap={props.onChangeTextGradient}
        />
         <VStack alignment="leading" spacing={5} onTapGesture={props.onResetTextGradient} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
          <AnimText
            font="title3"
            fontWeight="bold"
            lineLimit={2}
            foregroundStyle={props.foregroundStyle}
            dur={0.4}
          >
            {info.trackName || "未知应用"}
          </AnimText>
          <AnimText font="subheadline" foregroundStyle={props.foregroundStyle} anim="interpolate" dur={0.35}>
            {info.sellerName || "—"}
          </AnimText>
        </VStack>
        <PriceToggle
          appid={props.appid}
          expanded={props.priceExpanded}
          onToggle={props.onTogglePrice}
          foregroundStyle={props.foregroundStyle}
        />
      </HStack>

      <HStack spacing={8} alignment="firstTextBaseline">
        {info.version ? (
          <VersionBadgeMenu appid={props.appid} version={info.version} displayVersion={props.displayVersion} region={props.region} currentNotes={info.releaseNotes} onSelectNotes={props.onSelectNotes} foregroundStyle={props.foregroundStyle} />
        ) : null}
        {info.primaryGenreName ? (
          <GlassBadge style="teal">
                         <AnimText font="caption" foregroundStyle={props.foregroundStyle} anim="interpolate">{info.primaryGenreName}</AnimText>
          </GlassBadge>
        ) : null}
        {typeof info.averageUserRating === "number" ? (
          <RatingCollectionsButton
            rating={info.averageUserRating}
            ratingCount={ratingCount}
            foregroundStyle={props.foregroundStyle}
            appid={props.appid}
            appTitle={info.trackName || "未知应用"}
            artworkUrl={iconUrl}
          />
        ) : null}
        <Spacer />
      </HStack>
    </VStack>
  )
}

export function AppStoreView(props: { url: string }) {
  const dismiss = Navigation.useDismiss()
  const identity = parseAppStoreURL(props.url)
  const [reloadToken, setReloadToken] = useState(0)

  return (
    <NavigationStack>
      <AppStoreContent
        identity={identity}
        reloadToken={reloadToken}
        onReload={() => setReloadToken((value) => value + 1)}
        onClose={dismiss}
      />
    </NavigationStack>
  )
}

/** 底部搜索区：搜索 App Store 应用，选择后直接在页面底部翻译（最多六个应用） */
type PickedApp = {
  selectionId: number
  appid: string
  region: string
  trackName: string
  artistName?: string
  artworkUrl?: string
  version?: string
  releaseNotes?: string
  selectedVersionNotes?: AppVersionNotes
  description?: string
  detailLoading?: boolean
  detailError?: string
  priceExpanded?: boolean
  /** 更新译文折叠状态：默认折叠，点「更新」胶囊才展开翻译。 */
  releaseNotesExpanded?: boolean
  /** 应用说明折叠状态：默认折叠，展开时才翻译。 */
  descriptionExpanded?: boolean
  /** 图标面板折叠状态：默认折叠，点「图标」胶囊展开。 */
  iconExpanded?: boolean
  /** 每次详情成功刷新 +1；译文卡据此强制重译。 */
  detailToken?: number
  /** 详情页数据（用于图标下载 / 链接复制等功能）。 */
  detail?: AppStoreInfo
}

function AppSearchSection(props: {
  searchOpen: boolean
  inputVisible: boolean
  onInputVisibilityChanged: (visible: boolean) => void
  swapDescriptions: boolean
  onRefreshReady?: (refresh: () => Promise<void>) => void
  translationHost?: Translation
  foregroundStyle: any
  gradientColors?: [string, string]
  /** 折叠后把对应应用区滚回视口顶部，避免内容骤减造成的过度滚动空白。 */
  onScrollToApp?: (key: string) => void
  /** 把「从翻译记录重新选中应用」回调注册给宿主页面（记录面板使用）。 */
  onPickReady?: (pick: (item: TranslationHistoryItem) => void) => void
  /** 翻译记录发生变化（新增/删除/清空）时通知宿主，用于控制记录按钮显示。 */
  onHistoryChanged?: () => void
}) {
  const [query, setQuery] = useState("")
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState("")
  const [results, setResults] = useState<AppStoreSearchResult[]>([])
  const [picked, setPicked] = useState<PickedApp[]>([])
  const reqIdRef = useRef(0)
  // Refs are the synchronous authority; rendered state may lag behind a tap.
  const mountedRef = useRef(true)
  const pickedRef = useRef<PickedApp[]>([])
  const resultsRef = useRef<AppStoreSearchResult[]>([])
  const selectionIdRef = useRef(0)
  const detailIdRef = useRef(0)
  const detailRequestsRef = useRef(new Map<number, number>())
  const queryRef = useRef("")
  const searchOpenRef = useRef(props.searchOpen)
  searchOpenRef.current = props.searchOpen
  const swapRef = useRef(props.swapDescriptions)
  swapRef.current = props.swapDescriptions

  function updatePicked(items: PickedApp[]) {
    pickedRef.current = items
    setPicked(items)
  }

  function invalidateSearch() {
    reqIdRef.current += 1
    resultsRef.current = []
    setResults([])
    setSearching(false)
    setSearchError("")
  }

  function clearSearch() {
    invalidateSearch()
    queryRef.current = ""
    setQuery("")
  }

  function changeQuery(value: string) {
    // Native TextField may echo a programmatic clear; it is not a new search.
    if (value === queryRef.current) return
    queryRef.current = value
    setQuery(value)
    invalidateSearch()
  }

  async function doSearch() {
    const term = queryRef.current.trim()
    if (!mountedRef.current || !searchOpenRef.current || !term) return
    clearSearch()
    props.onInputVisibilityChanged(false)
    const reqId = reqIdRef.current
    const isCurrent = () => mountedRef.current && searchOpenRef.current && reqId === reqIdRef.current
    setSearching(true)
    try {
      // 默认美区，搜不到再试中国区；旧搜索不继续发起回退请求。
      let list = await searchAppStore(term, "us")
      if (!isCurrent()) return
      if (list.length === 0) list = await searchAppStore(term, "cn")
      if (!isCurrent()) return
      resultsRef.current = list
      setResults(list)
      if (list.length === 0) {
        setSearchError(`未找到与「${term}」相关的应用`)
        props.onInputVisibilityChanged(true)
      }
    } catch (reason) {
      if (!isCurrent()) return
      setSearchError(reason instanceof Error ? reason.message : String(reason))
      props.onInputVisibilityChanged(true)
    } finally {
      if (isCurrent()) setSearching(false)
    }
  }

  useEffect(() => {
    // Reopening the input or leaving search invalidates invisible row callbacks.
    if (!props.inputVisible && props.searchOpen) return
    reqIdRef.current += 1
    resultsRef.current = []
    setResults([])
    setSearching(false)
  }, [props.inputVisible, props.searchOpen])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      reqIdRef.current += 1
      resultsRef.current = []
      pickedRef.current = []
      detailRequestsRef.current.clear()
    }
  }, [])

  function isSelected(app: PickedApp) {
    return mountedRef.current && pickedRef.current.some((item) => item.selectionId === app.selectionId)
  }

  function selectVersionNotes(app: PickedApp, entry: AppVersionNotes) {
    if (!isSelected(app)) return
    updatePicked(pickedRef.current.map(item => item.selectionId === app.selectionId ? {
      ...item,
      selectedVersionNotes: entry,
      releaseNotesExpanded: swapRef.current ? item.releaseNotesExpanded : true,
      descriptionExpanded: swapRef.current ? true : item.descriptionExpanded,
    } : item))
    settleAfterCollapse(app)
  }

  function slotCancelled(app: PickedApp, index: 0 | 1, slot: ReturnType<typeof appStoreTextSlots>[number]) {
    const current = pickedRef.current.find(item => item.selectionId === app.selectionId)
    if (!mountedRef.current || !current || current.detailLoading || current.detailToken !== app.detailToken) return true
    if (index === 0 ? !current.releaseNotesExpanded : !current.descriptionExpanded) return true
    const active = appStoreTextSlots(current, current.selectedVersionNotes, swapRef.current)[index]
    return active.identity !== slot.identity || active.content !== slot.content
  }

  async function loadPickedDetails(app: PickedApp, preserveAvailable = false) {
    if (!isSelected(app)) return
    const detailId = ++detailIdRef.current
    detailRequestsRef.current.set(app.selectionId, detailId)
    const isCurrent = () => isSelected(app) && detailRequestsRef.current.get(app.selectionId) === detailId
    updatePicked(pickedRef.current.map((item) => item.selectionId === app.selectionId
      ? { ...item, detailLoading: true, detailError: "", detailToken: (item.detailToken || 0) + 1 }
      : item))
    try {
      const info = await getAppInfo({ appid: app.appid, region: app.region, url: "" })
      if (!isCurrent()) return
      updatePicked(pickedRef.current.map((item) => item.selectionId === app.selectionId
        ? {
          ...item,
          releaseNotes: preserveAvailable && item.version && item.releaseNotes !== undefined
            ? item.releaseNotes : info.releaseNotes || "",
          description: preserveAvailable ? item.description ?? info.description ?? "" : info.description || "",
          // 版本号与更新说明必须同次取得，刷新不能给旧版本挂上新说明。
          version: preserveAvailable && item.version && item.releaseNotes !== undefined
            ? item.version : info.version,
          detail: info,
          detailLoading: false,
          detailError: "",
        }
        : item))
    } catch (reason) {
      if (!isCurrent()) return
      updatePicked(pickedRef.current.map((item) => item.selectionId === app.selectionId
        ? { ...item, detailLoading: false, detailError: reason instanceof Error ? reason.message : String(reason) }
        : item))
    } finally {
      if (isCurrent()) detailRequestsRef.current.delete(app.selectionId)
    }
  }

  async function refreshPicked() {
    if (!mountedRef.current) return
    const current = pickedRef.current
    await Promise.all(current.map((app) => loadPickedDetails(app)))
  }

  useEffect(() => {
    props.onRefreshReady?.(refreshPicked)
  }, [props.onRefreshReady, picked])

  function settleAfterCollapse(app: PickedApp) {
    // 收起时面板先播放离场过渡（约 0.42s），译文卡（含 WebView 字体视图）
    // 在过渡结束后才真正卸载，内容高度逐步收缩，ScrollView 偏移可能停在
    // 旧位置形成过度滚动空白。等布局基本收缩后把该应用区平滑滚回视口
    // 顶部；第二次调用覆盖 WebView 晚卸载的极端情况，不强制重渲染列表。
    const key = `${app.appid}-${app.selectionId}`
    for (const delay of [140, 560]) {
      setTimeout(() => {
        if (!mountedRef.current || !isSelected(app)) return
        props.onScrollToApp?.(key)
      }, delay)
    }
  }

  useEffect(() => {
    const expanded = pickedRef.current.find(app => app.releaseNotesExpanded || app.descriptionExpanded)
    if (expanded) settleAfterCollapse(expanded)
  }, [props.swapDescriptions])

  function removePicked(app: PickedApp) {
    if (!isSelected(app)) return
    detailRequestsRef.current.delete(app.selectionId)
    const index = pickedRef.current.findIndex((item) => item.selectionId === app.selectionId)
    const remaining = pickedRef.current.filter((item) => item.selectionId !== app.selectionId)
    // Cancel translation ownership immediately, before the children unmount.
    updatePicked(remaining)
    // 删除展开着长译文/面板的应用时，高度骤减同样会留下过度滚动空白；
    // 把视口定位到被删应用原来的位置（下一个应用，或删最后一个时的搜索卡）。
    if (app.priceExpanded || app.releaseNotesExpanded || app.descriptionExpanded || app.iconExpanded) {
      const neighbor = remaining.length > 0
        ? remaining[Math.min(index, remaining.length - 1)]
        : undefined
      const key = neighbor ? `${neighbor.appid}-${neighbor.selectionId}` : "app-search-card"
      for (const delay of [140, 560]) {
        setTimeout(() => {
          if (!mountedRef.current) return
          props.onScrollToApp?.(key)
        }, delay)
      }
    }
    if (remaining.length === 0) {
      clearSearch()
      props.onInputVisibilityChanged(true)
    }
  }

  async function pickResult(item: AppStoreSearchResult) {
    // A row is valid only in the exact result batch which rendered this action.
    // Clearing the batch below locks all row actions before any await/render.
    if (!mountedRef.current || !searchOpenRef.current
      || results !== resultsRef.current || !resultsRef.current.includes(item)) return
    const appid = String(item.trackId)
    if (pickedRef.current.some((p) => p.appid === appid)) {
      setSearchError("这个应用已经添加。")
      return
    }
    if (pickedRef.current.length >= 6) {
      setSearchError("一次最多翻译六个应用。请先删除一个已选应用。")
      return
    }
    const entry: PickedApp = {
      selectionId: ++selectionIdRef.current,
      appid,
      region: item.region,
      trackName: item.trackName,
      artistName: item.artistName,
      artworkUrl: item.artworkUrl100,
      version: item.version,
      releaseNotes: item.releaseNotes,
      description: item.description,
    }
    updatePicked([...pickedRef.current, entry])
    // 记录到翻译历史（最新在前，去重置顶）
    addTranslationHistory({
      appid,
      region: entry.region,
      trackName: entry.trackName,
      artistName: entry.artistName,
      artworkUrl: entry.artworkUrl,
      recordedAt: Date.now(),
    })
    props.onHistoryChanged?.()
    clearSearch()
    // Search already carries full text for most apps; only fill absent fields.
    if (entry.releaseNotes === undefined || entry.description === undefined) {
      await loadPickedDetails(entry, true)
    }
  }

  /** 从翻译记录重新选中应用：加入已选列表（若未选中）、记录置顶并滚动定位到该应用。 */
  async function pickFromHistory(item: TranslationHistoryItem) {
    if (!mountedRef.current) return
    let target = pickedRef.current.find((p) => p.appid === item.appid)
    if (!target) {
      if (pickedRef.current.length >= 6) {
        setSearchError("一次最多翻译六个应用。请先删除一个已选应用。")
        return
      }
      const entry: PickedApp = {
        selectionId: ++selectionIdRef.current,
        appid: item.appid,
        region: item.region || "us",
        trackName: item.trackName,
        artistName: item.artistName,
        artworkUrl: item.artworkUrl,
      }
      updatePicked([...pickedRef.current, entry])
      target = entry
    }
    // 点击记录后置顶并持久化
    addTranslationHistory({
      appid: item.appid,
      region: item.region || "us",
      trackName: item.trackName,
      artistName: item.artistName,
      artworkUrl: item.artworkUrl,
      recordedAt: Date.now(),
    })
    clearSearch()
    // 滚动定位到该应用区（等布局完成后）
    const key = `${target.appid}-${target.selectionId}`
    setTimeout(() => {
      if (mountedRef.current) props.onScrollToApp?.(key)
    }, 120)
    // 历史记录不保存正文，拉取详情获得更新/说明
    if (target.releaseNotes === undefined || target.description === undefined) {
      await loadPickedDetails(target, true)
    }
  }

  useEffect(() => {
    props.onPickReady?.(pickFromHistory)
  }, [props.onPickReady])

  // 仅应用增删驱动整卡动画。价格/图标展开不能把已有长译文
  // 卷入同一隐式动画事务；各面板继续使用自己的局部过渡。
  const pickedSignature = picked.map((app) => app.selectionId).join(",")

  if (!props.searchOpen && picked.length === 0) {
    return <Spacer frame={{ width: 0, height: 0 }} />
  }

  return (
    <VStack
      key="app-search-card"
      alignment="leading"
      spacing={14}
      padding={props.inputVisible
        ? { horizontal: 18, vertical: 16 }
        : picked.length > 0
          ? { horizontal: 18, vertical: 14 }
          : { horizontal: 18, vertical: 0 }}
      frame={{ maxWidth: "infinity", alignment: "leading" as any }}
      background={<RoundedRectangle fill={{ light: "#FFFFFF", dark: "#1C1C1E" }} cornerRadius={24} />}
      clipShape={{ type: "rect", cornerRadius: 24, style: "continuous" }}
      animation={{ animation: PANEL_SPRING, value: pickedSignature }}
    >
      {props.searchOpen ? (
        <>
          {props.inputVisible ? (
            <AnimatedSection index={0}>
              <VStack alignment="leading" spacing={10}>
                <HStack
                  spacing={8}
                  padding={{ horizontal: 12, vertical: 4 }}
                  background={<RoundedRectangle fill={{ light: "rgba(120,120,128,0.10)", dark: "rgba(120,120,128,0.18)" }} cornerRadius={14} />}
                  clipShape={{ type: "rect", cornerRadius: 14, style: "continuous" }}
                >
                  <TextField
                    title=""
                    prompt="搜索应用名称"
                    value={query}
                    onChanged={changeQuery}
                    onSubmit={doSearch}
                    submitLabel="search"
                    frame={{ maxWidth: "infinity" }}
                  />
                  {query.trim().length > 0 ? (
                    <Image
                      systemName="xmark.circle.fill"
                      foregroundStyle="tertiaryLabel"
                      font="caption"
                      contentShape="rect"
                      onTapGesture={clearSearch}
                    />
                  ) : null}
                </HStack>
              </VStack>
            </AnimatedSection>
          ) : null}
          {searching ? (
            <AnimatedSection index={1}>
              <HStack spacing={8} padding={{ vertical: 4 }}>
                <ProgressView />
                <AnimText font="caption" foregroundStyle="tertiaryLabel" anim="opacity">正在搜索 App Store 应用…</AnimText>
              </HStack>
            </AnimatedSection>
          ) : null}

          {/* 搜索结果列表 */}
          {results.length > 0 ? (
            <AnimatedSection index={2}>
              <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
                {results.map((item, resultIndex) => (
                  <AnimatedSection key={String(item.trackId)} index={resultIndex + 3}>
                    <Button
                      buttonStyle="plain"
                      action={() => { void pickResult(item) }}
                    >
                      <HStack
                        spacing={12}
                        padding={{ horizontal: 10, vertical: 9 }}
                        frame={{ maxWidth: "infinity" }}
                        contentShape="rect"
                        background={<RoundedRectangle fill={{ light: "rgba(120,120,128,0.07)", dark: "rgba(120,120,128,0.12)" }} cornerRadius={16} />}
                        clipShape={{ type: "rect", cornerRadius: 16, style: "continuous" }}
                      >
                        <AppStoreIcon
                          imageUrl={item.artworkUrl100}
                          size={SEARCH_ICON_SIZE}
                          foregroundStyle={props.foregroundStyle}
                        />
                        <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
                          <Text font="body" fontWeight="semibold" foregroundStyle={props.foregroundStyle} lineLimit={1}>{item.trackName}</Text>
                          <Text font="caption" foregroundStyle={props.foregroundStyle} lineLimit={1}>
                            {item.artistName || "—"}{item.formattedPrice ? ` · ${item.formattedPrice}` : ""}
                          </Text>
                        </VStack>
                      </HStack>
                    </Button>
                  </AnimatedSection>
                ))}
              </VStack>
            </AnimatedSection>
          ) : null}

          {searchError ? (
            <AnimatedSection index={2}>
              <HStack spacing={8} padding={{ vertical: 4 }}>
                <Image systemName="exclamationmark.triangle.fill" font="caption" foregroundStyle="systemOrange" />
                <AnimText font="caption" foregroundStyle="systemOrange" anim="opacity">{searchError}</AnimText>
              </HStack>
            </AnimatedSection>
          ) : null}
        </>
      ) : null}

      {/* 已选应用的译文（最多六个，只显示译文不显示原文） */}
      {picked.map((app, index) => {
        const slots = appStoreTextSlots(app, app.selectedVersionNotes, props.swapDescriptions)
        return (
        <VStack key={`${app.appid}-${app.selectionId}`} alignment="leading" spacing={12} frame={{ maxWidth: "infinity", alignment: "leading" as any }} transition={APP_BLOCK_TRANSITION}>
          {index > 0 || (props.searchOpen && (props.inputVisible || searching || results.length > 0 || !!searchError)) ? <CardDivider /> : null}
          {/* 应用头部 */}
          <HStack spacing={12} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
            <DownIconBadge
              imageUrl={app.artworkUrl}
              size={SEARCH_ICON_SIZE}
              foregroundStyle={props.foregroundStyle}
              url={app.detail?.trackViewUrl}
              fallbackUrl={`https://apps.apple.com/us/app/id${app.appid}`}
            />
            <VStack alignment="leading" spacing={6} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
              <HStack spacing={8} alignment="firstTextBaseline">
                {/* 搜索页三胶囊底色换成与下排「更新/说明/图标」同款淡黑灰（仅底色，文字色不变）
                    分享页不传 grayBackground，保持原胶囊样式 */}
                {app.version ? (
                  <VersionBadgeMenu appid={app.appid} version={app.version} displayVersion={app.selectedVersionNotes?.version} region={app.region} currentNotes={app.releaseNotes} onSelectNotes={entry => selectVersionNotes(app, entry)} grayBackground foregroundStyle={props.foregroundStyle} />
                ) : null}
                <LinkBadgeButton
                  url={app.detail?.trackViewUrl}
                  fallbackUrl={`https://apps.apple.com/us/app/id${app.appid}`}
                  grayBackground
                  foregroundStyle={props.foregroundStyle}
                />
              </HStack>
              {/* AppRaven 星星入口（紧凑形态：小星星 + 灰色圆环）在 Reset 左侧；
                  向右偏移到上排 v 版本徽章与 Link 徽章中间的位置 */}
              <HStack padding={{ leading: 24 }} spacing={8}>
                <RatingCollectionsButton
                  compact
                  rating={app.detail && typeof app.detail.averageUserRating === "number" ? app.detail.averageUserRating : 0}
                  ratingCount={app.detail && typeof app.detail.userRatingCount === "number" ? app.detail.userRatingCount.toLocaleString() : ""}
                  foregroundStyle={props.foregroundStyle}
                  appid={app.appid}
                  appTitle={app.trackName || app.detail?.trackName || "未知应用"}
                  artworkUrl={app.detail?.artworkUrl512 || app.detail?.artworkUrl100 || app.artworkUrl}
                />
                <ResetBadgeButton
                  hasExpanded={app.priceExpanded === true
                    || app.releaseNotesExpanded === true
                    || app.descriptionExpanded === true
                    || app.iconExpanded === true}
                  foregroundStyle={props.foregroundStyle}
                  onTap={() => {
                    if (!isSelected(app)) return
                    updatePicked(pickedRef.current.map((item) => item.selectionId === app.selectionId
                      ? {
                        ...item,
                        priceExpanded: false,
                        releaseNotesExpanded: false,
                        descriptionExpanded: false,
                        iconExpanded: false,
                      }
                      : item))
                    // 与单个面板收起同样处理：内容高度骤减时把该应用滚回视口顶部
                    settleAfterCollapse(app)
                  }}
                />
              </HStack>
            </VStack>
            <HStack spacing={8}>
              <PriceToggle
                appid={app.appid}
                expanded={!!app.priceExpanded}
                onToggle={() => {
                  if (!isSelected(app)) return
                  const wasExpanded = app.priceExpanded === true
                  updatePicked(pickedRef.current.map((item) => item.selectionId === app.selectionId
                    ? { ...item, priceExpanded: !item.priceExpanded }
                    : item))
                  if (wasExpanded) settleAfterCollapse(app)
                }}
                foregroundStyle={props.foregroundStyle}
              />
              <Button
                buttonStyle="borderless"
                action={() => removePicked(app)}
              >
                <Image
                  systemName="xmark.circle.fill"
                  foregroundStyle={{ light: "rgba(255,59,48,0.55)", dark: "rgba(255,69,58,0.60)" }}
                  font="title3"
                />
              </Button>
            </HStack>
          </HStack>
          {app.priceExpanded ? (
            <VStack key={`search-price-${app.selectionId}`} alignment="leading" spacing={10} padding={{ horizontal: 4, vertical: 4 }} frame={{ maxWidth: "infinity", alignment: "leading" as any }} transition={PANEL_TRANSITION}>
              <MultiRegionCompactList appid={app.appid} foregroundStyle={props.foregroundStyle} />
            </VStack>
          ) : null}
          {app.detailError ? (
            <HStack spacing={8}>
              <Text font="caption" foregroundStyle="systemOrange">{app.detailError}</Text>
              <Button title="重试" action={() => { void loadPickedDetails(app, true) }} />
            </HStack>
          ) : null}
          {/* 稳定 key 属于面板槽位，不随价格展开或上下文互换改变。
              id 是业务属性，不能代替原生视图的 key。 */}
          {slots[0].content === undefined ? null : (
          <VStack key={`search-release-slot-${app.selectionId}`} alignment="leading" spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
            {app.releaseNotesExpanded === true ? (
              <VStack key={`search-release-body-${app.selectionId}`} alignment="leading" spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" as any }} transition={Transition.identity()}>
                <TranslatedBlock
                  id={`search-release-notes-${app.selectionId}-${app.appid}`}
                  contentIdentity={`${app.selectionId}:${app.appid}:${app.region}:${slots[0].identity}`}
                  content={slots[0].content || ""}
                  emptyText={slots[0].emptyText}
                  isCancelled={() => slotCancelled(app, 0, slots[0])}
                  translationHost={props.translationHost}
                  foregroundStyle={props.foregroundStyle}
                  gradientColors={props.gradientColors}
                  translationOnly
                  translationEnabled={app.detailLoading !== true}
                  priority={2}
                  translationToken={app.detailToken}
                />
              </VStack>
            ) : null}
          </VStack>
          )}
          {/* 应用说明译文（译文-only，默认折叠，展开时才翻译） */}
          {slots[1].content === undefined ? null : (
          <VStack key={`search-description-slot-${app.selectionId}`} alignment="leading" spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
            {app.descriptionExpanded ? (
              <VStack key={`search-description-body-${app.selectionId}`} alignment="leading" spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" as any }} transition={Transition.identity()}>
                <TranslatedBlock
                  id={`search-description-${app.selectionId}-${app.appid}`}
                  contentIdentity={`${app.selectionId}:${app.appid}:${app.region}:${slots[1].identity}`}
                  content={slots[1].content || ""}
                  emptyText={slots[1].emptyText}
                  isCancelled={() => slotCancelled(app, 1, slots[1])}
                  translationHost={props.translationHost}
                  foregroundStyle={props.foregroundStyle}
                  gradientColors={props.gradientColors}
                  translationOnly
                  preferSequential
                  translationEnabled={app.detailLoading !== true}
                  priority={2}
                  translationToken={app.detailToken}
                />
              </VStack>
            ) : null}
          </VStack>
          )}
          {/* 折叠控制胶囊：更新和应用说明均默认折叠；三个按钮包在整体淡黑色胶囊里 */}
          <HStack
            spacing={6}
            padding={{ horizontal: 6, vertical: 5 }}
            background={{ style: { light: "rgba(0,0,0,0.05)", dark: "rgba(0,0,0,0.22)" }, shape: "capsule" }}
            clipShape="capsule"
          >
            <Button
              buttonStyle="plain"
              action={() => {
                if (!isSelected(app)) return
                const wasExpanded = app.releaseNotesExpanded === true
                updatePicked(pickedRef.current.map((item) => item.selectionId === app.selectionId
                  ? { ...item, releaseNotesExpanded: !item.releaseNotesExpanded }
                  : item))
                if (wasExpanded) settleAfterCollapse(app)
              }}
            >
              <HStack spacing={6} padding={{ horizontal: 12, vertical: 8 }}>
                <Image
                  systemName="chevron.down"
                  font="caption2"
                  foregroundStyle={props.foregroundStyle}
                  rotationEffect={app.releaseNotesExpanded ? 180 : 0}
                  animation={{ animation: PANEL_SPRING, value: app.releaseNotesExpanded === true }}
                />
                <Text font="subheadline" foregroundStyle={props.foregroundStyle}>更新</Text>
              </HStack>
            </Button>
            <Button
              buttonStyle="plain"
              action={() => {
                if (!isSelected(app)) return
                const wasExpanded = app.descriptionExpanded === true
                updatePicked(pickedRef.current.map((item) => item.selectionId === app.selectionId
                  ? { ...item, descriptionExpanded: !item.descriptionExpanded }
                  : item))
                if (wasExpanded) settleAfterCollapse(app)
              }}
            >
              <HStack spacing={6} padding={{ horizontal: 12, vertical: 8 }}>
                <Image
                  systemName="chevron.down"
                  font="caption2"
                  foregroundStyle={props.foregroundStyle}
                  rotationEffect={app.descriptionExpanded ? 180 : 0}
                  animation={{ animation: PANEL_SPRING, value: app.descriptionExpanded === true }}
                />
                <Text font="subheadline" foregroundStyle={props.foregroundStyle}>说明</Text>
              </HStack>
            </Button>
            <IconPill
              bare
              expanded={app.iconExpanded === true}
              foregroundStyle={props.foregroundStyle}
              onToggle={() => {
                if (!isSelected(app)) return
                const wasExpanded = app.iconExpanded === true
                updatePicked(pickedRef.current.map((item) => item.selectionId === app.selectionId
                  ? { ...item, iconExpanded: item.iconExpanded === true ? false : true }
                  : item))
                if (wasExpanded) settleAfterCollapse(app)
              }}
            />
          </HStack>
          {/* 图标下载面板（点「图标」胶囊展开，仅保存到相册） */}
          {app.iconExpanded === true ? (
            <VStack alignment="leading" spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" as any }} transition={PANEL_TRANSITION}>
              <IconDownloadPanel url={app.artworkUrl} title={app.trackName} />
            </VStack>
          ) : null}
        </VStack>
        )
      })}
    </VStack>
  )
}

function AppStoreContent(props: {
  identity: AppStoreIdentity | null
  reloadToken: number
  onReload: () => void
  onClose: () => void
  foregroundStyle?: any
}) {
  const contentOwner = `${props.identity?.appid || ""}:${props.identity?.region || ""}`
  const ownerRef = useRef(contentOwner)
  ownerRef.current = contentOwner
  const [loadedInfo, setLoadedInfo] = useState<{ owner: string; info: AppStoreInfo } | null>(null)
  const info = loadedInfo?.owner === contentOwner ? loadedInfo.info : null
  const [selectedVersion, setSelectedVersion] = useState<{ owner: string; entry: AppVersionNotes } | null>(null)
  const selectedNotes = selectedVersion?.owner === contentOwner ? selectedVersion.entry : null
  const [loading, setLoading] = useState(!!props.identity)
  const [error, setError] = useState("")
  const [priceExpanded, setPriceExpanded] = useState(false)
  const [contentToken, setContentToken] = useState(0)
  // Refresh must invalidate an in-flight native translation immediately, not
  // only after App Store lookup returns. The native promise itself is not
  // cancellable, but its late result must lose the right to update this card.
  const translationGenerationRef = useRef(0)
  const [translationGeneration, setTranslationGeneration] = useState(0)
  const [searchOpen, setSearchOpen] = useState(!props.identity)
  const [searchInputVisible, setSearchInputVisible] = useState(true)
  const [swapDescriptions, setSwapDescriptions] = useState(false)
  const slots = appStoreTextSlots(info || {}, selectedNotes, swapDescriptions)
  const slotsRef = useRef(slots)
  slotsRef.current = slots
  const searchRefreshRef = useRef<() => Promise<void>>(() => Promise.resolve())
  const searchPickRef = useRef<(item: TranslationHistoryItem) => void>(() => {})
  const [historyOpen, setHistoryOpen] = useState(false)
  // 翻译记录数：为空时底部「翻译记录」按钮整体不渲染（点不着，也无任何 UI）。
  const [historyCount, setHistoryCount] = useState(() => getTranslationHistory().length)
  const refreshHistoryCount = () => setHistoryCount(getTranslationHistory().length)
  const scrollProxyRef = useRef<ScrollViewProxy>()
  /** 折叠后把对应应用区滚回视口顶部：内容高度骤减时 ScrollView 会停在旧偏移
   *  形成过度滚动空白；scrollTo 会一次性夹紧偏移，避免需要手动点击回弹。 */
  const scrollToApp = (key: string) => {
    const proxy = scrollProxyRef.current
    if (!proxy) return
    try {
      withAnimation(() => {
        proxy.scrollTo(key, "top")
      })
    } catch {
      proxy.scrollTo(key, "top")
    }
  }
  const [textGradientIndex, setTextGradientIndex] = useState<number | null>(() => {
    const stored = Storage.get<number>(TEXT_GRADIENT_STORAGE_KEY, { shared: true })
    if (stored === null || stored === -1) return null
    return Number.isInteger(stored) && stored >= 0 && stored < TEXT_GRADIENTS.length ? stored : 0
  })
  const textGradient = textGradientIndex === null ? undefined : TEXT_GRADIENTS[textGradientIndex]
  const textForeground = textGradient || { light: "#000000", dark: "#FFFFFF" }
  useEffect(() => {
    Storage.set(TEXT_GRADIENT_STORAGE_KEY, textGradientIndex === null ? -1 : textGradientIndex, { shared: true })
  }, [textGradientIndex])

  // 与旧版一致：页面持有专用 Translation 实例，译文卡走独立会话，
  // 快速渐进出结果（局部刷新），避免共享单例排队冲突。
  const [translationHost] = useState(() => new Translation())

  const mountedRef = useRef(true)
  const loadRequestRef = useRef(0)

  function selectContentVersion(entry: AppVersionNotes) {
    if (!mountedRef.current || ownerRef.current !== contentOwner || !info) return
    // 同步失效旧版本的译文回调，再交给状态刷新页面。
    slotsRef.current = appStoreTextSlots(info, entry, swapDescriptions)
    setSelectedVersion({ owner: contentOwner, entry })
    for (const delay of [140, 560]) setTimeout(() => {
      if (mountedRef.current && ownerRef.current === contentOwner) scrollToApp("appstore-content")
    }, delay)
  }

  function contentSlotCancelled(index: 0 | 1) {
    const active = slotsRef.current[index]
    return !mountedRef.current || loading || ownerRef.current !== contentOwner ||
      translationGenerationRef.current !== translationGeneration ||
      active.identity !== slots[index].identity || active.content !== slots[index].content
  }

  function invalidateContentTranslation() {
    translationGenerationRef.current += 1
    setTranslationGeneration(translationGenerationRef.current)
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      // 让返回后仍在进行的请求失去写入资格。
      loadRequestRef.current += 1
    }
  }, [])

  async function load(forceTranslate = false) {
    if (!mountedRef.current || !props.identity) {
      if (mountedRef.current) {
        setLoadedInfo(null)
        setLoading(false)
      }
      return
    }
    // Invalidate the old card before waiting for the network refresh. This
    // prevents a late translation from being mistaken for refreshed content.
    if (info) invalidateContentTranslation()
    const requestId = ++loadRequestRef.current
    const isCurrent = () => mountedRef.current && requestId === loadRequestRef.current && ownerRef.current === contentOwner
    setLoading(true)
    setError("")
    try {
      const nextInfo = await getAppInfo(props.identity)
      if (!isCurrent()) return
      setLoadedInfo({ owner: contentOwner, info: nextInfo })
      // 链接直达的应用也记入翻译记录，便于之后从「记录」快速找回
      addTranslationHistory({
        appid: props.identity.appid,
        region: props.identity.region || "us",
        trackName: nextInfo.trackName || "未知应用",
        artistName: nextInfo.sellerName,
        artworkUrl: nextInfo.artworkUrl512 || nextInfo.artworkUrl100,
        recordedAt: Date.now(),
      })
      refreshHistoryCount()
      // 首次装载只挂载一次译文卡；刷新/重载时才递增 token，
      // 避免说明卡刚开始翻译就被首屏第二次渲染取消。
      if (forceTranslate || props.reloadToken > 0) setContentToken((value) => value + 1)
    } catch (reason) {
      if (!isCurrent()) return
      // 保留当前页面内容，避免刷新失败时整页退化成白屏。
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (isCurrent()) {
        setLoading(false)
      }
    }
  }

  useEffect(() => { setSelectedVersion(null) }, [contentOwner])

  useEffect(() => {
    void load()
    return () => {
      // identity/reloadToken 变化时，旧请求不能回写新页面状态。
      loadRequestRef.current += 1
    }
  }, [props.identity?.appid, props.identity?.region, props.reloadToken])

  return (
    <ScrollViewReader>
    {(proxy) => {
      scrollProxyRef.current = proxy
      return (
    <ScrollView
      listStyle="plain"
      scrollContentBackground="hidden"
       background={{ light: "#FFFFFF", dark: "#000000" }}
      navigationTitle=""
      navigationBarTitleDisplayMode="inline"
      refreshable={async () => {
        if (searchOpen) await searchRefreshRef.current()
        else await load(true)
      }}
      translationHost={translationHost}
      overlay={{
        alignment: "bottom",
        content: (
          <HStack
            spacing={12}
            padding={{ horizontal: 14, vertical: 10 }}
            frame={{ maxWidth: "infinity", alignment: "center" as any }}
          >
            <HStack
              spacing={18}
              padding={{ horizontal: 22, vertical: 16 }}
              background={{
                style: { light: "rgba(255,255,255,0.85)", dark: "rgba(28,28,30,0.85)" },
                shape: "capsule",
              }}
                             shadow={{ color: "rgba(0,0,0,0.12)", radius: 14, y: 4 }}
            >
              {props.identity ? (
                <Button
                  buttonStyle="borderless"
                  disabled={loading}
                  action={() => {
                    if (searchOpen) {
                      void searchRefreshRef.current()
                    } else {
                      props.onReload()
                    }
                  }}
                >
                  <Image
                     systemName="arrow.clockwise"
                     font={18}
                     foregroundStyle={{ light: "#000000", dark: "#FFFFFF" }}
                     frame={{ width: 36, height: 36 }}
                     background={{ style: { light: "rgba(142, 142, 147, 0.22)", dark: "rgba(142, 142, 147, 0.28)" }, shape: "circle" }}
                   />
                </Button>
              ) : null}
              {props.identity && historyCount > 0 ? (
                <Button
                  buttonStyle="borderless"
                  disabled={loading}
                  action={() => {
                    setHistoryOpen((value) => !value)
                    // 面板挂载后滚到顶部，避免面板在长内容下方看不见
                    if (!historyOpen) {
                      setTimeout(() => {
                        const proxy = scrollProxyRef.current
                        if (!proxy) return
                        try {
                          withAnimation(() => proxy.scrollTo("translation-history-panel", "top"))
                        } catch {
                          proxy.scrollTo("translation-history-panel", "top")
                        }
                      }, 120)
                    }
                  }}
                >
                  <Image
                    systemName="clock.arrow.circlepath"
                    font={18}
                    foregroundStyle={historyOpen
                      ? { light: "#FFFFFF", dark: "#000000" }
                      : { light: "#000000", dark: "#FFFFFF" }}
                    frame={{ width: 36, height: 36 }}
                    background={historyOpen
                      ? { style: { light: "#000000", dark: "#FFFFFF" }, shape: "circle" }
                      : { style: { light: "rgba(142, 142, 147, 0.22)", dark: "rgba(142, 142, 147, 0.28)" }, shape: "circle" }}
                  />
                </Button>
              ) : null}
{props.identity ? (
                <Button
                  buttonStyle="borderless"
                  disabled={loading}
                  action={() => {
                    setSearchInputVisible(true)
                    setSearchOpen(true)
                  }}
                >
                  <Image systemName="magnifyingglass" font={18} foregroundStyle={{ light: "#000000", dark: "#FFFFFF" }} frame={{ width: 36, height: 36 }} background={{ style: { light: "rgba(142, 142, 147, 0.22)", dark: "rgba(142, 142, 147, 0.28)" }, shape: "circle" }} />
                </Button>
              ) : null}
              {props.identity ? (
                <Button buttonStyle="borderless" disabled={loading} action={() => {
                  setSwapDescriptions(value => !value)
                  if (!searchOpen) for (const delay of [140, 560]) setTimeout(() => {
                    if (mountedRef.current && ownerRef.current === contentOwner) scrollToApp("appstore-content")
                  }, delay)
                }}>
                  <Image systemName="arrow.up.arrow.down" font={18} foregroundStyle={{ light: "#000000", dark: "#FFFFFF" }} frame={{ width: 36, height: 36 }} background={{ style: { light: "rgba(142, 142, 147, 0.22)", dark: "rgba(142, 142, 147, 0.28)" }, shape: "circle" }} />
                </Button>
              ) : null}
              {props.identity && info ? (() => {
                const identity = props.identity
                return (
                  <Button
                    buttonStyle="borderless"
                    action={async () => {
                      const link = info.trackViewUrl || identity.url
                      await Pasteboard.setString(link)
                      try { HapticFeedback.lightImpact() } catch {}
                    }}
                  >
                    <Image
                       systemName="square.and.arrow.up"
                       font={18}
                       foregroundStyle={{ light: "#000000", dark: "#FFFFFF" }}
                       frame={{ width: 36, height: 36 }}
                       background={{ style: { light: "rgba(142, 142, 147, 0.22)", dark: "rgba(142, 142, 147, 0.28)" }, shape: "circle" }}
                     />
                  </Button>
                )
              })() : null}
              <Button
                role="close"
                buttonStyle={props.identity ? "borderless" : "borderedProminent"}
                frame={{ maxWidth: props.identity ? undefined : 160 }}
                action={() => {
                   if (props.identity && searchOpen) {
                     setSearchOpen(false)
                     setSearchInputVisible(true)
                   } else {
                     props.onClose()
                   }
                 }}
              >
                {props.identity ? (
                  <Image
                   systemName="xmark"
                   font={18}
                   foregroundStyle={{ light: "#000000", dark: "#FFFFFF" }}
                   frame={{ width: 36, height: 36 }}
                   background={{ style: { light: "rgba(142, 142, 147, 0.22)", dark: "rgba(142, 142, 147, 0.28)" }, shape: "circle" }}
                 />
                ) : (
                  <Image
                    systemName="xmark"
                    font={18}
                    foregroundStyle={{ light: "#000000", dark: "#FFFFFF" }}
                    frame={{ width: 36, height: 36 }}
                    background={{ style: { light: "rgba(142, 142, 147, 0.22)", dark: "rgba(142, 142, 147, 0.28)" }, shape: "circle" }}
                  />
                )}
              </Button>
            </HStack>
          </HStack>
        ),
      }}
    >
      <VStack
        alignment="leading"
        spacing={0}
        padding={{ bottom: 110 }}
        frame={{ maxWidth: "infinity", alignment: "topLeading" as any }}
      >
        <AppSearchSection searchOpen={searchOpen} inputVisible={searchInputVisible} onInputVisibilityChanged={setSearchInputVisible} swapDescriptions={swapDescriptions} onRefreshReady={(refresh) => { searchRefreshRef.current = refresh }} onPickReady={(pick) => { searchPickRef.current = pick }} onHistoryChanged={refreshHistoryCount} translationHost={translationHost} foregroundStyle={textForeground} gradientColors={textGradientIndex === null ? undefined : TEXT_GRADIENT_COLORS[textGradientIndex]} onScrollToApp={scrollToApp} />
        {historyOpen ? (
          <VStack key="translation-history-panel" spacing={0} padding={{ top: 8, bottom: 4 }} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
          <TranslationHistoryPanel
            foregroundStyle={textForeground}
            onPick={(item) => {
              setHistoryOpen(false)
              setSearchOpen(true)
              setSearchInputVisible(false)
              void searchPickRef.current(item)
            }}
            onRequestClose={() => setHistoryOpen(false)}
            onCountChanged={(count) => {
              setHistoryCount(count)
              // 记录被清空后按钮随之消失，面板也一并收起，避免留下空面板。
              if (count === 0) setHistoryOpen(false)
            }}
          />
          </VStack>
        ) : null}
      {!searchOpen ? (
        <> 
          {!props.identity ? (
          <EmptyState
            symbol="link.badge.plus"
            title="不是有效的 App Store 链接"
            message="请从 App Store 分享应用链接到 Lingo。"
          />
        ) : loading ? (
          <VStack alignment="leading" spacing={12} padding={{ vertical: 18 }}>
            <HStack spacing={10}>
              <ProgressView />
              <AnimText font="body" fontWeight="medium" anim="interpolate" dur={0.3}>正在读取应用信息…</AnimText>
            </HStack>
            <AnimText font="caption" foregroundStyle={props.foregroundStyle} anim="interpolate" dur={0.45}>正在连接 Apple App Store 数据服务</AnimText>
          </VStack>
        ) : error && !info ? (
          <AnimatedSection index={0}>
          <VStack alignment="leading" spacing={12} padding={{ vertical: 8 }}>
            <HStack spacing={8}>
              <Image systemName="wifi.exclamationmark" foregroundStyle="systemOrange" />
              <Text fontWeight="semibold">读取失败</Text>
            </HStack>
            <Text foregroundStyle="systemRed">{error}</Text>
            <Button title="重新加载" systemImage="arrow.clockwise" buttonStyle="borderedProminent" action={load} />
          </VStack>
          </AnimatedSection>
        ) : info && props.identity ? (
          <VStack key="appstore-content" alignment="leading" spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
            <AnimatedSection index={0}>
              <AppHeader info={info} appid={props.identity.appid} region={props.identity.region} displayVersion={selectedNotes?.version} onSelectNotes={selectContentVersion} priceExpanded={priceExpanded} onTogglePrice={() => setPriceExpanded((value) => !value)} onChangeTextGradient={() => setTextGradientIndex((current) => current === null ? 0 : nextGradient(current))} onResetTextGradient={() => setTextGradientIndex(null)} foregroundStyle={textForeground} />
            </AnimatedSection>
            {priceExpanded ? (
              <>
                <CardDivider />
                <AnimatedSection index={1}>
                  <VStack alignment="leading" spacing={10} padding={{ horizontal: 16, vertical: 16 }} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
                    <RegionPriceList appid={props.identity.appid} foregroundStyle={textForeground} />
                  </VStack>
                </AnimatedSection>
              </>
            ) : null}
            <CardDivider />
            <AnimatedSection index={2}>
              <VStack alignment="leading" spacing={10} padding={{ horizontal: 16, vertical: 16 }} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
                <TranslatedBlock id="release-notes" contentIdentity={`${contentOwner}:${slots[0].identity}`} translationFirst content={slots[0].content || ""} emptyText={slots[0].emptyText} foregroundStyle={textForeground} gradientColors={textGradientIndex === null ? undefined : TEXT_GRADIENT_COLORS[textGradientIndex]} priority={3} translationDelayMs={0} translationEnabled={!loading} translationToken={contentToken + translationGeneration} translationHost={translationHost} isCancelled={() => contentSlotCancelled(0)} />
               </VStack>
            </AnimatedSection>
            <CardDivider />
            <AnimatedSection index={3}>
              <VStack alignment="leading" spacing={10} padding={{ horizontal: 16, vertical: 16 }} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
                <TranslatedBlock id="app-description" contentIdentity={`${contentOwner}:${slots[1].identity}`} translationFirst content={slots[1].content || ""} emptyText={slots[1].emptyText} foregroundStyle={textForeground} gradientColors={textGradientIndex === null ? undefined : TEXT_GRADIENT_COLORS[textGradientIndex]} priority={1} translationDelayMs={180} translationEnabled={!loading} translationToken={contentToken + translationGeneration} translationHost={translationHost} isCancelled={() => contentSlotCancelled(1)} />
               </VStack>
            </AnimatedSection>
          </VStack>
        ) : null}
        </>
      ) : null}
      </VStack>
    </ScrollView>
      )
    }}
    </ScrollViewReader>
  )
}
