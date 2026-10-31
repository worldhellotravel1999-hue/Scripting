import {
  Button,
  Circle,
  Group,
  HStack,
  Image,
  MagnifyGesture,
  NavigationStack,
  ProgressView,
  Rectangle,
  ScrollView,
  Text,
  VStack,
  ZStack,
  useEffect,
  useRef,
  useState,
} from "scripting"
import { startScreenTranslation } from "../core/screen-job"
import { guard, safeAnimate, safeTimeout } from "../core/guarded"

/** 有效图片判定：跨桥丢失/宽度非法的图绝不能送进原生 Vision 管线。 */
function isValidImage(image?: UIImage): image is UIImage {
  return !!image && typeof image.width === "number" && image.width > 0
}

/** 可复制的 OCR 行（与 ScreenOverlayResult.lines 同构，避免引渲染模块）。 */
type CopyLine = {
  source: string
  translated: string
  box?: { x: number; y: number; width: number; height: number }
}

/** 缩放范围与行为常量：捏合限幅，回捏到贴近 1 时吸附复位。 */
const MAX_SCALE = 6
const RESET_SNAP = 1.08
/** 命中区行数上限：超长截图铺太多透明层时放弃逐行复制，保渲染性能。 */
const MAX_COPY_TARGETS = 600

/**
 * OCR 行命中区：贴在译文/原文覆盖位置的透明矩形。
 * 点一下 → 直接复制该行译文（无长按菜单）。
 * 视觉零改动（0.003 透明填充只为参与命中测试，同 translation-panel 的做法），
 * 框坐标是 Vision 归一化左下原点，这里换算成视图左上原点并各向外扩 8/6pt 好按。
 */
function CopyTargetsLayer(props: {
  lines: CopyLine[]
  dispW: number
  dispH: number
  /** 由调用方决定取原文还是译文（跟随当前显示的图）。 */
  copyTextForLine: (line: CopyLine) => string
  onCopy: (text: string) => void
}) {
  const items = props.lines.filter((line) => {
    const box = line.box
    return !!box && [box.x, box.y, box.width, box.height].every(Number.isFinite)
      && box.width > 0 && box.height > 0
  })
  if (!items.length || !(props.dispW > 0) || !(props.dispH > 0)) return null
  return (
    <Group>
      {items.map((line, index) => {
        const box = line.box!
        const left = Math.max(-20, box.x * props.dispW - 8)
        const top = Math.max(-20, (1 - box.y - box.height) * props.dispH - 6)
        const width = box.width * props.dispW + 16
        const height = box.height * props.dispH + 12
        return (
          <Rectangle
            key={index}
            fill="rgba(0,0,0,0.003)"
            contentShape="rect"
            frame={{ width, height }}
            offset={{ x: left + width / 2 - props.dispW / 2, y: top + height / 2 - props.dispH / 2 }}
            onTapGesture={guard(() => props.onCopy(props.copyTextForLine(line)), "screen-copy-tap")}
          />
        )
      })}
    </Group>
  )
}

/**
 * 可缩放图片：双手捏合放大（MagnifyGesture），无需任何按钮。
 * - 捏合过程中用 scaleEffect 做瞬时变换（布局不变，滚动不受干扰）；
 * - 松手后把捏合结果并入布局尺寸（base），图片真正变大，
 *   外层 ScrollView（双轴）即可上下左右拖动查看；
 * - 回捏到 1 附近自动吸附复位；缩放上限 6x。
 * 布局宽度取屏幕宽，命中区坐标与图片逐像素对齐。
 */
function ZoomableImage(props: {
  image: UIImage
  lines: CopyLine[]
  copyTextForLine: (line: CopyLine) => string
  onCopy: (text: string) => void
}) {
  const [base, setBase] = useState(1)
  const [transient, setTransient] = useState(1)
  // pinch 记录手势开始时的基准与最近一次瞬时值（onEnded 拿不到数值）。
  // active 标记本次捏合是否真的产生过 onChanged：两指轻触会走 onEnded
  // 却没有任何变化，若不区分会用上一次的 last 误跳缩放。
  const pinch = useRef({ base: 1, last: 1, active: false })

  const imageWidth = props.image.width
  const imageHeight = props.image.height
  const aspect = imageWidth > 0 && imageHeight > 0 ? imageHeight / imageWidth : 1
  const dispW = Device.screen.width * base
  const dispH = Device.screen.width * aspect * base

  const commit = (value: number) => {
    let next = Math.min(MAX_SCALE, Math.max(1, value))
    if (next <= RESET_SNAP) next = 1
    pinch.current.base = next
    pinch.current.active = false
    safeAnimate(() => {
      setTransient(1)
      setBase(next)
    })
  }

  const magnify = MagnifyGesture(0.02)
    .onChanged(guard((value) => {
      if (!pinch.current.active) {
        pinch.current.active = true
        pinch.current.last = pinch.current.base
      }
      const magnification = value?.magnification
      if (typeof magnification !== "number" || !Number.isFinite(magnification) || magnification <= 0) return
      const next = Math.min(MAX_SCALE, Math.max(1, pinch.current.base * magnification))
      pinch.current.last = next
      const anchor = pinch.current.base || 1
      setTransient(next / anchor)
    }, "screen-zoom-changed"))
    .onEnded(guard(() => {
      commit(pinch.current.last)
    }, "screen-zoom-ended"))

  const targets = props.lines.length > 0 && props.lines.length <= MAX_COPY_TARGETS ? (
    <CopyTargetsLayer lines={props.lines} dispW={dispW} dispH={dispH} copyTextForLine={props.copyTextForLine} onCopy={props.onCopy} />
  ) : null

  // 注意：不能在外面套 maxWidth: infinity 的容器——那会把 ScrollView 的
  // 内容宽度钉在屏宽，横向永远没有可滚动区域（左右拖不动）。直接返回
  // 尺寸 = dispW × dispH 的 ZStack，ScrollView 内容尺寸跟随图片，
  // 放大后四轴都能拖；未放大时宽恰好等于屏宽，不会横向晃。
  return (
    <ZStack
      frame={{ width: dispW, height: dispH }}
      scaleEffect={{ x: transient, y: transient }}
      simultaneousGesture={magnify}
    >
      <Image
        image={props.image}
        resizable
        frame={{ width: dispW, height: dispH }}
      />
      {targets}
    </ZStack>
  )
}

/**
 * 右下角浮动区（钉在页面角，图片滚动不影响）：同一位置叠两个状态——
 * - 加载中：转圈圆钮（与完成态同形同色，避免加载→完成跳形）；
 * - 完成：原图/译图切换钮——**黑色浅透圆形**（与主界面右上角同图标，
 *   浅色深色自适应半透黑底 + 细描边）；点击时图标弹一下；复制瞬间按钮
 *   缩放消失，原位弹出「Copied」（透明底纯文字，尺寸不变），1.4s 后弹回。
 * 特效用 Transition.scale + opacity（bouncy 弹簧），按钮/提示互斥出现。
 */
/** 圆钮直径与浅透黑底（浅色深色同一配方，压在图片上都可读）。 */
const FLOAT_BUTTON_SIZE = 40
const FLOAT_BUTTON_FILL: any = { light: "rgba(30,30,32,0.55)", dark: "rgba(30,30,32,0.55)" }
const FLOAT_BUTTON_STROKE: any = { light: "rgba(255,255,255,0.22)", dark: "rgba(255,255,255,0.16)" }

function FloatingCorner(props: {
  status: "loading" | "done" | "error"
  hasCover: boolean
  showOriginal: boolean
  showToast: boolean
  onToggleOriginal: () => void
}) {
  const pop = Transition.scale(0.3).combined(Transition.opacity())
    .animation(Animation.bouncy({ duration: 0.35, extraBounce: 0.18 }))
  if (props.status === "loading") {
    return (
      <HStack padding={{ trailing: 14, bottom: 14 }} frame={{ height: FLOAT_BUTTON_SIZE, alignment: "bottom" }}>
        <ZStack frame={{ width: FLOAT_BUTTON_SIZE, height: FLOAT_BUTTON_SIZE }}>
          <Circle fill={FLOAT_BUTTON_FILL} frame={{ width: FLOAT_BUTTON_SIZE, height: FLOAT_BUTTON_SIZE }} />
          <Circle stroke={{ shapeStyle: FLOAT_BUTTON_STROKE, strokeStyle: { lineWidth: 0.5 } }} frame={{ width: FLOAT_BUTTON_SIZE, height: FLOAT_BUTTON_SIZE }} />
          <ProgressView />
        </ZStack>
      </HStack>
    )
  }
  if (props.status !== "done" || !props.hasCover) return null
  return (
    <HStack padding={{ trailing: 14, bottom: 14 }} frame={{ height: FLOAT_BUTTON_SIZE, alignment: "bottom" }}>
      {props.showToast ? (
        <ZStack frame={{ width: FLOAT_BUTTON_SIZE, height: FLOAT_BUTTON_SIZE }} transition={pop}>
          <Text
            key="copied"
            textSelection={false}
            foregroundStyle={{ light: "#1C1C1E", dark: "#1C1C1E" }}
            font="footnote"
            fontWeight="semibold"
            lineLimit={1}
            minScaleFactor={0.6}
          >{"Copied"}</Text>
        </ZStack>
      ) : (
        <ZStack
          key="pill"
          frame={{ width: FLOAT_BUTTON_SIZE, height: FLOAT_BUTTON_SIZE }}
          transition={pop}
        >
          <Circle fill={FLOAT_BUTTON_FILL} frame={{ width: FLOAT_BUTTON_SIZE, height: FLOAT_BUTTON_SIZE }} />
          <Circle stroke={{ shapeStyle: FLOAT_BUTTON_STROKE, strokeStyle: { lineWidth: 0.5 } }} frame={{ width: FLOAT_BUTTON_SIZE, height: FLOAT_BUTTON_SIZE }} />
          {/* Button 必须擑满整个圆形（之前只包图标 ~20pt，圆内其余点击全落空
              —— 用户感受就是「点好几次才有用」）。contentShape 保证整个
              圆形区域都算按钮命中区。 */}
          <Button buttonStyle="borderless" action={props.onToggleOriginal}>
            <ZStack
              frame={{ width: FLOAT_BUTTON_SIZE, height: FLOAT_BUTTON_SIZE }}
              contentShape="circle"
            >
              <Image
                systemName="circle.grid.2x2"
                font="body"
                foregroundStyle="white"
                contentTransition="symbolEffect"
                symbolEffect={{ effect: "bounce", value: props.showOriginal }}
              />
            </ZStack>
          </Button>
        </ZStack>
      )}
    </HStack>
  )}

type ScreenTranslationResultProps = {
  image: UIImage
}

/**
 * 截图翻译结果页：页面立即呈现（原图打底 + 右下角加载态），
 * 「OCR → 翻译 → 覆盖渲染」与页面呈现**并行**进行（core/screen-job 与
 * intent 共用同一份工作）。
 *
 * 2026-10-19：入口（intent.tsx / views/home.tsx）一律先 beginScreenTranslation
 * 再 present，页面挂载时 startScreenTranslation 直接复用已开工的 Promise。
 * 旧注释说「重活必须在呈现之后」是对早期实现的描述：那时先 await 完整管线
 * 再 present，扩展会长时间无响应；正确做法是「不 await 地先开工 + 立即 present」，
 * 既保住首帧，又不把 present / 首帧挂载的时间白白串在管线前面。
 *
 * 完成态：整页只渲染译文覆盖图，右下角一个「原图」切换钮（下滑关闭）。
 * 无按钮的交互：
 * - 双手捏合放大/缩小图片（回捏复位，放大后滚动查看）；
 * - 点 OCR 行直接复制该行译文；
 * - 复制后短暂显示「Copied」纯文字提示（无背景框、不拦截触摸）。
 * 失败态：原图 + 页内错误文字，不弹任何系统对话框。
 */
export function ScreenTranslationResult(props: ScreenTranslationResultProps) {
  const [status, setStatus] = useState<"loading" | "done" | "error">("loading")
  const [coverImage, setCoverImage] = useState<UIImage | null>(null)
  const [lines, setLines] = useState<CopyLine[]>([])
  const [errorMessage, setErrorMessage] = useState("")
  const [showOriginal, setShowOriginal] = useState(false)
  const [toast, setToast] = useState(false)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let alive = true
    if (!isValidImage(props.image)) {
      // 图片跨桥丢失/无效时绝不能把 undefined 送进原生 Vision（会崩整个 App）。
      setErrorMessage("截图数据无效，请重新分享一次。")
      setStatus("error")
      return
    }
    startScreenTranslation(props.image).then(
      (result) => {
        if (!alive) return
        setCoverImage(result.image)
        setLines(Array.isArray(result.lines) ? result.lines : [])
        setStatus("done")
      },
      (reason) => {
        if (!alive) return
        setErrorMessage(reason instanceof Error ? reason.message : String(reason))
        setStatus("error")
      },
    )
    return () => {
      alive = false
    }
  }, [])

  /** 复制到系统剪贴板 + 「Copied」提示；取哪段文字由调用方（显示态）决定。 */
  const handleCopy = guard((text: string) => {
    const value = String(text || "").trim()
    if (!value) return
    void Pasteboard.setString(value).catch(() => {})
    setToast(true)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = safeTimeout(() => setToast(false), 1400)
  }, "screen-copy")

  /** 显示态下的取文函数：译文图 → 行译文；原图 → 行原文。 */
  const copyTextForLine = guard((line: CopyLine) => {
    return String(showOriginal ? line.source : line.translated || "")
  }, "screen-copy-pick")

  const validImage = isValidImage(props.image)
  const displayedImage = showOriginal ? props.image : (coverImage ?? props.image)

  // 右下角浮动区：加载转圈 / 原图切换钮 / Copied 提示同位互换，
  // 钉在页面角（真实截图比视口高，挂在图片角上会随内容滚出屏幕）。
  const floatingCorner = (
    <FloatingCorner
      status={status}
      hasCover={!!coverImage && validImage}
      showOriginal={showOriginal}
      showToast={toast}
      onToggleOriginal={() => setShowOriginal((current) => !current)}
    />
  )

  return (
    <NavigationStack>
      <ZStack>
        <ScrollView
          axes="all"
          scrollContentBackground="hidden"
          background={{ light: "#F2F2F7", dark: "#000000" }}
          overlay={{ alignment: "bottomTrailing", content: floatingCorner }}
        >
          {validImage ? (
            <ZoomableImage image={displayedImage} lines={lines} copyTextForLine={copyTextForLine} onCopy={handleCopy} />
          ) : (
            <Text textSelection={false} padding={{ horizontal: 16, vertical: 12 }}>
              {"截图数据无效，请重新分享一次。"}
            </Text>
          )}
          {status === "error" ? (
            <Text textSelection={false} padding={{ horizontal: 16, vertical: 12 }}>
              {`截图翻译失败：${errorMessage}`}
            </Text>
          ) : null}
        </ScrollView>
      </ZStack>
    </NavigationStack>
  )
}
