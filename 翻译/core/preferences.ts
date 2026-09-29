import { LANGUAGE_OPTIONS } from "./constants"
import type { TranslationPreferences } from "./types"

const PREFERENCES_KEY = "lingo_system_translation_preferences_v1"
const LEGACY_KEYS = [
  "lingolens_system_translation_preferences_v1",
  "appstore_translator_unified_settings_v1",
  "appstore_translator_settings_v1",
  "translator_settings_v2",
]
const DEFAULT_SOURCE_LANGUAGE_CODE = "auto"
const DEFAULT_TARGET_LANGUAGE_CODE = "zh-Hans"

function storage(): any {
  return (globalThis as any).Storage
}

// 语言选择必须跨进程共享：主 Translate 界面、系统翻译 UI 扩展、App Store
// 分享扩展各自运行在独立容器里，不带 { shared: true } 时各自存一份，
// 会出现「在一个界面换语言、其他两个卡片不同步」的问题。
const STORAGE_OPTIONS = { shared: true }

function safeGet(key: string): any {
  try {
    const shared = storage()?.get?.(key, STORAGE_OPTIONS)
    if (shared && typeof shared === "object") return shared
    // 旧版本把偏好存在各进程私有存储里：共享存储为空时回退读一次，
    // 让已有语言选择平滑迁移（读方随后的 safeSet 会写入共享存储）。
    return storage()?.get?.(key)
  } catch {
    return null
  }
}

function safeSet(key: string, value: TranslationPreferences) {
  try {
    storage()?.set?.(key, value, STORAGE_OPTIONS)
  } catch {}
}

function safeRemove(key: string) {
  try {
    storage()?.remove?.(key, STORAGE_OPTIONS)
  } catch {}
}

function isLanguage(code: string) {
  return LANGUAGE_OPTIONS.some((item) => item.code === code)
}

function normalizeSource(value: unknown) {
  const code = String(value ?? "").trim()
  return code === "auto" || isLanguage(code) ? code : DEFAULT_SOURCE_LANGUAGE_CODE
}

export function normalizeTargetSelection(values: unknown, sourceLanguage: string) {
  const result: string[] = []
  const candidates = Array.isArray(values) ? values : [values]
  for (const raw of candidates) {
    const code = String(raw ?? "").trim()
    if (!isLanguage(code)) continue
    if (sourceLanguage !== "auto" && code === sourceLanguage) continue
    if (result.includes(code)) continue
    result.push(code)
    if (result.length === 3) break
  }
  if (!result.length) result.push(sourceLanguage === "zh-Hans" ? "en" : DEFAULT_TARGET_LANGUAGE_CODE)
  return result
}

export function normalizePreferences(raw?: Partial<TranslationPreferences> | null): TranslationPreferences {
  const source = normalizeSource(raw?.defaultSourceLanguageCode)
  const targets = normalizeTargetSelection(
    raw?.defaultTargetLanguageCodes?.length
      ? raw.defaultTargetLanguageCodes
      : [raw?.defaultTargetLanguageCode],
    source,
  )
  return {
    defaultSourceLanguageCode: source,
    defaultTargetLanguageCode: targets[0],
    defaultTargetLanguageCodes: targets,
  }
}

export function loadPreferences(): TranslationPreferences {
  const current = safeGet(PREFERENCES_KEY)
  if (current && typeof current === "object") return normalizePreferences(current)

  const legacy = LEGACY_KEYS.map(safeGet).find((value) => value && typeof value === "object")
  const migrated = normalizePreferences(legacy)
  safeSet(PREFERENCES_KEY, migrated)
  for (const key of LEGACY_KEYS) safeRemove(key)
  return migrated
}

export function savePreferences(sourceLanguage: string, targetLanguages: string[]) {
  const preferences = normalizePreferences({
    defaultSourceLanguageCode: sourceLanguage,
    defaultTargetLanguageCode: targetLanguages[0],
    defaultTargetLanguageCodes: targetLanguages,
  })
  safeSet(PREFERENCES_KEY, preferences)
  return preferences
}
