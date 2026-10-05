#!/usr/bin/env python3
"""验证新登录检测 + 常驻单连接（结束后清理，不留后台连接）。"""
import sys, os, json, time, asyncio

ROOT = os.path.realpath("/var/mobile/Library/Mobile Documents/iCloud~com~thomfang~Scripting/Documents/scripts/TGClient/tg-hub")
while ROOT in sys.path:
    sys.path.remove(ROOT)
sys.path.insert(0, ROOT)

# 常驻解释器里可能残留旧模块/另一副本，全部清掉，确保跑的是新代码
for n in list(sys.modules):
    if n in ("tg_api", "tg_net", "vendor_bootstrap") or n == "scripts" or n.startswith("scripts."):
        del sys.modules[n]

import tg_api
import tg_net

# 安全阀（前置）：用户正在登录流程中（已获取验证码待输入）时一律不碰，
# 否则 status 的 revoked 清理会把验证码 hash 删掉。
try:
    from scripts.config import get_data_dir as _gdd
    _pending = False
    _ls = _gdd() / "login_state.json"
    if _ls.exists():
        import json as _json
        _pending = bool(_json.loads(_ls.read_text()).get("phone_code_hash"))
    if _pending:
        print("SKIP: 检测到进行中的验证码登录，跳过全部测试")
        sys.exit(0)
except SystemExit:
    raise
except Exception:
    pass

print("== ALL_COMMANDS:", tg_api.ALL_COMMANDS)

# 1) status：本地有（已被服务端注销的）密钥 → 联网确认 → revoked → 清本地
t0 = time.time()
r1 = tg_api.dispatch("status", json.dumps({"__timeout": 60}))
print("STATUS1 elapsed=%.2fs" % (time.time() - t0))

# 安全阀：当前是**有效已登录**状态时，绝不能继续跑后面的破坏性步骤
# （logout / 删 session 文件），否则会把用户的真实登录态清掉。
if r1.get("authorized"):
    print("SKIP: 当前是有效登录态，跳过破坏性步骤")
    tg_net.shutdown()
    sys.exit(0)

# 2) status：本地已无密钥 → 不联网、秒回未登录
t0 = time.time()
r2 = tg_api.dispatch("status", json.dumps({"__timeout": 60}))
print("STATUS2 elapsed=%.3fs (应远小于1s，说明没联网)" % (time.time() - t0))

# 3) 常驻连接机制：acquire → 连接 → release（验证单连接可正常建立）
async def _conn_test():
    c = await tg_net.acquire()
    try:
        return bool(c.is_connected())
    finally:
        tg_net.release()

ok = tg_net.run_on_loop(_conn_test(), 30)
print("SHARED_CONNECT:", ok)

# 3b) 并发 acquire：必须复用同一客户端、busy 正确归零（连接锁生效）
async def _acq_one():
    c = await tg_net.acquire()
    try:
        await asyncio.sleep(0.05)
        return id(c)
    finally:
        tg_net.release()

async def _acq_pair():
    return await asyncio.gather(_acq_one(), _acq_one())

import asyncio
pair = tg_net.run_on_loop(_acq_pair(), 30)
print("CONCURRENT_ACQUIRE same_client:", pair[0] == pair[1],
      "busy:", tg_net._busy, "clients_built_ok")

# 4) logout：只清本地（此时本地无会话，也应成功）
r4 = tg_api.dispatch("logout", json.dumps({"__timeout": 30}))
print("LOGOUT:", r4)

# 5) shutdown：停掉后台循环
r5 = tg_api.dispatch("shutdown", json.dumps({"__timeout": 20}))
print("SHUTDOWN:", r5)

# 6) shutdown 后仍能再次调度（懒加载重建循环）
r6 = tg_api.dispatch("status", json.dumps({"__timeout": 30}))
print("STATUS_AFTER_SHUTDOWN:", r6)

# 7) 离线分支：伪造“本地已登录 + 网络不可用”
#    → status 必须保持已登录（不踢回登录页），send_code 必须返回“已登录”不发码
import sqlite3
import pathlib
from contextlib import asynccontextmanager
from scripts.config import get_session_path, get_data_dir

sess = pathlib.Path(get_session_path() + ".session")
con = sqlite3.connect(str(sess))
con.execute("CREATE TABLE IF NOT EXISTS version (version INTEGER)")
con.execute(
    "CREATE TABLE IF NOT EXISTS sessions "
    "(dc_id INTEGER, server_address TEXT, port INTEGER, auth_key BLOB, takeout_id INTEGER)"
)
con.execute("DELETE FROM sessions")
con.execute("INSERT INTO sessions VALUES (4, '149.154.167.92', 443, ?, NULL)", (b"\x01" * 256,))
con.commit()
con.close()

state_file = get_data_dir() / "login_state.json"
state_file.write_text(json.dumps({"me": {"id": 1, "name": "测试用户", "username": "", "phone": "+86138"}}))

_real_online = tg_net.online

@asynccontextmanager
async def _offline_online():
    raise ConnectionError("simulated: network down")
    yield  # pragma: no cover

tg_net.online = _offline_online

r7 = tg_api.dispatch("status", json.dumps({"__timeout": 30}))
print("OFFLINE_STATUS:", {k: r7.get(k) for k in ("ok", "authorized", "offline", "me", "network_error")})
r8 = tg_api.dispatch("send_code", json.dumps({"phone": "+8613800138000", "__timeout": 30}))
print("OFFLINE_SEND_CODE:", r8)
tg_net.online = _real_online

# 清理伪造状态（恢复“未登录”原状）
tg_net.shutdown()
sess.unlink(missing_ok=True)
state_file.unlink(missing_ok=True)
print("CLEANED session file; done")
