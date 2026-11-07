// 临时：验证排行/概览按会话过滤的本地数据链路（timeline/top_senders 传 chat）
import { Script } from "scripting"

async function main() {
  const dir = Script.directory.endsWith("/") ? Script.directory.slice(0, -1) : Script.directory
  const root = `${dir}/tg-hub`
  const code = [
    "import sys, os, json",
    `root = ${JSON.stringify(root)}`,
    "for _p in (root, os.path.join(root, 'vendor')):",
    "    while _p in sys.path:",
    "        sys.path.remove(_p)",
    "sys.path.insert(0, root)",
    "from scripts.client import TGClient",
    "from scripts.exceptions import ChatNotFoundError",
    "c = TGClient()",
    "chats = sorted(c.local_chats(), key=lambda x: -x['msg_count'])",
    "print('local chats:', len(chats))",
    "if not chats:",
    "    print('NO LOCAL CHATS')",
    "else:",
    "    name = chats[0]['chat_name']",
    "    rows = c.timeline(chat=name, hours=168, granularity='hour')",
    "    grows = c.timeline(hours=168, granularity='hour')",
    "    tot = sum(r['msg_count'] for r in rows)",
    "    gtot = sum(r['msg_count'] for r in grows)",
    "    print(json.dumps({'chat': name, 'scoped_7d': tot, 'global_7d': gtot, 'scoped_rows': len(rows), 'global_rows': len(grows)}, ensure_ascii=False))",
    "    ts = c.top_senders(chat=name, hours=24, limit=30)",
    "    gts = c.top_senders(hours=24, limit=30)",
    "    print(json.dumps({'rank_scoped_24h': len(ts), 'rank_global_24h': len(gts), 'top_scoped': (ts[0]['sender_name'], ts[0]['msg_count']) if ts else None}, ensure_ascii=False))",
    "    try:",
    "        c.timeline(chat='__definitely_missing__', hours=24, granularity='hour')",
    "        print('MISSING: no exception (BAD)')",
    "    except ChatNotFoundError:",
    "        print('MISSING -> ChatNotFoundError (needs_sync path ok)')",
  ].join("\n")
  try {
    const r = await Python.run(code)
    console.log(r.output || "(no output)")
    console.log("exitCode =", r.exitCode)
  } catch (e: any) {
    console.log("failed:", String(e?.message ?? e))
  }
  Script.exit()
}

main()
