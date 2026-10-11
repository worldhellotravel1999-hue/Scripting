import {
  AppEvents,
  Button,
  ForEach,
  Image,
  List,
  Navigation,
  NavigationStack,
  Section,
  useEffect,
  useRef,
  useObservable,
  useState,
} from "scripting"
import { beginScreenTranslation } from "../core/screen-job"
import { inlineImageBitmap } from "../core/screen-ocr"
import { loadPreferences, normalizeTargetSelection, savePreferences } from "../core/preferences"
import { LanguageBar, toggleTargetSelection } from "./common"
import { TypefaceMenu } from "./font-menu"
import { ScreenTranslationResult } from "./screen-result"
import {
  TranslationCard,
  type TranslationCardResult,
  type TranslationCardSnapshot,
} from "./translation-card"

type TranslationCardItem = {
  id: string
  sourceLanguage: string
  targetLanguages: string[]
  compact: boolean
  sourceText?: string
  results?: TranslationCardResult[]
  detectedSourceLanguage?: string
}

function newCardId() {
  return `translation_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function makeCard(sourceLanguage: string, targetLanguages: string[]): TranslationCardItem {
  return {
    id: newCardId(),
    sourceLanguage,
    targetLanguages: targetLanguages.slice(0, 3),
    compact: false,
  }
}

function activeCard(cards: TranslationCardItem[]) {
  return cards.find((item) => !item.compact)
}

function TranslationWorkspace() {
  // 首渲染初始化器：偏好只在挂载时读一次（原先每次渲染都同步读 Storage，
  // 结果只喂下方 useState/useRef 初值，后续渲染的读取纯浪费）。回前台的
  // 跨进程同步仍由下方 scenePhase 监听自行 loadPreferences()，不受影响。
  const [initial] = useState(() => {
    const preferences = loadPreferences()
    const source = preferences.defaultSourceLanguageCode
    return {
      source,
      targets: normalizeTargetSelection(preferences.defaultTargetLanguageCodes, source),
    }
  })
  const initialSource = initial.source
  const initialTargets = initial.targets

  const [sourceLanguage, setSourceLanguage] = useState(initialSource)
  const [detectedSourceLanguage, setDetectedSourceLanguage] = useState<string | null>(null)
  const [sourceCorrectionEnabled, setSourceCorrectionEnabled] = useState(true)
  const [targetLanguages, setTargetLanguages] = useState<string[]>(initialTargets)
  const [translationHost] = useState(() => new Translation())
  const pickingRef = useRef(false)

  // 主界面右上角「更多（四个点）」：直接打开系统相册选一张截图，
  // 选中即跑同一份「OCR → 翻译 → 覆盖渲染」管线并呈现结果页；
  // 取消/失败一律静默返回，不弹任何提示。
  async function pickScreenshotForTranslation() {
    if (pickingRef.current) return
    pickingRef.current = true
    try {
      const picked = await Photos.pick({ filter: PHPickerFilter.images(), limit: 1 })
      const first = picked?.[0]
      if (!first) return
      const path = await first.imagePath()
      if (!path) return
      // 物化位图：原生 Vision 对无可用 CGImage 的 UIImage 会空指针崩溃。
      const bitmap = inlineImageBitmap(UIImage.fromFile(path))
      if (!bitmap) return
      // 相册入口与 intent 不同：主 App 进程常驻，screen-job 的 active
      // 会残留上一次任务，必须先 begin 覆盖旧任务再呈现（结果页挂载后
      // startScreenTranslation 拿到的就是这份新工作）。
      beginScreenTranslation(bitmap)
      Navigation.present({ element: <ScreenTranslationResult image={bitmap} /> }).catch(() => {})
    } catch {
      // 用户取消相册或呈现失败：静默。
    } finally {
      pickingRef.current = false
    }
  }

  const cards = useObservable<TranslationCardItem[]>(() => [makeCard(initialSource, initialTargets)])

  function updateCard(id: string, patch: Partial<TranslationCardItem>) {
    cards.setValue(cards.value.map((item) => item.id === id ? { ...item, ...patch } : item))
  }

  function deleteCard(id: string) {
    const remaining = cards.value.filter((item) => item.id !== id)
    cards.setValue(remaining.length
      ? remaining
      : [makeCard(sourceLanguage, targetLanguages)])
  }

  function applyLanguages(source: string, targets: string[], resetDetected = false) {
    const nextTargets = normalizeTargetSelection(targets, source)
    setSourceLanguage(source)
    setTargetLanguages(nextTargets)
    savePreferences(source, nextTargets)
    syncedLangRef.current = `${source}|${nextTargets.join(",")}`
    const current = activeCard(cards.value)
    if (current) {
      updateCard(current.id, {
        sourceLanguage: source,
        targetLanguages: nextTargets,
        ...(resetDetected ? { detectedSourceLanguage: undefined } : {}),
      })
    }
  }

  function toggleTargetLanguages(code: string) {
    const next = normalizeTargetSelection(toggleTargetSelection(targetLanguages, code), sourceLanguage)
    applyLanguages(sourceLanguage, next)
  }

  // 跨进程语言同步：系统翻译 UI / App Store 扩展改语言后写共享存储，
  // 但主界面不会收到任何推送。这里在每次回到前台时重读一次共享偏好，
  // 若与当前状态不同则同步语言栏与当前活动卡片（含增/减目标语言）。
  const syncedLangRef = useRef(`${initialSource}|${initialTargets.join(",")}`)
  useEffect(() => {
    const listener = (phase: string) => {
      if (phase !== "active") return
      const prefs = loadPreferences()
      const signature = `${prefs.defaultSourceLanguageCode}|${prefs.defaultTargetLanguageCodes.join(",")}`
      if (signature === syncedLangRef.current) return
      syncedLangRef.current = signature
      applyLanguages(prefs.defaultSourceLanguageCode, prefs.defaultTargetLanguageCodes, true)
    }
    AppEvents.scenePhase.addListener(listener)
    return () => AppEvents.scenePhase.removeListener(listener)
  }, [])

  function swapLanguages() {
    const nextSource = targetLanguages[0]
    const previousSource = displayedSourceLanguage === "auto" ? "en" : displayedSourceLanguage
    setDetectedSourceLanguage(null)
    setSourceCorrectionEnabled(true)
    applyLanguages(nextSource, [previousSource, ...targetLanguages.slice(1)], true)
  }

  const currentCardDetectedSourceLanguage = activeCard(cards.value)?.detectedSourceLanguage
  const displayedSourceLanguage = sourceCorrectionEnabled
    ? (currentCardDetectedSourceLanguage || detectedSourceLanguage || sourceLanguage)
    : sourceLanguage

  function completeCard(id: string, snapshot: TranslationCardSnapshot) {
    const current = cards.value.find((item) => item.id === id)
    if (!current || current.compact) return
    const completed = {
      ...current,
      compact: true,
      sourceText: snapshot.sourceText,
      results: snapshot.results,
    }
    const next = makeCard(sourceLanguage, targetLanguages)
    setDetectedSourceLanguage(null)
    cards.setValue(cards.value.map((item) => item.id === id ? completed : item).concat(next))
  }

  return (
    <List
      listStyle="plain"
      scrollContentBackground="hidden"
      listSectionSpacing={12}
      background={{ light: "#F2F2F7", dark: "#000000" }}
      translationHost={translationHost}
      navigationTitle="Translate"
      navigationBarTitleDisplayMode="inline"
      toolbar={{
        principal: <TypefaceMenu />,
        topBarTrailing: (
          <Button buttonStyle="borderless" action={() => { void pickScreenshotForTranslation() }}>
            <Image systemName="circle.grid.2x2" font="body" />
          </Button>
        ),
      }}
    >
      <Section>
        <LanguageBar
          sourceLanguage={displayedSourceLanguage}
          targetLanguages={targetLanguages}
          onSourceChanged={(value) => {
            // The toolbar language is an initial hint. Main cards always
            // re-detect each input, including after a concrete choice here.
            setSourceCorrectionEnabled(true)
            setDetectedSourceLanguage(null)
            applyLanguages(value, targetLanguages, true)
          }}
          onToggleTarget={toggleTargetLanguages}
          onSwap={swapLanguages}
        />
      </Section>

      <Section>
        <ForEach
          data={cards}
          builder={(card: TranslationCardItem) => (
            <TranslationCard
              key={card.id}
              id={card.id}
              sourceLanguage={card.sourceLanguage}
              targetLanguages={card.targetLanguages}
              detectedSourceLanguage={card.detectedSourceLanguage}
              autoCorrectSourceLanguage={sourceCorrectionEnabled}
              initialText={card.sourceText}
              initialResults={card.results}
              translationHost={translationHost}
              compact={card.compact}
              autoTranslate={!card.compact}
              onCompleted={completeCard}
              onDelete={deleteCard}
              onSourceLanguageDetected={(languageCode) => {
                // Keep the toolbar and this card in the same session state;
                // this does not update the saved source preference.
                if (sourceCorrectionEnabled) {
                  setDetectedSourceLanguage(languageCode)
                  updateCard(card.id, { detectedSourceLanguage: languageCode || undefined })
                }
              }}
            />
          )}
        />
      </Section>
    </List>
  )
}

export function HomeView() {
  return (
    <NavigationStack>
      <TranslationWorkspace />
    </NavigationStack>
  )
}
