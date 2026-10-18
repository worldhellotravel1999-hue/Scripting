import { Script } from "scripting"
import { appStoreTextSlots } from "../core/appstore"

function assert(value: unknown, message: string) {
  if (!value) throw new Error(message)
}
try {
  const app = { version: "3.0", releaseNotes: "Current notes", description: "App description" }
  const old = { version: "2.0", notes: "Historical notes" }
  const [current, description] = appStoreTextSlots(app, null, false)
  assert(current.content === app.releaseNotes && current.version === "3.0", "默认当前版本")
  assert(description.content === app.description && !description.version, "应用介绍不可带版本标题")
  const selected = appStoreTextSlots(app, old, false)
  assert(selected[0].content === old.notes && selected[0].version === old.version, "历史说明与版本号必须成对")
  assert(selected[1].identity === description.identity && selected[1].content === description.content, "选择历史版本不影响介绍")
  const swapped = appStoreTextSlots(app, old, true)
  assert(swapped[1].identity === selected[0].identity && swapped[1].content === old.notes, "换位后历史说明必须随内容移动")
  assert(swapped[0].content === app.description && swapped[0].emptyText === description.emptyText, "换位后应用说明文案")
  const sameText = appStoreTextSlots(app, { version: "2.9", notes: app.releaseNotes }, false)
  assert(sameText[0].identity !== current.identity, "同文不同版本必须隔离译文状态")
  const padded = appStoreTextSlots({ ...app, releaseNotes: "Current notes\n" }, null, false)
  assert(padded[0].content === current.content && padded[0].identity === current.identity, "空白变化不能取消且不重启翻译")
  const revised = appStoreTextSlots(app, { version: "3.0", notes: "Revised notes" }, false)
  assert(revised[0].identity !== current.identity, "同版本新说明必须隔离")
  const revisedDescription = appStoreTextSlots({ ...app, description: "Changed description" }, null, false)
  assert(revisedDescription[1].identity === description.identity, "普通介绍刷新应复用卡片")
  const missing = appStoreTextSlots({}, old, false)
  assert(missing[0].content === old.notes, "当前版本无正文时仍可选择历史版本")
  const empty = appStoreTextSlots(app, { version: "1.0", notes: "" }, false)
  assert(empty[0].content === "", "空历史说明不可偷换成当前说明")
  const refreshed = appStoreTextSlots({ ...app, version: "3.1", releaseNotes: "New" }, old, false)
  assert(refreshed[0].version === old.version && refreshed[0].content === old.notes, "刷新应保留主动选择")
  assert(app.releaseNotes === "Current notes" && app.version === "3.0", "不改写商店当前版本")

  // 超长发布说明曾是无上限输入：分享扩展里会拆出几十个原生翻译分片并渲染
  // 整篇长文本。截断必须同时保留版本归属、稳定身份和明确的截断提示。
  const hugeNotes = "注".repeat(9000)
  const huge = appStoreTextSlots({ ...app, releaseNotes: hugeNotes }, null, false)
  assert(huge[0].content!.startsWith("注".repeat(8000)), "超长发布说明必须截断到上限")
  assert(huge[0].content!.includes("发布说明过长，已截取前 8000 个字符"), "发布说明截断需要提示")
  assert(huge[0].version === "3.0", "截断不能丢失版本归属")
  assert(huge[0].identity !== current.identity, "截断后的说明必须有独立译文身份")
  const hugeAgain = appStoreTextSlots({ ...app, releaseNotes: `${hugeNotes}\n\n` }, null, false)
  assert(hugeAgain[0].identity === huge[0].identity, "仅尾部空白变化不应重启长说明翻译")
  const hugeSelected = appStoreTextSlots(app, { version: "2.0", notes: hugeNotes }, false)
  assert(hugeSelected[0].content === huge[0].content && hugeSelected[0].version === "2.0", "历史版本同样受上限保护")
  const hugeDescriptionText = "x".repeat(9000)
  const hugeDescription = appStoreTextSlots({ ...app, description: hugeDescriptionText }, null, false)
  assert(hugeDescription[1].content!.startsWith("x".repeat(8000)), "超长应用说明必须截断到上限")
  assert(hugeDescription[1].content!.includes("应用说明过长，已截取前 8000 个字符"), "应用说明截断需要提示")
  assert(hugeDescription[1].content!.length < hugeDescriptionText.length, "应用说明截断后长度必须变小")
  console.log("PASS: current/historical selection, slot swap, description isolation, same-text different versions, missing/empty notes, refresh, oversized notes/description caps")
  Script.exit("PASS")
} catch (error) { console.error(String(error)); Script.exit("FAIL") }
