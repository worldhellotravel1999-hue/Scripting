import { Script } from "scripting"

/**
 * TG Hub 面板的数据访问层。
 * 通过 Scripting 的 Python.run 在进程内调用 tg-hub 的 JSON 助手（tg_api.py）。
 */

const dir = Script.directory.endsWith("/") ? Script.directory.slice(0, -1) : Script.directory

/** Python 引擎目录（随脚本一起打包的 tg-hub/） */
export const TG_ROOT = `${dir}/tg-hub`

const SENTINEL = "@@TG@@"

export type TgResult = {
  ok: boolean
  error?: string
  etype?: string
  raw?: string
  trace?: string
  [key: string]: any
}

/**
 * 调用一个 tg-hub 命令。永远返回 JSON 对象（不会抛异常）。
 * @param cmd    命令名，见 tg_api.ALL_COMMANDS
 * @param args   JSON 参数
 * @param timeout 超时秒数——Python.run 不支持超时（官方文档），这里透传给
 *                Python 侧 __timeout，由 tg_api 的守护线程 join 兜底。
 */
export async function tg(
  cmd: string,
  args: Record<string, any> = {},
  timeout = 120
): Promise<TgResult> {
  const code = [
    "import sys, importlib, os",
    `root = os.path.realpath(${JSON.stringify(TG_ROOT)})`,
    `raw_root = ${JSON.stringify(TG_ROOT)}`,
    // 常驻解释器：每次把本副本路径固定到 sys.path 最前（防止另一副本抢先）；
    // realpath 归一化，/var 与 /private/var 视为同一路径
    "for _p in (root, raw_root):",
    "    while _p in sys.path:",
    "        sys.path.remove(_p)",
    "sys.path.insert(0, root)",
    // 清掉来自其他副本的模块：双面板共存时 sys.modules 只认首次导入路径，
    // 不清会表现为“改了代码不生效/跑旧逻辑”。（三方库如 telethon 不动）
    "for _n in ('tg_api', 'scripts', 'scripts.config', 'scripts.db', 'scripts.exceptions', 'scripts.client'):",
    "    _m = sys.modules.get(_n)",
    "    if _m is not None and not os.path.realpath(str(getattr(_m, '__file__', '') or '')).startswith(root):",
    "        del sys.modules[_n]",
    // 重载自有模块：子模块在前、父包在后（父包 __init__ 从子模块拿新对象）；
    // 失败打到 stderr（会进返回的 output），不再静默吞掉。
    "for _n in ('scripts.config', 'scripts.db', 'scripts.exceptions', 'scripts.client', 'scripts', 'tg_api'):",
    "    _m = sys.modules.get(_n)",
    "    if _m is not None:",
    "        try:",
    "            importlib.reload(_m)",
    "        except Exception as _e:",
    "            print('tg-hub reload failed:', _n, repr(_e), file=sys.stderr)",
    "import tg_api",
    `tg_api.dispatch(${JSON.stringify(cmd)}, ${JSON.stringify(
      JSON.stringify({ ...args, __timeout: timeout })
    )})`,
  ].join("\n")

  try {
    const r = await Python.run(code)
    const lines = (r.output || "").split("\n")
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (line.startsWith(SENTINEL)) {
        try {
          return JSON.parse(line.slice(SENTINEL.length)) as TgResult
        } catch {
          return { ok: false, error: "返回数据解析失败", etype: "ParseError", raw: line }
        }
      }
    }
    return {
      ok: false,
      error: `tg-hub 无响应（exit=${r.exitCode}）：${(r.output || "").slice(-200)}`,
      etype: "NoOutput",
    }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e), etype: "JSException" }
  }
}

// ── 格式化工具 ────────────────────────────────────────────────────────────────

const pad = (n: number) => (n < 10 ? `0${n}` : String(n))

/** ISO 时间 → 本地 "MM-dd HH:mm" */
export function fmtTime(iso?: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (isNaN(d.getTime())) return String(iso).slice(5, 16)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 数字千分位 */
export function fmtNum(n?: number | null): string {
  if (n === null || n === undefined) return "0"
  return Number(n).toLocaleString("en-US")
}

/** 消息行摘要（去掉换行，截断） */
export function brief(text?: string | null, max = 120): string {
  const s = (text || "").replace(/\s+/g, " ").trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

export const TYPE_LABEL: Record<string, string> = {
  user: "私聊",
  group: "群组",
  supergroup: "超级群",
  channel: "频道",
  unknown: "未知",
}
