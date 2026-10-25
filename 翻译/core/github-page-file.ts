/**
 * GitHub Release 页面落盘。
 *
 * WebView 的 loadHTML 在分享扩展/预览宿主里并不可靠（实测一直停在
 * loading），而 FontText 已经验证过 loadFile 在 App Group 目录里稳定。
 * 这里把构建好的整页写成 App Group 下的 HTML，再用 loadFile 打开；
 * 页面里的链接/图片都已转成绝对地址，所以文件来源不会影响资源加载。
 */
const DIRECTORY = `${FileManager.appGroupDocumentsDirectory}/lingo-github-pages`
const MAX_FILES = 12
const KEEP_MS = 7 * 24 * 60 * 60 * 1000
let swept = false

function sweep() {
  try {
    if (!FileManager.isDirectorySync(DIRECTORY)) return
    const files: Array<{ path: string; modified: number }> = []
    for (const name of FileManager.readDirectorySync(DIRECTORY)) {
      if (!/^github-[0-9a-z]+\.html$/i.test(name)) continue
      const path = `${DIRECTORY}/${name}`
      try {
        files.push({ path, modified: FileManager.statSync(path).modificationDate })
      } catch {}
    }
    files.sort((a, b) => b.modified - a.modified)
    files.forEach((file, index) => {
      if (index < MAX_FILES && Date.now() - file.modified < KEEP_MS) return
      try { FileManager.removeSync(file.path) } catch {}
    })
  } catch {}
}

/** 返回可供 WebViewController.loadFile 使用的绝对路径；失败时返回空串。 */
export function githubPageFile(html: string, hash: string) {
  try {
    if (!swept) {
      swept = true
      sweep()
    }
    if (!FileManager.isDirectorySync(DIRECTORY)) {
      FileManager.createDirectorySync(DIRECTORY, true)
    }
    const path = `${DIRECTORY}/github-${String(hash || "page").replace(/[^0-9a-z]/gi, "")}.html`
    FileManager.writeAsStringSync(path, html)
    return path
  } catch {
    return ""
  }
}

export function githubPageDirectory() {
  return DIRECTORY
}
