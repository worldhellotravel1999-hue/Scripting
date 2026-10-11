import { fetch, Script } from "scripting"

/**
 * 探针：谷歌两端点对「多行文本」的换行保留情况——决定截图翻译能否
 * 把多行 OCR 文本合并成一次请求（按 \n 拆回每行）。
 */
async function main() {
  const source = [
    "Open Settings to change the language",
    "Second line: tap the blue button",
    "Third line is here",
    "Line four with more words in it",
  ].join("\n")
  const q = encodeURIComponent(source)
  const cases: Array<{ name: string; url: string }> = [
    { name: "clients5-dict en->zh", url: `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=zh-CN&q=${q}` },
    { name: "gtx-single en->zh", url: `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${q}` },
    { name: "gtx-single auto->zh", url: `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${q}` },
    { name: "gtx-single zh->en", url: `https://translate.googleapis.com/translate_a/single?client=gtx&sl=zh-CN&tl=en&dt=t&q=${encodeURIComponent("设置页面第一行\n第二行在这里\n第三行测试")}` },
  ]

  const lines: string[] = []
  for (const item of cases) {
    const start = Date.now()
    try {
      const res = await fetch(item.url, {
        timeout: 4,
        handleRedirect: async () => null,
      })
      const ms = Date.now() - start
      if (!res.ok) {
        lines.push(`### ${item.name}\nHTTP ${res.status} ${ms}ms`)
        continue
      }
      const data: unknown = await res.json()
      let value = ""
      if (Array.isArray(data) && typeof data[0] === "string") value = data[0]
      else if (Array.isArray(data) && Array.isArray(data[0])) {
        for (const seg of data[0] as unknown[]) {
          if (Array.isArray(seg) && typeof seg[0] === "string") value += seg[0]
        }
      }
      const nl = (value.match(/\n/g) || []).length
      lines.push(`### ${item.name}\nHTTP 200 ${ms}ms newlines=${nl}\n${JSON.stringify(value)}`)
    } catch (error) {
      lines.push(`### ${item.name}\nFAILED ${Date.now() - start}ms ${String(error)}`)
    }
  }
  console.log(lines.join("\n\n"))
  Script.exit("done")
}

main()
