import { Script } from "scripting"
import { appStoreTextSlots, getAppInfo, parseAppStoreURL } from "../core/appstore"
import { translateText } from "../core/translate"

// Public App Store data only. The actual iOS Share Sheet must still be tested
// from App Store; this checks its URL formats and the Egern translation pipeline.
const EGERN_URL = "https://apps.apple.com/hk/app/egern/id1616105820"

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

function checkURLs() {
  const variants = [
    EGERN_URL,
    `Egern\n${EGERN_URL}`,
    `<${EGERN_URL}>`,
    `「${EGERN_URL}」`,
    `“${EGERN_URL}”`,
    `${EGERN_URL}\u200b`,
    `${EGERN_URL}。`,
    `${EGERN_URL}?l=en-GB&uo=4`,
    EGERN_URL.replace("https://", "itms-apps://"),
    EGERN_URL.replace("https://apps.", "https://itunes."),
    "https://apps.apple.com/hk/app/id1616105820",
  ]
  for (const input of variants) {
    const identity = parseAppStoreURL(input)
    assert(identity?.appid === "1616105820" && identity.region === "hk", `分享链接解析失败：${input}`)
    assert(identity.url.startsWith("https://"), "未规范化商店链接协议")
  }
  assert(parseAppStoreURL("https://example.com/") === null, "普通网页被误认为应用")
  assert(parseAppStoreURL("https://apps.apple.com/hk/") === null, "没有应用 ID 的链接被接受")
  console.log(`PASS: ${variants.length} Egern share URL formats and invalid inputs`)
}

async function run() {
  checkURLs()
  const started = Date.now()
  const identity = parseAppStoreURL(EGERN_URL)!
  const info = await getAppInfo(identity)
  assert(info.trackName === "Egern", "读取了错误的应用")
  const sections = appStoreTextSlots(info, null, false)
  assert(sections.every(slot => !!slot.content?.trim()), "未取得更新说明或应用说明")
  const results = await Promise.all(sections.map(async (slot, index) => {
    let engine = ""
    let progress = 0
    const translated = await translateText(slot.content!, {
      sourceLanguageCode: "en",
      targetLanguageCode: "zh-Hans",
      preferSequential: true,
      onEngineResolved: info => { engine = info.engine },
      onProgress: () => { progress += 1 },
    })
    assert(translated.trim() && translated !== slot.content && /[\u3400-\u9fff]/.test(translated), `第 ${index + 1} 段没有返回中文译文`)
    return { section: index === 0 ? "notes" : "description", sourceLength: slot.content!.length, translatedLength: translated.length, engine, progress }
  }))
  console.log(JSON.stringify({ app: info.trackName, region: identity.region, ms: Date.now() - started, sections: results }))
}

const deadline = setTimeout(() => Script.exit("FAIL: appstore-share exceeded 30s"), 30000)
void run().then(() => {
  clearTimeout(deadline)
  Script.exit("PASS: Egern HK lookup and both sections translated")
}, reason => {
  clearTimeout(deadline)
  console.error(String(reason))
  Script.exit(`FAIL: ${String(reason)}`)
})
