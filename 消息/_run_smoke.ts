// 临时：跑 tg-hub/__panel_smoke.py（shell 无 iCloud 权限，经 Python.run 执行）
import { Script } from "scripting"

async function main() {
  const dir = Script.directory.endsWith("/")
    ? Script.directory.slice(0, -1)
    : Script.directory
  const root = `${dir}/tg-hub`
  const code = [
    "import sys, os, runpy",
    `root = ${JSON.stringify(root)}`,
    "for _p in (root, os.path.join(root, 'vendor')):",
    "    while _p in sys.path:",
    "        sys.path.remove(_p)",
    "sys.path.insert(0, root)",
    "sys.argv = ['__panel_smoke.py']",
    "try:",
    "    runpy.run_path(os.path.join(root, '__panel_smoke.py'), run_name='__main__')",
    "except SystemExit as _e:",
    "    print('EXIT', _e.code)",
  ].join("\n")
  try {
    const r = await Python.run(code)
    console.log(r.output || "(no output)")
    console.log("exitCode =", r.exitCode)
  } catch (e: any) {
    console.log("runner failed:", String(e?.message ?? e))
  }
  Script.exit()
}

main()
