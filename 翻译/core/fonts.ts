import { useEffect, useState } from "scripting"
import { inspectFontDirectory } from "./font-file"

export type FontRole = "source" | "target"
export type ImportedFont = {
  id: string
  name: string
  filename: string
  format: "truetype" | "opentype"
}
export type FontSettings = {
  source: ImportedFont | null
  target: ImportedFont | null
  fonts: ImportedFont[]
  error?: string
}

export class FontError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FontError"
  }
}

type StoredSettings = {
  version: 1
  source: string | null
  target: string | null
  fonts: ImportedFont[]
}

// One record prevents a failed second write leaving selection and library out of sync.
// Shared across this project's hosts; also accessible to other scripts using this key.
const STORAGE_KEY = "lingo_translation_font_settings_v1"
const STORAGE_OPTIONS = { shared: true }
const MAX_BYTES = 30 * 1024 * 1024
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const listeners = new Set<() => void>()
let importing = false

function fontDirectory(): string {
  return `${FileManager.appGroupDocumentsDirectory}/lingo-translation-fonts`
}

function isImportedFont(value: unknown): value is ImportedFont {
  if (!value || typeof value !== "object") return false
  const font = value as Partial<ImportedFont>
  if (typeof font.id !== "string" || !UUID_PATTERN.test(font.id)) return false
  if (typeof font.name !== "string" || !font.name.trim()) return false
  if (font.format !== "truetype" && font.format !== "opentype") return false
  return font.filename === `${font.id}.${font.format === "opentype" ? "otf" : "ttf"}`
}

function load(): FontSettings {
  let value: unknown
  try {
    value = Storage.get<unknown>(STORAGE_KEY, STORAGE_OPTIONS)
  } catch {
    throw new FontError("无法读取字体设置，请稍后重试。")
  }
  if (value == null) return { source: null, target: null, fonts: [] }
  if (typeof value !== "object") throw new FontError("字体设置数据已损坏。")
  const stored = value as Partial<StoredSettings>
  if (stored.version !== 1 || !Array.isArray(stored.fonts)) {
    throw new FontError("字体设置数据格式不受支持。")
  }
  const fonts: ImportedFont[] = []
  for (const value of stored.fonts) {
    if (!isImportedFont(value) || fonts.some(font => font.id === value.id)) {
      throw new FontError("字体列表数据已损坏。")
    }
    // Return detached metadata, never external paths or the Storage object's references.
    fonts.push({ id: value.id, name: value.name, filename: value.filename, format: value.format })
  }
  return {
    source: fonts.find(font => font.id === stored.source) ?? null,
    target: fonts.find(font => font.id === stored.target) ?? null,
    fonts,
  }
}

function commit(settings: FontSettings): void {
  const stored: StoredSettings = {
    version: 1,
    source: settings.source?.id ?? null,
    target: settings.target?.id ?? null,
    fonts: settings.fonts,
  }
  try {
    if (!Storage.set(STORAGE_KEY, stored, STORAGE_OPTIONS)) {
      throw new FontError("无法保存字体设置，原设置未更改。")
    }
  } catch {
    throw new FontError("无法保存字体设置，原设置未更改。")
  }
  // Storage's success flag acknowledges the write; disk persistence is asynchronous.
  // A listener failure must not turn an already committed import into a rollback.
  for (const listener of Array.from(listeners)) {
    try { listener() } catch {}
  }
}

function loadForDisplay(): FontSettings {
  try { return load() }
  catch (error) {
    return { source: null, target: null, fonts: [], error: error instanceof Error ? error.message : "无法读取字体设置。" }
  }
}

export function useFontSettings(): FontSettings {
  const [settings, setSettings] = useState<FontSettings>(() => loadForDisplay())
  useEffect(() => {
    const refresh = () => setSettings(loadForDisplay())
    listeners.add(refresh)
    // Subscribe first, then reload: covers changes between initial render and mounting.
    refresh()
    return () => { listeners.delete(refresh) }
  }, [])
  return settings
}

function requireRole(role: FontRole): void {
  if (role !== "source" && role !== "target") throw new FontError("未知的字体用途。")
}

function resolveFont(settings: FontSettings, font: ImportedFont): ImportedFont {
  if (!isImportedFont(font)) throw new FontError("字体信息无效，请重新导入。")
  const saved = settings.fonts.find(item => item.id === font.id)
  if (!saved || saved.filename !== font.filename || saved.format !== font.format) {
    throw new FontError("该字体不在已导入列表中，请重新导入。")
  }
  return saved
}

function checkSize(size: number): void {
  if (!Number.isFinite(size) || size < 12) throw new FontError("字体文件为空或不完整。")
  if (size > MAX_BYTES) throw new FontError("字体文件不能超过 30 MB（30 × 1024 × 1024 字节）。")
}

function detectFormat(data: Data): ImportedFont["format"] {
  checkSize(data.size)
  const header = data.slice(0, 12).toUint8Array()
  if (!header || header.length !== 12) throw new FontError("无法读取字体文件头。")
  const directoryEnd = 12 + (header[4] * 256 + header[5]) * 16
  if (directoryEnd > data.size) throw new FontError("字体表目录不完整，文件可能已损坏。")
  const directory = data.slice(0, directoryEnd).toUint8Array()
  if (!directory) throw new FontError("无法读取字体表目录。")
  try { return inspectFontDirectory(directory, data.size) }
  catch (error) { throw new FontError(error instanceof Error ? error.message : "字体文件无效。") }
}

/** Select only a previously imported font; null restores this role's system font. */
export function selectFont(role: FontRole, font: ImportedFont | null): void {
  requireRole(role)
  const settings = load()
  const saved = font === null ? null : resolveFont(settings, font)
  if (saved) {
    try {
      const path = `${fontDirectory()}/${saved.filename}`
      if (!FileManager.isFileSync(path)) throw new FontError("已保存的字体文件不可用，请重新导入。")
      checkSize(FileManager.statSync(path).size)
    }
    catch (error) {
      if (error instanceof FontError) throw error
      throw new FontError("已保存的字体文件不可用，请重新导入。")
    }
  }
  commit({ ...settings, [role]: saved })
}

export async function deleteFont(role: FontRole, font: ImportedFont): Promise<void> {
  requireRole(role)
  const settings = load()
  const saved = resolveFont(settings, font)
  const nextFonts = settings.fonts.filter(item => item.id !== saved.id)
  commit({
    source: settings.source?.id === saved.id ? null : settings.source,
    target: settings.target?.id === saved.id ? null : settings.target,
    fonts: nextFonts,
  })
  try {
    await FileManager.remove(`${fontDirectory()}/${saved.filename}`)
  } catch {
    // The library record is already removed; an unavailable file cannot be selected again.
  }
}

/** Read only the private saved copy; never send font bytes through JavaScript. */
export async function fontResource(font: ImportedFont): Promise<{ directory: string; filename: string }> {
  const saved = resolveFont(load(), font)
  const directory = fontDirectory()
  try {
    checkSize((await FileManager.stat(`${directory}/${saved.filename}`)).size)
    return { directory, filename: saved.filename }
  } catch (error) {
    if (error instanceof FontError) throw error
    throw new FontError("无法读取已保存的字体，请重新导入。")
  }
}

/** Opens Files, validates, saves a unique local copy and selects it. Cancel => null. */
export async function importFont(role: FontRole): Promise<ImportedFont | null> {
  requireRole(role)
  if (importing) throw new FontError("正在导入字体，请等待完成。")
  importing = true
  let createdPath: string | undefined
  let committed = false
  try {
    // public.data deliberately permits misspelled .tff; content decides the format.
    const paths = await DocumentPicker.pickFiles({
      types: ["public.data"], allowsMultipleSelection: false, shouldShowFileExtensions: true,
    })
    const path = paths?.[0]
    if (!path) return null
    const originalName = path.slice(path.lastIndexOf("/") + 1)
    if (!/\.(ttf|otf|tff)$/i.test(originalName)) {
      throw new FontError("请选择 .ttf 或 .otf 文件，也兼容误写为 .tff 的有效字体。")
    }
    // Read the selected security-scoped URL directly. Some Files providers expose
    // readable documents whose stat metadata is unavailable or not "file".
    let data: Data
    try {
      data = await FileManager.readAsData(path)
    } catch {
      throw new FontError("无法读取所选字体的内容。若文件在 iCloud 或网盘，请先在“文件”App 中下载到本机，再重新导入。")
    }
    // Structural checks are synchronous and tiny. Decode in the visible WebView,
    // not an off-screen validation view that can stall after the document picker.
    const format = detectFormat(data)

    const directory = fontDirectory()
    await FileManager.createDirectory(directory, true)
    let id: string
    let filename: string
    do {
      id = UUID.string()
      filename = `${id}.${format === "opentype" ? "otf" : "ttf"}`
    } while (await FileManager.exists(`${directory}/${filename}`))
    const font: ImportedFont = {
      id, filename, format,
      name: originalName.replace(/\.(ttf|otf|tff)$/i, "").trim() || "未命名字体",
    }
    createdPath = `${directory}/${filename}`
    // Write the exact validated bytes, not a second copy of a possibly changed source.
    await FileManager.writeAsData(createdPath, data)
    checkSize((await FileManager.stat(createdPath)).size)
    const latest = load() // Preserve the other role and imports made while the picker was open.
    commit({ ...latest, [role]: font, fonts: [...latest.fonts, font] })
    committed = true
    return font
  } catch (error) {
    if (error instanceof FontError) throw error
    throw new FontError("无法导入字体，请确认文件可读取、本地空间充足，并在支持文件选择器的界面中重试。")
  } finally {
    if (createdPath && !committed) {
      try { await FileManager.remove(createdPath) } catch {}
    }
    // The API can release only ALL picker resources, potentially used by other features.
    // Leave the external security scope to the documented script-lifetime cleanup.
    importing = false
  }
}
