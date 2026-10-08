// 签到全链路真机回归（可复跑）：scripting-ts run _test_checkin.ts
//   probe（发 /start 抓回复）→ AI 看图决策 → 条件点击 → AI 判定结果。
// 安全闸：只真点文案含「签到/打卡/check」的按钮或 4 位内的数字（算术验证码答案），
// 其余只打印决策就停，避免误点无关按钮。要测别的机器人改下面的 BOT。
// 注意：无 UI 的 scripting-ts run 环境里，长时间运行偶见 host 级报错
// （Transpile JSContext released / sandbox_extension_consume failed）——
// 点击往往已到达 Telegram，只是本地回读失败；真机 UI 路径请在设置页回归。
import { Script } from "scripting"
import { tg } from "./api"
import { aiCheckinDecide, type CheckinMsg } from "./ai"

const BOT = "lilisiebot"

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
    const probe = await tg("bot_checkin_probe", { chat: BOT, text: "/start", wait: 12 }, 90)
    console.log("PROBE ok=", probe.ok, "err=", probe.error, "sent=", probe.sent_id)
    console.log(JSON.stringify(brief((probe.messages || []) as CheckinMsg[]), null, 1))
    if (!probe.ok) return

    let messages = (probe.messages || []) as CheckinMsg[]
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
          wait: 6,
        },
        90,
      )
      console.log("ACT ok=", res.ok, "err=", res.error, "answer=", JSON.stringify(res.answer))
      if (!res.ok) return
      const next = (res.messages || []) as CheckinMsg[]
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
