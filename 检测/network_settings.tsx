import { Button, Image, SecureField, TextField, VStack, useRef, useState } from "scripting"
import { ACCENT, Band, Note, Row, animate } from "./theme"
import { getNetworkSettings, getSurgeKey, networkSettingsError, saveNetworkSettings, setSurgeKey } from "./utils/network_settings"
import type { NetworkSettings } from "./utils/network_settings"

type Draft = { refreshMinutes: string; snapshotURL: string; surgeHost: string; surgePort: string }
const draftOf = (settings: NetworkSettings): Draft => ({ ...settings,
  refreshMinutes: String(settings.refreshMinutes), surgePort: String(settings.surgePort) })
const sameDraft = (a: Draft, b: Draft): boolean => a.refreshMinutes === b.refreshMinutes
  && a.snapshotURL === b.snapshotURL && a.surgeHost === b.surgeHost && a.surgePort === b.surgePort

/** 放在页面诊断区后方；折叠状态和输入草稿均由组件自己管理。 */
export function NetworkSettingsPanel({ onSaved }: { onSaved: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState(() => draftOf(getNetworkSettings()))
  // 只在 UI 初始化时读取本机密钥，交给 SecureField 掩码；不传出或记录输入。
  const [keyInput, setKeyInput] = useState(() => getSurgeKey())
  const [message, setMessage] = useState("")
  // 同步更新引用，避免 onChanged 后紧接提交，以及回车后失焦读到旧状态。
  const edits = useRef({ draft, keyInput, savedDraft: draft, savedKey: keyInput })

  function change(field: keyof Draft, input: string) {
    const next = { ...edits.current.draft, [field]: input }
    edits.current.draft = next
    setDraft(next)
    setMessage("")
  }

  function save(target: "settings" | "key" | "all" = "settings"): boolean {
    const current = edits.current
    const settingsChanged = target !== "key" && !sameDraft(current.draft, current.savedDraft)
    const keyChanged = target !== "settings" && current.keyInput !== current.savedKey
    if (!settingsChanged && !keyChanged) return true
    const errors: string[] = []
    let changed = false
    if (settingsChanged) {
      const input = current.draft
      const settings: NetworkSettings = {
        refreshMinutes: /^\d+$/.test(input.refreshMinutes.trim()) ? Number(input.refreshMinutes) : NaN,
        snapshotURL: input.snapshotURL.trim(), surgeHost: input.surgeHost.trim() || "127.0.0.1",
        surgePort: /^\d+$/.test(input.surgePort.trim()) ? Number(input.surgePort) : NaN,
      }
      const error = networkSettingsError(settings)
      if (error) errors.push(error)
      else {
        const unchanged = sameDraft(draftOf(settings), current.savedDraft)
        const saved = unchanged ? settings : saveNetworkSettings(settings)
        if (!saved) errors.push("设置未能保存，请重试。")
        else {
          current.draft = current.savedDraft = draftOf(saved)
          setDraft(current.draft)
          changed = !unchanged
        }
      }
    }
    if (keyChanged) {
      const key = current.keyInput.trim()
      if (current.keyInput && !key) errors.push("密钥不能仅含空白。")
      else if (key !== current.savedKey && !setSurgeKey(key || null)) {
        errors.push(key ? "密钥未能保存，请检查输入后重试。" : "密钥未能清除，请重试。")
      } else {
        changed = changed || key !== current.savedKey
        // 提交后保留掩码内容，不能清空输入而误删刚保存的密钥。
        current.keyInput = current.savedKey = key
        setKeyInput(key)
      }
    }
    // 在通知前记录保存值；随后的失焦或折叠不会重复写入、刷新。
    if (changed) {
      try { onSaved() }
      catch { errors.push("设置已保存；页面更新失败，请手动刷新。") }
    }
    setMessage(errors.join("\n"))
    return errors.length === 0
  }

  function changeKey(input: string) {
    if (input === edits.current.keyInput) return
    edits.current.keyInput = input
    setKeyInput(input)
    setMessage("")
    if (input === "") save("key")
  }

  function toggle() {
    if (expanded && !save("all")) return
    animate(() => setExpanded(current => !current))
  }

  return <Band title="网络诊断设置" icon="slider.horizontal.3" hint="可选" shaded
    accessory={<Button action={toggle} buttonStyle="plain" accessibilityLabel={expanded ? "收起网络诊断设置" : "展开网络诊断设置"}>
      <Image systemName={expanded ? "chevron.up" : "chevron.down"} font={13} foregroundStyle={ACCENT.blue}
        frame={{ width: 34, height: 34 }} />
    </Button>}>
    {expanded ? <VStack alignment="leading" spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      <Row label="有效期"><TextField title="缓存有效期（分钟）" value={draft.refreshMinutes}
        onChanged={input => change("refreshMinutes", input)} onBlur={() => save()}
        prompt="15" font={13} keyboardType="numberPad" /></Row>
      <Note text="默认 15 分钟，可设置 5–240 分钟。小组件按此周期申请重绘并标记过期；点击小组件打开脚本重新检测，实际调度由 iOS 决定。" />
      <Row label="快照 URL"><TextField title="快照 URL" value={draft.snapshotURL}
        onChanged={input => change("snapshotURL", input)} onSubmit={() => save()} onBlur={() => save()}
        prompt="可选 HTTP(S) 地址" font={13}
        keyboardType="URL" textInputAutocapitalization="never" autocorrectionDisabled /></Row>
      <Row label="Surge 地址"><TextField title="Surge 地址" value={draft.surgeHost}
        onChanged={input => change("surgeHost", input)} onSubmit={() => save()} onBlur={() => save()}
        prompt="127.0.0.1" font={13}
        keyboardType="asciiCapable" textInputAutocapitalization="never" autocorrectionDisabled /></Row>
      <Row label="Surge 端口"><TextField title="Surge 端口" value={draft.surgePort}
        onChanged={input => change("surgePort", input)} onBlur={() => save()}
        prompt="6171" font={13} keyboardType="numberPad" /></Row>
      <Row label="Surge 密钥"><SecureField title="Surge API 密钥" value={keyInput}
        onChanged={changeKey} onSubmit={() => save("key")} onBlur={() => save("key")}
        prompt="可选 Surge API 密钥" font={13} textInputAutocapitalization="never" autocorrectionDisabled /></Row>
      <Note text="快照和 Surge API 均为可选；填写快照 URL 后读取快照，配置密钥后读取 Surge API。密钥仅存于本机 Keychain。" />
      {message ? <Note text={message} /> : null}
    </VStack> : <Note text="可配置结果有效期、Surge 快照与 API；未配置时使用本机诊断。" />}
  </Band>
}
