import { Intent, Navigation, Script } from "scripting"
import { parseAppStoreURL } from "./core/appstore"
import { AppStoreView } from "./views/app-store"

function inputCandidates() {
  const values: string[] = []
  for (const value of Intent.urlsParameter || []) values.push(String(value || "").trim())
  for (const value of Intent.textsParameter || []) values.push(String(value || "").trim())

  const shortcut = Intent.shortcutParameter
  if (shortcut?.type === "text" || shortcut?.type === "fileURL") {
    values.push(String(shortcut.value || "").trim())
  }
  return values.filter(Boolean)
}

function firstAppStoreURL() {
  for (const value of inputCandidates()) {
    const identity = parseAppStoreURL(value)
    if (identity) return identity.url
  }
  return ""
}

async function run() {
  const url = firstAppStoreURL()
  if (!url) {
    await Dialog.alert({
      title: "无法打开应用",
      message: "请从 App Store 分享有效的应用链接。",
    })
    Script.exit()
    return
  }

  await Navigation.present({ element: <AppStoreView url={url} /> })
  Script.exit()
}

void run().catch(async (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason)
  try {
    await Dialog.alert({ title: Script.name, message })
  } finally {
    Script.exit()
  }
})
