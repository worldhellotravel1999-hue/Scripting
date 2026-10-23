import { Text, TextField, VStack, WebView, useEffect, useRef, useState } from "scripting"
import { fontResource, useFontSettings, type FontRole, type ImportedFont } from "../core/fonts"
import { fontTextHTML } from "../core/font-text-html"
import { safeTimeout } from "../core/guarded"
import { AnimText } from "./anim-text"

type FontTextProps = {
  text: string
  role: FontRole
  small?: boolean
  flat?: boolean
  editable?: boolean
  /** 行距（pt）：系统文本走 Text.lineSpacing，自带字体折算进 WebView 行高。 */
  lineSpacing?: number
  /** 深色模式宿主背景；App Store 搜索卡用 #1C1C1E，分享页用 #000。 */
  darkBackground?: string
  /** false 关闭系统文本选择（自绘长按菜单场景用，避免选择栏抢长按手势）。 */
  selectable?: boolean
  animated?: boolean
  foregroundStyle?: any
  gradientColors?: [string, string]
  onChanged?: (value: string) => void
  onTextSubmit?: () => void
}

/*
  字体页面按「字体 + 排版配置」共享（见 ensureFontPage），不再每个文本实例
  写一份。旧版本/异常退出留下的 view-* 页面曾在目录里积累上百个，其中还有
  引用已删除字体的页面；模块加载时清理旧的，主 App 与分享扩展共用目录，
  所以 view-* 只清 10 分钟前的，page-* 模板保留 7 天。
*/
let stalePagesSwept = false
function sweepStaleFontPages(): void {
  if (stalePagesSwept) return
  stalePagesSwept = true
  try {
    const directory = `${FileManager.appGroupDocumentsDirectory}/lingo-translation-fonts`
    if (!FileManager.isDirectorySync(directory)) return
    for (const name of FileManager.readDirectorySync(directory)) {
      if (/\.html\.tmp$/i.test(name)) {
        try { FileManager.removeSync(`${directory}/${name}`) } catch {}
        continue
      }
      if (!/^(?:page|view|probe|timing|intent-probe)-[0-9a-f-]+\.html$/i.test(name)) continue
      const path = `${directory}/${name}`
      // 主 App 和分享扩展共用这个目录。view-*/page-* 可能是另一个进程
      // 正在使用的页面：旧实例页面只清 10 分钟前的，共享模板保留 7 天；
      // 测试用的 probe/timing 页面直接清。
      const keepMs = /^page-/i.test(name) ? 7 * 24 * 60 * 60 * 1000 : /^view-/i.test(name) ? 10 * 60 * 1000 : 0
      if (keepMs) {
        try {
          if (Date.now() - FileManager.statSync(path).modificationDate < keepMs) continue
        } catch { continue }
      }
      try { FileManager.removeSync(path) } catch {}
    }
  } catch {}
}
sweepStaleFontPages()

// fontTextHTML 的 HTML/CSS/JS 改动后必须递增，否则会继续复用旧共享页面。
const FONT_PAGE_VERSION = 3
const fontPages = new Map<string, Promise<string>>()

function pageHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

/**
 * 同一份字体 + 排版配置的 HTML 页面可被多个 WebView 复用（页面初始为空，
 * 文本由 syncText 注入）。这样不会每张卡/每个译文块都写一个新页面。
 */
function ensureFontPage(
  resource: { directory: string; filename: string },
  font: ImportedFont,
  props: FontTextProps,
): Promise<string> {
  const key = [
    FONT_PAGE_VERSION,
    resource.filename,
    props.small ? 15 : 17,
    props.editable ? "editable" : "static",
    props.flat ? "flat" : "card",
    props.lineSpacing ?? 0,
    (props.gradientColors || []).join(","),
    props.darkBackground ?? "",
  ].join("|")
  const existing = fontPages.get(key)
  if (existing) return existing
  const path = `${resource.directory}/page-${pageHash(key)}.html`
  const task = (async () => {
    if (!FileManager.isFileSync(path)) {
      const html = fontTextHTML({
        filename: resource.filename,
        format: font.format,
        size: props.small ? 15 : 17,
        editable: !!props.editable,
        // 静态文本先按可选生成；domReady 后会按实际 prop 调 setSelectable。
        selectable: true,
        flat: !!props.flat,
        text: "",
        gradientColors: props.gradientColors,
        lineSpacing: props.lineSpacing,
        darkBackground: props.darkBackground,
      })
      const temporary = `${path}.tmp`
      await FileManager.writeAsString(temporary, html)
      try {
        await FileManager.rename(temporary, path)
      } catch {
        await FileManager.writeAsString(path, html)
        try { await FileManager.remove(temporary) } catch {}
      }
    }
    return path
  })()
  fontPages.set(key, task)
  void task.catch(() => { fontPages.delete(key) })
  return task
}

function SystemText(props: FontTextProps) {
  const lineSpacing = props.lineSpacing
  return props.editable ? (
    <TextField title="" value={props.text} onChanged={value => props.onChanged?.(value)}
      onSubmit={props.onTextSubmit} submitLabel="send"
      axis="vertical" lineLimit={{ min: 4, max: 9 }} />
  ) : props.animated ? (
    <AnimText anim="interpolate" dur={0.4} foregroundStyle={props.foregroundStyle} lineSpacing={lineSpacing} {...(props.selectable === false ? {} : { textSelection: true })}>{props.text}</AnimText>
  ) : (
    <Text font={props.small ? "subheadline" : "body"} foregroundStyle={props.foregroundStyle} lineSpacing={lineSpacing} {...(props.selectable === false ? {} : { textSelection: true })}>{props.text}</Text>
  )
}

// A separate instance per selected font keeps stale asynchronous loads isolated.
function ImportedFontText(props: FontTextProps & { selectedFont: ImportedFont }) {
  const [controller] = useState(() => new WebViewController({ ephemeral: true }))
  const [height, setHeight] = useState(props.editable ? 102 : 27)
  const [error, setError] = useState("")
  const current = useRef(props)
  current.current = props
  const ready = useRef(false)
  const fontReady = useRef(false)
  const editVersion = useRef(0)
  const syncTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const mounted = useRef(true)

  function syncText() {
    if (!ready.current) return
    const text = JSON.stringify(current.current.text)
    void controller.evaluateJavaScript(`window.setText(${text}, ${editVersion.current}); return true`).catch(() => {
      if (mounted.current) setError("字体显示失败，已使用系统字体。")
    })
  }

  function syncSelectable() {
    if (!ready.current) return
    // editable 的 textarea 必须始终可选；静态文本跟随 selectable。
    const allow = current.current.editable || current.current.selectable !== false
    void controller.evaluateJavaScript(`window.setSelectable && window.setSelectable(${allow}); return true`).catch(() => {})
  }

  useEffect(() => {
    let active = true
    mounted.current = true
    let timer: number | undefined
    async function load() {
      try {
        const resource = await fontResource(props.selectedFont)
        if (!active) return
        // 这个本地 HTML 不含原文/译文，只提供 WebKit 对字体目录的读取权限。
        // 同字体 + 同排版配置的页面会被多个 WebView 复用。
        const htmlPath = await ensureFontPage(resource, props.selectedFont, props)
        if (!active) return
        const normalize = (path: string) => path.replace(/^\/private\/var\//, "/var/")
        const urlPath = (url: string) => normalize(decodeURIComponent(url.replace(/^file:\/\/(localhost)?/, "").split(/[?#]/)[0]))
        controller.shouldAllowRequest = async request => {
          if (request.url === "about:blank") return true
          if (!request.url.startsWith("file://")) return false
          try {
            const path = urlPath(request.url)
            return path === normalize(htmlPath) || path === normalize(`${resource.directory}/${resource.filename}`)
          } catch { return false }
        }
        await controller.addScriptMessageHandler<{ type: string; value?: unknown; version?: number }>("fontText", message => {
          if (!active || !message) return
          if (message.type === "height" && typeof message.value === "number" && Number.isFinite(message.value)) {
            const next = Math.max(1, Math.ceil(message.value))
            setHeight(previous => previous === next ? previous : next)
          } else if (message.type === "input" && typeof message.value === "string") {
            editVersion.current = message.version ?? editVersion.current
            current.current.onChanged?.(message.value)
          } else if (message.type === "submit") {
            current.current.onTextSubmit?.()
          } else if (message.type === "domReady") {
            ready.current = true
            syncText()
            syncSelectable()
          } else if (message.type === "ready") {
            fontReady.current = true
            if (timer !== undefined) clearTimeout(timer)
            setError("") // A slow load can recover without re-importing the font.
            ready.current = true
            syncText()
            syncSelectable()
          } else if (message.type === "error") {
            if (timer !== undefined) clearTimeout(timer)
            setError("字体无法解码，已使用系统字体。请更换有效字体文件。")
          }
        })
        if (!active) return
        timer = safeTimeout(() => {
          if (active && !fontReady.current) setError("字体暂未加载完成，先显示系统字体。")
        }, 30000)
        const loaded = await controller.loadFile(htmlPath, resource.directory)
        if (!active) return
        if (!loaded) { setError("字体显示失败，已使用系统字体。"); return }
        // Do not depend on a single domReady callback for the initial text.
        ready.current = true
        syncText()
        const status = await controller.evaluateJavaScript<string>("return window.fontState")
        if (!active) return
        if (status === "ready") {
          fontReady.current = true
          if (timer !== undefined) clearTimeout(timer)
          setError("")
        } else if (status === "error") {
          if (timer !== undefined) clearTimeout(timer)
          setError("字体无法解码，已使用系统字体。请更换有效字体文件。")
        }
      } catch {
        if (active) setError("无法读取或显示字体，已使用系统字体。请重新导入。")
      }
    }
    void load()
    return () => {
      active = false
      mounted.current = false
      ready.current = false
      if (timer !== undefined) clearTimeout(timer)
      controller.dispose()
    }
  }, [])

  useEffect(() => {
    // 流式译文会连续更新 text；合并 30ms，避免每个分片都过桥、重排整段 WebView。
    if (syncTimer.current !== undefined) clearTimeout(syncTimer.current)
    syncTimer.current = safeTimeout(() => {
      syncTimer.current = undefined
      syncText()
    }, 30)
    return () => {
      if (syncTimer.current !== undefined) {
        clearTimeout(syncTimer.current)
        syncTimer.current = undefined
      }
    }
  }, [props.text])
  useEffect(() => { syncSelectable() }, [props.selectable, props.editable])

  return (
    <VStack alignment="leading" spacing={error ? 4 : 0} contentShape="rect">
      {/* 只读文本只是展示层：WebView 若参与命中测试会吞掉外层 List/ScrollView
          的拖动和复制长按。编辑态仍需要 WebView 接收输入。 */}
      <WebView controller={controller} allowsHitTesting={!!props.editable} frame={{ maxWidth: "infinity", height: error ? 0 : height }} opacity={error ? 0 : 1} />
      {error ? <SystemText {...props} /> : null}
      {error ? <Text font="caption2" foregroundStyle="secondaryLabel">{error}</Text> : null}
    </VStack>
  )
}

export function FontText(props: FontTextProps) {
  const settings = useFontSettings()
  const font = settings[props.role]
  const gradientKey = props.gradientColors?.join(":") ?? ""
  return font
    ? <ImportedFontText key={`${props.role}:${font.id}:${!!props.editable}:${!!props.small}:${!!props.flat}:${props.lineSpacing ?? 0}:${gradientKey}:${props.darkBackground ?? ""}`} {...props} selectedFont={font} />
    : <SystemText {...props} />
}
