import {
  Button,
  HStack,
  List,
  Rectangle,
  Section,
  Text,
  VStack,
  ZStack,
  useState,
} from "scripting"
import { loadPreferences, normalizeTargetSelection, savePreferences } from "../core/preferences"
import { TranslationCard, type CardMenuRequest } from "./translation-card"
import { LanguageBar, toggleTargetSelection } from "./common"

export function TranslationPanel(props: {
  inputText: string | null
  allowsReplacement: boolean
}) {
  // 首渲染初始化器：偏好只在挂载时读一次（原先每次渲染都同步读 Storage，
  // 结果只喂下方 useState 初值，后续读取纯浪费）。
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
  // 长按菜单：卡片通过 onMenuRequest 唤起面板自绘的小菜单（不用系统 contextMenu）。
  const [menu, setMenu] = useState<CardMenuRequest | null>(null)

  function applyLanguages(source: string, targets: string[]) {
    const nextTargets = normalizeTargetSelection(targets, source)
    setSourceLanguage(source)
    setTargetLanguages(nextTargets)
    savePreferences(source, nextTargets)
  }

  function toggleTargets(code: string) {
    const next = normalizeTargetSelection(toggleTargetSelection(targetLanguages, code), sourceLanguage)
    applyLanguages(sourceLanguage, next)
  }

  function swap() {
    const primary = targetLanguages[0]
    const previousSource = displayedSourceLanguage === "auto" ? "en" : displayedSourceLanguage
    setDetectedSourceLanguage(null)
    setSourceCorrectionEnabled(false)
    applyLanguages(primary, [previousSource, ...targetLanguages.slice(1)])
  }

  const displayedSourceLanguage = sourceCorrectionEnabled && detectedSourceLanguage
    ? detectedSourceLanguage
    : sourceLanguage

  return (
    <ZStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
      <List
        listStyle="plain"
        scrollContentBackground="hidden"
        listSectionSpacing={12}
        background={{ light: "#F2F2F7", dark: "#000000" }}
        translationHost={translationHost}
      >
        <Section>
          <LanguageBar
            sourceLanguage={displayedSourceLanguage}
            targetLanguages={targetLanguages}
            onSourceChanged={(value) => {
              // Selecting Auto enables correction for the next input. Selecting
              // a concrete language is an intentional manual override.
              setSourceCorrectionEnabled(value === "auto")
              setDetectedSourceLanguage(null)
              applyLanguages(value, targetLanguages)
            }}
            onToggleTarget={toggleTargets}
            onSwap={swap}
          />
        </Section>
        <Section>
          <TranslationCard
            id="system-translation"
            initialText={props.inputText || ""}
            sourceLanguage={sourceLanguage}
            detectedSourceLanguage={detectedSourceLanguage ?? undefined}
            targetLanguages={targetLanguages}
            autoCorrectSourceLanguage={sourceCorrectionEnabled}
            readOnly
            autoTranslate
            translationFirst
            allowsReplacement={props.allowsReplacement}
            translationHost={translationHost}
            onMenuRequest={setMenu}
            onSourceLanguageDetected={(languageCode) => {
              // Automatic detection is session-only: show it in the picker
              // without changing the persisted default source language. Feeding
              // it back into the card's sourceLanguage prop would restart the
              // running translation on every detection change.
              if (sourceCorrectionEnabled) setDetectedSourceLanguage(languageCode)
            }}
          />
        </Section>
      </List>
      {menu ? <TranslationMenuSheet request={menu} onClose={() => setMenu(null)} /> : null}
    </ZStack>
  )
}

/**
 * 系统面板的长按菜单：一个小方框，里面只有中文文字行（无图标），点方框外面关闭。
 * 不用系统 contextMenu，长按时界面不会被抬起缩小。
 */
export function TranslationMenuSheet(props: { request: CardMenuRequest; onClose: () => void }) {
  return (
    <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      onTapGesture={props.onClose}
      contentShape="rect"
      background={{ light: "rgba(0,0,0,0.12)", dark: "rgba(0,0,0,0.3)" }}>
      <VStack spacing={0}
        background={{ light: "#FFFFFF", dark: "#1C1C1E" }}
        clipShape={{ type: "rect", cornerRadius: 12, style: "continuous" }}
        shadow={{ color: "rgba(0,0,0,0.22)", radius: 18, y: 6 }}>
        {props.request.actions.map(action => (
          <Button key={action.label} buttonStyle="plain"
            action={() => { props.onClose(); action.run() }}
            overlay={
              /* 隐形命中层：外观零变化，点击/长按判定各向外扩约 8–10pt。
                 保持有界（不能撑满），否则会吞掉遮罩的「点空白关闭」。 */
              <Rectangle fill="rgba(0,0,0,0.003)" contentShape="rect"
                onTapGesture={() => { props.onClose(); action.run() }}
                onLongPressGesture={() => { props.onClose(); action.run() }}
                frame={{ minWidth: 116, minHeight: 56 }} />
            }>
            <HStack padding={{ horizontal: 18, vertical: 10 }} frame={{ minWidth: 96, alignment: "leading" as any }}>
              <Text>{action.label}</Text>
            </HStack>
          </Button>
        ))}
      </VStack>
    </VStack>
  )
}
