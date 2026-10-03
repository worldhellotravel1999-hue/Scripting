import {
  AppEvents,
  ForEach,
  List,
  NavigationStack,
  Section,
  useEffect,
  useRef,
  useObservable,
  useState,
} from "scripting"
import { loadPreferences, normalizeTargetSelection, savePreferences } from "../core/preferences"
import { LanguageBar, toggleTargetSelection } from "./common"
import { TypefaceMenu } from "./font-menu"
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

export function TranslationWorkspace() {
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
      toolbar={{ principal: <TypefaceMenu /> }}
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
