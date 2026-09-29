import { Script } from "scripting"
import { fetchAppVersions, fetchVersionHistoryNotes, mergeVersionNotes, parseVersionHistoryNotes } from "../core/versions"

function assert(value: unknown, message: string) {
  if (!value) throw new Error(message)
}

async function run() {
  const notes = parseVersionHistoryNotes({ pageData: { id: "123", versionHistory: [
    { versionString: "2.10", releaseNotes: "Current\n\nNotes" },
    { versionString: "2.9", releaseNotes: " Historical notes " },
    { versionString: "2.9", releaseNotes: "Duplicate" },
    { versionString: "2.8", releaseNotes: " " },
    { versionString: "2.7", releaseNotes: null },
    { releaseNotes: "No version" },
  ] } }, "123")
  assert(notes.length === 2 && notes[1].notes === "Historical notes", "历史解析、空说明或去重错误")
  assert(notes[0].notes === "Current\n\nNotes", "换行丢失")
  for (const pageData of [{ id: "999", versionHistory: [] }, { id: "123" }, null]) {
    let rejected = false
    try { parseVersionHistoryNotes({ pageData }, "123") } catch { rejected = true }
    assert(rejected, "应用不匹配或无效响应应允许重试")
  }
  assert(parseVersionHistoryNotes({ pageData: { id: "123", versionHistory: [] } }, "123").length === 0, "合法空历史异常")
  const base = [
    { version: "2.9", versionId: "901" },
    { version: "2.9", versionId: "902" },
    { version: "2.8", versionId: "801" },
    { version: "1.0", versionId: "100" },
  ]
  const merged = mergeVersionNotes(base, notes)
  assert(merged.length === 5 && merged[0].version === "2.10" && !merged[0].versionId, "说明独有版本应加入并正确排序")
  assert(merged.filter(item => item.version === "2.9").every(item => item.notes === "Historical notes"), "同版本说明匹配失败")
  assert(merged.find(item => item.version === "2.8")?.notes === undefined, "把当前说明错误填给无说明旧版本")
  assert(merged.filter(item => item.version === "2.9").map(item => item.versionId).join() === "901,902", "构建 ID 丢失")
  assert(!("notes" in base[0]), "修改了版本 ID 来源原对象")
  assert(mergeVersionNotes([], notes).length === 2, "版本 ID 接口失败时说明也应可查看")
  let invalidRejected = false
  try { await fetchVersionHistoryNotes("invalid/id") } catch { invalidRejected = true }
  assert(invalidRejected, "非法 appid 未拒绝")
  console.log("PASS: parsing, exact matching, duplicates, missing IDs, empty/malformed data, non-mutation")

  const results = await Promise.all([
    { appid: "1442620678", region: "us", name: "Surge US" },
    { appid: "1443988620", region: "jp", name: "Quantumult X JP" },
    { appid: "6479691128", region: "cn", name: "Scripting CN" },
  ].map(async app => {
    const [history, ids] = await Promise.all([fetchVersionHistoryNotes(app.appid, app.region).catch(error => { throw new Error(`${app.name}: ${String(error)}`) }), fetchAppVersions(app.appid)])
    const entries = mergeVersionNotes(ids, history)
    assert(history.length > 1, `${app.name}: 无旧版本说明`)
    assert(history.every(item => entries.some(entry => entry.version === item.version && entry.notes === item.notes)), `${app.name}: 丢失可查询版本`)
    const saved = await fetchVersionHistoryNotes(app.appid, app.region)
    assert(saved === history, `${app.name}: 成功结果未缓存`)
    return { app: app.name, versions: ids.length, notes: history.length, first: history[0].version,
      last: history[history.length - 1].version, withNotes: entries.filter(item => item.notes).length }
  }))
  console.log(JSON.stringify(results))
  Script.exit("PASS")
}
void run().catch(reason => { console.error(String(reason)); Script.exit("FAIL") })
