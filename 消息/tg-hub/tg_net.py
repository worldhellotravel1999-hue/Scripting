# -*- coding: utf-8 -*-
"""
常驻单连接：整个进程只维持**一条** Telegram 主连接，所有联网命令复用它。

为什么必须这样（这是“一登录就被登出 / 手机端也掉线”的根源）：

Telegram 官方文档 core.telegram.org/api/errors 明确规定——
  · 非媒体 DC 上，同一个登录会话（授权 / auth key）只允许**一条主连接**；
  · 一旦服务端检测到同一授权并行地从两条 TCP 连接发请求（包括“上一条连接
    还没被服务端关掉，就又连上一条”），会返回 AUTH_KEY_DUPLICATED，并且
    **直接吊销该登录会话**（“the session was already invalidated by the
    server”），客户端必须换新密钥重新登录。

旧实现每执行一条命令就“新建客户端 → connect → 用完 disconnect”，于是：
  · 登录成功后紧接着的 status / 拉列表，会与尚未被服务端关闭的登录连接撞车；
  · 命令超时后守护线程里的客户端仍在后台连着，下一条命令又连一条；
弱网 / VPN 下 FIN 丢包时这种撞车几乎必然发生，表现就是“刚登录几秒就被登出”。

因此这里：
  · 单个常驻事件循环（后台线程）+ 单个 Telethon 客户端，命令都调度到该循环执行；
  · 只有空闲超过 _IDLE_CLOSE 秒、或脚本显式 shutdown 时才断开；
  · 凭证变更 / 退出登录 / 会话被服务端吊销时调用 reset() 丢弃客户端重建。

注意：本模块名刻意**不**放进面板的 importlib.reload 名单（api.ts），
模块级状态要在多次 Python.run 调用之间持久存活；被 reload 的 tg_api /
scripts.* 只是重新 import 本模块，不会重置连接。
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import sqlite3
import threading
from contextlib import asynccontextmanager
from pathlib import Path

try:  # vendor/telethon 可导入（重复导入无副作用）
    import vendor_bootstrap  # noqa: F401
except Exception:  # noqa: BLE001
    pass

# 空闲多少秒后断开连接（防止脚本关闭后仍留着后台连接被别的进程判定为并行会话）
_IDLE_CLOSE = 300.0

_lock = threading.Lock()
_loop: "asyncio.AbstractEventLoop | None" = None
_thread: threading.Thread | None = None
_client = None
_conn_lock: asyncio.Lock | None = None
_idle_handle = None
_busy = 0


# ── 事件循环 ─────────────────────────────────────────────────────────────────

def _ensure_loop():
    global _loop, _thread, _conn_lock
    with _lock:
        if _loop is None or _loop.is_closed():
            _loop = asyncio.new_event_loop()
            _thread = threading.Thread(
                target=_loop.run_forever, daemon=True, name="tg-net-loop"
            )
            _thread.start()
            # asyncio.Lock 会在首次 await 时绑定事件循环，换循环必须重建
            _conn_lock = asyncio.Lock()
        return _loop


def run_on_loop(coro, timeout: float | None = None):
    """在常驻事件循环上执行协程并同步等待结果。

    超时不取消任务：与旧的守护线程行为保持一致（后台继续跑完），
    但连接是共享的，不会因为“后台还有一个客户端连着”而产生并行会话。
    """
    loop = _ensure_loop()
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is loop:
        coro.close()
        raise RuntimeError("不能在共享事件循环内同步等待同一循环（会死锁）")
    fut = asyncio.run_coroutine_threadsafe(coro, loop)
    try:
        return fut.result(timeout)
    except concurrent.futures.TimeoutError:
        raise TimeoutError(
            f"命令超时（{int(timeout or 0)}s），已中断；"
            "后台仍会继续执行，建议稍后点刷新查看结果"
        ) from None


# ── 客户端生命周期 ───────────────────────────────────────────────────────────

def _make_client():
    from telethon import TelegramClient
    # 短事务 session：每次同步的 session 读写都在方法内提交/回滚并关闭连接，
    # 文件句柄绝不跨网络 await 存活——否则 iOS 挂起时仍持锁 → 0xdead10cc 被杀。
    # 保持旧 .session 文件格式与单连接约束不变。
    from tg_session import IOSSQLiteSession
    from scripts.config import (
        get_api_hash,
        get_api_id,
        get_app_version,
        get_device_model,
        get_lang_code,
        get_session_path,
        get_system_lang_code,
        get_system_version,
    )

    return TelegramClient(
        IOSSQLiteSession(get_session_path()),
        get_api_id(),
        get_api_hash(),
        device_model=get_device_model(),
        system_version=get_system_version(),
        app_version=get_app_version(),
        lang_code=get_lang_code(),
        system_lang_code=get_system_lang_code(),
        flood_sleep_threshold=120,
    )


async def acquire():
    """取用常驻客户端（必要时创建并确保已连接），busy+1；用完必须 release()。

    连接动作用**连接锁**串行化：并发命令同时发现“未连接”时只能有一个
    真正建链，否则就会出现第二条 TCP 连接（→ AUTH_KEY_DUPLICATED → 会话被注销）。
    """
    global _client, _idle_handle, _busy, _conn_lock
    with _lock:
        if _idle_handle is not None:
            _idle_handle.cancel()
            _idle_handle = None
        if _client is None:
            _client = _make_client()
        if _conn_lock is None:  # 理论上 _ensure_loop 已建，防御性兜底
            _conn_lock = asyncio.Lock()
        client = _client
        lock = _conn_lock
        _busy += 1
    try:
        if not client.is_connected():
            async with lock:
                if not client.is_connected():
                    await client.connect()
    except BaseException:
        release()
        raise
    return client


def release():
    """命令结束：busy-1，回到 0 时布置“空闲自动断开”定时器。"""
    global _busy, _idle_handle
    with _lock:
        _busy = max(0, _busy - 1)
        if _busy == 0:
            if _idle_handle is not None:
                _idle_handle.cancel()
                _idle_handle = None
            if _loop is not None and not _loop.is_closed():
                _idle_handle = _loop.call_later(_IDLE_CLOSE, _idle_fire)


def _idle_fire():
    global _idle_handle
    with _lock:
        _idle_handle = None
        if _busy != 0:  # 期间又有命令进来，放弃本次空闲断开
            return
        client = _client
    if client is not None and client.is_connected():
        asyncio.ensure_future(_quiet_disconnect(client))


async def _quiet_disconnect(client):
    try:
        await client.disconnect()
    except Exception:  # noqa: BLE001
        pass


async def reset():
    """丢弃常驻客户端（断开连接）。凭证变更 / 退出登录 / 会话被吊销后调用。

    只断本地连接，不向服务器发送任何请求。
    """
    global _client, _idle_handle
    with _lock:
        client = _client
        _client = None
        if _idle_handle is not None:
            _idle_handle.cancel()
            _idle_handle = None
    if client is not None:
        await _quiet_disconnect(client)
        try:
            sess = getattr(client, "session", None)
            conn = getattr(sess, "_conn", None)
            if conn is not None:
                conn.close()
        except Exception:  # noqa: BLE001
            pass


def shutdown(timeout: float = 5.0):
    """脚本退出时调用：断开连接并停掉事件循环，彻底不留后台连接。"""
    global _loop, _thread, _client, _conn_lock, _idle_handle, _busy
    with _lock:
        loop, thread, client = _loop, _thread, _client
        _loop = None
        _thread = None
        _client = None
        _conn_lock = None
        _idle_handle = None
        _busy = 0
    if loop is None or loop.is_closed():
        return
    if client is not None:
        try:
            asyncio.run_coroutine_threadsafe(_quiet_disconnect(client), loop).result(timeout)
        except Exception:  # noqa: BLE001
            pass
    try:
        loop.call_soon_threadsafe(loop.stop)
        if thread is not None:
            thread.join(timeout)
        loop.close()
    except Exception:  # noqa: BLE001
        pass


# ── 本地会话判定（不联网） ───────────────────────────────────────────────────

def local_auth_key() -> bool | None:
    """读本地 session 文件里的 auth key。

    True  = 本地有登录密钥（是否仍有效需联网确认）
    False = 本地确定没有密钥（未登录，无需联网即可判定）
    None  = 文件读不出来（比如被占用），交给联网探测决定
    """
    from scripts.config import get_session_path

    p = Path(get_session_path() + ".session")
    if not p.exists():
        return False
    try:
        con = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
        try:
            row = con.execute("SELECT auth_key FROM sessions LIMIT 1").fetchone()
        finally:
            con.close()
        return bool(row and row[0])
    except Exception:  # noqa: BLE001
        return None


async def drop_local_session():
    """删除本地 session 文件与登录缓存（只动本机，不碰服务器）。"""
    from scripts.config import get_session_path

    await reset()
    try:
        Path(get_session_path() + ".session").unlink(missing_ok=True)
    except Exception:  # noqa: BLE001
        pass


# ── 便捷上下文 ───────────────────────────────────────────────────────────────

@asynccontextmanager
async def online():
    """取用常驻连接的上下文管理器：退出时只 release，不断开。"""
    c = await acquire()
    try:
        yield c
    finally:
        release()
