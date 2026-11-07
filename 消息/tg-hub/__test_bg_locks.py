# -*- coding: utf-8 -*-
"""离线回归：数据库不得把文件锁带过 await/方法边界（iOS 挂起 → 0xdead10cc）。

不联网、不碰真实 session/db，全部用临时目录。

覆盖：
  A. MessageDB：外层 with 跨 await 不持锁；批次异常整批回滚且立即可写。
  B. IOSSQLiteSession：每次 session 操作后 _conn 为 None，外部写者立刻可拿写锁；
     异常路径回滚并释放；set_dc/auth_key 更新原子（DELETE+INSERT 不撕开）。
  C. tg_net._make_client 接线：产出 IOSSQLiteSession 且构造后不持连接。
"""
import asyncio
import os
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

HERE = os.path.dirname(os.path.realpath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

# 常驻解释器：弹掉旧模块，保证测的是当前代码
for _n in ("tg_api", "tg_session", "tg_net", "scripts", "scripts.config",
           "scripts.db", "scripts.exceptions", "scripts.client"):
    sys.modules.pop(_n, None)

failures: list[str] = []


def check(cond: bool, label: str):
    if cond:
        print(f"  ok   {label}")
    else:
        failures.append(label)
        print(f"  FAIL {label}")


def assert_no_lock(db_path: str, label: str):
    """独立连接必须能立刻拿到写锁（BEGIN IMMEDIATE），证明无残留写事务。"""
    con = sqlite3.connect(db_path, timeout=0.5)
    try:
        con.execute("BEGIN IMMEDIATE")
        con.rollback()
        check(True, label)
    except sqlite3.Error as e:
        check(False, f"{label}（残留锁: {e}）")
    finally:
        con.close()


# ── A. MessageDB ─────────────────────────────────────────────────────────────
print("A. MessageDB 短连接")

from scripts.db import MessageDB  # noqa: E402


def row(msg_id: int, content: str) -> dict:
    return dict(chat_id=101, chat_name="测试群", msg_id=msg_id,
                sender_id=7, sender_name="甲", content=content,
                timestamp=datetime.now(timezone.utc))


def test_message_db():
    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, "msg.db")

        # A1: 外层 with 跨 await，窗口内无锁
        async def cross_await():
            with MessageDB(path) as db:
                db.insert_batch([row(1, "第一条")])
                await asyncio.sleep(0.01)  # “await 期间”外部写者必须畅通
                assert_no_lock(path, "A1 with 跨 await 期间无写锁")
                db.insert_batch([row(2, "第二条")])
            assert_no_lock(path, "A1 with 退出后无写锁")

        asyncio.run(cross_await())
        check(MessageDB(path).count() == 2, "A1 批次已提交")

        # A2: 批次中途失败 → 整批回滚 + 立即释放锁
        con = sqlite3.connect(path)
        con.execute("""CREATE TRIGGER fail_bad BEFORE INSERT ON messages
                       WHEN NEW.content = 'BAD'
                       BEGIN SELECT RAISE(ABORT, 'boom'); END""")
        con.commit()
        con.close()

        db = MessageDB(path)
        n = db.insert_batch([row(3, "好的"), row(4, "BAD"), row(5, "好的2")])
        check(n == 0, "A2 失败批次返回 0")
        check(bool(db.last_error), "A2 last_error 有记录")
        check(db.count() == 2, "A2 部分写入已整批回滚（3/4/5 都不在）")
        assert_no_lock(path, "A2 异常后立即无写锁")
        db.close()

        # A3: 失败后同一实例还能继续正常写（连接没被污染）
        db2 = MessageDB(path)
        n2 = db2.insert_batch([row(6, "恢复")])
        check(n2 == 1, "A3 失败后可恢复写入")
        assert_no_lock(path, "A3 恢复写入后无写锁")
        db2.close()


try:
    test_message_db()
except Exception as e:  # noqa: BLE001
    failures.append(f"A 未捕获异常: {e!r}")
    print(f"  FAIL A 未捕获异常: {e!r}")

# ── B. IOSSQLiteSession ──────────────────────────────────────────────────────
print("B. IOSSQLiteSession 短事务")


def test_session():
    from tg_session import IOSSQLiteSession
    from telethon.crypto import AuthKey

    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, "acct")
        s = IOSSQLiteSession(path)          # 创建 schema
        check(s._conn is None, "B1 初始化后不持连接")
        assert_no_lock(path + ".session", "B1 建库后无写锁")

        s.set_dc(2, "149.154.167.40", 443)  # delete+insert 必须原子
        check(s._conn is None, "B2 set_dc 后不持连接")
        assert_no_lock(path + ".session", "B2 set_dc 后无写锁")

        s.auth_key = AuthKey(b"\x11" * 256)
        check(s._conn is None, "B3 auth_key 落盘后不持连接")

        # 直接读文件确认原子更新已提交
        con = sqlite3.connect(path + ".session")
        row_ = con.execute("select dc_id, length(auth_key) from sessions").fetchone()
        con.close()
        check(row_ == (2, 256), f"B3 会话行完整提交（读到 {row_}）")

        # 异常路径：回滚 + 关连接 + 释放锁
        try:
            s._execute("SELECT * FROM definitely_missing")
            check(False, "B4 未知表应抛异常")
        except sqlite3.Error:
            check(s._conn is None, "B4 异常后不持连接")
            assert_no_lock(path + ".session", "B4 异常后无写锁")

        # 读路径（命令热路径）也不留连接
        s._execute("select count(*) from sessions")
        check(s._conn is None, "B5 读取后不持连接")

        # save/close 幂等安全
        s.save()
        s.close()
        check(s._conn is None, "B6 save/close 后不持连接")

        # 复用：关掉后仍可继续用（下次操作按需重开）
        s.set_dc(4, "149.154.167.90", 443)
        check(s.dc_id == 4, "B7 close 后可复用")
        assert_no_lock(path + ".session", "B7 复用后无写锁")


try:
    test_session()
except Exception as e:  # noqa: BLE001
    import traceback
    traceback.print_exc()
    failures.append(f"B 未捕获异常: {e!r}")
    print(f"  FAIL B 未捕获异常: {e!r}")

# ── C. tg_net 接线 ───────────────────────────────────────────────────────────
print("C. tg_net 单连接客户端接线")


def test_wire():
    import tg_net
    client = tg_net._make_client()
    try:
        check(type(client.session).__name__ == "IOSSQLiteSession",
              "C1 常驻客户端使用 IOSSQLiteSession")
        check(client.session._conn is None, "C1 构造后不持 session 连接")
    finally:
        # 只拆对象，不 connect/disconnect（不碰网络）
        try:
            client.session.close()
        except Exception:  # noqa: BLE001
            pass


try:
    test_wire()
except Exception as e:  # noqa: BLE001
    import traceback
    traceback.print_exc()
    failures.append(f"C 未捕获异常: {e!r}")
    print(f"  FAIL C 未捕获异常: {e!r}")

print()
if failures:
    print("FAILED:", len(failures))
    for f in failures:
        print(" -", f)
    sys.exit(1)
print("ALL PASSED")
