import { fetch } from "scripting"


/**
 * 谷歌免费网页翻译（移植自「App Store工具」）：
 * - Chrome 词典端点 clients5.google.com/translate_a/t?client=dict-chrome-ex 更抗限流，优先；
 * - 失败再走 translate.googleapis.com/translate_a/single?client=gtx；
 * - 无需密钥、不挑语言包，网络请求可并发，比系统原生翻译快得多。
 * 任何失败都由调用方回退系统引擎；连续失败进入短冷却，冷却期内直接走系统引擎，
 * 避免被墙/断网环境下每篇都白等超时。
 *
 * 2026-09-18 提速：本机（AWS 机房出口 IP）实测 Google 所有网页端点均被限流——
 * 跟随重定向时要先下载整页 /sorry HTML（~2s）再收到 429，两个端点串联白等 ~4s/篇。
 * 改为 handleRedirect 返回 null 让 302 立即失败（1.2s 内），超时 5s→3s，
 * 冷却 2min→5min，把白等压到一次失败 ≈1.2s、之后 5 分钟内零等待。
 *
 * 2.4.26 弱网修复：超时 3s→2s；词典端点超时/断网时直接失败、不再串行试 gtx
 * （断网下两个端点都会超时，串行=白等双倍；只有 HTTP/空结果这种“网络通但端点
 * 被限”才值得试第二个端点）。单段弱网回退从 ~6s 压到 ~2s。
 *
 * 2026-10-01 平衡优化：translate.ts 改为谷歌+系统双引擎并行竞速后，谷歌失败
 * 已不再拖慢任何翻译（系统引擎同时在跑），冷却的作用只剩“别反复撞限流”，
 * 因此 5min→2min，让恢复后的谷歌更快重新参跑（端点限流常在几分钟内恢复）。
 */

const GOOGLE_TIMEOUT_MS = 2000
const GOOGLE_COOLDOWN_MS = 2 * 60 * 1000
let googleBlockedUntil = 0


/** 谷歌单次请求的分片长度（URL 查询参数承载，不宜过长）。 */
export const GOOGLE_CHUNK_LENGTH = 1000

function mapGoogleLanguage(code: string | undefined): string {
  if (!code || code === "auto") return "auto"
  if (code === "zh-Hans" || code === "zh-CN" || code === "zh") return "zh-CN"
  if (code === "zh-Hant" || code === "zh-TW" || code === "zh-HK") return "zh-TW"
  return code
}

function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Google 翻译请求超时。")), ms)
    task.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

/** 两个端点的响应结构一致：`["译文"]` 或 `[[["译文","原文",...],...],...]`。 */
function parseGooglePayload(data: unknown): string {
  if (Array.isArray(data) && typeof data[0] === "string") return data[0]
  const segs: unknown[] = Array.isArray(data) && Array.isArray((data as unknown[])[0])
    ? (data as unknown[])[0] as unknown[]
    : []
  let out = ""
  for (const seg of segs) {
    if (Array.isArray(seg) && typeof seg[0] === "string") out += seg[0]
  }
  return out
}

async function googleFetch(url: string, ms: number): Promise<string> {
  const response = await withTimeout(
    fetch(url, {
      timeout: Math.ceil(ms / 1000),
      // 被限流时 Google 302 到 www.google.com/sorry（整页 HTML，还要再等 ~2s）。
      // 取消跟随重定向：拿到 3xx 立即以非 ok 失败，省一次完整下载。
      handleRedirect: async () => null,
    }),
    ms,
  )
  if (!response.ok) throw new Error("Google 翻译 HTTP " + response.status)
  const data: unknown = await response.json()
  const value = parseGooglePayload(data).trim()
  if (!value) throw new Error("Google 翻译没有返回可用译文。")
  return value
}

/** 单段翻译：词典端点优先，失败再走 gtx。失败时抛错，由调用方回退系统引擎。 */
export async function translateGoogleChunk(
  text: string,
  sourceLanguageCode: string | undefined,
  targetLanguageCode: string,
): Promise<string> {
  const sourceText = String(text || "").trim()
  if (!sourceText) return ""
  const sl = mapGoogleLanguage(sourceLanguageCode)
  const tl = mapGoogleLanguage(targetLanguageCode)
  const q = encodeURIComponent(sourceText)
  const dictUrl = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${sl}&tl=${tl}&q=${q}`
  const gtxUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${q}`
  // 弱网/断网下两个端点都会超时或断连：串行试第二个只是白等双倍。只有第一个是
  // 「网络通但端点被限」（HTTP 非 ok、空译文）时，才值得试第二个端点；
  // 超时/断网等 fetch 层错误直接抛，由调用方回退系统引擎。
  try {
    return await googleFetch(dictUrl, GOOGLE_TIMEOUT_MS)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const endpointLimited = message.indexOf("HTTP") >= 0
      || message.indexOf("可用译文") >= 0
    if (!endpointLimited) throw error
    return googleFetch(gtxUrl, GOOGLE_TIMEOUT_MS)
  }
}


/** 冷却期内跳过谷歌直连，直接走系统引擎（避免每次白等超时）。 */
export function isGoogleEngineAvailable(): boolean {
  return Date.now() >= googleBlockedUntil
}

export function markGoogleEngineBlocked() {
  googleBlockedUntil = Date.now() + GOOGLE_COOLDOWN_MS
}
