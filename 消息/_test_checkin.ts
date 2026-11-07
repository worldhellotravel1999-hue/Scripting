// 签到全链路真机回归（可复跑）：scripting-ts run _test_checkin.ts
//   probe（发 /start 抓回复）→ AI 看图决策 → 条件点击 → AI 判定结果。
// 传输层与设置页同款「短调用 + 只读轮询」（宿主对长耗时 Python.run 偶发丢 stdout）：
//   后端每次只等 3~4s，等回复由前端轮询 bot_checkin_read（只读、幂等）累加出预算。
// 安全闸：只真点文案含「签到/打卡/check」的按钮或 4 位内的数字（算术验证码答案），
// 其余只打印决策就停，避免误点无关按钮。要测别的机器人改下面的 BOT。
// 注意：无 UI 的 scripting-ts run 环境里，长时间运行偶见 host 级报错
// （Transpile JSContext released / sandbox_extension_consume failed）——
// 点击往往已到达 Telegram，只是本地回读失败；真机 UI 路径请在设置页回归。
import { Script } from "scripting"
import { tg } from "./api"
import { aiCheckinDecide, type CheckinMsg } from "./ai"

const BOT = "lilisiebot"

const SEND_WAIT = 3
const POLL_WAIT = 4

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** 只读轮询：丢输出重试，拿到新消息且一轮无更新（或预算耗尽）收口。 */
async function pollRead(bot: string, afterId: number, budgetS: number) {
  const deadline = Date.now() + budgetS * 1000
  let got: CheckinMsg[] = []
  while (Date.now() < deadline) {
    const lastId = got.reduce((mx, m) => Math.max(mx, m.id), afterId)
    const r = await tg("bot_checkin_read", { chat: bot, after_id: lastId, wait: POLL_WAIT }, 60)
    if (!r.ok) {
      console.log(`  poll etype=${r.etype} err=${r.error}`)
      await sleep(800)
      continue
    }
    const fresh = ((r.messages || []) as CheckinMsg[]).filter(m => !m.out)
    if (fresh.length > 0) got = got.concat(fresh)
    else if (got.length > 0) break
    await sleep(400)
  }
  return got
}

function brief(msgs: CheckinMsg[]) {
  return msgs.map(m => ({
    id: m.id,
    out: m.out,
    text: (m.text || "").slice(0, 120),
    img: m.image?.data ? `${m.image.mime}(${m.image.data.length}b64)` : null,
    buttons: (m.buttons || []).map(row => row.map(b => `${b.kind}:${b.text}`)),
    refetched: !!m.refetched,
  }))
}

async function main() {
  try {
    const probe = await tg("bot_checkin_probe", { chat: BOT, text: "/start", wait: SEND_WAIT }, 60)
    console.log("PROBE ok=", probe.ok, "err=", probe.error, "sent=", probe.sent_id)
    console.log(JSON.stringify(brief((probe.messages || []) as CheckinMsg[]), null, 1))
    if (!probe.ok) return

    let messages = (probe.messages || []) as CheckinMsg[]
    if (messages.filter(m => !m.out).length === 0) {
      console.log("等待回复（短调用轮询）…")
      messages = messages.concat(
        await pollRead(BOT, Number(probe.sent_id) || 0, 24),
      )
      console.log(JSON.stringify(brief(messages), null, 1))
      if (messages.filter(m => !m.out).length === 0) return
    }
    let history = ""
    let d = await aiCheckinDecide(messages, history)
    console.log("DECIDE#1", JSON.stringify(d))

    for (let step = 1; step <= 3 && d.success === null && d.act; step++) {
      const act = d.act
      const label = act.kind === "click" ? act.label : act.text
      const safe =
        act.kind === "click" &&
        (/签到|打卡|check/i.test(label) || /^\d{1,4}$/.test(label)) // 签到按钮 / 算术验证码答案
      console.log(`STEP${step} act=${act.kind} label=${label} safeToClick=${safe}`)
      if (!safe) {
        console.log("STOP：非签到按钮，不真点（首跑安全闸）")
        break
      }
      history += `${step}. ${d.feedback} → 点「${label}」\n`
      const afterId = messages.reduce((mx, m) => Math.max(mx, m.id), 0)
      const res = await tg(
        "bot_checkin_act",
        {
          chat: BOT,
          mode: "click",
          msg_id: act.kind === "click" ? act.msgId : 0,
          data: act.kind === "click" ? act.data : "",
          after_id: afterId,
          wait: SEND_WAIT,
        },
        60,
      )
      console.log("ACT ok=", res.ok, "err=", res.error, "answer=", JSON.stringify(res.answer))
      if (!res.ok) return
      let next = (res.messages || []) as CheckinMsg[]
      if (next.filter(m => !m.out).length === 0) {
        next = next.concat(await pollRead(BOT, afterId, 8))
      }
      console.log(JSON.stringify(brief(next), null, 1))
      if (next.length === 0) break
      messages = next
      d = await aiCheckinDecide(messages, history)
      console.log(`DECIDE#${step + 1}`, JSON.stringify(d))
    }
    console.log("DONE")
  } catch (e) {
    console.log("E2E error:", String(e))
  } finally {
    Script.exit()
  }
}

main()
