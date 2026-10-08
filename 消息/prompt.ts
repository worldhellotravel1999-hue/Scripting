/**
 * 输入弹窗记忆（全项目统一）：
 * 每个输入位一个 key，确认后把这次输入写入 Storage，下次打开默认值即上次输入
 * （数字类输入如「撤回条数 / 每会话最多条数」不再每次回默认值）。
 * 调用方可在得到结果后用 savePrompt 覆写为**归一化后的值**（钳制/去空格）。
 */
const PREFIX = "tgclient.prompt."

/** 读取某个输入位上次确认的值（无记忆返回 null） */
export function loadPrompt(key: string): string | null {
  try {
    const v = Storage.get<unknown>(PREFIX + key)
    if (typeof v === "string" && v.trim() !== "") return v.trim()
  } catch {}
  return null
}

/**记住某个输入位的值（空串 = 清空记忆，下次回退到调用方默认值） */
export function savePrompt(key: string, value: string): void {
  try {
    Storage.set(PREFIX + key, String(value ?? "").trim())
  } catch {}
}

export type PromptOptions = {
  title: string
  message?: string
  placeholder?: string
  keyboardType?: "numberPad" | "default"
  confirmLabel?: string
  /** 没有记忆时的兜底默认值 */
  defaultValue?: string
}

/**
 * Dialog.prompt 的记忆版：默认值 = 上次输入 ?? 调用方给的默认值；
 * 确认非空即写入记忆（取消不写）。
 *
 * 两道防御（2026-10-07 审计）：
 *  · 重入保护：连点同一行会叠开两个弹窗（关闭时互相盖），这里全局单飞；
 *  · 取消判定用 `== null`（兼容宿主返回 undefined）并统一 String()，
 *    否则 undefined 会清掉记忆并把 undefined 透传给调用方（v.trim() 直接炸）。
 */
let opening = false

export async function promptInput(
  key: string,
  opts: PromptOptions,
): Promise<string | null> {
  if (opening) return null
  opening = true
  try {
    const remembered = loadPrompt(key)
    const v = await Dialog.prompt({
      ...opts,
      defaultValue: remembered ?? opts.defaultValue ?? "",
    })
    if (v == null) return null
    const s = String(v)
    savePrompt(key, s)
    return s
  } finally {
    opening = false
  }
}
