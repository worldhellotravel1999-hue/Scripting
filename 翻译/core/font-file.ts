// Structural validation only: the visible WebView performs the actual font decode.
// Read just the SFNT directory, not megabytes of glyph data across the JS bridge.
export function inspectFontDirectory(bytes: Uint8Array, fileSize: number): "truetype" | "opentype" {
  const fail = () => { throw new Error("字体表目录无效或文件不完整，请重新下载字体。") }
  if (bytes.length < 12 || fileSize < 12) return fail()
  const u16 = (at: number) => bytes[at] * 256 + bytes[at + 1]
  const u32 = (at: number) => bytes[at] * 16777216 + bytes[at + 1] * 65536 + bytes[at + 2] * 256 + bytes[at + 3]
  const tag = (at: number) => String.fromCharCode(...Array.from(bytes.slice(at, at + 4)))
  const signature = u32(0)
  const format = signature === 0x4f54544f ? "opentype"
    : signature === 0x00010000 || signature === 0x74727565 ? "truetype" : null
  if (!format) throw new Error("文件内容不是受支持的 TrueType/OpenType 字体。")
  const count = u16(4)
  const end = 12 + count * 16
  if (!count || end > bytes.length || end > fileSize) return fail()
  const tables = new Map<string, { start: number; length: number }>()
  for (let at = 12; at < end; at += 16) {
    const name = tag(at)
    const start = u32(at + 8)
    const length = u32(at + 12)
    if (tables.has(name) || start > fileSize || length > fileSize - start || (length > 0 && start < end)) return fail()
    tables.set(name, { start, length })
  }
  const minimums: Record<string, number> = { head: 54, hhea: 36, hmtx: 4, maxp: 6, cmap: 4, name: 6 }
  for (const name of Object.keys(minimums)) {
    if ((tables.get(name)?.length ?? 0) < minimums[name]) return fail()
  }
  if (format === "truetype") {
    if (!tables.has("glyf") || !tables.has("loca")) return fail()
  } else if (!tables.has("CFF ") && !tables.has("CFF2")) return fail()
  const spans = Array.from(tables.values()).filter(table => table.length > 0).sort((a, b) => a.start - b.start)
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].start < spans[i - 1].start + spans[i - 1].length) return fail()
  }
  return format
}
