import { expandTranslationSheet, getTranslationSession, presentTranslationUI } from "./core/session"
import { loadPreferences, normalizeTargetSelection } from "./core/preferences"
import { prewarmGoogleTranslation } from "./core/translate"
import { TranslationPanel } from "./views/translation-panel"

const session = getTranslationSession()
const inputText = session.inputText || ""
if (inputText.length > 500) expandTranslationSheet()
// 脚本一启动就先预热谷歌快路径：与扩展冷启动、翻译面板呈现重叠，
// 面板内首次翻译可直接复用这次结果，显著减少等待。预热失败静默，
// 面板会自动回退系统原生翻译（失败的冷却标记也在预热内完成）。
if (inputText.trim()) {
  const preferences = loadPreferences()
  const targets = normalizeTargetSelection(
    preferences.defaultTargetLanguageCodes,
    preferences.defaultSourceLanguageCode,
  )
  prewarmGoogleTranslation(inputText, {
    sourceLanguageCode: preferences.defaultSourceLanguageCode,
    targetLanguageCode: targets[0],
    autoCorrectSourceLanguage: true,
  })
}
presentTranslationUI(
  <TranslationPanel
    inputText={inputText}
    allowsReplacement={session.allowsReplacement}
  />
)
