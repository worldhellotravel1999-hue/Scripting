"""面板后端冒烟（可复跑）：python3 tg-hub/__panel_smoke.py

逐条 dispatch 面板用到的命令，只用空/只读参数（不碰登录态与 API 凭证），
刷新用最轻参数（1 会话 / 1 条 / 无间隔）。断言：每条都返回 @@TG@@ 哨兵行。

关注点：
  · refresh 必须 ok=True（曾因 _sync_all 缺 capped_out 参数而全量报错）；
    但已登出时 refresh 报“尚未登录”属预期，此时降级为不计入（登出状态
    2026-10-06 起是合法态：公共凭证删除后每次都要重新登录）。
  · status 必须 ok=True 且 authorized=True（GetState+get_me 并行探测）
"""
import contextlib
import io
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.realpath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

# 常驻解释器：先扚掉旧模块，否则测的是上一版代码
for _n in ("tg_api", "scripts", "scripts.config", "scripts.db",
           "scripts.exceptions", "scripts.client"):
    sys.modules.pop(_n, None)

import tg_api  # noqa: E402

CASES = [
    ("stats", {}),
    ("local_chats", {}),
    ("timeline", {"hours": 168, "granularity": "day"}),
    ("top_senders", {"hours": 24, "limit": 5}),
    ("recent", {"hours": 24, "limit": 5}),
    ("today", {"limit": 5}),
    ("search", {"keyword": "e", "limit": 5}),
    ("filter", {"keywords": "e"}),
    ("delete_chat", {"chat": "__no_such_chat__"}),
    ("status", {}),
    ("send_code", {}),
    ("sign_in", {}),
    ("password", {}),
    ("send_message", {}),
    ("send_messages", {}),
    ("delete_messages", {}),
    ("leave_chat", {}),
    ("destroy_chat", {}),
    ("bulk_leave", {}),
    ("join_chat", {}),
    # 机器人签到：空参数必须在触网前报参数错（真正发 /start / 点按钮不进 smoke）
    ("bot_checkin_probe", {}),
    ("bot_checkin_act", {}),
    ("bot_checkin_read", {}),
    # 多账号：只加**纯只读/无副作用**的（有 pending 才写盘；begin/switch/remove 会改真实注册表，不进 smoke）
    ("account_add_cancel", {}),
    ("unknown_cmd", {}),
    ("refresh", {"limit_per_chat": 1, "max_chats": 1, "delay": 0}),
]

REQUIRED_OK = {"stats", "timeline", "top_senders", "recent", "today",
               "search", "filter", "status", "local_chats"}

failed = 0
# 是否已登录：决定 refresh 是否计入必过项（登出时它必然报“尚未登录”）
authorized = False
for cmd, args in CASES:
    a = dict(args)
    a["__timeout"] = 60
    buf = io.StringIO()
    t0 = time.time()
    with contextlib.redirect_stdout(buf):
        payload = tg_api.dispatch(cmd, json.dumps(a))
    ms = (time.time() - t0) * 1000
    ok = payload.get("ok")
    if cmd == "status":
        authorized = bool(payload.get("authorized"))
        # 多账号字段必须始终存在（前端账号页/菜单依赖）
        if "account_sid" not in payload or "accounts" not in payload or "adding" not in payload:
            print("   !! status 缺多账号字段")
            failed += 1
        if not authorized:
            print("   （未登录：refresh 的必过断言本次跳过）")
    required = cmd in REQUIRED_OK or (cmd == "refresh" and authorized)
    if required and not ok:
        failed += 1
    if not buf.getvalue().strip().splitlines()[-1].startswith("@@TG@@"):
        failed += 1
        print("   !! 没有哨兵输出")
    print("%-16s %6.0fms  ok=%-5s %s" % (
        cmd, ms, ok, (payload.get("error") or payload.get("etype") or "")[:80]))

print("\nFAILED:", failed)
sys.exit(1 if failed else 0)
