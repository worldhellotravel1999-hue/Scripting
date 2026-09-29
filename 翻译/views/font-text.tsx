import { Text, TextField, VStack, WebView, useEffect, useRef, useState } from "scripting"
import { fontResource, useFontSettings, type FontRole, type ImportedFont } from "../core/fonts"
import { fontTextHTML } from "../core/font-text-html"
import { AnimText } from "./anim-text"

type FontTextProps = {
  text: string
  role: FontRole
  small?: boolean
  flat?: boolean
  editable?: boolean
  /** false 关闭系统文本选择（自绘长按菜单场景用，避免选择栏抢长按手势）。 */
  selectable?: boolean
  animated?: boolean
  foregroundStyle?: any
  gradientColors?: [string, string]
  onChanged?: (value: string) => void
  onTextSubmit?: () => void
}

function SystemText(props: FontTextProps) {
  return props.editable ? (
    <TextField title="" value={props.text} onChanged={value => props.onChanged?.(value)}
      onSubmit={props.onTextSubmit} submitLabel="send"
      axis="vertical" lineLimit={{ min: 4, max: 9 }} />
  ) : props.animated ? (
    <AnimText anim="interpolate" dur={0.4} foregroundStyle={props.foregroundStyle} {...(props.selectable === false ? {} : { textSelection: true })}>{props.text}</AnimText>
  ) : (
    <Text font={props.small ? "subheadline" : "body"} foregroundStyle={props.foregroundStyle} {...(props.selectable === false ? {} : { textSelection: true })}>{props.text}</Text>
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
  const mounted = useRef(true)

  function syncText() {
    if (!ready.current) return
    const text = JSON.stringify(current.current.text)
    void controller.evaluateJavaScript(`window.setText(${text}, ${editVersion.current}); return true`).catch(() => {
      if (mounted.current) setError("字体显示失败，已使用系统字体。")
    })
  }

  useEffect(() => {
    let active = true
    mounted.current = true
    let timer: number | undefined
    let pagePath: string | undefined
    async function removePage() {
      if (pagePath) {
        try { await FileManager.remove(pagePath) } catch {}
      }
    }
    async function load() {
      try {
        const resource = await fontResource(props.selectedFont)
        if (!active) return
        const htmlPath = `${resource.directory}/view-${UUID.string()}.html`
        const normalize = (path: string) => path.replace(/^\/private\/var\//, "/var/")
        controller.shouldAllowRequest = async request => {
          if (request.url === "about:blank") return true
          if (!request.url.startsWith("file://")) return false
          try {
            const path = normalize(decodeURIComponent(request.url.replace(/^file:\/\/(localhost)?/, "").split(/[?#]/)[0]))
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
          } else if (message.type === "ready") {
            fontReady.current = true
            if (timer !== undefined) clearTimeout(timer)
            setError("") // A slow load can recover without re-importing the font.
            ready.current = true
            syncText()
          } else if (message.type === "error") {
            if (timer !== undefined) clearTimeout(timer)
            setError("字体无法解码，已使用系统字体。请更换有效字体文件。")
          }
        })
        if (!active) return
        pagePath = htmlPath
        // This small local HTML contains no source text or translated content.
        // It grants WebKit read access to the font directory explicitly.
        await FileManager.writeAsString(htmlPath, fontTextHTML({
          filename: resource.filename, format: props.selectedFont.format,
          size: props.small ? 15 : 17, editable: !!props.editable, flat: !!props.flat, text: "", gradientColors: props.gradientColors,
        }))
        if (!active) { await removePage(); return }
        timer = setTimeout(() => {
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
      void removePage()
    }
  }, [])

  useEffect(() => { syncText() }, [props.text])

  return (
    <VStack alignment="leading" spacing={error ? 4 : 0}>
      <WebView controller={controller} frame={{ maxWidth: "infinity", height: error ? 0 : height }} opacity={error ? 0 : 1} />
      {error ? <SystemText {...props} /> : null}
      {error ? <Text font="caption2" foregroundStyle="secondaryLabel">{error}</Text> : null}
    </VStack>
  )
}

export function FontText(props: FontTextProps) {
  const settings = useFontSettings()
  const font = settings[props.role]
  return font
    ? <ImportedFontText key={`${font.id}:${!!props.editable}:${!!props.small}:${!!props.flat}`} {...props} selectedFont={font} />
    : <SystemText {...props} />
}
