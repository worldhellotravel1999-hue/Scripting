import { ImageRenderer, Script, Text, VStack } from "scripting"
import { getAppInfo, parseAppStoreURL } from "../core/appstore"
import { translateText } from "../core/translate"
import { recognizeScreenBlocks } from "../core/screen-ocr"
import { translateScreenOverlay } from "../core/screen-overlay"

// Uses public App Store content and a generated image, never the user's clipboard/photos.
// This checks business logic; actual Share Sheet input and presentation still require iOS.
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
function assertChinese(source: string, translated: string, label: string) {
  assert(translated.trim() && translated !== source && /[\u3400-\u9fff]/.test(translated), `${label}: 没有返回中文译文`)
}

async function main() {
  const deadline = setTimeout(() => {
    console.error("recovery-smoke: 超过45秒，未通过")
    Script.exit("failed: deadline")
  }, 45000)
  try {
    const options = { sourceLanguageCode: "en", targetLanguageCode: "zh-Hans" }
    const text = "Open Settings to change the language."
    const translated = await translateText(text, options)
    assertChinese(text, translated, "普通翻译")
    console.log(`PASS 普通翻译: ${translated}`)
    assert((await translateText(text, options)) === translated, "重复翻译缓存不一致")
    assert((await translateText("   ", options)) === "", "空输入处理异常")
    assert(parseAppStoreURL("https://example.com/not-an-app") === null, "无效链接未被拒绝")

    const identity = parseAppStoreURL("https://apps.apple.com/us/app/things-3/id904237743")
    assert(identity?.appid === "904237743" && identity.region === "us", "App Store 链接解析异常")
    const info = await getAppInfo(identity)
    assert(info.trackName && info.description?.trim(), "App Store 没有返回应用正文")
    const sections = [info.releaseNotes, info.description].filter((value): value is string => !!value?.trim())
    const results = await Promise.all(sections.map((value) => translateText(value, options)))
    results.forEach((value, index) => assertChinese(sections[index], value, `App Store 正文 ${index + 1}`))
    console.log(`PASS App Store: ${info.trackName}, ${sections.length}段正文, 译文长度=${results.map((value) => value.length).join(",")}`)

    const image = await ImageRenderer.toUIImage(
      <VStack spacing={10} padding={30} background="#FFFFFF">
        <Text font="largeTitle" fontWeight="bold">Open Settings Page</Text>
        <Text font="title">Change the language</Text>
      </VStack>,
      { scale: 2 },
    )
    const overlay = await translateScreenOverlay(image, options)
    assert(overlay.lines.length === 2, "截图两行未被完整识别")
    overlay.lines.forEach((line) => assertChinese(line.source, line.translated, "截图行"))
    assert(Math.round(overlay.image.width) === Math.round(image.width), "覆盖图宽度发生变化")
    assert(Math.round(overlay.image.height) === Math.round(image.height), "覆盖图高度发生变化")
    const renderedText = (await recognizeScreenBlocks(overlay.image)).map((block) => block.text).join("\n")
    assert(/[\u3400-\u9fff]/.test(renderedText), "覆盖图再次识别未读到中文")
    assert(!/Open Settings|Change the language/i.test(renderedText), "覆盖图仍残留测试英文")
    console.log(`PASS 截图英译中及中文盖写: ${renderedText}`)
    clearTimeout(deadline)
    Script.exit("passed")
  } catch (error) {
    clearTimeout(deadline)
    console.error(String(error))
    Script.exit(`failed: ${String(error)}`)
  }
}
void main()
