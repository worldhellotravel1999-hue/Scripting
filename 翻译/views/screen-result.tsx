import {
  Button,
  HStack,
  Image,
  List,
  NavigationStack,
  ProgressView,
  RoundedRectangle,
  Section,
  Text,
  useEffect,
  useState,
} from "scripting"
import { startScreenTranslation } from "../core/screen-job"

/** 有效图片判定：跨桥丢失/宽度非法的图绝不能送进原生 Vision 管线。 */
function isValidImage(image?: UIImage): image is UIImage {
  return !!image && typeof image.width === "number" && image.width > 0
}

/** 右下角浮钮容器：钉在页面角的半透明胶囊（加载转圈与原图/译图切换共用同一位置）。 */
function FloatingPillFrame(props: { pillPadding: any; children: any }) {
  return (
    <HStack padding={{ trailing: 14, bottom: 14 }}>
      <HStack
        padding={props.pillPadding}
        background={<RoundedRectangle fill={{ light: "rgba(255,255,255,0.85)", dark: "rgba(28,28,30,0.85)" }} cornerRadius={18} />}
        clipShape="capsule"
      >
        {props.children}
      </HStack>
    </HStack>
  )
}

type ScreenTranslationResultProps = {
  image: UIImage
}

/**
 * 截图翻译结果页：页面立即呈现（原图打底 + 右下角加载态），
 * 「OCR → 翻译 → 覆盖渲染」在页面挂载后的后台进行（core/screen-job 与
 * intent 共用同一份工作）。分享扩展宿主对「呈现之前跑完整条重管线」
 * 不友好（表现为整个扩展无响应、用不了），所以重活必须在呈现之后。
 * 完成态：整页只渲染译文覆盖图，右下角一个「原图」切换钮（再点「译图」
 * 切回，下滑关闭）；顶部不显示标题，图片下方不渲染任何译文文本。
 * 失败态：原图 + 页内错误文字，不弹任何系统对话框。
 */
export function ScreenTranslationResult(props: ScreenTranslationResultProps) {
  const [status, setStatus] = useState<"loading" | "done" | "error">("loading")
  const [coverImage, setCoverImage] = useState<UIImage | null>(null)
  const [errorMessage, setErrorMessage] = useState("")
  const [showOriginal, setShowOriginal] = useState(false)

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

  const validImage = isValidImage(props.image)
  const displayedImage = showOriginal ? props.image : (coverImage ?? props.image)

  // 右下角浮钮：加载转圈与「原图/译图」切换同一位置，钉在页面角
  // （真实截图比视口高，挂在图片角上会随内容滚出屏幕）。
  const floatingPill = status === "loading" && validImage ? (
    <FloatingPillFrame pillPadding={10}>
      <ProgressView />
    </FloatingPillFrame>
  ) : status === "done" && coverImage && validImage ? (
    <FloatingPillFrame pillPadding={{ horizontal: 14, vertical: 9 }}>
      <Button buttonStyle="borderless" action={() => setShowOriginal((current) => !current)}>
        <Image systemName="circle.grid.2x2" font="body" />
      </Button>
    </FloatingPillFrame>
  ) : null

  return (
    <NavigationStack>
      <List
        listStyle="plain"
        scrollContentBackground="hidden"
        background={{ light: "#F2F2F7", dark: "#000000" }}
        navigationTitle=""
        overlay={floatingPill ? { alignment: "bottomTrailing", content: floatingPill } : undefined}
      >
        <Section>
          {validImage ? (
            <Image
              image={displayedImage}
              resizable
              aspectRatio={{ value: null, contentMode: "fit" }}
              frame={{ maxWidth: "infinity" }}
            />
          ) : (
            <Text textSelection={false}>{"截图数据无效，请重新分享一次。"}</Text>
          )}
        </Section>
        {status === "error" ? (
          <Section>
            <Text textSelection={false}>{`截图翻译失败：${errorMessage}`}</Text>
          </Section>
        ) : null}
      </List>
    </NavigationStack>
  )
}
