import { Button, Menu, Text } from "scripting"
import { FontError, deleteFont, importFont, selectFont, useFontSettings } from "../core/fonts"
import type { FontRole } from "../core/fonts"

// Shared by both role menus; acquire before scheduling to prevent rapid double taps.
let actionPending = false

function scheduleAction(action: () => void | Promise<unknown>): void {
  if (actionPending) return
  actionPending = true
  setTimeout(() => {
    void (async () => {
      try {
        await action()
      } catch (error) {
        try {
          await Dialog.alert({
            title: "字体设置失败",
            message: error instanceof FontError ? error.message : "无法完成字体设置，请稍后重试。",
          })
        } catch {
          // Some background hosts cannot present alerts; still release the action lock.
          console.error("字体设置失败，当前宿主无法显示提示。")
        }
      } finally {
        actionPending = false
      }
    })()
  }, 200)
}

/** A genuine submenu: insert directly among a language Menu's children. */
export function FontMenu({ role }: { role: FontRole }) {
  const settings = useFontSettings()
  const selected = settings[role]
  return (
    <Menu label={<Text>{role === "source" ? "原文字体" : "译文字体"}</Text>}>
      {settings.fonts.map(font => (
        <Menu key={font.id} label={<Text>{font.name}</Text>}>
          <Button
            title={font.name}
            systemImage={selected?.id === font.id ? "checkmark" : undefined}
            action={() => scheduleAction(() => selectFont(role, font))}
          />
          <Button
            title="删除字体"
            systemImage="trash"
            role="destructive"
            action={() => scheduleAction(() => deleteFont(role, font))}
          />
        </Menu>
      ))}
      <Button
        title="文件导入"
        action={() => scheduleAction(() => importFont(role))}
      />
      <Button
        title="系统字体"
        systemImage={selected === null ? "checkmark" : undefined}
        action={() => scheduleAction(() => selectFont(role, null))}
      />
    </Menu>
  )
}

export function TypefaceMenu() {
  return (
    <Menu label={<Text font="body" foregroundStyle="secondaryLabel">Translate</Text>}>
      <FontMenu role="source" />
      <FontMenu role="target" />
    </Menu>
  )
}
