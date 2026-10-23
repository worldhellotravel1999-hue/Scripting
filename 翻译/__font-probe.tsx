import { Script } from "scripting"

try {
  const value = (globalThis as any).Storage?.get("lingo_translation_font_settings_v1", { shared: true })
  console.log("APP_GROUP=" + FileManager.appGroupDocumentsDirectory)
  console.log("SETTINGS=" + JSON.stringify(value))
} catch (error) {
  console.log("ERROR=" + String(error))
}
Script.exit()
