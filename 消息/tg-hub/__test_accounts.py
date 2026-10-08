# -*- coding: utf-8 -*-
"""多账号离线测试（可复跑）：经 Python.run 或 python3 调用本文件的 main()。

只碰临时目录（TG_DATA_DIR 指向 tmp），不碰真实登录态与 API 凭证、不联网。

覆盖：
  1. 注册表 load/save 默认结构、default 账号路径零迁移（tg_hub/login_state.json/messages.db）
  2. 非 default 账号的 session/state/db 三路径互相隔离
  3. upsert_account 注册与 pending 清除；unregister_current 回落
  4. 四命令：account_add_begin / account_switch / account_add_cancel / account_remove
     （含：切换时放弃 pending、移除当前账号被拒、重复 sid 防撞）
  5. status（local=true）返回 account_sid/accounts/adding 字段
  6. logout 在多账号时回落 switched_to（不联网：直接调 _c_logout 前置条件不满足则跳过）
"""
import asyncio
import json
import os
import shutil
import sys
import tempfile
import traceback

HERE = os.path.dirname(os.path.realpath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

# 常驻解释器：先掚掉旧模块，否则测的是上一版代码
for _n in ("tg_api", "scripts", "scripts.config", "scripts.db",
           "scripts.exceptions", "scripts.client", "tg_net", "tg_session",
           "vendor_bootstrap"):
    sys.modules.pop(_n, None)

_TMP = tempfile.mkdtemp(prefix="tghub_acc_test_")
# 保存并覆盖环境（常驻解释器：结束时必须恢复，否则污染真实面板）
_SAVED_ENV = {k: os.environ.get(k) for k in
              ("TG_DATA_DIR", "TG_API_ID", "TG_API_HASH", "TG_DB_PATH", "TG_SESSION_NAME")}
os.environ["TG_DATA_DIR"] = _TMP
# 避开真实 env 凭证影响（api_configured 会读 TG_API_*）
os.environ.pop("TG_API_ID", None)
os.environ.pop("TG_API_HASH", None)
os.environ.pop("TG_DB_PATH", None)
os.environ.pop("TG_SESSION_NAME", None)


def _restore_env():
    for _k, _v in _SAVED_ENV.items():
        if _v is None:
            os.environ.pop(_k, None)
        else:
            os.environ[_k] = _v

import tg_api  # noqa: E402
import scripts.config as cfg  # noqa: E402

FAILED = 0


def check(name, cond, extra=""):
    global FAILED
    if cond:
        print("  ok  %s" % name)
    else:
        FAILED += 1
        print("  FAIL %s %s" % (name, extra))


def run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def make_fake_session(sid, key=b"\x01" * 256):
    """造一个带 auth_key 的真结构 session 文件（让 _sid_has_key 判 True）。"""
    import sqlite3
    p = os.path.join(_TMP, cfg.session_path_for(sid).split("/")[-1] + ".session")
    con = sqlite3.connect(p)
    try:
        con.execute("CREATE TABLE IF NOT EXISTS sessions (auth_key BLOB, dc_id INTEGER, server_address TEXT, port INTEGER, takeout INTEGER)")
        con.execute("DELETE FROM sessions")
        con.execute("INSERT INTO sessions (auth_key, dc_id) VALUES (?, 2)", (key,))
        con.commit()
    finally:
        con.close()
    return p


def main():
    print("== 1. 注册表默认结构 / default 账号零迁移 ==")
    reg = cfg.load_accounts()
    check("默认 current=default", reg["current"] == "default", reg)
    check("默认 list 空", reg["list"] == [])
    check("默认 pending None", reg["pending"] is None)

    sp = cfg.get_session_path()
    check("default session 沿用 tg_hub", sp.endswith("/tg_hub"), sp)
    check("default state 沿用 login_state.json",
          str(cfg.state_path_for("default")).endswith("/login_state.json"),
          str(cfg.state_path_for("default")))
    check("default db 沿用 messages.db",
          str(cfg.db_path_for("default")).endswith("/messages.db"),
          str(cfg.db_path_for("default")))
    check("get_session_path 与 session_path_for 一致",
          cfg.get_session_path() == cfg.session_path_for("default"))

    print("== 2. 非 default 账号三路径隔离 ==")
    a2 = "acc1728000001"
    check("session 隔离", cfg.session_path_for(a2).endswith("/" + a2),
          cfg.session_path_for(a2))
    check("state 隔离", str(cfg.state_path_for(a2)).endswith("/login_state." + a2 + ".json"),
          str(cfg.state_path_for(a2)))
    check("db 隔离", str(cfg.db_path_for(a2)).endswith("/messages." + a2 + ".db"),
          str(cfg.db_path_for(a2)))
    check("三路径互不相同",
          len({cfg.session_path_for(a2), str(cfg.state_path_for(a2)),
               str(cfg.db_path_for(a2))}) == 3)

    print("== 3. upsert / unregister ==")
    cfg.upsert_account({"id": 111, "name": "张三", "username": "zs", "phone": "+86138"})
    reg = cfg.load_accounts()
    check("default 注册进列表", len(reg["list"]) == 1, reg)
    check("注册表字段", reg["list"][0]["sid"] == "default"
          and reg["list"][0]["name"] == "张三"
          and reg["list"][0]["user_id"] == 111, reg["list"])
    # pending 指向当前 sid → upsert 应清除
    reg["pending"] = {"sid": "default", "prev": None}
    cfg.save_accounts(reg)
    cfg.upsert_account({"id": 111, "name": "张三2", "username": "zs", "phone": "+86138"})
    reg = cfg.load_accounts()
    check("upsert 清除指向自己的 pending", reg["pending"] is None, reg)
    check("upsert 更新名字", reg["list"][0]["name"] == "张三2", reg["list"])
    # 再注册一个账号，然后 unregister 回落
    reg["list"].append({"sid": a2, "name": "李四", "phone": "+86139"})
    cfg.save_accounts(reg)
    reg = cfg.load_accounts()
    reg["current"] = a2
    cfg.save_accounts(reg)
    got = cfg.unregister_current()
    reg = cfg.load_accounts()
    check("unregister 移除当前", all(a["sid"] != a2 for a in reg["list"]), reg)
    check("unregister 回落到 default", reg["current"] == "default", reg)
    check("unregister 返回剩余 sid", got == "default", got)

    print("== 4. 四命令（async）==")
    make_fake_session("default")  # default 有有效会话，才能走“正常切换”路径
    # account_add_begin：开新 slot
    res = run(tg_api._c_account_add_begin({}))
    check("begin ok", res.get("ok") is True, res)
    reg = cfg.load_accounts()
    check("begin 记录 pending", isinstance(reg.get("pending"), dict)
          and reg["pending"]["prev"] == "default", reg)
    new_sid = reg["pending"]["sid"]
    check("begin 切到新 sid", reg["current"] == new_sid, reg)
    check("begin 返回 sid", res.get("account_sid") == new_sid, res)

    # 重复 begin 幂等
    res2 = run(tg_api._c_account_add_begin({}))
    check("重复 begin 幂等", res2.get("ok") and reg["pending"]["sid"] == new_sid, res2)

    # 切到已注册账号（default）→ 应放弃 pending
    res = run(tg_api._c_account_switch({"sid": "default"}))
    check("switch ok", res.get("ok") is True, res)
    reg = cfg.load_accounts()
    check("switch 清 pending", reg["pending"] is None, reg)
    check("switch current=default", reg["current"] == "default", reg)
    check("switch 返回 accounts 字段", isinstance(res.get("accounts"), list), res)

    # switch 到不存在的 sid
    res = run(tg_api._c_account_switch({"sid": "nope"}))
    check("switch 未知 sid 报错", res.get("ok") is False, res)

    # 无 pending 时 cancel 是 noop
    res = run(tg_api._c_account_add_cancel({}))
    check("cancel 无 pending 为 noop", res.get("ok") and res.get("noop"), res)

    # 再 begin，然后 cancel 回滚
    run(tg_api._c_account_add_begin({}))
    reg = cfg.load_accounts()
    pend_sid = reg["pending"]["sid"]
    res = run(tg_api._c_account_add_cancel({}))
    check("cancel ok", res.get("ok") is True, res)
    reg = cfg.load_accounts()
    check("cancel 清 pending", reg["pending"] is None, reg)
    check("cancel 回 default", reg["current"] == "default", reg)
    check("cancel 返回 sid", res.get("account_sid") == "default", res)
    # 未登录 slot 的 session 文件本就不存在，purge 不应报错（幂等）
    check("cancel 后无残留 session",
          not os.path.exists(os.path.join(_TMP, pend_sid + ".session")))

    # remove：当前账号被拒
    res = run(tg_api._c_account_remove({"sid": "default"}))
    check("remove 当前账号被拒", res.get("ok") is False, res)

    print("== 4b. 切到会话已失效账号 → 可取消的重登态 ==")
    # 造一个已注册但无 session 文件的账号 dead
    dead = "accdead"
    reg = cfg.load_accounts()
    reg["list"].append({"sid": dead, "name": "失效号", "phone": "+86100"})
    cfg.save_accounts(reg)
    res = run(tg_api._c_account_switch({"sid": dead}))
    check("switch 失效账号 ok", res.get("ok") is True, res)
    check("switch 失效账号 relogin", res.get("relogin") is True, res)
    reg = cfg.load_accounts()
    check("relogin 置 pending{sid,prev}", reg.get("pending")
          and reg["pending"]["sid"] == dead and reg["pending"]["prev"] == "default", reg)
    check("relogin current=dead", reg["current"] == dead, reg)
    # status 应报 adding=True（登录页据此出「取消」）
    res = run(tg_api._c_status({"local": True}))
    check("relogin 期间 adding=True", res.get("adding") is True, res)
    # 取消 → 回 default，dead 仍在列表（只回标记不删）
    res = run(tg_api._c_account_add_cancel({}))
    check("cancel 回 default", res.get("ok") and res.get("account_sid") == "default", res)
    reg = cfg.load_accounts()
    check("cancel 清 pending", reg["pending"] is None, reg)
    check("dead 账号保留在列表", any(a["sid"] == dead for a in reg["list"]), reg)

    print("== 4c. 注册第二个账号后 remove 非当前 ==")
    cfg.upsert_account({"id": 222, "name": "王五", "username": "ww", "phone": "+86137"})
    reg = cfg.load_accounts()
    reg["list"].append({"sid": a2, "name": "李四", "phone": "+86139"})
    cfg.save_accounts(reg)
    res = run(tg_api._c_account_remove({"sid": a2}))
    check("remove 非当前 ok", res.get("ok") is True, res)
    reg = cfg.load_accounts()
    check("remove 后列表少一项", all(a["sid"] != a2 for a in reg["list"]), reg)
    res = run(tg_api._c_account_remove({"sid": "nope"}))
    check("remove 未知 sid 报错", res.get("ok") is False, res)

    print("== 5. status(local) 字段 ==")
    res = run(tg_api._c_status({"local": True}))
    check("status ok", res.get("ok") is True, res)
    check("status.account_sid", res.get("account_sid") == "default", res)
    check("status.accounts 是列表", isinstance(res.get("accounts"), list), res)
    check("status.adding 是 bool", isinstance(res.get("adding"), bool), res)
    check("accounts 条目含 has_session", all("has_session" in a for a in res["accounts"]),
          res["accounts"])
    check("未配置凭证 → need_api", res.get("need_api") is True, res)
    # 制造 pending → adding=True
    reg = cfg.load_accounts()
    reg["pending"] = {"sid": "accX", "prev": "default"}
    cfg.save_accounts(reg)
    res = run(tg_api._c_status({"local": True}))
    check("pending → adding=True", res.get("adding") is True, res)
    reg = cfg.load_accounts()
    reg["pending"] = None
    cfg.save_accounts(reg)

    print("== 6. 注册表损坏容错 ==")
    bak = cfg._accounts_bak_path()
    if bak.exists():
        bak.unlink()
    with open(cfg._accounts_path(), "w") as f:
        f.write("{broken json!!")
    reg = cfg.load_accounts()
    check("损坏且无备份 → 重建默认", reg["current"] == "default" and reg["list"] == [], reg)
    # 2026-10-07 新语义：save_accounts 会把上一份可解析的注册表落成 .bak，
    # 主文件损坏时回退备份（不丢账号列表）——先落两次好数据把 .bak 造出来。
    cfg.save_accounts({"current": "default", "list": [{"sid": "default", "name": "王五"}], "pending": None})
    cfg.save_accounts({"current": "default", "list": [], "pending": None})
    with open(cfg._accounts_path(), "w") as f:
        f.write("{broken json!!")
    reg = cfg.load_accounts()
    check("损坏但有备份 → 回退备份", bool(reg["list"]) and reg["list"][0].get("name") == "王五", reg)

    shutil.rmtree(_TMP, ignore_errors=True)
    _restore_env()
    print("\nFAILED:", FAILED)
    return 1 if FAILED else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc()
        _restore_env()
        sys.exit(2)
