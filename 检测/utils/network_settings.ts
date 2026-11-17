import { canonicalAddress } from "./ip"

export interface NetworkSettings {
  refreshMinutes: number
  snapshotURL: string
  surgeHost: string
  surgePort: number
}

const DEFAULT_NETWORK_SETTINGS: Readonly<NetworkSettings> = Object.freeze({
  refreshMinutes: 15, snapshotURL: "", surgeHost: "127.0.0.1", surgePort: 6171,
})

// 仅使用本脚本的新键；不读取或迁移 radar_*、旧脚本设置或明文密钥。
const SETTINGS_KEY = "report-ip.network.settings.v1"
const SURGE_KEY = "report-ip.network.surge-key.v1"
const text = (value: unknown): string => typeof value === "string" ? value.trim() : ""

export function normalizeNetworkSettings(value: unknown): NetworkSettings {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
  return {
    refreshMinutes: typeof raw.refreshMinutes === "number" && Number.isFinite(raw.refreshMinutes)
      ? Math.max(5, Math.min(240, Math.floor(raw.refreshMinutes))) : 15,
    snapshotURL: text(raw.snapshotURL),
    surgeHost: text(raw.surgeHost) || "127.0.0.1",
    surgePort: typeof raw.surgePort === "number" && Number.isInteger(raw.surgePort)
      && raw.surgePort >= 1 && raw.surgePort <= 65535 ? raw.surgePort : 6171,
  }
}

/** 仅接受 HTTP(S)；凭据不允许写在 URL 的 userinfo 中。 */
export function isNetworkSnapshotURL(value: string): boolean {
  if (!value || value.length > 8192 || /[\s\u0000-\u001f\u007f]/.test(value)) return false
  try {
    const url = new URL(value)
    return (url.protocol === "https:" || url.protocol === "http:")
      && !!url.hostname && !url.username && !url.password && !url.hash
  } catch { return false }
}

/** 地址不含协议、端口、路径或凭据；支持 DNS、IPv4 以及带/不带方括号的 IPv6。 */
export function isSurgeHost(value: string): boolean {
  if (!value || value.length > 253 || /[\s/@?#\\]/.test(value)) return false
  const host = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value
  if (canonicalAddress(host)) return true
  if (/[\[\]:]/.test(value) || /^[\d.]+$/.test(value)) return false
  return value.split(".").every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))
}

/** 返回可直接显示的固定文案，不回显地址或任何输入。 */
export function networkSettingsError(settings: NetworkSettings): string {
  if (!Number.isInteger(settings.refreshMinutes) || settings.refreshMinutes < 5 || settings.refreshMinutes > 240) {
    return "刷新间隔须为 5–240 分钟的整数。"
  }
  if (settings.snapshotURL && !isNetworkSnapshotURL(settings.snapshotURL)) {
    return "快照地址须为有效的 HTTP(S) URL，不含空白、用户名、密码或片段。"
  }
  if (!isSurgeHost(settings.surgeHost)) return "Surge 地址须为主机名或 IP；端口请单独填写。"
  if (!Number.isInteger(settings.surgePort) || settings.surgePort < 1 || settings.surgePort > 65535) {
    return "Surge 端口须为 1–65535 的整数。"
  }
  return ""
}

export function getNetworkSettings(): NetworkSettings {
  try {
    const raw = Storage.get<unknown>(SETTINGS_KEY)
    return normalizeNetworkSettings(typeof raw === "string" ? JSON.parse(raw) : raw)
  } catch { return { ...DEFAULT_NETWORK_SETTINGS } }
}

/** 成功返回实际保存值；验证或存储失败返回 null。额外字段不会进入 Storage。 */
export function saveNetworkSettings(patch: Partial<NetworkSettings>): NetworkSettings | null {
  try {
    const next = normalizeNetworkSettings({ ...getNetworkSettings(), ...patch })
    if (networkSettingsError(next)) return null
    return Storage.set(SETTINGS_KEY, next) ? next : null
  } catch { return null }
}

export function getSurgeKey(): string {
  try { return Keychain.get(SURGE_KEY, { synchronizable: false })?.trim() || "" }
  catch { return "" }
}

/** null 表示显式清除；空输入保留原值。密钥只写入本设备、本脚本的 Keychain。 */
export function setSurgeKey(value: string | null): boolean {
  try {
    if (value === null) return Keychain.remove(SURGE_KEY, { synchronizable: false })
    const key = value.trim()
    if (!key) return true
    if (key.length > 4096 || /[\u0000-\u001f\u007f]/.test(key)) return false
    return Keychain.set(SURGE_KEY, key, {
      synchronizable: false, accessibility: "first_unlock_this_device",
    })
  } catch { return false }
}
