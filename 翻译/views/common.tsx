import {
  Button,
  HStack,
  Image,
  Menu,
  RoundedRectangle,
  Spacer,
  Text,
  VStack,
} from "scripting"
import { AUTO_LANGUAGE, LANGUAGE_OPTIONS } from "../core/constants"
import type { LanguageOption } from "../core/types"

/** 语言特例表：显示名与短名的覆盖值（其余走 LANGUAGE_OPTIONS 查表）。 */
const DISPLAY_LABEL_OVERRIDES: Record<string, string> = {
  en: "英语（美国）",
  "zh-Hans": "中文（普通话，简体）",
  "zh-Hant": "中文（繁体）",
}
const SHORT_LABEL_OVERRIDES: Record<string, string> = {
  en: "英语",
  "zh-Hans": "中文（简体）",
  "zh-Hant": "中文（繁体）",
}

export function languageDisplayLabel(code: string) {
  if (code === AUTO_LANGUAGE.code) return "自动检测"
  const override = DISPLAY_LABEL_OVERRIDES[code]
  if (override) return override
  const item = LANGUAGE_OPTIONS.find((option) => option.code === code)
  return item ? item.label : code
}

export function languageLabel(code: string) {
  if (code === AUTO_LANGUAGE.code) return "自动检测"
  const item = LANGUAGE_OPTIONS.find((option) => option.code === code)
  return item ? item.label : code
}

export function languageShortLabel(code: string) {
  if (code === AUTO_LANGUAGE.code) return "自动检测"
  const override = SHORT_LABEL_OVERRIDES[code]
  if (override) return override
  return languageLabel(code)
}

function LanguageOptionRow(props: {
  code: string
  label: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <Button key={props.code} buttonStyle="plain" action={props.onSelect}>
      <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
        {props.selected ? (
          <Image systemName="checkmark" foregroundStyle="accentColor" font="subheadline" />
        ) : null}
        <Text>{props.label}</Text>
      </HStack>
    </Button>
  )
}

export function LanguageMenu(props: {
  value: string
  options: LanguageOption[]
  onChanged: (value: string) => void
  prominent?: boolean
  alignment?: "leading" | "trailing"
}) {
  return (
    <Menu
      label={
        <Text
          foregroundStyle={props.prominent ? "label" : "accentColor"}
          font={props.prominent ? "title3" : "subheadline"}
          fontWeight={props.prominent ? "semibold" : undefined}
          lineLimit={1}
          truncationMode="tail"
          allowsTightening
          frame={{
            maxWidth: props.prominent ? 160 : 170,
            alignment: (props.alignment || "trailing") as any,
          }}
          multilineTextAlignment={props.alignment || "trailing"}
        >
          {props.prominent ? languageShortLabel(props.value) : languageLabel(props.value)}
        </Text>
      }
    >
      {props.options.map((option) => (
        <LanguageOptionRow
          key={option.code}
          code={option.code}
          label={languageDisplayLabel(option.code)}
          selected={option.code === props.value}
          onSelect={() => props.onChanged(option.code)}
        />
      ))}
    </Menu>
  )
}

/** 目标语言菜单口径：最多 3 个，空时回退简体中文。 */
function menuTargets(targetLanguages: string[]) {
  return targetLanguages.length ? targetLanguages.slice(0, 3) : ["zh-Hans"]
}

export function targetMenuSummary(targetLanguages: string[]) {
  const targets = menuTargets(targetLanguages)
  return targets.length === 1
    ? languageShortLabel(targets[0])
    : `${languageShortLabel(targets[0])} +${targets.length - 1}`
}

export function toggleTargetSelection(values: string[], code: string) {
  if (values.includes(code)) {
    return values.length > 1 ? values.filter((item) => item !== code) : values
  }
  if (values.length >= 3) return values
  return [...values, code]
}

export function TargetLanguageMenu(props: {
  targetLanguages: string[]
  onToggle: (code: string) => void
}) {
  const targets = menuTargets(props.targetLanguages)
  return (
    <Menu
      label={
        <Text
          foregroundStyle="label"
          font="title3"
          fontWeight="semibold"
          lineLimit={1}
          truncationMode="tail"
          allowsTightening
          frame={{ maxWidth: 160, alignment: "trailing" as any }}
          multilineTextAlignment="trailing"
        >
          {targetMenuSummary(props.targetLanguages)}
        </Text>
      }
    >
      {LANGUAGE_OPTIONS.map((option) => (
        <LanguageOptionRow
          key={option.code}
          code={option.code}
          label={languageDisplayLabel(option.code)}
          selected={targets.includes(option.code)}
          onSelect={() => props.onToggle(option.code)}
        />
      ))}
    </Menu>
  )
}

export function CopyButton(props: { title?: string; text: string }) {
  const value = String(props.text || "")
  return (
    <Button
      title={props.title ?? "复制"}
      systemImage="doc.on.doc"
      disabled={!value.trim()}
      action={async () => {
        if (!value.trim()) return
        await Pasteboard.setString(value)
        try { HapticFeedback.lightImpact() } catch {}
      }}
    />
  )
}

export function LanguageBar(props: {
  sourceLanguage: string
  targetLanguages: string[]
  onSourceChanged: (value: string) => void
  onToggleTarget: (code: string) => void
  /** 中间的交换按钮：互换原文语言与译文语言。 */
  onSwap?: () => void
}) {
  const sourceOptions = [AUTO_LANGUAGE, ...LANGUAGE_OPTIONS]

  return (
    <HStack
      spacing={0}
      padding={{ horizontal: 16, vertical: 10 }}
      frame={{ maxWidth: "infinity", alignment: "center" as any }}
      background={<RoundedRectangle fill={{ light: "#FFFFFF", dark: "#1C1C1E" }} cornerRadius={18} />}
      clipShape={{ type: "rect", cornerRadius: 18, style: "continuous" }}
    >
      <LanguageMenu
        value={props.sourceLanguage}
        options={sourceOptions}
        prominent
        alignment="leading"
        onChanged={props.onSourceChanged}
      />
      <Spacer />
      {props.onSwap ? (
        <Button action={props.onSwap} buttonStyle="plain">
          <Image
            systemName="arrow.left.arrow.right"
            font={16}
            foregroundStyle={{ light: "#000000", dark: "#FFFFFF" }}
            frame={{ width: 32, height: 32 }}
            background={{ style: { light: "rgba(142, 142, 147, 0.22)", dark: "rgba(142, 142, 147, 0.28)" }, shape: "circle" }}
          />
        </Button>
      ) : null}
      <Spacer />
      <TargetLanguageMenu
        targetLanguages={props.targetLanguages}
        onToggle={props.onToggleTarget}
      />
    </HStack>
  )
}

export function EmptyState(props: {
  symbol: string
  title: string
  message: string
}) {
  return (
    <VStack alignment="center" spacing={8} padding={{ vertical: 12 }}>
      <Image systemName={props.symbol} imageScale="large" foregroundStyle="secondaryLabel" />
      <Text fontWeight="semibold">{props.title}</Text>
      <Text foregroundStyle="secondaryLabel" multilineTextAlignment="center">
        {props.message}
      </Text>
    </VStack>
  )
}
