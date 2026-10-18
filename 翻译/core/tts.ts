/**
 * 系统 TTS 朗读：用系统合成语音朗读原文 / 译文。
 * 三态：空闲 → 播放 ⇄ 暂停。
 *
 * 两个关键约束：
 * 1. 不信任本地状态机和 Speech.speak 的 promise 时机（App UI 运行时里可能提前
 *    resolve）。每次动作都通过 Speech.isSpeaking / isPaused 询问引擎真实状态。
 * 2. 所有动作经过串行队列（enqueue），双击/连点时前一个动作（暂停/续播）
 *    完整落定后重播才开始，避免交叉执行把新语音又暂停在开头。
 */

export type TTSState = "idle" | "speaking" | "paused"

type TTSListener = (payload: { key: string | null; state: TTSState }) => void

let currentKey: string | null = null
let currentState: TTSState = "idle"
const listeners = new Set<TTSListener>()

function notify() {
  for (const listener of listeners) {
    try { listener({ key: currentKey, state: currentState }) } catch {}
  }
}

function setLocal(key: string | null, state: TTSState) {
  currentKey = key
  currentState = state
  notify()
}

/** 串行队列：动作按提交顺序逐个完整执行，后一个动作开始时前一个已落定。 */
let queueTail: Promise<void> = Promise.resolve()
function enqueue(task: () => Promise<void>): Promise<void> {
  const run = queueTail.then(task, task)
  queueTail = run.then(() => undefined, () => undefined)
  return run
}

/** 订阅当前朗读状态，返回取消订阅函数。 */
export function subscribeSpeaking(listener: TTSListener): () => void {
  listeners.add(listener)
  listener({ key: currentKey, state: currentState })
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

/** 引擎真实状态。isSpeaking 在暂停时也为 true，必须先看 isPaused。 */
async function engineState(): Promise<{ speaking: boolean; paused: boolean }> {
  let speaking = false
  let paused = false
  try { paused = (await Speech.isPaused) === true } catch {}
  try { speaking = (await Speech.isSpeaking) === true } catch {}
  return { speaking: speaking && !paused, paused }
}

async function startNewSpeak(key: string, value: string, languageCode: string) {
  // 清掉旧队列（含暂停中的），再开新的一段。
  try { await Speech.stop() } catch {}
  setLocal(key, "speaking")
  const options: SpeechSynthesisOptions = {}
  try {
    const identifier = await resolveVoiceIdentifier(languageCode)
    if (identifier) options.voiceIdentifier = identifier
  } catch {}
  try {
    await Speech.speak(value, options)
  } catch {}
  // promise 返回后核对引擎：仍在播/在暂停说明 promise 提前返回（App UI 运行时），
  // 保持 speaking 状态；真正播完才清成空闲。
  if (currentKey === key) {
    const engine = await engineState()
    if (currentKey === key && !engine.speaking && !engine.paused) setLocal(null, "idle")
  }
}

async function toggleSpeakImpl(key: string, text: string, languageCode: string) {
  const value = text.trim()
  if (!value) return
  if (currentKey === key) {
    const engine = await engineState()
    if (engine.paused) {
      // 暂停中 → 从暂停处续播。
      try { await Speech.resume() } catch {}
      if (currentKey === key) setLocal(key, "speaking")
      return
    }
    if (engine.speaking) {
      // 播放中 → 立即暂停。
      try { await Speech.pause() } catch {}
      if (currentKey === key) {
        const after = await engineState()
        setLocal(key, after.paused ? "paused" : after.speaking ? "speaking" : "idle")
      }
      return
    }
    // 状态说是当前 key，但引擎已经空闲（播完/被系统打断）→ 重新播放。
    await startNewSpeak(key, value, languageCode)
    return
  }
  await startNewSpeak(key, value, languageCode)
}

/**
 * 播放 / 暂停 / 续播一段文本。以引擎真实状态为准，出错静默。
 * 动作进串行队列：双击时前一次点击的暂停/续播先完整落定，重播随后执行。
 */
export function toggleSpeak(key: string, text: string, languageCode: string): Promise<void> {
  return enqueue(() => toggleSpeakImpl(key, text, languageCode))
}

/** 长按/连点：无论当前在播/暂停/空闲，都清掉队列后从头播放这段文本。 */
export function restartSpeak(key: string, text: string, languageCode: string): Promise<void> {
  return enqueue(async () => {
    const value = text.trim()
    if (!value) return
    await startNewSpeak(key, value, languageCode)
  })
}

/** 立即停止当前朗读（卡片销毁 / 清空文本时调用）。 */
export function stopSpeaking() {
  if (currentKey === null) return
  setLocal(null, "idle")
  enqueue(async () => {
    try { await Speech.stop() } catch {}
  })
}
