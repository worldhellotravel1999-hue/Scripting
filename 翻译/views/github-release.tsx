import {
  Button,
  Circle,
  Ellipse,
  HStack,
  Image,
  Navigation,
  NavigationStack,
  ProgressView,
  Rectangle,
  RoundedRectangle,
  Text,
  VStack,
  WebView,
  ZStack,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "scripting"
import {
  getGitHubRelease,
  parseGitHubReleaseURL,
  type GitHubReleaseInfo,
} from "../core/github"
import { prepareGitHubReleasePage, type PreparedGitHubPage } from "../core/github-page"
import { githubPageDirectory, githubPageFile } from "../core/github-page-file"
import {
  githubTranslationCacheKey,
  readGitHubTranslationCache,
  translateGitHubPage,
  writeGitHubTranslationCache,
} from "../core/github-translation"
import { safeAnimate, safeTimeout } from "../core/guarded"
import { loadPreferences } from "../core/preferences"

type TranslationState = "idle" | "loading" | "done" | "error"
type ViewMode = "translated" | "original"

function closeButtonStyle(): any {
  return {
    foregroundStyle: { light: "#000000", dark: "#FFFFFF" } as any,
    background: {
      style: { light: "rgba(142, 142, 147, 0.24)", dark: "rgba(142, 142, 147, 0.32)" },
      shape: "circle" as const,
    },
  }
}

function FloatingCloseButton(props: { onClose: () => void }) {
  const style = closeButtonStyle()
  return (
    <Button role="close" buttonStyle="plain" action={props.onClose}>
      <Image
        systemName="xmark"
        font={17}
        foregroundStyle={style.foregroundStyle}
        frame={{ width: 36, height: 36 }}
        background={style.background}
      />
    </Button>
  )
}

/*
  右下角状态胶囊：进入页面的自动翻译不显示（全屏 LoadingView 已有提示，
  见 GitHubReleaseContent 里 manualRunRef 的门控）；只有用户点右下角
  菜单里的「重新翻译」手动触发时才出现，红色错误胶囊可点按重试。
*/
function TranslationStatus(props: {
  state: TranslationState
  progress: string
  error: string
  onRetryTranslation: () => void
}) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const show = props.state === "loading" || props.state === "error"
    setVisible(show)
    if (!show) return
    // 进度文字变化不重启计时；普通提示、红色错误都自动消失。
    const timer = safeTimeout(() => setVisible(false), props.state === "error" ? 4500 : 2400)
    return () => { clearTimeout(timer) }
  }, [props.state])
  if (!visible) return null
  if (props.state === "loading") {
    return (
      <HStack
        spacing={8}
        padding={{ horizontal: 14, vertical: 8 }}
        background={{ style: { light: "rgba(255,255,255,0.94)", dark: "rgba(28,28,30,0.94)" }, shape: "capsule" }}
        clipShape="capsule"
        shadow={{ color: "rgba(0,0,0,0.14)", radius: 10, y: 3 }}
      >
        <ProgressView frame={{ width: 16, height: 16 }} />
        <Text font="caption" foregroundStyle="secondaryLabel">{props.progress || "Translating GitHub Release..."}</Text>
      </HStack>
    )
  }
  if (props.state === "error") {
    return (
      <Button buttonStyle="plain" action={props.onRetryTranslation}>
        <HStack
          spacing={7}
          padding={{ horizontal: 14, vertical: 8 }}
          background={{ style: { light: "rgba(255, 235, 235, 0.96)", dark: "rgba(70, 20, 20, 0.96)" }, shape: "capsule" }}
          clipShape="capsule"
          shadow={{ color: "rgba(0,0,0,0.14)", radius: 10, y: 3 }}
        >
          <Image systemName="exclamationmark.circle.fill" font="caption" foregroundStyle="systemRed" />
          <Text font="caption" fontWeight="medium" foregroundStyle="systemRed" lineLimit={1} truncationMode="tail">
            {props.error || "Translation failed. Tap to retry."}
          </Text>
        </HStack>
      </Button>
    )
  }
  return null
}

function LoadingView(props: { identityLabel: string; message: string }) {
  return (
    <VStack alignment="center" spacing={14} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
      <ProgressView />
      <Text font="body" fontWeight="medium">{props.message}</Text>
      <Text font="caption" foregroundStyle="secondaryLabel">{props.identityLabel}</Text>
    </VStack>
  )
}

function ErrorView(props: { onRetry: () => void }) {
  return (
    <VStack alignment="center" spacing={14} padding={{ horizontal: 28 }} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
      <Image systemName="exclamationmark.triangle.fill" font={34} foregroundStyle="systemOrange" />
      <Text font="headline">Unable to open GitHub Release</Text>
      <Text font="subheadline" foregroundStyle="secondaryLabel" multilineTextAlignment="center">
        Check the URL or your network connection, then try again.
      </Text>
      <Button title="Reload" systemImage="arrow.clockwise" buttonStyle="borderedProminent" action={props.onRetry} />
    </VStack>
  )
}

/*
  GitHub Release 底部操作。

  参考 WLOC 虚拟定位的设置钮：42pt 圆钮（24pt 图标 + 9pt 内边距）、8pt 间距，
  从右下角那颗入口向上逐个弹出；动画用 transition 而不是 scaleEffect——
  按钮是条件渲染，插入/移除本身才可动画，延迟挂在 transition 上才有波浪。

  底色沿用截图翻译页浮动钮的半透黑配方（rgba(30,30,32,0.55) + 细描边），
  压在 GitHub 的浅色页面上也清楚；入口图标是「四个圆点 + 一个圆角框」。
*/
const ACTION_BUTTON_SIZE = 42
const ACTION_BUTTON_ICON_SIZE = 24
const ACTION_BUTTON_FILL: any = { light: "rgba(30,30,32,0.55)", dark: "rgba(30,30,32,0.55)" }
const ACTION_BUTTON_STROKE: any = { light: "rgba(255,255,255,0.22)", dark: "rgba(255,255,255,0.16)" }

function actionCircleShell(icon: any, label: string): any {
  return (
    <ZStack
      frame={{ width: ACTION_BUTTON_SIZE, height: ACTION_BUTTON_SIZE }}
      contentShape="circle"
      accessibilityLabel={label}
    >
      <Circle fill={ACTION_BUTTON_FILL} frame={{ width: ACTION_BUTTON_SIZE, height: ACTION_BUTTON_SIZE }} />
      <Circle
        stroke={{ shapeStyle: ACTION_BUTTON_STROKE, strokeStyle: { lineWidth: 0.5 } }}
        frame={{ width: ACTION_BUTTON_SIZE, height: ACTION_BUTTON_SIZE }}
      />
      {icon}
    </ZStack>
  )
}

function actionCircle(systemName: string, label: string, enabled = true): any {
  return actionCircleShell(
    <Image
      systemName={systemName}
      font={ACTION_BUTTON_ICON_SIZE}
      foregroundStyle={enabled ? "white" : "rgba(255,255,255,0.35)"}
    />,
    label,
  )
}

/*
  自绘「原文 / 译文」图标。

  不再用系统书页符号：一个地球仪（外圈 + 经线 + 赤道）压一枚右下角的语言徽章，
  A = 原文、文 = 译文——比齿轮/书页更贴合翻译语境，也和「更多」的四圈一框成一套。
  徽章先垫一层近不透明深色再做白底，免得地球仪的线条从字缝里穿过去。
*/
function TranslationGlobe(props: { char: "A" | "文" }): any {
  const box = ACTION_BUTTON_ICON_SIZE
  const globe = box * 5 / 6
  const badge = box / 2
  return (
    <ZStack frame={{ width: box, height: box }}>
      <ZStack frame={{ width: globe, height: globe }}>
        <Circle
          stroke={{ shapeStyle: "white", strokeStyle: { lineWidth: 1.3 } }}
          frame={{ width: globe, height: globe }}
        />
        <Ellipse
          stroke={{ shapeStyle: "white", strokeStyle: { lineWidth: 0.9 } }}
          frame={{ width: globe * 0.44, height: globe }}
        />
        <Rectangle fill="white" frame={{ width: globe * 0.88, height: 1 }} />
      </ZStack>
      <ZStack
        frame={{ width: badge, height: badge }}
        offset={{ x: box / 4, y: box / 4 }}
      >
        <Circle fill="rgba(30,30,32,0.96)" frame={{ width: badge, height: badge }} />
        <Circle fill="white" frame={{ width: badge * 5 / 6, height: badge * 5 / 6 }} />
        <Text font={7.5} fontWeight="bold" foregroundStyle="#1E1E20">{props.char}</Text>
      </ZStack>
    </ZStack>
  )
}

/** 「更多」图标：四个圆点套一个圆角方框（四圈一框）。 */
function MoreGlyph(): any {
  const box = ACTION_BUTTON_ICON_SIZE
  const dot = box * 0.26
  const gap = box * 0.1
  return (
    <ZStack frame={{ width: box, height: box }}>
      <RoundedRectangle
        stroke={{ shapeStyle: "white", strokeStyle: { lineWidth: box * 0.07 } }}
        cornerRadius={box * 0.24}
        frame={{ width: box, height: box }}
      />
      <VStack spacing={gap}>
        <HStack spacing={gap}>
          <Circle fill="white" frame={{ width: dot, height: dot }} />
          <Circle fill="white" frame={{ width: dot, height: dot }} />
        </HStack>
        <HStack spacing={gap}>
          <Circle fill="white" frame={{ width: dot, height: dot }} />
          <Circle fill="white" frame={{ width: dot, height: dot }} />
        </HStack>
      </VStack>
    </ZStack>
  )
}

function BottomActions(props: {
  mode: ViewMode
  canToggle: boolean
  onToggleMode: () => void
  onRetryTranslation: () => void
  onOpenInGitHubApp: () => void
  onCopyLink: () => void
  shareTapGuardRef: { current: boolean }
}) {
  const [open, setOpen] = useState(false)

  /** 点完入口就收起扇形，别让圆钮一直挡着页面。 */
  function closeThen(action: () => void) {
    safeAnimate(() => setOpen(false))
    action()
  }

  function toggle() {
    safeAnimate(() => setOpen((value) => !value))
  }

  /** index 是离入口多远；anchor 朝入口一侧缩放，看起来像从入口里长出来。 */
  function popTransition(index: number, count: number): Transition {
    const pop = () => Transition.scale(0.1, "bottom").combined(Transition.opacity())
    return Transition.asymmetric(
      pop().animation(Animation.bouncy({ duration: 0.42, extraBounce: 0.32 }).delay(index * 0.055)),
      pop().animation(Animation.easeIn(0.16).delay((count - 1 - index) * 0.035)),
    )
  }

  const items: { render: (transition: Transition) => any }[] = [
    {
      render: (transition) => (
        <Button
          key="mode"
          buttonStyle="plain"
          disabled={!props.canToggle}
          transition={transition}
          action={() => closeThen(props.onToggleMode)}
        >
          {actionCircleShell(
            <ZStack opacity={props.canToggle ? 1 : 0.35}>
              <TranslationGlobe char={props.mode === "translated" ? "A" : "文"} />
            </ZStack>,
            props.mode === "translated" ? "显示原文" : "显示译文",
          )}
        </Button>
      ),
    },
    {
      render: (transition) => (
        <Button key="retry" buttonStyle="plain" transition={transition} action={() => closeThen(props.onRetryTranslation)}>
          {actionCircle("arrow.clockwise", "重新翻译")}
        </Button>
      ),
    },
    {
      render: (transition) => (
        <ZStack
          key="share"
          contentShape="circle"
          transition={transition}
          onTapGesture={() => {
            if (props.shareTapGuardRef.current) return
            closeThen(props.onOpenInGitHubApp)
          }}
          onLongPressGesture={{
            minDuration: 450,
            perform: () => {
              props.shareTapGuardRef.current = true
              safeTimeout(() => { props.shareTapGuardRef.current = false }, 700)
              closeThen(props.onCopyLink)
            },
          }}
        >
          {actionCircle("square.and.arrow.up", "Open in GitHub app, long press to copy link")}
        </ZStack>
      ),
    },
  ]

  const count = items.length
  // VStack 从上到下排；反序后第一个入口挨着底部那颗更多钮，波浪也从它开始。
  const ordered = [...items].reverse()

  return (
    <VStack spacing={8} alignment="center">
      {open
        ? ordered.map((item, index) => item.render(popTransition(count - 1 - index, count)))
        : null}
      <Button
        buttonStyle="plain"
        action={toggle}
        accessibilityLabel={open ? "收起操作" : "更多操作"}
      >
        {open
          ? actionCircle("xmark", "收起操作")
          : actionCircleShell(<MoreGlyph />, "更多操作")}
      </Button>
    </VStack>
  )
}

export function GitHubReleaseContent(props: { url: string; onClose: () => void }) {
  const identity = useMemo(() => parseGitHubReleaseURL(props.url), [props.url])
  const identityLabel = identity
    ? identity.mode === "profile" ? `github.com/${identity.owner}` : `${identity.owner}/${identity.repo}`
    : "GitHub"

  const [reloadToken, setReloadToken] = useState(0)
  const [release, setRelease] = useState<GitHubReleaseInfo | null>(null)
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading")
  const [loadError, setLoadError] = useState("")
  const [prepared, setPrepared] = useState<PreparedGitHubPage | null>(null)
  const [prepareError, setPrepareError] = useState("")

  const [controller] = useState(() => new WebViewController({ ephemeral: true }))
  const [pageReady, setPageReady] = useState(false)
  const [pageContentReady, setPageContentReady] = useState(false)
  const [pageError, setPageError] = useState("")

  const [preferences] = useState(() => loadPreferences())
  const targetLanguages = preferences.defaultTargetLanguageCodes.length
    ? preferences.defaultTargetLanguageCodes
    : [preferences.defaultTargetLanguageCode]
  const [targetLanguage] = useState(preferences.defaultTargetLanguageCode || targetLanguages[0])
  const [translationHost] = useState<Translation>(() => {
    try { return new Translation() } catch { return Translation.shared }
  })

  const [translations, setTranslations] = useState<(string | null)[] | null>(null)
  const [translationState, setTranslationState] = useState<TranslationState>("idle")
  const [translationError, setTranslationError] = useState("")
  const [translationProgress, setTranslationProgress] = useState("")
  const [translationToken, setTranslationToken] = useState(0)
  const [mode, setMode] = useState<ViewMode>("translated")
  const translationRequestRef = useRef(0)
  const forceTranslationRef = useRef(false)
  /** 点了「重新翻译」手动触发后为 true；进入页面的自动翻译不弹右下角胶囊。 */
  const manualRunRef = useRef(false)
  const mountedRef = useRef(true)
  const shareTapGuardRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      translationRequestRef.current += 1
    }
  }, [])

  useEffect(() => {
    let active = true
    setLoadState("loading")
    setLoadError("")
    setPrepareError("")
    setRelease(null)
    setPrepared(null)
    setPageReady(false)
    setPageError("")
    setTranslationState("idle")
    setTranslations(null)
    setTranslationError("")
    if (!identity) {
      setLoadState("error")
      setLoadError("Provide a GitHub repository, README, or Release URL.")
      return () => { active = false }
    }
    getGitHubRelease(identity)
      .then((info) => {
        if (!active) return
        setRelease(info)
      })
      .catch((reason) => {
        if (!active) return
        setLoadState("error")
        setLoadError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => { active = false }
  }, [identity?.url, reloadToken])

  useEffect(() => {
    if (!release) return
    try {
      const page = prepareGitHubReleasePage(release)
      setPrepared(page)
      setPrepareError("")
      setLoadState("ready")
    } catch (reason) {
      setPrepared(null)
      setPrepareError(reason instanceof Error ? reason.message : String(reason))
      setLoadState("error")
    }
  }, [release])

  useEffect(() => {
    controller.onNavigationAction = (action) => {
      const target = action.url || ""
      if (action.navigationType === "linkActivated" && /^(?:https?:|mailto:)/i.test(target)) {
        void Safari.openURL(target).catch(() => {})
        return "cancel"
      }
      return "allow"
    }
  }, [controller])

  useEffect(() => {
    return () => {
      controller.dispose()
    }
  }, [controller])

  useEffect(() => {
    if (!prepared) return
    let active = true
    setPageReady(false)
    setPageContentReady(false)
    setPageError("")
    // 在同一个 effect 中写入并加载，不能把尚未提交的 pagePath 当写入失败。
    const pagePath = githubPageFile(prepared.html, prepared.sourceHash)
    if (!pagePath) {
      setPageError("Unable to write the page.")
      return
    }
    controller.loadFile(pagePath, githubPageDirectory())
      .then((ok) => {
        if (!active) return
        if (ok) {
          setPageReady(true)
        } else setPageError("Unable to render the page.")
      })
      .catch((reason) => {
        if (!active) return
        setPageError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => { active = false }
  }, [prepared, controller])

  useEffect(() => {
    const page = prepared
    if (!page || !release) return
    let active = true
    const requestId = ++translationRequestRef.current
    const isCancelled = () => !active || !mountedRef.current || translationRequestRef.current !== requestId
    const sourceLanguage = preferences.defaultSourceLanguageCode
    const cacheKey = githubTranslationCacheKey(release, page.sourceHash, sourceLanguage, targetLanguage)
    const bypassCache = forceTranslationRef.current
    forceTranslationRef.current = false
    const cached = bypassCache ? null : readGitHubTranslationCache(cacheKey, page.segments.length)

    if (cached) {
      setTranslations(cached)
      setTranslationState("done")
      setTranslationError("")
      setMode("translated")
      return () => { active = false }
    }
    if (sourceLanguage !== "auto" && sourceLanguage === targetLanguage) {
      setTranslations(null)
      setTranslationState("done")
      setTranslationError("")
      return () => { active = false }
    }

    setTranslations(null)
    setTranslationState("loading")
    setTranslationProgress(`Translating 0/${page.segments.length} sections...`)
    setTranslationError("")
    setMode("translated")
    translateGitHubPage(page, {
      targetLanguageCode: targetLanguage,
      translationHost,
      isCancelled,
      onProgress: (result) => {
        if (isCancelled()) return
        setTranslationProgress(`Translating ${result.covered}/${result.total} sections...`)
        setTranslations([...result.segments])
      },
    })
      .then((result) => {
        if (isCancelled()) return
        setTranslations(result.segments)
        if (result.covered === result.total) {
          setTranslationState("done")
          setTranslationError("")
          writeGitHubTranslationCache(cacheKey, result.segments)
        } else {
          const message = `Translated ${result.covered}/${result.total} sections. Tap to retry.`
          setTranslationState("error")
          setTranslationError(message)
        }
      })
      .catch(() => {
        if (isCancelled()) return
        setTranslationState("error")
        setTranslationError("Translation failed. Tap to retry.")
      })
    return () => { active = false }
  }, [prepared, release, targetLanguage, translationToken, preferences.defaultSourceLanguageCode, translationHost])

  useEffect(() => {
    if (!pageReady || !prepared) return
    const map: Record<string, string> = {}
    if (translations) {
      for (const segment of prepared.segments) {
        const value = translations[segment.index]
        if (typeof value !== "string" || !value.trim()) continue
        map[segment.index] = `${segment.leading}${value}${segment.trailing}`
      }
    }
    // 页面脚本在 </body> 前才定义 __lingoSet。loadFile 返回与脚本执行之间
    // 偶尔有极短的空窗；只注入一次会在空窗里抛异常，译文就再也进不去。
    // 未 attach / 未 ready 都做有限重试，成功后才把页面显示出来。
    const script = `if (typeof window.__lingoSet !== "function") return false; window.__lingoSet(${JSON.stringify(map)}); window.__lingoMode(${JSON.stringify(mode)}); return true`
    let active = true
    let attempts = 0
    const apply = async () => {
      if (!active) return
      if (!controller.isAttached && attempts < 12) {
        attempts += 1
        safeTimeout(() => { void apply() }, 150)
        return
      }
      try {
        const applied = await controller.evaluateJavaScript(script)
        if (!active) return
        if (applied !== false) {
          setPageContentReady(true)
          return
        }
      } catch {}
      if (!active) return
      if (attempts < 16) {
        attempts += 1
        safeTimeout(() => { void apply() }, 150)
        return
      }
      setPageError(controller.isAttached ? "Unable to render the release page." : "Unable to attach the release page.")
    }
    void apply()
    return () => { active = false }
  }, [pageReady, prepared, translations, mode, controller])

  function retryPage() {
    setLoadState("loading")
    setLoadError("")
    setPrepareError("")
    setPageError("")
    setTranslationState("idle")
    setTranslations(null)
    setTranslationError("")
    setTranslationProgress("")
    setPageContentReady(false)
    manualRunRef.current = false
    setReloadToken((value) => value + 1)
  }

  function retryTranslation() {
    forceTranslationRef.current = true
    manualRunRef.current = true
    setTranslationError("")
    setTranslationProgress(`Translating 0/${prepared?.segments.length || 0} sections...`)
    setTranslationState("loading")
    setTranslationToken((value) => value + 1)
  }

  function openInGitHubApp() {
    const link = release?.htmlUrl || props.url
    void Safari.openURL(link).catch(() => {})
  }

  function copyLink() {
    const link = release?.htmlUrl || props.url
    try { Pasteboard.setString(link) } catch {}
    try { HapticFeedback.lightImpact() } catch {}
  }

  function toggleMode() {
    setMode((value) => value === "translated" ? "original" : "translated")
  }

  const canToggle = !!translations?.some((value) => typeof value === "string" && !!value.trim())
  const hasPreparedPage = loadState === "ready" && !!prepared && !prepareError && !pageError
  // 首次注入完成即显示；后续翻译分批回填时页面保持可见。
  const showPage = hasPreparedPage && pageReady && pageContentReady
  const fatalError = loadState === "error" ? (prepareError || loadError) : pageError
  const hasFatalError = loadState === "error" || !!fatalError
  const loadingMessage = loadState !== "ready"
    ? identity?.mode === "profile" ? "Loading GitHub Profile..." : "Loading GitHub Release..."
    : !pageReady
      ? "Preparing release page..."
      : translationState === "loading"
        ? translationProgress || "Translating GitHub Release..."
        : "Preparing translated content..."

  return (
    <ZStack
      navigationBarVisibility="hidden"
      background={{ light: "#FFFFFF", dark: "#0D1117" }}
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
    >
      {hasPreparedPage ? (
        <WebView
          controller={controller}
          opacity={showPage ? 1 : 0}
          frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
        />
      ) : hasFatalError ? (
        <ErrorView onRetry={retryPage} />
      ) : null}

      {!hasFatalError && !showPage ? (
        <LoadingView identityLabel={identityLabel} message={loadingMessage} />
      ) : null}

      <VStack
        alignment="trailing"
        spacing={10}
        frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "bottomTrailing" as any }}
        padding={{ trailing: 14, bottom: 14 }}
      >
        <TranslationStatus
          state={manualRunRef.current ? translationState : "idle"}
          progress={translationProgress}
          error={translationError}
          onRetryTranslation={retryTranslation}
        />
        {showPage ? (
          <BottomActions
            mode={mode}
            canToggle={canToggle}
            onToggleMode={toggleMode}
            onRetryTranslation={retryTranslation}
            onOpenInGitHubApp={openInGitHubApp}
            onCopyLink={copyLink}
            shareTapGuardRef={shareTapGuardRef}
          />
        ) : null}
      </VStack>

      <VStack
        frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "topTrailing" as any }}
        padding={{ top: 12, trailing: 16 }}
      >
        <FloatingCloseButton onClose={props.onClose} />
      </VStack>
    </ZStack>
  )
}

export function GitHubReleaseView(props: { url: string }) {
  const dismiss = Navigation.useDismiss()
  return (
    <NavigationStack>
      <GitHubReleaseContent url={props.url} onClose={dismiss} />
    </NavigationStack>
  )
}
