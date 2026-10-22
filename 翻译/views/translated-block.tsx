import { Text, useMemo } from "scripting"
import { loadPreferences } from "../core/preferences"
import { readTranslationSnapshot, translationSnapshotKey, writeTranslationSnapshot } from "../core/translation-snapshot"
import { TranslationCard, type TranslationCardResult } from "./translation-card"

export function TranslatedBlock(props: {
  content: string
  /** 版本归属变化时重建内部译文，避免保留上一版本的结果。 */
  contentIdentity?: string
  id?: string
  /** 跨进程译文快照的稳定归属；默认用 id。搜索页 id 含会话内递增序号，
   *  必须传不含序号的作用域，否则新进程永远命不中缓存。 */
  snapshotScope?: string
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
  const preferences = loadPreferences()
  const targetLanguages = preferences.defaultTargetLanguageCodes
  const id = props.id || "appstore-content"
  const scope = props.snapshotScope || `${id}:${props.contentIdentity || ""}`
  /**
   * 分享扩展每次打开都是新进程，内存译文缓存留不住。这里按
   * 「卡片身份 + 原文 + 语言」读取上次完成的译文，命中就直接渲染，
   * 不再重新请求翻译——「查看新说明」重复打开同一版本因此是秒开。
   * 只在身份/正文变化时读一次共享存储，避免译文进度刷新时重复读盘。
   */
  const snapshotKey = translationSnapshotKey(scope, content, preferences.defaultSourceLanguageCode, targetLanguages)
  const cached = useMemo(
    () => content ? readTranslationSnapshot(snapshotKey, content) : null,
    [snapshotKey, content],
  )
  if (!content) {
    return <Text foregroundStyle={props.foregroundStyle || "secondaryLabel"}>{props.emptyText || "App Store 未提供此项内容。"}</Text>
  }

  return (
    <TranslationCard
      key={props.contentIdentity}
      id={id}
      initialText={content}
      initialResults={cached || undefined}
      sourceLanguage={preferences.defaultSourceLanguageCode}
      targetLanguages={targetLanguages}
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
      preferSequential={props.preferSequential ?? content.length > 900}
      translationEnabled={props.translationEnabled}
      translationDelayMs={props.translationDelayMs}
      isCancelled={props.isCancelled}
      foregroundStyle={props.foregroundStyle}
      gradientColors={props.gradientColors}
      onSnapshot={(results: TranslationCardResult[]) => writeTranslationSnapshot(snapshotKey, content, results)}
    />
  )
}
