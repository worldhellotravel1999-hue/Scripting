import {
  Button,
  Circle,
  HStack,
  Image,
  ProgressView,
  RoundedRectangle,
  ScrollView,
  Script,
  SecureField,
  Spacer,
  Text,
  TextField,
  VStack,
  ZStack,
  useEffect,
  useRef,
  useState,
} from "scripting"
import {
  addAppToAppRavenCollection,
  appRavenArtworkURL,
  appRavenUserIconURL,
  captureAppRavenSession,
  getActiveAppRavenAccount,
  getAppRavenAppIdFromITunesId,
  getAppRavenCollectionItemOrder,
  getAppRavenCollectionItems,
  getAppRavenCollectionOrder,
  getJoinedAppRavenCollectionIds,
  getRecentAppRavenCollections,
  getSavedAppRavenAccounts,
  getUserAppRavenCollections,
  isAppRavenLoggedOut,
  loginAppRaven,
  loginAppRavenCookie,
  readCachedJoinedState,
  readCachedUserCollections,
  refreshAppRavenAccountIcon,
  logoutAppRaven,
  recordRecentAppRavenCollection,
  removeAppFromAppRavenCollection,
  removeAppRavenAccount,
  removeAppRavenCollectionItemById,
  setAppRavenCollectionItemOrder,
  setAppRavenCollectionOrder,
  switchAppRavenAccount,
  writeCachedJoinedState,
  writeCachedUserCollections,
  type AppRavenCollection,
  type AppRavenCollectionItem,
  type AppRavenSession,
} from "../core/appraven"
import { AppStoreIcon } from "./app-store"
import { AnimatedSection } from "./animated-section"

const CARD_FILL = { light: "rgba(120,120,128,0.12)", dark: "#1C1C1E" } as const
/** 已加入合集的卡片底色：在 CARD_FILL 基础上透出一层淡绿（明暗各一档）。 */
const JOINED_CARD_FILL = { light: "rgba(52,199,89,0.10)", dark: "rgba(52,199,89,0.16)" } as const
/** 合集行两个按钮（单列并排切换 / 加减）的外层方框填充：浅灰（与顶部三钮同款双层嵌套：外灰框 + 内灰白圆）。 */
const TOP_BOX_FILL = { light: "rgba(120,120,128,0.18)", dark: "rgba(120,120,128,0.24)" } as const
/** 双层嵌套的内层圆形填充（按钮图标底座，外框用 TOP_BOX_FILL）。 */
const BUTTON_BOX_FILL = { light: "rgba(248,248,251,0.75)", dark: "rgba(240,240,245,0.70)" } as const
/** 展开合集内 App 图标与底部翻译记录行同款同尺寸（40）。 */
const SEARCH_PAGE_ICON_SIZE = 40
/** AppRaven 透明底蓝老鹰（官网 header logo，assets/ 随脚本分发）。 */
const APPROVEN_RAVEN_PATH = Script.directory + "/assets/appraven-raven.png"

/** 淡绿渐变（顶部浅 → 底部深），明暗模式各一档。 */
const GREEN_GRADIENT = {
  light: { startPoint: "top" as const, endPoint: "bottom" as const, colors: [`rgba(52,199,89,0.55)` as const, `rgba(40,167,74,0.95)` as const] },
  dark: { startPoint: "top" as const, endPoint: "bottom" as const, colors: [`rgba(72,219,112,0.60)` as const, `rgba(52,199,89,1.00)` as const] },
}
/** 淡红渐变（顶部浅 → 底部深）。 */
const RED_GRADIENT = {
  light: { startPoint: "top" as const, endPoint: "bottom" as const, colors: [`rgba(255,105,97,0.55)` as const, `rgba(245,66,60,0.95)` as const] },
  dark: { startPoint: "top" as const, endPoint: "bottom" as const, colors: [`rgba(255,125,120,0.60)` as const, `rgba(255,69,58,1.00)` as const] },
}
/** 蓝色渐变：单列/并排排版切换按钮专用（与加/减钮同结构，色系用蓝区分）。 */
const LAYOUT_GRADIENT = {
  light: { startPoint: "top" as const, endPoint: "bottom" as const, colors: [`rgba(90,170,255,0.55)` as const, `rgba(28,140,255,0.92)` as const] },
  dark: { startPoint: "top" as const, endPoint: "bottom" as const, colors: [`rgba(90,170,255,0.60)` as const, `rgba(10,132,255,1.00)` as const] },
}

/** Cookie 登录行出入场过渡：显示时淡入并从上方 10pt 轻轻落下，隐藏时淡出，下方行随弹簧回流。 */
const COOKIE_ROW_TRANSITION = Transition.asymmetric(
  Transition.opacity().combined(Transition.offset({ x: 0, y: -10 })),
  Transition.opacity(),
).animation(Animation.snappy({ duration: 0.32 }))

/** 登录页 ↔ 合集页互换：入场淡入 + 上浮 12pt，退场纯淡出。 */
const PAGE_TRANSITION = Transition.asymmetric(
  Transition.opacity().combined(Transition.offset({ x: 0, y: 12 })),
  Transition.opacity(),
).animation(Animation.snappy({ duration: 0.34 }))

/** 合集详情展开/收起：从卡片下缘轻落展开，收起纯淡出。 */
const DETAIL_TRANSITION = Transition.asymmetric(
  Transition.opacity().combined(Transition.offset({ x: 0, y: -8 })),
  Transition.opacity(),
).animation(Animation.snappy({ duration: 0.34 }))

/** 详情内条目（单列/并排）排版切换：淡入 + 轻微上浮。 */
const ITEM_TRANSITION = Transition.asymmetric(
  Transition.opacity().combined(Transition.offset({ x: 0, y: 8 })),
  Transition.opacity(),
).animation(Animation.snappy({ duration: 0.3 }))

/** 「已加入」小绿字出入场：纯淡现。 */
const JOIN_TAG_TRANSITION = Transition.opacity().animation(Animation.smooth({ duration: 0.28 }))



type Account = ReturnType<typeof getActiveAppRavenAccount>

type CollectionPageProps = {
  appid: string
  appTitle: string
  artworkUrl?: string
  foregroundStyle?: any
  /** 由 sheet 宿主传入：点关闭时把 sheet 收起。 */
  onClose?: () => void
  /** 登录态变化回传宿主：登出时宿主把弹窗重置回非全屏尺寸。 */
  onLoginStateChange?: (loggedIn: boolean) => void
  /** 弹窗全屏开关：当前是否全屏（由宿主持有）。 */
  fullscreen?: boolean
  /** 点击全屏按钮：全屏 ↔ 缩回登录页同尺寸。 */
  onToggleFullscreen?: () => void
  /** 内联模式（搜索页卡片）：未扩大时内容不包内层 ScrollView、自然高度撑开（整页滚动兕底）；
   *  扩大态（fullscreen）固定近全屏高度并恢复内滚防截断。全屏按钮照常显示。 */
  inline?: boolean
}

function errorText(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason || "未知错误")
}

/** 把列表切成每行 size 个（并排网格用）。 */
function chunkItems<T>(list: T[], size: number): T[][] {
  const rows: T[][] = []
  for (let index = 0; index < list.length; index += size) rows.push(list.slice(index, index + size))
  return rows
}

/**
 * 登录失败反馈：顶部错误文字已按用户要求删除，改为输入行轻微放大推一下（scale 不占布局、无裁切风险）。
 * trigger（错误文案）变化即推一下，240ms 后复位。
 */
function useErrorNudge(trigger: string) {
  const [scale, setScale] = useState(1)
  useEffect(() => {
    if (!trigger) return
    setScale(1.045)
    const timer = setTimeout(() => setScale(1), 240)
    return () => clearTimeout(timer)
  }, [trigger])
  return scale
}


/** 顶部方框钮：双层嵌套——外层 TOP_BOX_FILL 浅灰方框 + 内层 BUTTON_BOX_FILL 灰白圆形图标（外框 40×40 与行头对齐）。图标带呼吸灯（opacity 随 pulse 在 1 ↔ 0.45 间往复）。 */
function RoundIconButton(props: { systemName: string; tint?: any; pulse: number; onTap: () => void }) {
  return (
    <Button buttonStyle="plain" action={props.onTap}>
      <HStack
        padding={{ horizontal: 4, vertical: 4 }}
        background={<RoundedRectangle fill={TOP_BOX_FILL} cornerRadius={10} />}
        clipShape={{ type: "rect", cornerRadius: 10, style: "continuous" }}
      >
        <Image
          systemName={props.systemName}
          font={16}
          foregroundStyle={props.tint ?? { light: "#000000", dark: "#FFFFFF" }}
          frame={{ width: 32, height: 32 }}
          background={{ style: BUTTON_BOX_FILL, shape: "circle" }}
          opacity={props.pulse === 0 ? 1 : 0.45}
          animation={{ animation: Animation.easeOut(1.05), value: props.pulse }}
        />
      </HStack>
    </Button>
  )
}

/**
 * 合集行的加入/移除按钮：位于行头白色方框内（方框由外层容器提供），加减符号渐变配色。
 * 展开/收起小箭头固定淡灰色（secondaryLabel），偏在方框右下角内侧，随状态反转方向（收起=向下、展开=向上）。
 * 点按（tick 变化）时符号弹跳 + 整体缩放回弹（popped）。
 */
export function CollectionJoinButton(props: {
  isJoined: boolean
  expanded: boolean
  tick: number
  popped: boolean
  /** 「已加入」状态同步完成前禁用（变淡防误点）。 */
  disabled?: boolean
  onTap: () => void
}) {
  const gradient = props.isJoined ? RED_GRADIENT : GREEN_GRADIENT
  return (
    <Button buttonStyle="plain" action={props.onTap} disabled={props.disabled === true}>
      <ZStack frame={{ width: 32, height: 32 }} opacity={props.disabled === true ? 0.4 : 1} animation={{ animation: Animation.smooth({ duration: 0.28 }), value: props.disabled === true }}>
        {/* 双层嵌套内圆：与顶部刷新钮同款（外灰框由调用处提供，此处是内层灰白圆）。 */}
        <Circle fill={BUTTON_BOX_FILL} />
        <ZStack
          frame={{ width: 32, height: 32 }}
          opacity={props.popped ? 1 : 0.78}
          animation={{ animation: Animation.snappy({ duration: 0.32, extraBounce: 0.35 }), value: props.popped }}
        >
          <Image
            systemName={props.isJoined ? "minus.circle.fill" : "plus.circle.fill"}
            font={22}
            foregroundStyle={gradient}
            contentTransition="symbolEffect"
            symbolEffect={{ effect: "bounce", value: props.tick }}
            scaleEffect={props.popped ? 1.16 : 1}
            animation={{ animation: Animation.snappy({ duration: 0.32, extraBounce: 0.4 }), value: props.popped }}
          />
          <Image
            systemName={props.expanded ? "chevron.up" : "chevron.down"}
            font={9}
            fontWeight="bold"
            foregroundStyle="secondaryLabel"
            opacity={0.95}
            offset={{ x: 9, y: 9 }}
            contentTransition="symbolEffect"
            symbolEffect={{ effect: "bounce", value: props.tick }}
          />
        </ZStack>
      </ZStack>
    </Button>
  )
}

/**
 * 单列/并排排版切换按钮：双层嵌套——内层灰白圆底（外层灰框由调用处提供，同顶部刷新钮）。
 * 图标随当前排版反向提示可切到的模式（并排→列表图标、单列→网格图标）。
 * 附呼吸灯：opacity 随 deletePulse 在 1 ↔ 0.45 间往复（圆底与图标一起呼吸）。
 */
function LayoutToggleButton(props: { grid: boolean; pulse: number; onTap: () => void }) {
  return (
    <Button buttonStyle="plain" action={props.onTap}>
      <ZStack
        frame={{ width: 32, height: 32 }}
        background={{ style: BUTTON_BOX_FILL, shape: "circle" }}
        opacity={props.pulse === 0 ? 1 : 0.45}
        animation={{ animation: Animation.easeOut(1.05), value: props.pulse }}
      >
        <Image
          systemName={props.grid ? "list.bullet" : "square.grid.2x2"}
          font={15}
          foregroundStyle={LAYOUT_GRADIENT}
        />
      </ZStack>
    </Button>
  )
}

type CollectionLoadStage = "resolving" | "collections" | "ready"

/** 登录输入行：图标 + 内嵌输入框，同搜索页搜索框的灰底圆角风格。grow 时行高扩大约 10%（竖向 padding 8→10）。errored 时底色短暂泛红（登录失败反馈；不叫 alert——会与内置对话框属性撞名）。 */
function LoginFieldRow(props: { systemName: string; children: any; grow?: boolean; errored?: boolean }) {
  const fill = (props.errored
    ? { light: "rgba(255,59,48,0.16)", dark: "rgba(255,69,58,0.22)" }
    : { light: "rgba(120,120,128,0.08)", dark: "rgba(120,120,128,0.14)" }) as any
  return (
    <HStack
      spacing={8}
      padding={{ horizontal: 12, vertical: props.grow ? 10 : 8 }}
      frame={{ maxWidth: "infinity" }}
      background={<RoundedRectangle fill={fill} cornerRadius={14} />}
      clipShape={{ type: "rect", cornerRadius: 14, style: "continuous" }}
      animation={{ animation: Animation.smooth({ duration: 0.28 }), value: props.errored === true }}
    >
      <Image systemName={props.systemName} font={15} foregroundStyle="tertiaryLabel" />
      {props.children}
    </HStack>
  )
}

/**
 * 单页合集：登录表单、合集列表、合集详情全部在同一页内切换。
 * 页面本身由 app-store.tsx 的 sheet 窗口承载，关闭通过 props.onClose 上抛。
 */
/** 合集页滚动包装：sheet 模式包 ScrollView（弹窗固定 detent 内滚）；inline 自然高度态（未扩大）不包，
 *  内容自然高度撑开、卡片随合集数量变高，由搜索页整页滚动兕底；inline 扩大态（固定高度）恢复内滚防截断。 */
function PageScroll(props: { inline?: boolean; fullscreen?: boolean; children?: any; transition?: any }) {
  if (props.inline && !props.fullscreen) {
    return <VStack spacing={0} frame={{ maxWidth: "infinity" }} transition={props.transition}>{props.children}</VStack>
  }
  return <ScrollView frame={{ maxWidth: "infinity", maxHeight: "infinity" }} transition={props.transition}>{props.children}</ScrollView>
}

function SinglePageCollections(props: CollectionPageProps) {
  const [account, setAccount] = useState<Account>(() => getActiveAppRavenAccount())
  const [session, setSession] = useState<AppRavenSession | null>(() => {
    try {
      const active = getActiveAppRavenAccount()
      return active ? captureAppRavenSession(active.id) : null
    } catch {
      return null
    }
  })
  const [loginTick, setLoginTick] = useState(0)

  // 登录表单（内联，不跳页）
  const [principal, setPrincipal] = useState("")
  const [password, setPassword] = useState("")
  const [cookie, setCookie] = useState("")
  // Cookie 登录行默认隐藏：轻点左上角老鹰图标显示/隐藏，长按老鹰图标执行登录。
  const [cookieRowVisible, setCookieRowVisible] = useState(false)
  // 长按登录后松手可能再触发一次按钮点击，短暂吞掉那一次，避免误把刚显示的行收起。
  const ravenTapGuardRef = useRef(false)
  const [loginLoading, setLoginLoading] = useState(false)
  const [loginError, setLoginError] = useState("")
  const loginErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 顶部提示胶囊只显示 1 秒，自动关闭。
  useEffect(() => {
    if (!loginError) return
    if (loginErrorTimerRef.current) clearTimeout(loginErrorTimerRef.current)
    loginErrorTimerRef.current = setTimeout(() => {
      loginErrorTimerRef.current = null
      setLoginError("")
    }, 1000)
    return () => {
      if (loginErrorTimerRef.current) clearTimeout(loginErrorTimerRef.current)
      loginErrorTimerRef.current = null
    }
  }, [loginError])
  const [accounts, setAccounts] = useState(() => getSavedAppRavenAccounts())
  // 登录失败反馈：输入行放大轻推 + 红底闪现（顶部文字提示已删）。
  const errorNudge = useErrorNudge(loginError)

  // 开页缓存（共享存储，分享页 ↔ 搜索页、跨进程互通）：
  // 合集列表是账号级数据（同一账号查任何 App 都一样），已加入状态按 App 单独记。
  // 命中即作为首帧内容，网络只做后台静默校验——打开不再转圈重载。
  const bootCollections = account ? readCachedUserCollections(account.id) : null
  const bootJoined = account ? readCachedJoinedState(account.id, props.appid) : null

  // 合集列表
  const [collections, setCollections] = useState<AppRavenCollection[]>(() => bootCollections ?? [])
  const [joined, setJoined] = useState<Set<string>>(() => new Set(bootJoined?.joinedIds ?? []))
  const [internalAppId, setInternalAppId] = useState(bootJoined?.internalAppId ?? "")
  const [stage, setStage] = useState<CollectionLoadStage>(bootCollections ? "ready" : "resolving")
  const [stageError, setStageError] = useState("")
  const [recentOrder, setRecentOrder] = useState<string[]>(() => {
    try {
      const active = getActiveAppRavenAccount()
      return active ? getRecentAppRavenCollections(active.id) : []
    } catch {
      return []
    }
  })
  const operationChains = useRef(new Map<string, Promise<void>>())
  const cancelledRef = useRef(false)
  // 当前展示数据所属的「账号:App」键：load() 据此判断套用缓存 / 清理旧账号数据，
  // persist 据此防止把旧账号的数据写进新账号的缓存。"" = 尚无数据。
  const shownSnapshotKeyRef = useRef(account ? `${account.id}:${props.appid}` : "")
  // 是否已完成过一次合集加载（或加载失败）——首次加载期间 collections 还是空的，
  // 顶部回退按钮行若不加门槛会先闪出三钮再随数据到达消失（“第一次进入有缓存”现象）。
  // 开页缓存命中时首帧即视为已知（数据是上次的真实结果），只做后台静默校验。
  const everLoadedRef = useRef(bootCollections !== null)
  // 「已加入」同步代数：每次本地乐观改写（加/减/删除条目）+1；load() 发起同步时记下代数，
  // 结果返回时若代数已变（用户期间动过手），丢弃这份先于操作取回的旧结果，避免覆盖刚点出来的状态。
  const joinedEpochRef = useRef(0)
  // 首次「已加入」状态是否已按 AUTHOR 条目同步完成；完成前加/减按钮禁用，
  // 防止在「不知道到底加没加」的空集状态上误点（这是「未加入却变成已加入」的窗口之一）。
  // 开页缓存里已有本 App 的已加入状态 → 首帧即可点，后台校验会静默纠正。
  const [joinedSynced, setJoinedSynced] = useState(bootJoined !== null)

  // 合集详情（内联展开，不跳页）
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [expandedItems, setExpandedItems] = useState<Record<string, AppRavenCollectionItem[]>>({})
  const [expandedLoading, setExpandedLoading] = useState<Record<string, boolean>>({})
  const [expandedError, setExpandedError] = useState<Record<string, string>>({})
  const [removingItemId, setRemovingItemId] = useState<string | null>(null)
  // 长按排序：外层合集与合集内 App 各自独立，本地记住顺序
  const [sortCollectionId, setSortCollectionId] = useState<string | null>(null)
  const [sortItemContext, setSortItemContext] = useState<{ collectionId: string; itemId: string } | null>(null)
  const [manualCollectionOrder, setManualCollectionOrder] = useState<string[]>(() => {
    try {
      const active = getActiveAppRavenAccount()
      return active ? getAppRavenCollectionOrder(active.id) : []
    } catch {
      return []
    }
  })
  const [manualItemOrders, setManualItemOrders] = useState<Record<string, string[]>>({})
  const [pressedCollectionId, setPressedCollectionId] = useState<string | null>(null)
  const [pressedItemId, setPressedItemId] = useState<string | null>(null)

  // 展开列表排版：单列（默认）/ 并排网格，存共享存储下次打开记住。
  const [detailGrid, setDetailGrid] = useState<boolean>(() => {
    try { return Storage.get("lingo_appraven_detail_grid_v1", { shared: true }) === true } catch { return false }
  })
  function toggleDetailGrid() {
    // 单列 ↔ 并排换排版时给条目出入场（ITEM_TRANSITION）。
    withAnimation(() => {
      setDetailGrid(previous => {
        const next = !previous
        try { Storage.set("lingo_appraven_detail_grid_v1", next, { shared: true }) } catch {}
        return next
      })
    })
  }

  // 呼吸动效：tick 在 0/1 间往复，透明度随之渐变。
  // 账号行删除钮、展开详情删除钮、合集行排版切换钮共用，故常驻。
  // Scripting 无 setInterval，用 setTimeout 链。
  const [deletePulse, setDeletePulse] = useState(0)
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    let stopped = false
    const schedule = () => {
      pulseTimerRef.current = setTimeout(() => {
        if (stopped) return
        setDeletePulse(value => 1 - value)
        schedule()
      }, 1100)
    }
    schedule()
    return () => {
      stopped = true
      if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current)
      pulseTimerRef.current = null
    }
  }, [])

  // 防误删：删除钮需点两下（第一下武装变红，1.5 秒内再点才真删，超时自动解除）。
  const [deleteArmedId, setDeleteArmedId] = useState<string | null>(null)
  const deleteArmedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  function disarmDelete() {
    if (deleteArmedTimerRef.current) {
      clearTimeout(deleteArmedTimerRef.current)
      deleteArmedTimerRef.current = null
    }
    setDeleteArmedId(null)
  }
  useEffect(() => {
    return () => {
      if (deleteArmedTimerRef.current) clearTimeout(deleteArmedTimerRef.current)
      deleteArmedTimerRef.current = null
    }
  }, [])

  // 加/减收藏与展开箭头的联动小特效：点按 +/− 时 tick 递增驱动符号弹跳、
  // popped 短暂为真驱动缩放回弹；同一行右侧的展开箭头同步变色（加=绿 / 减=红）轻摆。
  const [fxTick, setFxTick] = useState<Record<string, number>>({})
  const [fxPop, setFxPop] = useState<Record<string, boolean>>({})
  const fxTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  useEffect(() => {
    const timers = fxTimersRef.current
    return () => {
      timers.forEach(timer => clearTimeout(timer))
      timers.clear()
    }
  }, [])

  function playToggleFx(collectionId: string) {
    setFxTick(previous => ({ ...previous, [collectionId]: (previous[collectionId] ?? 0) + 1 }))
    setFxPop(previous => ({ ...previous, [collectionId]: true }))
    const existing = fxTimersRef.current.get(collectionId)
    if (existing) clearTimeout(existing)
    fxTimersRef.current.set(collectionId, setTimeout(() => {
      setFxPop(previous => {
        if (!previous[collectionId]) return previous
        const next = { ...previous }
        delete next[collectionId]
        return next
      })
      fxTimersRef.current.delete(collectionId)
    }, 380))
  }

  const loggedIn = !!account && !!session && !isAppRavenLoggedOut()
  // 登录态回传宿主：登出时宿主把弹窗重置回登录页同尺寸（非全屏）。
  useEffect(() => {
    props.onLoginStateChange?.(loggedIn)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn])

  function reloadAccount() {
    // 登录页 ↔ 合集页互换在同一个动画事务里播（PAGE_TRANSITION 淡入上浮）。
    withAnimation(() => {
      const active = getActiveAppRavenAccount()
      setAccount(active)
      try {
        setSession(active ? captureAppRavenSession(active.id) : null)
      } catch {
        setSession(null)
      }
      setAccounts(getSavedAppRavenAccounts())
      setLoginTick(value => value + 1)
      if (active) {
        try {
          setRecentOrder(getRecentAppRavenCollections(active.id))
          setManualCollectionOrder(getAppRavenCollectionOrder(active.id))
        } catch {}
      } else {
        setManualCollectionOrder([])
      }
      setManualItemOrders({})
      setSortCollectionId(null)
      setSortItemContext(null)
      setExpandedId(null)
    })
  }

  // 登录页挂载时后台刷新已保存账号的头像（老账号无 icon 字段时补上）。
  useEffect(() => {
    if (loggedIn) return
    let cancelled = false
    void (async () => {
      const saved = getSavedAppRavenAccounts()
      let changed = false
      for (const item of saved) {
        if (cancelled) return
        try {
          const ok = await refreshAppRavenAccountIcon(item.id)
          if (ok) changed = true
        } catch {}
      }
      if (!cancelled && changed) setAccounts(getSavedAppRavenAccounts())
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function submitPassword() {
    const name = principal.trim()
    if (!name || !password) {
      setLoginError("请输入账号和密码")
      return
    }
    setLoginError("")
    setLoginLoading(true)
    try {
      const user = await loginAppRaven(name, password)
      setPassword("")
      setPrincipal("")
      reloadAccount()
      void refreshAppRavenAccountIcon(user.id).then(ok => { if (ok) setAccounts(getSavedAppRavenAccounts()) }).catch(() => {})
      showCollectionToast(`已登录：${user.displayName || name}`)
    } catch (reason) {
      setLoginError(`登录失败：${errorText(reason)}`)
    } finally {
      setLoginLoading(false)
    }
  }

  async function submitCookie() {
    const value = cookie.trim()
    if (!value) {
      setLoginError("请先粘贴 AppRaven 会话 Cookie")
      return
    }
    setLoginError("")
    setLoginLoading(true)
    try {
      const user = await loginAppRavenCookie(value)
      setCookie("")
      reloadAccount()
      void refreshAppRavenAccountIcon(user.id).then(ok => { if (ok) setAccounts(getSavedAppRavenAccounts()) }).catch(() => {})
      showCollectionToast(`已登录：${user.displayName || user.username || "AppRaven 账号"}`)
    } catch (reason) {
      setLoginError(`登录失败：${errorText(reason)}`)
    } finally {
      setLoginLoading(false)
    }
  }

  /** 回车登录：与长按老鹰图标同一套逻辑（有 Cookie 走 Cookie，否则账号密码）。 */
  function submitFromKeyboard() {
    if (loginLoading) return
    void (cookie.trim() ? submitCookie() : submitPassword())
  }

  /** 长按左上角老鹰图标：执行登录（即原先点击图标的登录逻辑）。 */
  function loginFromRavenIcon() {
    if (loginLoading) return
    // 长按识别后松手可能再补一次点按，先把接下来 ~0.7s 内的点按吞掉，避免误收起 Cookie 行。
    ravenTapGuardRef.current = true
    setTimeout(() => { ravenTapGuardRef.current = false }, 700)
    try { HapticFeedback.lightImpact() } catch {}
    void (cookie.trim() ? submitCookie() : submitPassword())
  }

  /** 轻点左上角老鹰图标：显示 / 隐藏下方的 Cookie 登录行。 */
  function toggleCookieRow() {
    if (ravenTapGuardRef.current) return
    withAnimation(() => setCookieRowVisible(value => !value))
  }

  function selectAccount(id: string) {
    if (deleteArmedId) disarmDelete()
    if (!switchAppRavenAccount(id)) {
      setLoginError("该账号会话已失效，请重新登录")
      return
    }
    setLoginError("")
    reloadAccount()
  }

  async function load() {
    const activeSession = session
    const activeAccount = account
    if (!activeSession || !activeAccount) return
    cancelledRef.current = false
    // 开页缓存判定：当前展示数据是否已属于「本账号 + 本 App」。
    // 不是 → 先套用该账号/该 App 的缓存（首帧直接呈现），无缓存则清掉旧账号数据回冷加载。
    const activeKey = `${activeAccount.id}:${props.appid}`
    if (shownSnapshotKeyRef.current !== activeKey) {
      const cachedList = readCachedUserCollections(activeAccount.id)
      const cachedJoined = readCachedJoinedState(activeAccount.id, props.appid)
      shownSnapshotKeyRef.current = activeKey
      if (cachedList || cachedJoined) {
        withAnimation(() => {
          if (cachedList) {
            setCollections(cachedList)
            setStage("ready")
          } else {
            setStage("resolving")
          }
          if (cachedJoined) {
            setInternalAppId(cachedJoined.internalAppId)
            setJoined(new Set(cachedJoined.joinedIds))
          }
        })
        everLoadedRef.current = true
        if (cachedJoined) setJoinedSynced(true)
      } else {
        // 换到无缓存的账号：清掉上一账号的展示数据，回到冷加载。
        withAnimation(() => {
          setCollections([])
          setJoined(new Set())
          setInternalAppId("")
          setStage("resolving")
        })
        everLoadedRef.current = false
        setJoinedSynced(false)
      }
    }
    // 命中缓存（或数据已知）→ 静默后台校验：不闪「正在定位/正在加载」行，也不锁加/减按钮。
    const hasCache = everLoadedRef.current
    if (!hasCache) {
      withAnimation(() => setStage("resolving"))
      // 重新加载期间先禁用加/减按钮，直到新一轮「已加入」同步完成。
      setJoinedSynced(false)
    }
    setStageError("")
    try {
      const appId = await getAppRavenAppIdFromITunesId(props.appid, activeSession)
      if (cancelledRef.current) return
      setInternalAppId(appId)
      withAnimation(() => setStage("collections"))
      const mine = await getUserAppRavenCollections(activeAccount.id, activeSession)
      if (cancelledRef.current) return
      // 列表卡片 AnimatedSection 入场 + 顶部按钮行出入场同一事务。
      withAnimation(() => {
        setCollections(mine)
        setStage("ready")
      })
      everLoadedRef.current = true
      // 「已加入」改按 AUTHOR 条目判定（与展开列表、加/减 mutation 同源同数据）。
      // 旧的 app(id).collections 语义不符（含非成员合集）且间歇 500，
      // 是「明明没加入却显示已加入 / 同步时好时坏」的根因之一。
      const epoch = joinedEpochRef.current
      try {
        const ids = await getJoinedAppRavenCollectionIds(appId, mine.map(item => item.id), activeSession)
        if (cancelledRef.current) return
        // 同步进行中用户动过手（代数已变）→ 丢弃这份旧结果，保留本地已确认状态。
        if (epoch === joinedEpochRef.current) {
          withAnimation(() => setJoined(ids))
        }
        setJoinedSynced(true)
      } catch (reason) {
        if (cancelledRef.current) return
        // 同步失败不写入不完整结果；保持按钮禁用并给出重试入口，
        // 避免在错误的空集状态上放行加/减操作。
        withAnimation(() => setStageError(`已加入状态同步失败：${errorText(reason)}（点重试重新同步）`))
        showCollectionToast(`已加入状态同步失败：${errorText(reason)}`, true)
      }
    } catch (reason) {
      if (cancelledRef.current) return
      withAnimation(() => setStageError(`AppRaven 会话已失效，请重新登录：${errorText(reason)}`))
    }
  }

  // 当前展示状态写回共享缓存（含本地乐观改动）：下次打开（分享页 ↔ 搜索页、跨进程）首帧即呈现。
  // 必须声明在下面的加载 effect 之前：换账号时先守卫跳过（此刻 collections 还是旧账号的），
  // 等 load() 同步套用新账号缓存/清空、数据落定后的下一次提交再写，避免串号。
  // 「已加入」只在同步完成后才写，防止把未确认的空状态缓存成真值。
  useEffect(() => {
    if (!account || !everLoadedRef.current) return
    if (shownSnapshotKeyRef.current !== `${account.id}:${props.appid}`) return
    writeCachedUserCollections(account.id, collections)
    if (joinedSynced && internalAppId) writeCachedJoinedState(account.id, props.appid, internalAppId, Array.from(joined))
  }, [collections, joined, joinedSynced, internalAppId, account?.id, props.appid])

  useEffect(() => {
    if (!loggedIn) return
    cancelledRef.current = false
    void load()
    return () => {
      cancelledRef.current = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.id, props.appid, loginTick])

  function enqueue(id: string, task: () => Promise<void>) {
    const previous = operationChains.current.get(id) || Promise.resolve()
    const next = previous.then(task, task).catch(() => {})
    operationChains.current.set(id, next)
  }

  function updateJoined(id: string, value: boolean) {
    // 本地状态被改写 → 同步代数 +1，使仍在飞行中的同步结果作废（防旧数据覆盖）。
    joinedEpochRef.current += 1
    // 「已加入」绿字出入场 + 卡片底色变化同一动画事务。
    withAnimation(() => {
      setJoined(previous => {
        const next = new Set(previous)
        if (value) next.add(id)
        else next.delete(id)
        return next
      })
      setCollections(previous => previous.map(item => item.id === id
        ? { ...item, appCount: Math.max(0, item.appCount + (value ? 1 : -1)) }
        : item))
    })
  }

  function toggleCollection(collection: AppRavenCollection) {
    // 首次「已加入」尚未同步完成：不接受加/减（按钮同时已禁用，这里兜底）。
    if (!joinedSynced) return
    if (!session || !account || !internalAppId) {
      showCollectionToast("AppRaven 会话已失效，请重新登录", true)
      return
    }
    playToggleFx(collection.id)
    const activeSession = session
    const activeAccountId = account.id
    const isJoined = joined.has(collection.id)
    updateJoined(collection.id, !isJoined)
    if (!isJoined) {
      enqueue(collection.id, async () => {
        try {
          await addAppToAppRavenCollection(internalAppId, collection.id, activeSession)
          try {
            recordRecentAppRavenCollection(activeAccountId, collection.id)
            setRecentOrder(getRecentAppRavenCollections(activeAccountId))
          } catch {}
          // 加入后他在详情里的条目未知，失效该合集的展开缓存，下次展开重拉
          setExpandedItems(previous => {
            if (!(collection.id in previous)) return previous
            const next = { ...previous }
            delete next[collection.id]
            return next
          })
          if (expandedId === collection.id) void loadExpanded(collection, true)
          showCollectionToast(`已加入「${collection.title}」`)
        } catch (reason) {
          updateJoined(collection.id, false)
          showCollectionToast(`「${collection.title}」加入失败：${errorText(reason)}`, true)
        }
      })
    } else {
      enqueue(collection.id, async () => {
        try {
          const removed = await removeAppFromAppRavenCollection(collection.id, internalAppId, activeSession)
          if (!removed) {
            // 服务器上本来就没有这条（外部已移除/状态过期）→真实状态就是「未加入」：
            // 保持未加入，只把乐观多减的计数恢复，不再回写成「已加入」（旧逻辑的错点）。
            withAnimation(() => {
              setCollections(previous => previous.map(item => item.id === collection.id
                ? { ...item, appCount: item.appCount + 1 }
                : item))
            })
            showCollectionToast(`「${collection.title}」中本来就没有这个 App，已按未加入显示`, true)
          } else {
            // 同步展开缓存里的当前 App
            setExpandedItems(previous => {
              const list = previous[collection.id]
              if (!list) return previous
              return { ...previous, [collection.id]: list.filter(item => item.app?.id !== internalAppId) }
            })
            showCollectionToast(`已从「${collection.title}」移除`)
          }
        } catch (reason) {
          updateJoined(collection.id, true)
          showCollectionToast(`「${collection.title}」移除失败：${errorText(reason)}`, true)
        }
      })
    }
  }

  async function loadExpanded(collection: AppRavenCollection, force = false) {
    if (!session || !account) return
    if (!force && expandedItems[collection.id]) {
      ensureItemOrder(collection)
      return
    }
    setExpandedLoading(previous => ({ ...previous, [collection.id]: true }))
    setExpandedError(previous => {
      const next = { ...previous }
      delete next[collection.id]
      return next
    })
    try {
      const all: AppRavenCollectionItem[] = []
      let page = 0
      let hasNext = true
      while (hasNext && page < 200) {
        const result = await getAppRavenCollectionItems(collection.id, page, session)
        all.push(...result.content)
        hasNext = result.hasNext
        page += 1
      }
      setExpandedItems(previous => ({ ...previous, [collection.id]: all }))
      ensureItemOrder(collection)
    } catch (reason) {
      setExpandedError(previous => ({ ...previous, [collection.id]: errorText(reason) }))
    } finally {
      setExpandedLoading(previous => ({ ...previous, [collection.id]: false }))
    }
  }

  function toggleExpand(collection: AppRavenCollection) {
    // 展开/收起在动画事务里（DETAIL_TRANSITION 轻落展开）。
    if (expandedId === collection.id) {
      withAnimation(() => setExpandedId(null))
      return
    }
    withAnimation(() => setExpandedId(collection.id))
    void loadExpanded(collection)
  }

  async function removeExpandedItem(collection: AppRavenCollection, item: AppRavenCollectionItem) {
    if (!session || !account) return
    if (removingItemId) {
      showCollectionToast("正在删除，请稍候", true)
      return
    }
    const activeSession = session
    const activeAccountId = account.id
    setRemovingItemId(item.id)
    const previous = expandedItems[collection.id] || []
    const nextList = previous.filter(current => current.id !== item.id)
    // 乐观移除：条目滑出淡出（ITEM_TRANSITION）。
    withAnimation(() => {
      setExpandedItems(prev => ({ ...prev, [collection.id]: nextList }))
      setManualItemOrders(prev => ({ ...prev, [collection.id]: nextList.map(entry => entry.id) }))
    })
    try {
      await removeAppRavenCollectionItemById(collection.id, item.id, activeSession)
      if (item.app?.id === internalAppId) updateJoined(collection.id, false)
      setCollections(prev => prev.map(entry => entry.id === collection.id
        ? { ...entry, appCount: Math.max(0, entry.appCount - 1) }
        : entry))
      try { setAppRavenCollectionItemOrder(activeAccountId, collection.id, nextList.map(entry => entry.id)) } catch {}
      showCollectionToast(`已从「${collection.title}」移除`)
    } catch (reason) {
      withAnimation(() => {
        setExpandedItems(prev => ({ ...prev, [collection.id]: previous }))
      })
      showCollectionToast(`「${item.app?.title || "该 App"}」移除失败：${errorText(reason)}`, true)
    } finally {
      setRemovingItemId(null)
    }
  }

  function persistManualOrder(next: AppRavenCollection[]) {
    if (!account) return
    setManualCollectionOrder(next.map(item => item.id))
    try { setAppRavenCollectionOrder(account.id, next.map(item => item.id)) } catch {}
  }

  function moveCollection(id: string, direction: -1 | 1) {
    const index = ordered.findIndex(item => item.id === id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= ordered.length) return
    const next = [...ordered]
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved)
    // 排序上下移动：列表重排带动画。
    withAnimation(() => {
      setCollections(prev => {
        const ids = new Set(next.map(item => item.id))
        const untouched = prev.filter(item => !ids.has(item.id))
        return [...next, ...untouched]
      })
    })
    persistManualOrder(next)
  }

  function moveExpandedItem(collection: AppRavenCollection, itemId: string, direction: -1 | 1) {
    if (!account) return
    const list = sortedExpandedItems(collection)
    const index = list.findIndex(item => item.id === itemId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= list.length) return
    const next = [...list]
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved)
    // 合集内条目排序：重排带动画。
    withAnimation(() => {
      setExpandedItems(prev => ({ ...prev, [collection.id]: next }))
      setManualItemOrders(prev => ({ ...prev, [collection.id]: next.map(entry => entry.id) }))
    })
    try { setAppRavenCollectionItemOrder(account.id, collection.id, next.map(entry => entry.id)) } catch {}
  }

  function sortedExpandedItems(collection: AppRavenCollection) {
    const list = expandedItems[collection.id] || []
    const manual = manualItemOrders[collection.id]
    const order = manual || (() => {
      if (!account) return []
      try { return getAppRavenCollectionItemOrder(account.id, collection.id) } catch { return [] }
    })()
    if (order.length === 0) return list
    const byId = new Map(list.map(item => [item.id, item]))
    return [
      ...order.map(id => byId.get(id)).filter((item): item is AppRavenCollectionItem => !!item),
      ...list.filter(item => !order.includes(item.id)),
    ]
  }

  function ensureItemOrder(collection: AppRavenCollection) {
    if (!account || manualItemOrders[collection.id]) return
    try {
      const saved = getAppRavenCollectionItemOrder(account.id, collection.id)
      if (saved.length > 0) setManualItemOrders(prev => ({ ...prev, [collection.id]: saved }))
    } catch {}
  }

  const filtered = collections
  const manualFirst = manualCollectionOrder.length > 0 ? [
    ...manualCollectionOrder.map(id => filtered.find(item => item.id === id)).filter((item): item is AppRavenCollection => !!item),
    ...filtered.filter(item => !manualCollectionOrder.includes(item.id)),
  ] : filtered
  const recentFirst = [
    ...recentOrder.map(id => manualFirst.find(item => item.id === id)).filter((item): item is AppRavenCollection => !!item),
    ...manualFirst.filter(item => !recentOrder.includes(item.id)),
  ]
  const ordered = [...recentFirst].sort((a, b) => Number(joined.has(b.id)) - Number(joined.has(a.id)))

  // 登录表单（未登录）：扁平子节点数组。
  // 不再插入弹性 Spacer——旧版靠 Spacer 纵向撑满卡片，但弹窗 detent 高度固定，
  // 内容（多账号行 / 长 Cookie / 键盘弹出）超过弹窗高度时 Spacer 归零仍会溢出被裁切；
  // 现改为固定间距 + 外层 ScrollView，超出可滚动，任何账号数量都能看全。
  const loginFormChildren: any[] = []
  const pushLoginFormBlock = (node: any, _tight = false) => {
    loginFormChildren.push(node)
  }
  // 顶部提示词胶囊（loginError）已按用户要求整体删除，不再显示任何顶部提示；
  // 失败反馈改为输入行红底闪现 + 放大轻推（alert / errorNudge），块间用 AnimatedSection 级联入场。
  pushLoginFormBlock(
    <AnimatedSection key="login-header" index={0}>
      <HStack key="login-header-row" spacing={8} padding={{ leading: 60, trailing: 40 }} frame={{ maxWidth: "infinity" }}>
      {/* 左上角老鹰图标：轻点 = 显示/隐藏下方 Cookie 登录行；长按 = 登录（原点击登录逻辑）。
          手势挂在普通 ZStack 上（本环境没有 Button 直接挂手势的先例）；长按后松手补出的那一次点按由 ravenTapGuardRef 吞掉。 */}
      <ZStack
        frame={{ width: 67, height: 67 }}
        disabled={loginLoading}
        contentShape="rect"
        onTapGesture={toggleCookieRow}
        onLongPressGesture={{ minDuration: 450, perform: loginFromRavenIcon }}
      >
        <Circle
          fill={(cookieRowVisible
            ? { light: "rgba(0,122,255,0.16)", dark: "rgba(10,132,255,0.26)" }
            : { light: "rgba(142,142,147,0.18)", dark: "rgba(142,142,147,0.28)" }) as any}
          animation={{ animation: Animation.smooth({ duration: 0.32 }), value: cookieRowVisible }}
        />
        {loginLoading ? (
          <ProgressView />
        ) : (
          <Image
            filePath={APPROVEN_RAVEN_PATH}
            resizable
            aspectRatio={{ contentMode: "fit" }}
            frame={{ width: 55, height: 55 }}
          />
        )}
      </ZStack>
      <Spacer />
      </HStack>
    </AnimatedSection>
  )
  // 已保存账号行：紧跟登录头（蓝老鹰图标）正下方、偏右一点（图标右下面的旁边），不加弹性 Spacer（tight）。
  // 无背景、整体缩小；右侧删除钮 offset x +10（只改绘制与点按区，不动布局）。
  // 删除钮双层嵌套（10-01 定稿）：外层 TOP_BOX_FILL 浅灰圆 + 内层纯白圆（不要灰白 BUTTON_BOX_FILL，用户明确要白色）+ × 静止态淡粉 #FFC0CB（恢复原色，用户要求）；点按确认时 × 变红；整体 23pt。
  // 切换按钮已删：切换账号功能移到行头头像上（点头像即切换到该账号）。
  if (accounts.length > 0) {
    pushLoginFormBlock(
      <AnimatedSection key="login-accounts" index={1}>
      <VStack key="login-accounts-rows" alignment="leading" spacing={8} padding={{ leading: 180, trailing: 40, top: 10 }} offset={{ x: 0, y: -35 }} frame={{ maxWidth: "infinity" }}>
        {accounts.map(item => (
          <HStack
            key={item.id}
            spacing={8}
            padding={{ horizontal: 4, vertical: 4 }}
            frame={{ maxWidth: "infinity" }}
          >
            <Button buttonStyle="plain" action={() => selectAccount(item.id)}>
              <Image
                imageUrl={appRavenUserIconURL(item.iconSmall || item.iconMedium)}
                resizable
                aspectRatio={{ contentMode: "fill" }}
                frame={{ width: 24, height: 24 }}
                clipShape={{ type: "rect", cornerRadius: 12, style: "continuous" }}
                opacity={deletePulse === 0 ? 1 : 0.45}
                animation={{ animation: Animation.easeOut(1.05), value: deletePulse }}
                placeholder={
                  <Image systemName="person.crop.circle" font={17} foregroundStyle="secondaryLabel" />
                }
              />
            </Button>
            <VStack alignment="leading" spacing={1} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
              <Text font="footnote" lineLimit={1} fontWeight="medium">{item.displayName || item.username || "AppRaven 账号"}</Text>
              {item.username ? <Text font="caption2" foregroundStyle="secondaryLabel">@{item.username}</Text> : null}
            </VStack>
            <HStack spacing={14} offset={{ x: 10, y: 0 }}>
              <Button
                buttonStyle="plain"
                action={() => {
                  if (deleteArmedId !== item.id) {
                    setDeleteArmedId(item.id)
                    try { HapticFeedback.lightImpact() } catch {}
                    if (deleteArmedTimerRef.current) clearTimeout(deleteArmedTimerRef.current)
                    deleteArmedTimerRef.current = setTimeout(() => {
                      deleteArmedTimerRef.current = null
                      setDeleteArmedId(current => (current === item.id ? null : current))
                    }, 1500)
                    return
                  }
                  disarmDelete()
                  try { removeAppRavenAccount(item.id) } catch (reason) { setLoginError(errorText(reason)) }
                  setAccounts(getSavedAppRavenAccounts())
                }}
              >
                <HStack
                  padding={{ horizontal: 3, vertical: 3 }}
                  background={<Circle fill={TOP_BOX_FILL} />}
                >
                  <ZStack frame={{ width: 17, height: 17 }}>
                    <Circle fill={{ light: "#FFFFFF", dark: "#FFFFFF" } as const} />
                    <Image
                      systemName="xmark"
                      font={11}
                      foregroundStyle={deleteArmedId === item.id ? { light: "#FF3B30", dark: "#FF453A" } : { light: "#FFC0CB", dark: "#FFC0CB" }}
                      opacity={deletePulse === 0 ? 1 : 0.45}
                      animation={{ animation: Animation.easeOut(1.05), value: deletePulse }}
                    />
                  </ZStack>
                </HStack>
              </Button>
            </HStack>
          </HStack>
        ))}
      </VStack>
      </AnimatedSection>,
      true
    )
  }
  // Cookie 登录行：默认隐藏，轻点左上角老鹰图标切换；单行输入框 + 出入场过渡，保持简约。
  if (cookieRowVisible) {
    pushLoginFormBlock(
      <VStack
        key="login-cookie"
        padding={{ horizontal: 14, vertical: 8 }}
        frame={{ maxWidth: "infinity" }}
        transition={COOKIE_ROW_TRANSITION}
      >
        {/* cookie 符号在本系统不存在（ImageRenderer 实测渲染失败→空白），换用 doc.on.clipboard */}
        <LoginFieldRow systemName="doc.on.clipboard" grow>
          <TextField title="" prompt="粘贴 AppRaven 会话 Cookie" value={cookie} onChanged={setCookie} axis="vertical" onSubmit={submitFromKeyboard} frame={{ maxWidth: "infinity" }} />
        </LoginFieldRow>
      </VStack>
    )
  }
  pushLoginFormBlock(
    <AnimatedSection key="login-user" index={2}>
    <VStack key="login-user-row" padding={{ horizontal: 14, vertical: 8 }} frame={{ maxWidth: "infinity" }}
      scaleEffect={errorNudge}
      animation={{ animation: Animation.snappy({ duration: 0.3, extraBounce: 0.35 }), value: errorNudge }}
    >
      <LoginFieldRow systemName="person" grow errored={!!loginError}>
        <TextField title="" prompt="邮箱或用户名" value={principal} onChanged={setPrincipal} onSubmit={submitFromKeyboard} submitLabel="go" frame={{ maxWidth: "infinity" }} />
      </LoginFieldRow>
    </VStack>
    </AnimatedSection>
  )
  pushLoginFormBlock(
    <AnimatedSection key="login-pass" index={3}>
    <VStack key="login-pass-row" padding={{ horizontal: 14, vertical: 8 }} frame={{ maxWidth: "infinity" }}
      scaleEffect={errorNudge}
      animation={{ animation: Animation.snappy({ duration: 0.3, extraBounce: 0.35 }), value: errorNudge }}
    >
      <LoginFieldRow systemName="lock" grow errored={!!loginError}>
        <SecureField title="" prompt="密码" value={password} onChanged={setPassword} onSubmit={submitFromKeyboard} submitLabel="go" frame={{ maxWidth: "infinity" }} />
      </LoginFieldRow>
    </VStack>
    </AnimatedSection>
  )

  return (
    <VStack spacing={0} frame={{ maxWidth: "infinity", maxHeight: "infinity" }} background="clear">
      {/* 顶部回退按钮行只在「合集数量已知」时渲染：首次加载阶段 ordered.length=0 也满足 <3，
          不加门槛会在第一次进入时先闪出顶部三钮、数据到达后再消失；
          已知条件 = 完成过一次加载（刷新中旧数据仍在，不闪）/ 加载失败（保留重试与退出入口）。 */}
      {loggedIn && (everLoadedRef.current || !!stageError || collections.length > 0) && ordered.length < 3 ? (
        <VStack spacing={12} padding={{ horizontal: 16, vertical: 12 }} frame={{ maxWidth: "infinity" }} transition={ITEM_TRANSITION}>
          <HStack spacing={12} frame={{ maxWidth: "infinity" }}>
            {ordered.length < 1 ? (
              <RoundIconButton systemName="arrow.clockwise" pulse={deletePulse} onTap={() => { void load() }} />
            ) : null}
            {ordered.length < 2 ? (
              <RoundIconButton systemName="rectangle.portrait.and.arrow.right" pulse={deletePulse} onTap={() => { logoutAppRaven(); reloadAccount() }} />
            ) : null}
            <Spacer />
            <RoundIconButton
              systemName={props.fullscreen ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right"}
              pulse={deletePulse}
              onTap={() => props.onToggleFullscreen?.()}
            />
          </HStack>
        </VStack>
      ) : <Spacer frame={{ width: 0, height: 0 }} />}

      {!loggedIn ? (
          // 登录表单可滚动：内容高度不受弹窗高度裁切（旧版直接铺在弹窗里会被裁掉下半截）。
          <PageScroll inline={props.inline} fullscreen={props.fullscreen} transition={PAGE_TRANSITION}>
            <VStack
              alignment="center"
              spacing={8}
              padding={{ horizontal: 0, vertical: 20 }}
              frame={{ maxWidth: "infinity" }}
            >
              {loginFormChildren}
            </VStack>
          </PageScroll>
      ) : (
        <PageScroll inline={props.inline} fullscreen={props.fullscreen} transition={PAGE_TRANSITION}>
          <VStack alignment="leading" spacing={12} padding={{ horizontal: 16, vertical: 8 }}>
            <>
              {stage === "resolving" ? (
                <HStack spacing={8} padding={{ vertical: 12 }} transition={ITEM_TRANSITION}>
                  <ProgressView />
                  <Text font="caption" foregroundStyle="secondaryLabel">正在定位 AppRaven 应用…</Text>
                </HStack>
              ) : null}
              {stage === "collections" && collections.length === 0 ? (
                <HStack spacing={8} padding={{ vertical: 12 }} transition={ITEM_TRANSITION}>
                  <ProgressView />
                  <Text font="caption" foregroundStyle="secondaryLabel">正在加载我的合集…</Text>
                </HStack>
              ) : null}
              {stageError ? (
                <VStack spacing={10} padding={16} frame={{ maxWidth: "infinity", alignment: "leading" }} background={<RoundedRectangle fill={CARD_FILL} cornerRadius={14} />} transition={ITEM_TRANSITION}>
                  <Text foregroundStyle="systemRed">{stageError}</Text>
                  <Button title="重试" action={() => { void load() }} />
                </VStack>
              ) : null}
              {stage === "ready" && !stageError && ordered.length === 0 ? <Text foregroundStyle="secondaryLabel" padding={12} transition={ITEM_TRANSITION}>暂无可用合集</Text> : null}
              {ordered.map((collection, collectionIndex) => {
                const isJoined = joined.has(collection.id)
                const expanded = expandedId === collection.id
                const detailList = sortedExpandedItems(collection)
                const detailLoading = expandedLoading[collection.id] === true
                const detailError = expandedError[collection.id] || ""
                const collectionSorting = sortCollectionId === collection.id
                return (
                  <AnimatedSection key={collection.id} index={collectionIndex}>
                  <VStack key="collection-card" alignment="leading" spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" as any }} background={<RoundedRectangle fill={isJoined ? JOINED_CARD_FILL : CARD_FILL} cornerRadius={14} />}
                    animation={{ animation: Animation.smooth({ duration: 0.4 }), value: isJoined }}
                  >
                    <HStack
                      spacing={10}
                      padding={10}
                      frame={{ maxWidth: "infinity" }}
                      onLongPressGesture={{
                        perform: () => {
                          withAnimation(() => {
                            if (sortCollectionId === collection.id) {
                              setSortCollectionId(null)
                              setPressedCollectionId(null)
                            } else {
                              setSortCollectionId(collection.id)
                              setSortItemContext(null)
                              setPressedCollectionId(collection.id)
                            }
                          })
                          try { HapticFeedback.mediumImpact() } catch {}
                        },
                      }}
                    >
                      <Button
                        buttonStyle="plain"
                        action={() => {
                          if (collectionSorting) {
                            withAnimation(() => {
                              setSortCollectionId(null)
                              setPressedCollectionId(null)
                            })
                            return
                          }
                          toggleExpand(collection)
                        }}
                      >
                        <HStack spacing={10} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
                          <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
                            <Text lineLimit={2}>{collection.title}</Text>
                            <HStack spacing={0}>
                              <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={1}>
                                {collection.appCount} 个 App{collection.user?.displayName ? ` · ${collection.user.displayName}` : ""}
                              </Text>
                              {isJoined ? (
                                <Text font="caption" foregroundStyle="systemGreen" lineLimit={1} transition={JOIN_TAG_TRANSITION}> · 已加入</Text>
                              ) : null}
                            </HStack>
                          </VStack>
                          <HStack spacing={4}>
                            {collection.topArtworks?.slice(0, collectionIndex < 3 ? 2 : 3).map((artwork, artworkIndex) => (
                              <HStack
                                key={`${collection.id}-artwork-${artworkIndex}`}
                                padding={{ horizontal: 4, vertical: 4 }}
                                background={<RoundedRectangle fill={TOP_BOX_FILL} cornerRadius={10} />}
                                clipShape={{ type: "rect", cornerRadius: 10, style: "continuous" }}
                              >
                                <AppStoreIcon
                                  imageUrl={appRavenArtworkURL(artwork, 256)}
                                  size={32}
                                  foregroundStyle={props.foregroundStyle}
                                />
                              </HStack>
                            ))}
                          </HStack>
                        </HStack>
                      </Button>
                      <HStack spacing={4} alignment="center">
                        {collectionIndex === 0 ? (
                          <RoundIconButton systemName="arrow.clockwise" pulse={deletePulse} onTap={() => { void load() }} />
                        ) : null}
                        {collectionIndex === 1 ? (
                          <RoundIconButton systemName="rectangle.portrait.and.arrow.right" pulse={deletePulse} onTap={() => { logoutAppRaven(); reloadAccount() }} />
                        ) : null}
                        {collectionIndex === 2 ? (
                          <RoundIconButton
                            systemName={props.fullscreen ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right"}
                            pulse={deletePulse}
                            onTap={() => props.onToggleFullscreen?.()}
                          />
                        ) : null}
                        <HStack
                          padding={{ horizontal: 4, vertical: 4 }}
                          background={<RoundedRectangle fill={TOP_BOX_FILL} cornerRadius={10} />}
                          clipShape={{ type: "rect", cornerRadius: 10, style: "continuous" }}
                        >
                          <LayoutToggleButton grid={detailGrid} pulse={deletePulse} onTap={toggleDetailGrid} />
                        </HStack>
                        <HStack
                          padding={{ horizontal: 4, vertical: 4 }}
                          background={<RoundedRectangle fill={TOP_BOX_FILL} cornerRadius={10} />}
                          clipShape={{ type: "rect", cornerRadius: 10, style: "continuous" }}
                        >
                          {collectionSorting ? (
                            <VStack spacing={4} transition={ITEM_TRANSITION}>
                              <Button
                                buttonStyle="plain"
                                action={() => moveCollection(collection.id, -1)}
                                disabled={collectionIndex === 0}
                              >
                                <Image systemName="chevron.up" font="body" foregroundStyle={collectionIndex === 0 ? "tertiaryLabel" : "systemBlue"} />
                              </Button>
                              <Button
                                buttonStyle="plain"
                                action={() => {
                                  moveCollection(collection.id, 1)
                                  if (collectionIndex === ordered.length - 1) {
                                    setSortCollectionId(null)
                                    setPressedCollectionId(null)
                                  }
                                }}
                                disabled={collectionIndex === ordered.length - 1}
                              >
                                <Image systemName="chevron.down" font="body" foregroundStyle={collectionIndex === ordered.length - 1 ? "tertiaryLabel" : "systemBlue"} />
                              </Button>
                            </VStack>
                          ) : (
                            <HStack transition={ITEM_TRANSITION}>
                              <CollectionJoinButton isJoined={isJoined} expanded={expanded} tick={fxTick[collection.id] ?? 0} popped={fxPop[collection.id] === true} disabled={!joinedSynced} onTap={() => toggleCollection(collection)} />
                            </HStack>
                          )}
                        </HStack>
                      </HStack>
                    </HStack>
                    {expanded ? (
                      <VStack alignment="leading" spacing={8} padding={{ horizontal: 10, bottom: 10 }} frame={{ maxWidth: "infinity", alignment: "leading" as any }} transition={DETAIL_TRANSITION}>
                        {detailLoading ? (
                          <HStack spacing={8} padding={{ vertical: 6 }}>
                            <ProgressView />
                            <Text font="caption" foregroundStyle="secondaryLabel">正在加载合集内容…</Text>
                          </HStack>
                        ) : null}
                        {detailError ? (
                          <HStack spacing={8}>
                            <Text font="caption" foregroundStyle="systemRed">{detailError}</Text>
                            <Button title="重试" action={() => { void loadExpanded(collection, true) }} />
                          </HStack>
                        ) : null}
                        {!detailLoading && !detailError && detailList.length === 0 ? (
                          <Text font="caption" foregroundStyle="secondaryLabel">这个合集暂无 App</Text>
                        ) : null}
                        {detailGrid ? (
                          chunkItems(detailList, 3).map((gridRow, gridRowIndex) => (
                            <HStack key={`grid-row-${gridRowIndex}`} spacing={8} transition={ITEM_TRANSITION}>
                              {gridRow.map(item => (
                                <VStack key={item.id} spacing={4} frame={{ maxWidth: "infinity" }}>
                                  <ZStack>
                                    <AppStoreIcon imageUrl={appRavenArtworkURL(item.app?.artworkUrl, 256)} size={SEARCH_PAGE_ICON_SIZE} foregroundStyle={props.foregroundStyle} />
                                    <Button
                                      buttonStyle="plain"
                                      disabled={removingItemId === item.id}
                                      action={() => { void removeExpandedItem(collection, item) }}
                                    >
                                      <Image
                                        systemName="xmark.circle.fill"
                                        foregroundStyle={{ light: "rgba(255,59,48,0.55)", dark: "rgba(255,69,58,0.60)" }}
                                        font="caption"
                                        offset={{ x: 16, y: -16 }}
                                        opacity={deletePulse === 0 ? 1 : 0.45}
                                        animation={{ animation: Animation.easeOut(1.05), value: deletePulse }}
                                      />
                                    </Button>
                                  </ZStack>
                                  <Text font="caption2" foregroundStyle="secondaryLabel" lineLimit={2} frame={{ maxWidth: "infinity", alignment: "center" }}>
                                    {item.app?.title || "未知 App"}
                                  </Text>
                                </VStack>
                              ))}
                              {gridRow.length < 3 ? <VStack key="grid-pad" spacing={4} frame={{ maxWidth: "infinity" }} /> : null}
                            </HStack>
                          ))
                        ) : detailList.map((item, itemIndex) => {
                          const itemSorting = sortItemContext?.collectionId === collection.id && sortItemContext?.itemId === item.id
                          return (
                          <HStack
                            key={item.id}
                            spacing={10}
                            padding={8}
                            frame={{ maxWidth: "infinity" }}
                            transition={ITEM_TRANSITION}
                            background={{ light: "rgba(120,120,128,0.08)", dark: "rgba(120,120,128,0.14)" } as any}
                            clipShape={{ type: "rect", cornerRadius: 10 } as any}
                            onLongPressGesture={{
                              perform: () => {
                                if (!expanded) {
                                  setExpandedId(collection.id)
                                  void loadExpanded(collection)
                                }
                                if (sortItemContext?.collectionId === collection.id && sortItemContext?.itemId === item.id) {
                                  setSortItemContext(null)
                                  setPressedItemId(null)
                                } else {
                                  setSortItemContext({ collectionId: collection.id, itemId: item.id })
                                  setPressedItemId(item.id)
                                }
                                try { HapticFeedback.mediumImpact() } catch {}
                              },
                            }}
                          >
                            <AppStoreIcon imageUrl={appRavenArtworkURL(item.app?.artworkUrl, 256)} size={SEARCH_PAGE_ICON_SIZE} foregroundStyle={props.foregroundStyle} />
                            <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
                              <Text lineLimit={1}>{item.app?.title || "未知 App"}</Text>
                              {item.app?.iTunesId ? <Text font="caption2" foregroundStyle="secondaryLabel">App Store ID {item.app.iTunesId}</Text> : null}
                            </VStack>
                            {itemSorting ? (
                              <VStack spacing={4}>
                                <Button
                                  buttonStyle="plain"
                                  action={() => moveExpandedItem(collection, item.id, -1)}
                                  disabled={itemIndex === 0}
                                >
                                  <Image systemName="chevron.up" font="body" foregroundStyle={itemIndex === 0 ? "tertiaryLabel" : "systemBlue"} />
                                </Button>
                                <Button
                                  buttonStyle="plain"
                                  action={() => moveExpandedItem(collection, item.id, 1)}
                                  disabled={itemIndex === detailList.length - 1}
                                >
                                  <Image systemName="chevron.down" font="body" foregroundStyle={itemIndex === detailList.length - 1 ? "tertiaryLabel" : "systemBlue"} />
                                </Button>
                              </VStack>
                            ) : (
                              <Button
                                buttonStyle="borderless"
                                disabled={removingItemId === item.id}
                                action={() => { void removeExpandedItem(collection, item) }}
                              >
                                <Image
                                  systemName="xmark.circle.fill"
                                  foregroundStyle={{ light: "rgba(255,59,48,0.55)", dark: "rgba(255,69,58,0.60)" }}
                                  font="title3"
                                  opacity={deletePulse === 0 ? 1 : 0.45}
                                  animation={{ animation: Animation.easeOut(1.05), value: deletePulse }}
                                />
                              </Button>
                            )}
                          </HStack>
                          )
                        })}
                      </VStack>
                    ) : null}
                  </VStack>
                  </AnimatedSection>
                )
              })}
            </>
          </VStack>
        </PageScroll>
      )}
    </VStack>
  )
}

export function AppRavenCollectionsPage(props: CollectionPageProps) {
  // 由宿主（评分星星的底部弹窗）承载，页面本身透明背景，透出 App Store 分享页内容。
  return (
    <VStack
      spacing={0}
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      background="clear"
    >
      <SinglePageCollections {...props} />
    </VStack>
  )
}

function showCollectionToast(_text: string, _error = false) {
  // 顶部通知栏已按用户要求删除：保留调用点兼容，不再显示任何通知。
}

export function CollectionToastOverlay() {
  // 顶部通知栏已删除：保留导出兼容外部引用，不渲染任何内容。
  return <Text> </Text>
}
