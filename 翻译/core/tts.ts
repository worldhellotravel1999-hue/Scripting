/**
 * 系统 TTS 朗读：用系统合成语音朗读原文 / 译文。
 * - 每个播放点有唯一 key；再次点同一个 key 即停止。
 * - 播放状态通过订阅广播，按钮据此切换 播放/停止 图标。
 */

type TTSListener = (key: string | null) => void

let playingKey: string | null = null
const listeners = new Set<TTSListener>()

function notify() {
  for (const listener of listeners) {
    try { listener(playingKey) } catch {}
  }
}

/** 订阅当前正在朗读的 key（null 表示空闲），返回取消订阅函数。 */
export function subscribeSpeaking(listener: TTSListener): () => void {
  listeners.add(listener)
  listener(playingKey)
  return () => { listeners.delete(listener) }
}

type SimpleVoice = { identifier?: string; language?: string; quality?: string }

let voicesCache: SimpleVoice[] | null = null

async function loadVoices(): Promise<SimpleVoice[]> {
  if (voicesCache) return voicesCache
  try {
    const raw: any = await (Speech as any).speechVoices
    voicesCache = Array.isArray(raw) ? (raw as SimpleVoice[]) : []
  } catch {
    voicesCache = []
  }
  return voicesCache
}

const QUALITY_RANK: Record<string, number> = { default: 0, enhanced: 1, premium: 2 }

/** 应用语言代码 → 系统 BCP 47 候选（zh-Hans/zh-Hant 需要映射到地区码）。 */
const BCP47_HINTS: Record<string, string[]> = {
  "zh-Hans": ["zh-cn", "zh-hans"],
  "zh-Hant": ["zh-tw", "zh-hk", "zh-mo", "zh-hant"],
}

function voiceRank(voice: SimpleVoice) {
  const quality = String(voice.quality || "default").toLowerCase()
  return QUALITY_RANK[quality] ?? 0
}

async function resolveVoiceIdentifier(code: string): Promise<string | undefined> {
  const voices = await loadVoices()
  if (!voices.length) return undefined
  const hints = BCP47_HINTS[code] || []
  const base = code.split("-")[0].toLowerCase()
  const matches = voices.filter((voice) => {
    const language = String(voice.language || "").toLowerCase().replace("_", "-")
    if (!language) return false
    if (hints.some((hint) => language === hint || language.startsWith(hint))) return true
    return language.split("-")[0] === base
  })
  if (!matches.length) return undefined
  matches.sort((a, b) => voiceRank(b) - voiceRank(a))
  return matches[0].identifier
}

/**
 * 朗读一段文本；若该 key 正在朗读则停止。
 * 语音解析失败时回退系统默认语音，出错静默（不打断界面）。
 */
export async function toggleSpeak(key: string, text: string, languageCode: string) {
  if (playingKey === key) {
    playingKey = null
    notify()
    try { await Speech.stop() } catch {}
    return
  }
  const value = text.trim()
  if (!value) return
  playingKey = key
  notify()
  // 先停掉可能存在的上一段朗读，避免队列里叠音。
  try { await Speech.stop() } catch {}
  const options: SpeechSynthesisOptions = {}
  try {
    const identifier = await resolveVoiceIdentifier(languageCode)
    if (identifier) options.voiceIdentifier = identifier
  } catch {}
  try {
    await Speech.speak(value, options)
  } catch {}
  if (playingKey === key) {
    playingKey = null
    notify()
  }
}

/** 立即停止当前朗读（卡片销毁 / 清空文本时调用）。 */
export function stopSpeaking() {
  if (playingKey === null) return
  playingKey = null
  notify()
  try { void Speech.stop() } catch {}
}
