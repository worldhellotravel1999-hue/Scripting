import { Text } from "scripting"
import { loadPreferences } from "../core/preferences"
import { TranslationCard } from "./translation-card"

export function TranslatedBlock(props: {
  content: string
  /** 版本归属变化时重建内部译文，避免保留上一版本的结果。 */
  contentIdentity?: string
  id?: string
  emptyText?: string
  translationHost?: Translation
  /** 用户主动展开的说明优先进入系统翻译队列。 */
  priority?: number
  /** 发布说明等长文本逐段调用 batch，避免整篇请求卡住。 */
  preferSequential?: boolean
  /** 页面刷新或详情请求期间暂停自动翻译。 */
  translationEnabled?: boolean
  /** 首屏后台内容可稍后启动，给说明留出优先机会。 */
  translationDelayMs?: number
  /** Immediate owner cancellation, including the interval before unmount. */
  isCancelled?: () => boolean
  foregroundStyle?: any
  gradientColors?: [string, string]
  /** 只显示译文，隐藏原文 */
  translationOnly?: boolean
  /** 译文显示在原文上方（App Store 分享页用） */
  translationFirst?: boolean
  /** 变化时强制重新翻译（刷新按钮用），即使内容相同。 */
  translationToken?: number
}) {
  const content = String(props.content || "").trim()
  if (!content) {
    return <Text foregroundStyle={props.foregroundStyle || "secondaryLabel"}>{props.emptyText || "App Store 未提供此项内容。"}</Text>
  }

  const preferences = loadPreferences()
  return (
    <TranslationCard
      key={props.contentIdentity}
      id={props.id || "appstore-content"}
      initialText={content}
      sourceLanguage={preferences.defaultSourceLanguageCode}
      targetLanguages={preferences.defaultTargetLanguageCodes}
      readOnly
      flat
      autoTranslate
      stabilizeAutoSource
      autoCorrectSourceLanguage
      translationOnly={props.translationOnly}
      translationFirst={props.translationFirst}
      translationToken={props.translationToken}
      translationHost={props.translationHost}
      priority={props.priority}
      preferSequential={props.preferSequential}
            translationEnabled={props.translationEnabled}
      translationDelayMs={props.translationDelayMs}
      isCancelled={props.isCancelled}
      foregroundStyle={props.foregroundStyle}
      gradientColors={props.gradientColors}
    />
  )
}
