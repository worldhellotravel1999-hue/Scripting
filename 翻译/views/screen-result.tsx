import {
  Button,
  HStack,
  Image,
  List,
  Navigation,
  NavigationStack,
  Section,
  Text,
  useState,
} from "scripting"

type ScreenTranslationResultProps = {
  image: UIImage
  text: string
  /** 有覆盖图时只展示覆盖图；无则展示原图。 */
  coverImage?: UIImage | null
}

/**
 * 截图翻译结果页：译文覆盖图在上（原文位置直接显示译文）、纯文本在下。
 * 早前用 QuickLook.previewText / Dialog 只给纯文本，用户看不到对应截图，
 * 故改为本页呈现（Navigation.present）；点「完成」dismiss 后 present 的
 * Promise 结束，intent 侧再 Script.exit 返回译文。
 */
export function ScreenTranslationResult(props: ScreenTranslationResultProps) {
  const dismiss = Navigation.useDismiss()
  const [copied, setCopied] = useState(false)

  async function copyTranslation() {
    try {
      await Pasteboard.setString(props.text)
      try { HapticFeedback.lightImpact() } catch {}
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {}
  }

  return (
    <NavigationStack>
      <List
        listStyle="plain"
        scrollContentBackground="hidden"
        background={{ light: "#F2F2F7", dark: "#000000" }}
        navigationTitle="截图译文"
        navigationBarTitleDisplayMode="inline"
        toolbar={{
          topBarTrailing: (
            <HStack spacing={18}>
              <Button buttonStyle="borderless" action={() => { void copyTranslation() }}>
                <Text fontWeight="medium" foregroundStyle={copied ? "systemGreen" : { light: "#000000", dark: "#FFFFFF" }}>
                  {copied ? "已复制" : "复制"}
                </Text>
              </Button>
              <Button buttonStyle="borderless" action={dismiss}>
                <Text fontWeight="medium" foregroundStyle={{ light: "#000000", dark: "#FFFFFF" }}>完成</Text>
              </Button>
            </HStack>
          ),
        }}
      >
        <Section>
          <Image
            image={props.coverImage ?? props.image}
            resizable
            aspectRatio={{ value: null, contentMode: "fit" }}
            frame={{ maxWidth: "infinity" }}
          />
        </Section>
        <Section>
          <Text textSelection={false}>{props.text}</Text>
        </Section>
      </List>
    </NavigationStack>
  )
}
