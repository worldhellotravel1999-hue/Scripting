import {
  Button,
  Circle,
  HStack,
  Image,
  ProgressView,
  Rectangle,
  RoundedRectangle,
  Spacer,
  Text,
  VStack,
  ZStack,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "scripting"
import { translateText } from "../core/translate"
import { detectedAutoSourceLanguage } from "../core/source-language"
import { SystemTranslationWaitError } from "../core/system_engine"
import { finishTranslation } from "../core/session"
import { CopyButton, languageShortLabel } from "./common"
import { FontText } from "./font-text"
import { AnimText } from "./anim-text"

const LOADING_PHRASES = ["正在连接翻译引擎…", "正在理解原文语境…", "正在组织译文表达…"]
// A long page may contain many native requests. Do not leave the card's UI
// spinning forever when one native promise stalls; the late promise is still
// ignored by requestId and the user gets an explicit retry state.
const TRANSLATION_RUN_TIMEOUT_MS = 3 * 60 * 1000

function LoadingCaption(props: { active: boolean }) {
  const [index, setIndex] = useState(0)
  const timerRef = useRef<any>(null)
  useEffect(() => {
    if (!props.active) return
    const schedule = () => {
      timerRef.current = setTimeout(() => {
        setIndex((current) => (current + 1) % LOADING_PHRASES.length)
        schedule()
      }, 1800)
    }
    schedule()
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [props.active])
  if (!props.active) return <Text font="caption" foregroundStyle="tertiaryLabel"> </Text>
  return (
    <HStack spacing={6}>
      <AnimText font="caption" foregroundStyle="tertiaryLabel" anim="opacity" dur={0.4}>
        {LOADING_PHRASES[index]}
      </AnimText>
      <Image
        systemName="ellipsis"
        font="caption2"
        foregroundStyle="tertiaryLabel"
        contentTransition="symbolEffect"
        symbolEffect={{ effect: "pulse", value: index }}
      />
    </HStack>
  )
}

export type TranslationCardResult = {
  languageCode: string
  text: string
  error: string
  loading: boolean
}

export type TranslationCardSnapshot = {
  sourceText: string
  results: TranslationCardResult[]
}

export type CardMenuAction = { label: string; run: () => void }
export type CardMenuRequest = { actions: CardMenuAction[] }

export type TranslationCardProps = {
  key?: string
  id: string
  sourceLanguage: string
  targetLanguages: string[]
  initialText?: string
  initialResults?: TranslationCardResult[]
  compact?: boolean
  readOnly?: boolean
  flat?: boolean
  autoTranslate?: boolean
  /** 只显示译文，隐藏原文区域（App Store 搜索双应用对比用） */
  translationOnly?: boolean
  /** 译文显示在原文上方（App Store 分享页用），其余布局不变。 */
  translationFirst?: boolean
  /** 变化时强制重新翻译（刷新按钮用），即使内容相同。 */
  translationToken?: number
  allowsReplacement?: boolean
  /** 系统 Translation UI：面板传入后，readOnly 卡的长按唤起面板自绘小菜单（系统菜单按压时会缩小界面）。 */
  onMenuRequest?: (request: CardMenuRequest) => void
  translationHost?: Translation
  priority?: number
  /** 发布说明等长文本逐段走 batch，避免整篇请求卡死。 */
  preferSequential?: boolean
  /** 默认辅助识别整篇与短词；false 保留原生自动检测。 */
  stabilizeAutoSource?: boolean
  /** 系统 Translate 中自动纠正当前输入与旧源语言选择的冲突。 */
  autoCorrectSourceLanguage?: boolean
  /** 自动识别成功后通知父视图更新当前源语言显示。 */
  onSourceLanguageDetected?: (languageCode: string | null) => void
  /** 父视图保存的当前卡片识别结果，跨 compact 重建仍保留。 */
  detectedSourceLanguage?: string
  /** 页面刷新/详情请求期间暂停启动翻译；请求完成后自动恢复。 */
  translationEnabled?: boolean
  translationDelayMs?: number
  isCancelled?: () => boolean
  foregroundStyle?: any
  gradientColors?: [string, string]
  onCompleted?: (id: string, snapshot: TranslationCardSnapshot) => void
  onDelete?: (id: string) => void
}

type TargetResult = TranslationCardResult

const CARD_FILL = { light: `#FFFFFF` as const, dark: `#1C1C1E` as const }

export function targetCodes(values: string[]) {
  const result: string[] = []
  for (const value of values) {
    if (!value || result.includes(value)) continue
    result.push(value)
    if (result.length === 3) break
  }
  return result.length ? result : ["zh-Hans"]
}

export function restoredResults(values: string[], saved?: TranslationCardResult[]) {
  const byLanguage = new Map((saved || []).map((item) => [item.languageCode, item]))
  return targetCodes(values).map((languageCode) => {
    const item = byLanguage.get(languageCode)
    return item
      ? { ...item, languageCode, loading: false }
      : { languageCode, text: "", error: "", loading: false }
  })
}

export function submittedTextAfterReturn(previous: string, next: string) {
  const insertedLength = next.length - previous.length
  if (insertedLength !== 1 && insertedLength !== 2) return null

  let index = 0
  while (index < previous.length && previous[index] === next[index]) index += 1
  const inserted = next.slice(index, index + insertedLength)
  if (inserted !== "\n" && inserted !== "\r\n") return null
  if (next.slice(index + insertedLength) !== previous.slice(index)) return null
  return previous
}

function normalizedCardHeight(targetCount: number) {
  return 300 + Math.max(1, Math.min(3, targetCount)) * 58
}

function CardFrame(props: {
  compact: boolean
  readOnly: boolean
  flat?: boolean
  targetCount: number
  children?: any
  onDelete?: () => void
}) {
  const frame = props.compact
    ? { minHeight: 92, alignment: "leading" as any }
    : props.readOnly
      ? { alignment: "leading" as any }
      : { minHeight: normalizedCardHeight(props.targetCount), alignment: "leading" as any }

  return (
    <VStack
      alignment="leading"
      spacing={0}
      padding={props.flat ? { horizontal: 0, vertical: 0 } : { horizontal: 18, vertical: 16 }}
      frame={{ maxWidth: "infinity", ...frame }}
      background={props.flat ? undefined : <RoundedRectangle fill={CARD_FILL} cornerRadius={24} />}
      clipShape={props.flat ? undefined : { type: "rect", cornerRadius: 24, style: "continuous" }}
      trailingSwipeActions={props.onDelete ? {
        allowsFullSwipe: false,
        actions: [
          <Button title="删除" systemImage="trash" role="destructive" action={props.onDelete} />,
        ],
      } : undefined}
    >
      {props.children}
    </VStack>
  )
}

function IconButton(props: {
  systemName: string
  action: () => void | Promise<void>
  disabled?: boolean
  foregroundStyle?: any
}) {
  return (
    <Button action={props.action} disabled={props.disabled} buttonStyle="plain">
      <Image
        systemName={props.systemName}
        font="title3"
        foregroundStyle={props.foregroundStyle || "systemBlue"}
      />
    </Button>
  )
}

function CircleActionButton(props: {
  systemName: string
  action: () => void | Promise<void>
  disabled?: boolean
}) {
  const foreground = props.disabled ? "secondaryLabel" : "systemBlue"
  return (
    <Button action={props.action} disabled={props.disabled} buttonStyle="plain">
      <ZStack frame={{ width: 50, height: 50 }}>
        <Circle fill="#D0D3DA" frame={{ width: 50, height: 50 }} />
        <Image systemName={props.systemName} font="title3" foregroundStyle={foreground} />
      </ZStack>
    </Button>
  )
}

function DirectionCaption(props: { source: string; targets: string[] }) {
  return (
    <HStack spacing={6}>
      <Text font="caption" foregroundStyle="secondaryLabel">{languageShortLabel(props.source)}</Text>
      <Image systemName="arrow.right" font="caption2" foregroundStyle="tertiaryLabel" />
      <Text font="caption" foregroundStyle="secondaryLabel">
        {targetCodes(props.targets).map(languageShortLabel).join(" · ")}
      </Text>
    </HStack>
  )
}

/** 面板自绘长按菜单里的“复制”：行为与 CopyButton 一致（复制成功轻震，失败静默）。 */
function copyText(value: string) {
  if (!value.trim()) return
  void Pasteboard.setString(value).then(() => { try { HapticFeedback.lightImpact() } catch {} }).catch(() => {})
}

export function TranslationCard(props: TranslationCardProps) {
  const readOnly = !!props.readOnly
  const compact = !!props.compact
  const translationOnly = !!props.translationOnly
  // System Translate is the only engine in this reduced build.
  const autoTranslate = props.autoTranslate === true
  const translationEnabled = props.translationEnabled !== false
  const normalizedTargets = targetCodes(props.targetLanguages)
  const targetSignature = normalizedTargets.join("|")
  const [sourceText, setSourceText] = useState(String(props.initialText || ""))
  const [results, setResults] = useState<TargetResult[]>(() => restoredResults(normalizedTargets, props.initialResults))
  const [isTranslating, setIsTranslating] = useState(false)
  const [autoDetectedSourceLanguage, setAutoDetectedSourceLanguage] = useState<string | null>(() => (
    props.detectedSourceLanguage
      || (props.autoCorrectSourceLanguage || props.sourceLanguage === "auto"
        ? detectedAutoSourceLanguage(String(props.initialText || ""))
        : undefined)
  ) ?? null)
  const displayIdentityRef = useRef({
    sourceLanguage: props.sourceLanguage,
    initialText: String(props.initialText || ""),
    detectedSourceLanguage: props.detectedSourceLanguage,
  })
  const requestId = useRef(0)
  const sourceTextRef = useRef(String(props.initialText || ""))
  const lastEditedTextRef = useRef(String(props.initialText || ""))
  const debounceTimer = useRef<any>(null)
  const submitTimer = useRef<any>(null)
  const watchdogTimer = useRef<any>(null)
  const completedRef = useRef(false)

  function clearWatchdog() {
    if (watchdogTimer.current) clearTimeout(watchdogTimer.current)
    watchdogTimer.current = null
  }

  function updateResult(languageCode: string, patch: Partial<TargetResult>) {
    setResults((current) => current.map((item) => (
      item.languageCode === languageCode ? { ...item, ...patch } : item
    )))
  }

  const runTranslation = useEffectEvent(async () => {
    if (!translationEnabled || props.isCancelled?.()) return
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current)
      debounceTimer.current = null
    }
    if (submitTimer.current) {
      clearTimeout(submitTimer.current)
      submitTimer.current = null
    }
    const source = sourceTextRef.current.trim()
    const sourceLanguage = props.sourceLanguage
    const translationHost = props.translationHost
    const languages = targetCodes(props.targetLanguages)
    const id = requestId.current + 1
    requestId.current = id
    const isCancelled = () => id !== requestId.current || props.isCancelled?.() === true
    completedRef.current = false

    if (props.autoCorrectSourceLanguage || props.sourceLanguage === "auto") {
      // A changed input starts a new language decision. This notification is
      // session state only; it never changes the saved language preference.
      setAutoDetectedSourceLanguage(null)
      try { props.onSourceLanguageDetected?.(null) } catch {}
    }

    if (!source) {
      setResults(restoredResults(languages))
      setIsTranslating(false)
      return
    }

    setIsTranslating(true)
    clearWatchdog()
    watchdogTimer.current = setTimeout(() => {
      clearWatchdog()
      if (isCancelled()) return
      // Invalidate this run so a late native response cannot restore stale text.
      requestId.current += 1
      setResults((current) => current.map((item) => ({
        ...item,
        loading: false,
        error: item.text.trim()
          ? "翻译等待时间过长，已保留当前译文；请点重试。"
          : "翻译等待时间过长，请点重试。",
      })))
      setIsTranslating(false)
    }, TRANSLATION_RUN_TIMEOUT_MS)
    // 内容切换（更新/说明互换、刷新）时保留上一轮译文，不清空已显示文本：
    // 清空会让展开面板高度瞬间塌缩，ScrollView 偏移超出内容形成整页白屏；
    // 新译文到达后原位替换（与超时「已保留当前译文」语义一致）。
    setResults((current) => languages.map((languageCode) => {
      const existing = current.find((item) => item.languageCode === languageCode)
      const sameLanguage = sourceLanguage !== "auto" && sourceLanguage === languageCode
      return {
        languageCode,
        text: existing?.text ?? "",
        error: sameLanguage ? "源语言和目标语言不能相同。" : "",
        loading: !sameLanguage,
      }
    }))

    // Native Translation sessions are not reliably re-entrant, so targets
    // always run serially through the single built-in System Translate engine.
    const translateOne = async (languageCode: string) => {
      if (sourceLanguage !== "auto" && sourceLanguage === languageCode) {
        return {
          languageCode,
          ok: false,
          text: "",
          error: "源语言和目标语言不能相同。",
        }
      }
      try {
        const translated = await translateText(source, {
          sourceLanguageCode: sourceLanguage,
          targetLanguageCode: languageCode,
          translationHost,
          priority: props.priority,
          preferSequential: props.preferSequential,
          stabilizeAutoSource: props.stabilizeAutoSource,
          autoCorrectSourceLanguage: props.autoCorrectSourceLanguage,
          onSourceLanguageDetected: (languageCode) => {
            if (!isCancelled()) {
              setAutoDetectedSourceLanguage(languageCode)
              props.onSourceLanguageDetected?.(languageCode)
            }
          },
          isCancelled,
          onProgress: (partial) => {
            if (!isCancelled() && partial.trim()) {
              updateResult(languageCode, { text: partial, error: "", loading: true })
            }
          },
        })
        const value = translated.trim()
        if (!isCancelled()) {
          updateResult(languageCode, {
            text: value,
            error: value ? "" : "翻译引擎返回了空译文。",
            loading: false,
          })
        }
        return {
          languageCode,
          ok: !!value,
          text: value,
          error: value ? "" : "翻译引擎返回了空译文。",
        }
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason)
        if (!isCancelled()) {
          updateResult(languageCode, {
            error: message,
            loading: false,
          })
        }
        return { languageCode, ok: false, text: "", error: message, terminal: reason instanceof SystemTranslationWaitError }
      }
    }

    const outcomes: Array<{
      languageCode: string
      ok: boolean
      text: string
      error: string
    }> = []
    for (const languageCode of languages) {
      if (isCancelled()) return
      const outcome = await translateOne(languageCode)
      outcomes.push(outcome)
      if (isCancelled()) return
      if ("terminal" in outcome && outcome.terminal) {
        for (const remaining of languages.slice(outcomes.length)) {
          updateResult(remaining, { error: outcome.error, loading: false })
          outcomes.push({ languageCode: remaining, ok: false, text: "", error: outcome.error })
        }
        break
      }
    }

    if (isCancelled()) return
    clearWatchdog()
    setIsTranslating(false)
    if (!readOnly && !compact && outcomes.length > 0 && outcomes.every((item) => item.ok)) {
      if (!completedRef.current) {
        completedRef.current = true
        props.onCompleted?.(props.id, {
          sourceText: source,
          results: outcomes.map((item) => ({
            languageCode: item.languageCode,
            text: item.text,
            error: item.error,
            loading: false,
          })),
        })
      }
    }
  })

  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
      if (submitTimer.current) clearTimeout(submitTimer.current)
      clearWatchdog()
      requestId.current += 1
    }
  }, [])

  useEffect(() => {
    const identity = {
      sourceLanguage: props.sourceLanguage,
      initialText: String(props.initialText || ""),
      detectedSourceLanguage: props.detectedSourceLanguage,
    }
    const previous = displayIdentityRef.current
    const textChanged = previous.initialText !== identity.initialText
    const sameAsCurrentText = identity.initialText === sourceTextRef.current
    const sourceChanged = previous.sourceLanguage !== identity.sourceLanguage
    const textChangedWithoutInternalEdit = textChanged && !sameAsCurrentText
    if (sourceChanged || textChangedWithoutInternalEdit) {
      // A genuinely new source/input invalidates the old card decision.
      setAutoDetectedSourceLanguage(null)
    } else if (previous.detectedSourceLanguage !== identity.detectedSourceLanguage) {
      // Parent feedback is the authoritative per-card session state. Do not
      // clear it while synchronizing the compact/completed card row.
      setAutoDetectedSourceLanguage(identity.detectedSourceLanguage || null)
    }
    displayIdentityRef.current = identity
  }, [props.sourceLanguage, props.initialText, props.detectedSourceLanguage])

  useEffect(() => {
    if (!readOnly || props.initialText === undefined) return
    const next = String(props.initialText || "")
    if (next !== sourceTextRef.current) {
      // Invalidate before the state update schedules the next translation effect.
      requestId.current += 1
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current)
        debounceTimer.current = null
      }
      if (submitTimer.current) {
        clearTimeout(submitTimer.current)
        submitTimer.current = null
      }
      clearWatchdog()
      sourceTextRef.current = next
      lastEditedTextRef.current = next
      setSourceText(next)
      // 内容切换保留旧译文（见 runTranslation），避免高度骤减造成白屏。
      setResults((current) => restoredResults(normalizedTargets, current).map((item) => ({ ...item, error: "" })))
      setIsTranslating(false)
      completedRef.current = false
    }
  }, [props.initialText, readOnly])

  useEffect(() => {
    // Completed cards own a persisted translation snapshot. Never clear it
    // when ForEach rebuilds the row after switching to compact mode.
    if (compact) return
    requestId.current += 1
    completedRef.current = false
    setResults((current) => restoredResults(normalizedTargets, current).map((item) => ({ ...item, error: "" })))
    setIsTranslating(false)
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    clearWatchdog()
    if (!autoTranslate || !translationEnabled || !sourceTextRef.current.trim()) return
    const delay = props.translationDelayMs ?? (readOnly ? 0 : 700)
    debounceTimer.current = setTimeout(() => { void runTranslation() }, Math.max(0, delay))
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
      clearWatchdog()
    }
  }, [props.sourceLanguage, targetSignature, autoTranslate, translationEnabled, readOnly, sourceText, compact, props.translationToken, props.translationDelayMs, props.priority, props.preferSequential, props.stabilizeAutoSource, props.autoCorrectSourceLanguage])

  function updateInputText(value: string) {
    const previous = lastEditedTextRef.current
    const submittedText = submittedTextAfterReturn(previous, value)
    const next = submittedText ?? value
    requestId.current += 1
    completedRef.current = false
    lastEditedTextRef.current = next
    sourceTextRef.current = next
    setSourceText(next)
    setResults(restoredResults(normalizedTargets))
    setIsTranslating(false)
    clearWatchdog()
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current)
      debounceTimer.current = null
    }
    if (submittedText !== null && next.trim()) submitTranslation()
  }

  function submitTranslation() {
    if (submitTimer.current) clearTimeout(submitTimer.current)
    submitTimer.current = setTimeout(() => {
      submitTimer.current = null
      void runTranslation()
    }, 60)
  }

  function clear() {
    requestId.current += 1
    completedRef.current = false
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    sourceTextRef.current = ""
    lastEditedTextRef.current = ""
    setSourceText("")
    setResults(restoredResults(normalizedTargets))
    setIsTranslating(false)
    clearWatchdog()
  }

  async function copyTranslations() {
    const value = results
      .filter((item) => item.text.trim())
      .map((item) => item.text.trim())
      .join("\n\n")
    if (value) await Pasteboard.setString(value)
  }

  function finishPrimaryResult() {
    if (!props.allowsReplacement) return
    const primary = results.find((item) => item.text.trim())
    if (primary) finishTranslation(primary.text)
  }

  const shownSourceLanguage = (props.autoCorrectSourceLanguage || props.sourceLanguage === "auto")
    ? (props.detectedSourceLanguage || autoDetectedSourceLanguage || props.sourceLanguage)
    : props.sourceLanguage

  // 自绘长按菜单（系统面板）：在文本正上方盖一层几乎透明的 Rectangle 接管长按。
  // 文本本身（WebView 字体 / 动画 Text / 普通 Text）不再挂任何手势，避免被吞或抢手势。
  // 注意：每个位置必须用独立的元素实例（menuOverlay 工厂），共享实例会串菜单。
  const menuOverlay = (fire: () => void) => (
    <Rectangle fill="rgba(0,0,0,0.003)"
      contentShape="rect" onLongPressGesture={fire}
      frame={{ maxWidth: "infinity" as any, maxHeight: "infinity" as any }} />
  )
  const menuActions = (readOnly && props.onMenuRequest) ? {
    source: () => {
      const request = props.onMenuRequest
      if (!request) return
      request({
        actions: [
          { label: "原文", run: () => copyText(sourceText) },
          { label: "重试", run: () => { void runTranslation() } },
        ],
      })
    },
    target: (text: string) => {
      const request = props.onMenuRequest
      if (!request) return
      request({
        actions: [
          { label: "译文", run: () => copyText(text) },
          { label: "重试", run: () => { void runTranslation() } },
          ...(props.allowsReplacement ? [{ label: "替换", run: () => finishTranslation(text) }] : []),
        ],
      })
    },
  } : null

  if (compact) {
    return (
      <CardFrame compact targetCount={normalizedTargets.length} readOnly={false} flat={props.flat} onDelete={props.onDelete ? () => props.onDelete?.(props.id) : undefined}>
        <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
          <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
            <DirectionCaption source={shownSourceLanguage} targets={normalizedTargets} />
            <VStack alignment="leading" contextMenu={{ menuItems: <CopyButton title="复制原文" text={sourceText} /> }}>
              <FontText role="source" small flat={props.flat} foregroundStyle={props.foregroundStyle} gradientColors={props.gradientColors} text={sourceText || "—"} />
            </VStack>
          </VStack>
          <Image systemName="checkmark.circle.fill" foregroundStyle="systemGreen" />
        </HStack>

        {results.map((item) => (
          <VStack key={item.languageCode} alignment="leading" spacing={3} padding={{ top: 7 }}>
            <Text font="caption" foregroundStyle="tertiaryLabel">{languageShortLabel(item.languageCode)}</Text>
            <VStack alignment="leading" contextMenu={{ menuItems: <CopyButton title="复制" text={item.text} /> }}>
              <FontText role="target" flat={props.flat} foregroundStyle={props.foregroundStyle} gradientColors={props.gradientColors} text={item.text || item.error || (item.loading ? "…" : "—")} />
            </VStack>
          </VStack>
        ))}

        <HStack spacing={14} padding={{ top: 12 }}>
          <Spacer />
          <CircleActionButton systemName="doc.on.doc" action={copyTranslations} />
        </HStack>
      </CardFrame>
    )
  }

  const sourceSection = props.translationOnly ? null : (
        <>
          <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
            <HStack spacing={2} frame={{ height: 26, alignment: "leading" as any }}>
              <Text font="title3" fontWeight="semibold">{languageShortLabel(shownSourceLanguage)}</Text>
            </HStack>
            <Spacer />
            {!readOnly && sourceText.trim() ? (
              <IconButton systemName="xmark.circle.fill" foregroundStyle="secondaryLabel" action={clear} />
            ) : null}
          </HStack>

          <ZStack alignment="leading" padding={{ top: 8, bottom: 13 }} frame={{ maxWidth: "infinity" as any, alignment: "leading" as any }}
            {...(readOnly && !props.onMenuRequest ? { contextMenu: { menuItems: <CopyButton title="复制原文" text={sourceText} /> } } : {})}>
            <FontText role="source" text={readOnly ? sourceText || "—" : sourceText} selectable={menuActions ? false : !(readOnly && props.onMenuRequest)}
              flat={props.flat} foregroundStyle={props.foregroundStyle} gradientColors={props.gradientColors} editable={!readOnly} onChanged={updateInputText} onTextSubmit={submitTranslation} />
            {menuActions ? menuOverlay(menuActions.source) : null}
          </ZStack>
        </>
  )

  const resultsSection = results.map((item) => (
        <VStack key={item.languageCode} alignment="leading" spacing={8} padding={{ top: translationOnly ? 0 : 13, bottom: 5 }}>
          <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
            <HStack spacing={2} frame={{ height: 26, alignment: "leading" as any }}>
              <AnimText font="title3" fontWeight="semibold" anim="interpolate" dur={0.35}>
                {languageShortLabel(item.languageCode)}
              </AnimText>
            </HStack>
            <Spacer />
            {item.loading ? <ProgressView /> : item.text ? (
              <Image
                systemName="checkmark.circle.fill"
                foregroundStyle="systemGreen"
                contentTransition="symbolEffect"
                symbolEffect={{ effect: "bounce", value: true }}
              />
            ) : null}
          </HStack>
          {/* 系统 Translation UI：长按唤起面板自绘小菜单——手势由文本上方的透明覆盖层接管。
              非面板（搜索/分享页）仍用系统 contextMenu。 */}
          {item.text ? (
            menuActions ? (
              <ZStack alignment="leading" frame={{ maxWidth: "infinity" as any, alignment: "leading" as any }}>
                <FontText role="target" animated={!translationOnly} selectable={false} flat={props.flat} foregroundStyle={props.foregroundStyle} gradientColors={props.gradientColors} text={item.text} />
                {menuActions ? menuOverlay(() => menuActions.target(item.text)) : null}
              </ZStack>
            ) : (
              <VStack alignment="leading" contextMenu={{ menuItems: <CopyButton title="复制" text={item.text} /> }}>
                <FontText role="target" animated={!translationOnly} selectable flat={props.flat} foregroundStyle={props.foregroundStyle} gradientColors={props.gradientColors} text={item.text} />
              </VStack>
            )
          ) : null}
          {item.error ? (
            <HStack spacing={8} padding={{ top: item.text ? 6 : 0 }}>
              <Text font="subheadline" foregroundStyle="systemRed">{item.error}</Text>
              <Spacer />
              <IconButton systemName="arrow.clockwise" action={() => { void runTranslation() }} />
            </HStack>
          ) : !item.text ? (
            // readOnly 卡（搜索/分享页更新·说明）：底部已有全局 LoadingCaption，
            // 此处只占位不重复显示，避免“正在连接翻译引擎…”出现两行；可编辑卡不动。
            readOnly ? <Text font="caption" foregroundStyle="tertiaryLabel"> </Text>
              : <LoadingCaption active={item.loading} />
          ) : null}
        </VStack>
  ))

  return (
    <CardFrame compact={false} targetCount={normalizedTargets.length} readOnly={readOnly} flat={props.flat} onDelete={props.onDelete ? () => props.onDelete?.(props.id) : undefined}>
      {/* 译文在上 / 原文在下：仅调换渲染顺序，各块内部样式与功能不动。 */}
      {props.translationFirst ? (
        <>
          {resultsSection}
          {sourceSection}
        </>
      ) : (
        <>
          {sourceSection}
          {resultsSection}
        </>
      )}

      {!readOnly ? (
        <HStack spacing={14} padding={{ top: 12 }} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
          <Spacer />
          {isTranslating ? <ProgressView /> : null}
        </HStack>
      ) : (
        <LoadingCaption active={isTranslating} />
      )}
    </CardFrame>
  )
}
