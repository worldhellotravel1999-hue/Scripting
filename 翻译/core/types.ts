export type LanguageOption = {
  code: string
  label: string
  promptName: string
}

export type TranslationPreferences = {
  defaultTargetLanguageCode: string
  defaultTargetLanguageCodes: string[]
  defaultSourceLanguageCode: string
}

export type TranslationRequest = {
  sourceText: string
  sourceLanguageCode: string
  targetLanguageCode: string
  isCancelled?: () => boolean
  /** 用户主动打开的内容可优先于后台/首屏内容进入系统翻译队列。 */
  priority?: number
  /** 长更新说明逐段调用批量接口，避免整篇 batch 卡住。 */
  preferSequential?: boolean
}

export type TranslationResult = {
  translatedText: string
}
