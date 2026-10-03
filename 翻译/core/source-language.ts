import { LANGUAGE_OPTIONS } from "./constants"

const MIN_TEXT_LENGTH = 4
const MAX_TEXT_LENGTH = 60_000
const SHORT_TEXT_LENGTH = 160
const MIN_CONFIDENCE = 0.95
const MIN_MARGIN = 0.20
const CACHE_LIMIT = 24

// Session-only, bounded, and keyed by the complete source text: another app,
// refreshed release notes, or a context swap must never inherit this decision.
// Do not persist user text or rewrite the user's "auto" language preference.
const detectedSources = new Map<string, string | null>()

function supportedLanguage(value: string) {
  const code = value.replace(/_/g, "-").toLowerCase()
  // NaturalLanguage uses nb for Bokmal; the existing language menu uses no.
  if (code === "nb" || code.startsWith("nb-")) return "no"
  const exact = LANGUAGE_OPTIONS.find((item) => item.code.toLowerCase() === code)
  if (exact) return exact.code
  // Preserve Chinese script identity. An unspecified zh must NOT imply Hans.
  if (code === "zh" || code.startsWith("zh-")) return undefined
  const base = code.split("-")[0]
  return LANGUAGE_OPTIONS.find((item) => item.code === base)?.code
}

type Candidate = { language: string; confidence: number }

function rankedLanguages(text: string): Candidate[] {
  const candidates = NaturalLanguage.languageHypotheses(text, { maximumCount: 3 })
  if (!Array.isArray(candidates)) return []
  return candidates.filter((item) => item
    && typeof item.language === "string"
    && Number.isFinite(item.confidence)
    && item.confidence >= 0 && item.confidence <= 1)
    .sort((a, b) => b.confidence - a.confidence)
}

function confidentLanguage(ranked: Candidate[]): string | undefined {
  const best = ranked[0]
  const runnerUp = ranked[1]?.confidence ?? 0
  return best && best.confidence >= MIN_CONFIDENCE
    && best.confidence - runnerUp >= MIN_MARGIN
    ? supportedLanguage(best.language)
    : undefined
}

// Deliberately small English/UI vocabulary, not an "ASCII means English" rule.
// Homographs such as Gift / Pain / Chat / Die, names and unknown abbreviations
// are NOT resolved by this fallback. High-confidence other languages win first.
const ENGLISH_WORDS = new Set((
  "hello goodbye welcome thanks thank you your please good morning evening night world me adult english " +
  "translate translated translating translation translations language languages " +
  "settings setting download downloads update updates updated updating " +
  "release notes bug bugs fixes fixed improvements improve improved " +
  "search history privacy password username clipboard keyboard " +
  "copy copied paste delete deleted save saved cancel retry done " +
  "enable enabled disable disabled failed error loading success " +
  "button card field editor view controller text source target " +
  "app store input output menu item label list scroll stack image icon " +
  "read only readme help home share reset refresh font size color " +
  "background foreground screen toolbar navigation link file open close " +
  "ui url api http https json html png jpg"
).split(" "))
const ENGLISH_SINGLE_WORDS = new Set((
  "hello goodbye welcome thanks translate translated translating adult english app store " +
  "settings download downloads updates updated updating " +
  "fixes fixed improvements improved search history privacy password " +
  "username clipboard keyboard copied deleted saved retry done " +
  "enabled disabled failed loading"
).split(" "))
const ENGLISH_PHRASES = new Set([
  "app store", "source text", "target text", "source language", "target language",
  "text field", "text editor", "translation card", "release notes", "read only",
  "good morning", "good evening", "good night", "thank you",
])

// A short project/title can contain one opaque name. Assess the remaining
// words independently: a name is not English evidence and is never classified
// by a hard-coded person/project list. Weak whole-name scores alone cannot
// select a language. Keep this bounded and out of the long-text hot path.
function identifierEnglish(sample: string): boolean {
  if (!/^[A-Za-z]+(?:[ \t]+[A-Za-z]+){1,5}$/.test(sample)) return false
  const words = [...new Set(sample.toLowerCase().split(/[ \t]+/))]
  if (words.length < 2) return false
  let evidence = 0
  let unknown = 0
  for (const word of words) {
    const ranked = rankedLanguages(word)
    const best = ranked[0]
    if (!best) return false
    // Do not erase a credible foreign word to fabricate an English title.
    if (supportedLanguage(best.language) !== "en" && best.confidence >= 0.60) return false
    const lexical = word.length >= 5 && ENGLISH_SINGLE_WORDS.has(word)
    const scored = word.length >= 6 && supportedLanguage(best.language) === "en"
      && best.confidence >= 0.40
      && best.confidence - (ranked[1]?.confidence ?? 0) >= 0.25
    if (lexical || scored) evidence += 1
    else if (!ENGLISH_WORDS.has(word)) unknown += 1
  }
  // No English-bearing word, or several unexplained words: retain native auto.
  // Single homographs and arbitrary all-Latin names do not use this fallback.
  return evidence > 0 && unknown <= 1
}

function shortSource(text: string, original: Candidate[]): string | undefined {
  if (text.length > SHORT_TEXT_LENGTH) return undefined
  // Split CamelCase / PascalCase / snake_case only in the detection sample.
  // The translation request, cache key, displayed text and replacement keep
  // the exact original (e.g. TranslationCard, not "Translation Card").
  // Normalize common typographic dashes only for detection. Never mutate the
  // translation payload (names, case, punctuation, cache and replacement).
  const sample = text
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]+/g, " ")
  const split = sample !== text
  const ranked = split ? rankedLanguages(sample) : original
  if (!ranked.length) return undefined
  // Normalization must not override an already credible, different language.
  if (split && original[0]?.confidence >= 0.60
    && supportedLanguage(original[0].language) !== supportedLanguage(ranked[0].language)) return undefined
  const confident = confidentLanguage(ranked)
  if (confident) return confident

  // English fallback is restricted to short ASCII words/UI identifiers. Do not
  // discard Chinese/French/etc. characters to manufacture English evidence.
  if (!/^[A-Za-z\s.!?,;:'"()]+$/.test(sample)) return undefined
  const conflicts = (items: Candidate[]) => items.some((item) => (
    supportedLanguage(item.language) !== "en" && item.confidence >= 0.60
  ))
  if (conflicts(original) || conflicts(ranked)) return undefined

  const words = sample.toLowerCase().match(/[a-z]+/g) || []
  if (!words.length || words.length > 12) return undefined
  const best = ranked[0]
  // Normalizing a compound can turn an ambiguous identifier into an ordinary
  // English phrase. Still require a clear lead, not merely the first result.
  if (split && words.length >= 2 && best
    && supportedLanguage(best.language) === "en"
    && best.confidence >= 0.60
    && best.confidence - (ranked[1]?.confidence ?? 0) >= 0.35) return "en"

  const known = words.every((word) => ENGLISH_WORDS.has(word))
  const englishEvidence = words.some((word) => ENGLISH_SINGLE_WORDS.has(word))
    || ENGLISH_PHRASES.has(words.join(" "))
    || (split && words.length >= 2)
  if (known && englishEvidence) return "en"
  return identifierEnglish(sample) ? "en" : undefined
}

/** Resolve once per complete original, never from a fragment or device locale. */
function detectWholeSource(text: string): string | undefined {
  if (text.length < MIN_TEXT_LENGTH || text.length > MAX_TEXT_LENGTH) return undefined
  if (detectedSources.has(text)) return detectedSources.get(text) ?? undefined
  const minimumLetters = text.length >= 80 ? 40 : 4
  if ((text.match(/\p{L}/gu) || []).length < minimumLetters) return undefined
  try {
    // Older Scripting builds keep the original native auto path. No network,
    // language hints, per-device bias, or guessed dominantLanguage() fallback.
    if (typeof NaturalLanguage === "undefined"
      || typeof NaturalLanguage.languageHypotheses !== "function") return undefined
    const ranked = rankedLanguages(text)
    // Empty/malformed native results are not evidence; retain native auto.
    if (!ranked.length) return undefined
    const language = confidentLanguage(ranked) ?? shortSource(text, ranked)
    detectedSources.set(text, language ?? null)
    while (detectedSources.size > CACHE_LIMIT) {
      const oldest = detectedSources.keys().next().value
      if (oldest === undefined) break
      detectedSources.delete(oldest)
    }
    return language
  } catch {
    // Detection is optional. Do not fail translation or change native retries.
    return undefined
  }
}

/** Return the best safe auto-detection result, including source == target. */
export function detectedAutoSourceLanguage(text: string): string | undefined {
  return detectWholeSource(text)
}

/** Session-local auto assistance; the caller's manual source always wins. */
export function stableAutoSource(text: string, targetLanguage: string): string | undefined {
  const language = detectedAutoSourceLanguage(text)
  // Inferring source == target would activate the engine's same-language fast
  // path and silently return untranslated mixed-language input. Keep auto then.
  const target = targetLanguage === "zh" ? "zh-Hans" : supportedLanguage(targetLanguage)
  return language && language !== target ? language : undefined
}
