// 候选图标有效性探测（Cookie 登录行换图标用）。
// 运行：scripting-ts run tests/probe-cookie-symbol.tsx
import { ImageRenderer, Image, Script } from "scripting"

async function measure(name: string, element: any, scale = 3) {
  try {
    const img = await ImageRenderer.toUIImage(element, { scale })
    console.log(`${name}@${scale}: width=${img.width} height=${img.height}`)
  } catch (error) {
    console.log(`${name}@${scale}: INVALID`)
  }
}

async function main() {
  await measure("person(baseline)", <Image systemName="person" font={15} />)
  for (const name of [
    "doc.on.clipboard",
    "clipboard",
    "list.bullet.rectangle",
    "doc.text",
    "globe",
    "link",
    "network",
    "square.and.pencil",
    "number",
    "at",
    "envelope",
    "wand.and.stars",
    "key",
  ]) {
    await measure(name, <Image systemName={name} font={15} />)
  }
  Script.exit("probe done")
}

void main()
