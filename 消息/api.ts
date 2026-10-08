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
 * 串行队列：tg 命令按提交顺序排队执行。
 *
 * 为什么需要——
 * 1. Python.run 本身不支持超时（官方文档），长命令（如全量同步）会让调用方
 *    永远 await 挂着，界面表现为「点了没反应」；
 * 2. Python.run 与 Shell.run 共享宿主串行队列，若前端并发堆命令，会越排越长，
 *    用户连点几下就攒一串过期操作。
 * 现在：排队等待和实际执行各设预算，超预算立即返回 BusyTimeout，
 * 界面能给出「命令仍在后台执行」的明确提示，而不是无声挂死。
 */
let tail: Promise<void> = Promise.resolve()

/** 带截止时间的 race：超时返回 null（计时器到点自动清理）。 */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      }
    )
  })
}

async function execute(cmd: string, args: Record<string, any>, timeout: number): Promise<TgResult> {
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
    "for _n in ('tg_api', 'tg_session', 'scripts', 'scripts.config', 'scripts.db', 'scripts.exceptions', 'scripts.client'):",
    "    _m = sys.modules.get(_n)",
    "    if _m is not None and not os.path.realpath(str(getattr(_m, '__file__', '') or '')).startswith(root):",
    "        del sys.modules[_n]",
    // 自有源码指纹（root + 文件 mtime_ns/size）：指纹没变就**跳过 reload**。
    // 旧行为每条命令都 reload 6 个模块，实测白花 ~10ms；现在只有真改了
    // tg-hub/*.py（开发期）指纹才变，才走下面的重载逻辑，行为不变。
    "_fps = [root]",
    "for _f in ('tg_api.py', 'tg_session.py', 'vendor_bootstrap.py', 'vendor/telethon/extensions/html.py'):",
    "    _p = os.path.join(root, _f)",
    "    try:",
    "        _s = os.stat(_p)",
    "        _fps.append((_f, _s.st_mtime_ns, _s.st_size))",
    "    except OSError:",
    "        _fps.append((_f, -1, -1))",
    "try:",
    "    for _f in sorted(os.listdir(os.path.join(root, 'scripts'))):",
    "        if not _f.endswith('.py'):",
    "            continue",
    "        _p = os.path.join(root, 'scripts', _f)",
    "        try:",
    "            _s = os.stat(_p)",
    "            _fps.append((_f, _s.st_mtime_ns, _s.st_size))",
    "        except OSError:",
    "            _fps.append((_f, -1, -1))",
    "except OSError:",
    "    pass",
    "_fp = tuple(_fps)",
    "if getattr(sys, '__tghub_fp__', None) != _fp:",
    // 重载自有模块：子模块在前、父包在后（父包 __init__ 从子模块拿新对象）。
    // **scripts.exceptions 必须排在 scripts.db 之前**：db 里 `from .exceptions
    // import ChatNotFoundError` 是绑类对象，exceptions 后重载会让 db 握着
    // 上一代的类，而 tg_api 的 `_guard_chat` except 拿的是新一代 —— 永远匹配
    // 不上，needs_sync 降级静默失效（表现为“本该自动同步的会话直接弹错误”）。
    // 失败打到 stderr（会进返回的 output），不再静默吞掉。
    "    for _n in ('scripts.config', 'scripts.exceptions', 'scripts.db', 'scripts.client', 'scripts', 'tg_session', 'tg_api'):",
    "        _m = sys.modules.get(_n)",
    "        if _m is not None:",
    "            try:",
    "                importlib.reload(_m)",
    "            except Exception as _e:",
    "                print('tg-hub reload failed:', _n, repr(_e), file=sys.stderr)",
    "    sys.__tghub_fp__ = _fp",
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

/**
 * 调用一个 tg-hub 命令。永远返回 JSON 对象（不会抛异常）。
 * @param cmd     命令名，见 tg_api.ALL_COMMANDS
 * @param args    JSON 参数
 * @param timeout 命令自身超时秒数——透传给 Python 侧 __timeout，由 tg_api 的
 *                守护线程 join 兜底；JS 侧另有看门狗（timeout + 30s 预算），
 *                超预算返回 etype=BusyTimeout，避免永久挂起。
 */
export async function tg(
  cmd: string,
  args: Record<string, any> = {},
  timeout = 120
): Promise<TgResult> {
  const budgetMs = (timeout + 30) * 1000
  const prev = tail
  let release!: () => void
  tail = new Promise<void>((r) => {
    release = r
  })

  // ① 排队等待前序命令（同样受预算约束——前序卡死时快速让路，不无限堆积）
  const gotTurn = await withDeadline(prev, budgetMs)
  if (gotTurn === null) {
    release()
    return {
      ok: false,
      etype: "BusyTimeout",
      error: `前一条命令仍在执行，已跳过 ${cmd}（请稍后重试）`,
    }
  }

  // ② 实际执行 + 看门狗
  const runner = execute(cmd, args, timeout)
  const done = await withDeadline(runner, budgetMs)
  if (done !== null) {
    release()
    return done
  }
  // 看门狗触发：命令仍在后台跑，等它真正结束再放行下一条（保持顺序不串扰）
  runner.then(
    () => release(),
    () => release()
  )
  return {
    ok: false,
    etype: "BusyTimeout",
    error: `命令 ${cmd} 超过 ${Math.round(budgetMs / 1000)}s 未返回，可能仍在后台执行，请稍后再试`,
  }
}

// ── 格式化工具 ────────────────────────────────────────────────────────────────

const pad = (n: number) => (n < 10 ? `0${n}` : String(n))

/**
 * 后端时间串 → Date：**无时区偏移的裸 ISO 按 UTC 解释**（补 'Z'）。
 * 后端返回 Telethon 的 naive UTC ISO（无后缀），裸 `new Date(iso)` 会把它
 * 当本地时间解析（整体偏 8 小时）。chats.tsx.chatTime 早有同样防护，这里
 * 收敛成公共实现，ai.ts.localStamp 同用，三处口径一致。
 */
export function parseBackendDate(iso: string): Date {
  const s = /[zZ]$|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`
  return new Date(s)
}

/** ISO 时间 → 本地 "MM-dd HH:mm" */
export function fmtTime(iso?: string | null): string {
  if (!iso) return "—"
  const d = parseBackendDate(String(iso))
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
