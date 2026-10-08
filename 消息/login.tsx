import {
  Button,
  Circle,
  Device,
  Image,
  ProgressView,
  Rectangle,
  RoundedRectangle,
  SecureField,
  Text,
  TextField,
  VStack,
  ZStack,
  useEffect,
  useMemo,
  useState,
} from "scripting"

/**
 * TG Hub 品牌层 —— Telegram 浅色主题：
 *  · TgFluidBackground：白底 + 极淡蓝色光晕（不再是深色重底）
 *  · LaunchScreen：冷启动遮罩（白底徽标 + 蓝色转圈）
 *  · LoginScreen：Telegram-iOS AuthorizationUI 风格（28pt 标题 + 17pt 说明 +
 *    18/30 间距 + 20pt 输入 + 13pt 底部提示）
 */

const BRAND = "TG Hub"

/** Telegram-iOS 浅色主题色板（AuthorizationUI 规范） */
export const TG = {
  blue: "#2AABEE", // 品牌蓝（主按钮 / 链接）
  text: "#000000", // 标题近黑
  sub: "#8E8E93", // 次级文字（iOS secondaryLabel）
  hair: "#E4E9ED", // 分隔线
  error: "#E14258", // 错误红（destructive）
} as const

function useScreenSize() {
  const [size, setSize] = useState(() => ({
    width: typeof Device !== "undefined" && Device.screen?.width ? Device.screen.width : 393,
    height: typeof Device !== "undefined" && Device.screen?.height ? Device.screen.height : 852,
  }))

  useEffect(() => {
    if (typeof Device === "undefined" || typeof Device.addOrientationListener !== "function") return
    const update = () => {
      const w = Device.screen?.width
      const h = Device.screen?.height
      if (w && h) setSize({ width: w, height: h })
    }
    Device.addOrientationListener(update)
    return () => {
      // 与 add 同样做存在性校验：宿主若只实现 add（或版本移除了 remove），
      // 卸载时裸调会抛 TypeError。
      if (typeof Device.removeOrientationListener === "function") {
        Device.removeOrientationListener(update)
      }
    }
  }, [])

  return size
}

/**
 * 极淡光晕：blur 修饰符实机不生效，用 16 层同心低透明度圆模拟径向衰减；
 * 单层 alpha 压得很低，叠加后最深处也只有约 20% 淡蓝，保证白底不脏。
 */
const BLOB_LAYERS: [number, number][] = Array.from({ length: 16 }, (_, i) => {
  const t = i / 15
  return [1 - t * 0.88, 0.006 + t * 0.016]
})

function SoftBlob(props: { r: number; g: number; b: number; size: number; x: number; y: number }) {
  return (
    <ZStack
      alignment="center"
      frame={{ width: props.size, height: props.size }}
      offset={{ x: props.x, y: props.y }}
    >
      {BLOB_LAYERS.map(([factor, alpha], i) => (
        <Circle
          key={i}
          fill={`rgba(${props.r},${props.g},${props.b},${alpha})`}
          frame={{
            width: Math.round(props.size * factor),
            height: Math.round(props.size * factor),
          }}
        />
      ))}
    </ZStack>
  )
}

/** 白底 + 淡蓝光晕（Telegram 浅色观感） */
export function TgFluidBackground() {
  const { width, height } = useScreenSize()

  const blobs = useMemo(() => {
    const w = width > 0 ? width : 393
    const h = height > 0 ? height : 852
    const maxDim = Math.max(w, h)
    const isPad = typeof Device !== "undefined" && Device.isiPad
    const scale = (ratio: number, min: number) =>
      Math.round(isPad ? maxDim * ratio : Math.max(min, maxDim * ratio))

    return {
      blue: { size: scale(0.5, 320), x: Math.round(w * 0.32), y: Math.round(-h * 0.2) },
      sky: { size: scale(0.44, 280), x: Math.round(-w * 0.3), y: Math.round(h * 0.16) },
      pale: { size: scale(0.36, 240), x: Math.round(w * 0.1), y: Math.round(h * 0.34) },
    }
  }, [width, height])

  return (
    <ZStack
      alignment="center"
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      ignoresSafeArea={true}
      clipped={true}
      background="#FFFFFF"
      preferredColorScheme="light"
    >
      <Rectangle
        fill={{
          colors: ["#FFFFFF", "#F2F9FE", "#FFFFFF"],
          startPoint: "top",
          endPoint: "bottom",
        }}
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
        ignoresSafeArea={true}
      />

      <ZStack
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
        ignoresSafeArea={true}
        clipped={true}
      >
        <SoftBlob r={42} g={171} b={238} size={blobs.blue.size} x={blobs.blue.x} y={blobs.blue.y} />
        <SoftBlob r={120} g={205} b={245} size={blobs.sky.size} x={blobs.sky.x} y={blobs.sky.y} />
        <SoftBlob r={190} g={232} b={250} size={blobs.pale.size} x={blobs.pale.x} y={blobs.pale.y} />
      </ZStack>
    </ZStack>
  )
}

/** 品牌徽标：Telegram 蓝渐变圆 + 纸飞机 */
export function BrandBadge({ size = 76 }: { size?: number }) {
  return (
    <ZStack
      alignment="center"
      frame={{ width: size, height: size }}
      shadow={{ color: "rgba(42, 171, 238, 0.4)", radius: 14, y: 6 }}
    >
      <Circle
        fill={{
          colors: ["#5CC8F8", "#2299D6"],
          startPoint: "topLeading",
          endPoint: "bottomTrailing",
        }}
        frame={{ width: size, height: size }}
      />
      <Image
        systemName="paperplane.fill"
        foregroundStyle="white"
        frame={{ width: Math.round(size * 0.46), height: Math.round(size * 0.46) }}
      />
    </ZStack>
  )
}

function BrandTitle() {
  return (
    <VStack alignment="center" spacing={8}>
      <Text font={28} fontWeight="semibold" foregroundStyle={TG.text}>
        {BRAND}
      </Text>
      <Text font={17} foregroundStyle={TG.sub}>
        Telegram 本地消息分析面板
      </Text>
    </VStack>
  )
}

/** 冷启动遮罩：白底徽标 + 蓝色转圈 */
export function LaunchScreen(props?: { text?: string }) {
  return (
    <ZStack alignment="center" frame={{ maxWidth: "infinity", maxHeight: "infinity" }} ignoresSafeArea={true}>
      <TgFluidBackground />
      <VStack
        alignment="center"
        spacing={20}
        frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "center" }}
        padding={32}
      >
        <BrandBadge />
        <BrandTitle />
        <VStack spacing={12} alignment="center" padding={{ top: 8 }}>
          <ProgressView progressViewStyle="circular" tint={TG.blue} />
          {props?.text ? (
            <Text font={15} foregroundStyle={TG.sub}>
              {props.text}
            </Text>
          ) : null}
        </VStack>
      </VStack>
    </ZStack>
  )
}

/** Telegram 风实心主按钮：全宽 + 12pt 圆角（原生 Button 不吃 frame 宽度，自绘最稳） */
function TgButton(props: { title: string; action: () => void }) {
  const height = 50
  return (
    <ZStack
      alignment="center"
      frame={{ maxWidth: "infinity", height }}
      onTapGesture={props.action}
    >
      <RoundedRectangle fill={TG.blue} cornerRadius={12} frame={{ maxWidth: "infinity", height }} />
      <Text font={17} fontWeight="semibold" foregroundStyle="white">
        {props.title}
      </Text>
    </ZStack>
  )
}

/** Telegram-iOS 输入框：浅灰圆角底 + 20pt 输入字（原生输入控件否则白底上像隐形） */
function TgField(props: { children: any }) {
  const height = 52
  return (
    <ZStack alignment="center" frame={{ maxWidth: "infinity", height }}>
      <RoundedRectangle fill="#F1F4F7" cornerRadius={12} frame={{ maxWidth: "infinity", height }} />
      {props.children}
    </ZStack>
  )
}

/** 次级操作：蓝色 17pt 文字链（AuthorizationUI 链接规范） */
function TgLink(props: { title: string; action: () => void }) {
  return (
    <Text
      font={17}
      foregroundStyle={TG.blue}
      padding={{ vertical: 8 }}
      onTapGesture={props.action}
    >
      {props.title}
    </Text>
  )
}

export function LoginScreen(props: {
  busy: string | null
  error: string | null
  phone: string
  setPhone: (v: string) => void
  code: string
  setCode: (v: string) => void
  password: string
  setPassword: (v: string) => void
  codeSent: boolean
  needPassword: boolean
  /**
   * API 凭证分步（公共凭证已删除，登录必须用自己的 api_id/api_hash）：
   *   "id"  → 只显示 API ID 一行
   *   "hash" → 只显示 API Hash 一行
   *   null  → 正常手机号登录流程
   * 每步只出一个输入框，且每步都有返回入口。
   */
  apiPhase: "id" | "hash" | null
  apiId: string
  setApiId: (v: string) => void
  apiHash: string
  setApiHash: (v: string) => void
  /** API ID 那步点「下一步」（前端校验纯数字） */
  nextFromApiId: () => void
  /** API Hash 那步点「保存并继续」（落盘并进入手机号步骤） */
  submitApi: () => void
  /** API Hash 那步返回 API ID */
  backToApiId: () => void
  /** 手机号那步返回改凭证 */
  backToApi: () => void
  /** 凭证本来就已经配置好（只是点进来修改）→ 可直接跳回手机号步骤 */
  canSkipToPhone: boolean
  skipToPhone: () => void
  sendCode: () => void
  doSignIn: () => void
  doPassword: () => void
  restart: () => void
  dismiss: () => void
  /** 正在“添加账号”（多账号）：顶部出「取消」回滚到原账号，而非关闭脚本 */
  adding?: boolean
  onCancelAdd?: () => void
}) {
  const step =
    props.apiPhase === "id"
      ? "apiId"
      : props.apiPhase === "hash"
        ? "apiHash"
        : !props.codeSent
          ? "phone"
          : !props.needPassword
            ? "code"
            : "password"

  const stepHint =
    step === "apiId"
      ? "先填写 API ID（my.telegram.org 创建应用获取）"
      : step === "apiHash"
        ? "再填写对应的 API Hash（32 位）"
        : step === "phone"
          ? props.adding
            ? "输入新账号手机号，登录后可随时切换"
            : "输入手机号，获取登录验证码"
          : step === "code"
            ? "验证码已发送，查收后输入即可登录"
            : "该账号开启了两步验证"

  /** Telegram 风主按钮 */
  const primary = (title: string, action: () => void) => <TgButton title={title} action={action} />

  /** 次级操作：纯文字蓝链 */
  const link = (title: string, action: () => void) => <TgLink title={title} action={action} />

  return (
    <ZStack
      alignment="center"
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      ignoresSafeArea={true}
      preferredColorScheme="light"
      toolbar={{
        cancellationAction: props.adding ? (
          <Button title="取消" action={props.onCancelAdd ?? props.dismiss} />
        ) : (
          <Button title="关闭" action={props.dismiss} />
        ),
      }}
    >
      <TgFluidBackground />

      {props.busy ? (
        <VStack
          alignment="center"
          spacing={20}
          frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "center" }}
          padding={32}
        >
          <BrandBadge />
          <BrandTitle />
          <VStack spacing={12} alignment="center" padding={{ top: 8 }}>
            <ProgressView progressViewStyle="circular" tint={TG.blue} />
            <Text font={15} foregroundStyle={TG.sub}>
              {props.busy}
            </Text>
          </VStack>
        </VStack>
      ) : (
        <VStack
          alignment="center"
          spacing={0}
          frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "center" }}
          padding={{ top: 24, bottom: 24, leading: 28, trailing: 28 }}
        >
          <BrandBadge />

          {/* 标题 → 说明：18pt（AuthorizationUI 间距规范） */}
          <VStack alignment="center" spacing={18} padding={{ top: 20 }}>
            <Text font={28} fontWeight="semibold" foregroundStyle={TG.text}>
              {BRAND}
            </Text>
            <Text font={17} foregroundStyle={TG.sub} multilineTextAlignment="center">
              {stepHint}
            </Text>
          </VStack>

          {/* 说明 → 输入框：30pt；输入字 20pt、错误 13pt destructive */}
          <VStack
            alignment="center"
            spacing={14}
            frame={{ maxWidth: 340 }}
            padding={{ top: 30 }}
          >
            {step === "apiId" ? (
              <>
                <TgField>
                  <TextField
                    title="API ID（纯数字）"
                    value={props.apiId}
                    onChanged={props.setApiId}
                    font={20}
                    keyboardType="numberPad"
                    frame={{ maxWidth: "infinity" }}
                    padding={{ leading: 16, trailing: 16 }}
                  />
                </TgField>
                {primary("下一步", props.nextFromApiId)}
                {props.canSkipToPhone ? link("直接使用已保存的凭证", props.skipToPhone) : null}
              </>
            ) : step === "apiHash" ? (
              <>
                <TgField>
                  <TextField
                    title="API Hash（32 位）"
                    value={props.apiHash}
                    onChanged={props.setApiHash}
                    font={20}
                    keyboardType="asciiCapable"
                    frame={{ maxWidth: "infinity" }}
                    padding={{ leading: 16, trailing: 16 }}
                  />
                </TgField>
                {primary("保存并继续", props.submitApi)}
                {link("返回上一步", props.backToApiId)}
                {props.canSkipToPhone ? link("直接使用已保存的凭证", props.skipToPhone) : null}
              </>
            ) : step === "phone" ? (
              <>
                <TgField>
                  <TextField
                    title="+86 13800138000"
                    value={props.phone}
                    onChanged={props.setPhone}
                    font={20}
                    frame={{ maxWidth: "infinity" }}
                    padding={{ leading: 16, trailing: 16 }}
                  />
                </TgField>
                {primary("获取验证码", props.sendCode)}
                {link("修改 API 凭证", props.backToApi)}
              </>
            ) : step === "code" ? (
              <>
                <TgField>
                  <TextField
                    title="6 位验证码"
                    value={props.code}
                    onChanged={props.setCode}
                    font={20}
                    frame={{ maxWidth: "infinity" }}
                    padding={{ leading: 16, trailing: 16 }}
                  />
                </TgField>
                {primary("登录", props.doSignIn)}
                {link("更换手机号", props.restart)}
              </>
            ) : (
              <>
                <TgField>
                  <SecureField
                    title="两步验证密码"
                    value={props.password}
                    onChanged={props.setPassword}
                    font={20}
                    frame={{ maxWidth: "infinity" }}
                    padding={{ leading: 16, trailing: 16 }}
                  />
                </TgField>
                {primary("确认登录", props.doPassword)}
                {link("返回上一步", props.restart)}
              </>
            )}

            {props.error ? (
              <Text
                font={13}
                foregroundStyle={TG.error}
                multilineTextAlignment="center"
                frame={{ maxWidth: 340 }}
              >
                {props.error}
              </Text>
            ) : null}
          </VStack>
        </VStack>
      )}
    </ZStack>
  )
}
