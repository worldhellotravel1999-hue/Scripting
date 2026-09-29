import { fetch } from "scripting"
import { Script } from "scripting"

// 实测：谷歌各端点在真实设备网络下的状态/耗时；对比「取消重定向」能否立即失败。
async function main() {
  const q = encodeURIComponent("Hello world, this is a translation speed test.")
  const cases: Array<{ name: string; url: string }> = [
    { name: "clients5-dict", url: `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=zh-CN&q=${q}` },
    { name: "gtx-single", url: `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${q}` },
    { name: "gtx-t", url: `https://translate.googleapis.com/translate_a/t?client=gtx&sl=en&tl=zh-CN&q=${q}` },
  ]

  const lines: string[] = []
  for (const item of cases) {
    // 1) 默认（跟随重定向）
    const startA = Date.now()
    let a = ""
    try {
      const res = await fetch(item.url, { timeout: 10 })
      const body = await res.text()
      a = `follow: HTTP ${res.status} ${Date.now() - startA}ms url=${res.url || "-"} body=${body.slice(0, 120)}`
    } catch (error) {
      a = `follow: FAILED ${Date.now() - startA}ms ${String(error)}`
    }

    // 2) 取消重定向（应立刻拿到 3xx 而不是跟着跳到 /sorry）
    const startB = Date.now()
    let b = ""
    try {
      const res = await fetch(item.url, {
        timeout: 10,
        handleRedirect: async () => null,
      })
      const body = await res.text()
      b = `noredirect: HTTP ${res.status} ok=${res.ok} ${Date.now() - startB}ms body=${body.slice(0, 120)}`
    } catch (error) {
      b = `noredirect: FAILED ${Date.now() - startB}ms ${String(error)}`
    }

    lines.push(`### ${item.name}\n${a}\n${b}`)
  }

  console.log(lines.join("\n\n"))
  Script.exit("done")
}

main()