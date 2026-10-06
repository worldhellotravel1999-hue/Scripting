#!/usr/bin/env python3
"""
tg-hub JSON API 助手 —— 供 Scripting 面板通过 Python.run 调用。

用法（进程内）:
    import tg_api
    tg_api.dispatch("stats", "{}")

所有命令输出单行哨兵 JSON：@@TG@@{...}
成功: {"ok": true, ...}   失败: {"ok": false, "error": "...", "etype": "..."}
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import sys
import threading
import time
import traceback
from contextlib import asynccontextmanager
from pathlib import Path

HERE = Path(__file__).resolve().parent
for _p in (str(HERE), str(HERE / "vendor")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import vendor_bootstrap  # noqa: E402,F401  (确保 vendor 可导入)
import tg_net  # noqa: E402  (常驻单连接：见 tg_net.py 顶部说明)

# 常驻解释器里 telethon 可能来自另一副本（《TG Hub》的 html.py 不认 tg-spoiler 遮罩），
# 而三方库不会被面板的重载逻辑刷新——这里把 html 解析扩展强制锁定到本 vendor 的文件，
# 否则格式发送（尤其遮罩）会静默降级成无格式。
try:
    import importlib.util as _importlib_util
    import sys as _sys
    import telethon.extensions as _tele_extensions

    _html_file = os.path.realpath(str(HERE / "vendor" / "telethon" / "extensions" / "html.py"))
    _cur_html = _sys.modules.get("telethon.extensions.html")
    if (
        _cur_html is None
        or os.path.realpath(str(getattr(_cur_html, "__file__", "") or "")) != _html_file
    ):
        _spec = _importlib_util.spec_from_file_location("telethon.extensions.html", _html_file)
        _new_html = _importlib_util.module_from_spec(_spec)
        _spec.loader.exec_module(_new_html)
        _sys.modules["telethon.extensions.html"] = _new_html
        _tele_extensions.html = _new_html
except Exception:  # noqa: BLE001 锁定失败不影响纯文本发送
    pass

SENTINEL = "@@TG@@"

# 静默三方库日志：telethon 的告警会走 stderr 污染面板控制台；
# 我们自己的 scripts.* 日志保持默认（真正的问题仍会显示）。
logging.getLogger("telethon").setLevel(logging.ERROR)
logging.getLogger("telethon").addHandler(logging.NullHandler())


# ── 输出 ─────────────────────────────────────────────────────────────────────

def emit(obj: dict) -> None:
    try:
        line = SENTINEL + json.dumps(obj, ensure_ascii=False, default=str)
    except Exception:
        line = SENTINEL + json.dumps({"ok": False, "error": "result not serializable"})
    print(line, flush=True)


# ── 通用工具 ─────────────────────────────────────────────────────────────────

def _state_path() -> Path:
    from scripts.config import get_data_dir
    return get_data_dir() / "login_state.json"


def _load_state() -> dict:
    p = _state_path()
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:
            return {}
    return {}


def _save_state(state: dict) -> None:
    p = _state_path()
    tmp = p.parent / (p.name + ".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False))
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, p)  # 原子替换，中途被杀不会留下半截文件


def _clear_state() -> None:
    try:
        _state_path().unlink(missing_ok=True)
    except Exception:
        pass


def _make_client():
    # 连接统一由 tg_net 常驻管理（单连接约束），这里只保留工厂入口兼容旧引用。
    return tg_net._make_client()


@asynccontextmanager
async def _online():
    """取用**常驻单连接**（用完不断开）。

    旧实现每条命令 connect→disconnect：多条连接/残留连接并行会被 Telegram
    服务端判为 AUTH_KEY_DUPLICATED 并**直接吊销登录会话**（刚登录就被登出的
    真正原因，见 core.telegram.org/api/errors）。现在整进程只有一条连接。
    """
    async with tg_net.online() as c:
        yield c


def _me_dict(m) -> dict:
    """Telethon 的 User → 面板用的 me 字典。"""
    from scripts.client import _get_sender_name

    return {
        "id": m.id,
        "name": _get_sender_name(m) or "",
        "username": m.username or "",
        "phone": m.phone or "",
    }


async def _me(c) -> dict:
    return _me_dict(await c.get_me())


def _err(e: BaseException) -> dict:
    name = type(e).__name__
    msg = str(e) or name
    hints = {
        "PhoneCodeInvalidError": "验证码错误",
        "PhoneCodeExpiredError": "验证码已过期，请重新获取",
        "PhoneCodeEmptyError": "验证码不能为空",
        "SessionPasswordNeededError": "该账号开启了两步验证，需要输入密码",
        "PasswordHashInvalidError": "两步验证密码错误",
        "PhoneNumberBannedError": "该手机号已被 Telegram 封禁",
        "PhoneNumberInvalidError": "手机号格式不正确",
        "FloodWaitError": f"触发 Telegram 限流，请等待 {msg} 后重试",
        "AuthKeyUnregisteredError": "会话已失效，请重新登录",
        "AuthKeyInvalidError": "会话已失效，请重新登录",
        "AuthKeyDuplicatedError": (
            "同一账号被多条连接同时使用，服务端已注销本会话；"
            "请确认没有另一份脚本/旧连接同时在线，然后重新登录"
        ),
        "SessionRevokedError": "会话已被终止，请重新登录",
        "NotAuthenticatedError": "尚未登录 Telegram，请先完成登录",
        "UserDeactivatedError": "账号已被停用",
        "ConnectionError": "无法连接 Telegram 服务器",
        "OSError": "网络连接失败",
        "TimeoutError": "连接 Telegram 超时，请检查网络后重试",
        "PhoneCodeHashEmptyError": "缺少验证码 hash，请先获取验证码",
        "PhoneNumberUnoccupiedError": "该手机号尚未注册 Telegram，请先用官方 App 注册",
        "UserAlreadyParticipantError": "你已经在这个会话里了",
        "InviteHashExpiredError": "邀请链接已失效",
        "InviteHashInvalidError": "邀请链接无效",
        "InviteRequestSentError": "已发送加入申请，需等管理员同意",
        "UsernameInvalidError": "用户名无效",
        "UsernameNotOccupiedError": "该用户名不存在",
        "ChannelPrivateError": "该会话是私有的，请用邀请链接加入",
        "ChannelsTooMuchError": "你加入的频道/群太多了，先退出一些",
        "UserBannedInChannelError": "你已被该频道封禁",
        "PeerFloodError": "操作触发风控，请稍后再试",
    }
    return {"ok": False, "error": hints.get(name, msg), "etype": name, "raw": msg}


# 服务端“明确注销了本会话”的错误：判定为真掉线，清本地回登录页。
# 其他异常（网络/超时）一律按“网络不可用”处理，**保持本地登录态**，
# 绝不因抖动的网络把用户踢回登录页（那会诱使用户重复登录、触发风控）。
_REVOKED_ETYPES = {
    "AuthKeyUnregisteredError",
    "AuthKeyInvalidError",
    "AuthKeyPermEmptyError",
    "AuthKeyDuplicatedError",
    "SessionRevokedError",
    "UserDeactivatedError",
    "UserDeactivatedBanError",
}


def _is_revoked(e: BaseException) -> bool:
    return type(e).__name__ in _REVOKED_ETYPES


async def _drop_session() -> None:
    """清理本地登录痕迹：断开常驻连接 + 删 session 文件 + 清登录缓存。

    只动本机，**不向 Telegram 服务器发送任何请求**。
    """
    try:
        await tg_net.drop_local_session()
    except Exception:  # noqa: BLE001
        pass
    _clear_state()


async def _probe_session() -> tuple[str, dict | None, str | None]:
    """本地存在登录密钥时，确认其是否仍然有效（登录检测的核心）。

    返回 (outcome, me, network_error)：
      "valid"   —— 服务端确认已登录；
      "revoked" —— 服务端明确吊销（已同步清理本地，回登录页）；
      "offline" —— 网络不可用/超时，**按本地仍已登录处理**（误踢回登录页
                  会诱使用户反复登录，反复登录正是被服务端批量登出的诱因）。
    """
    from telethon import functions

    cached_me = _load_state().get("me")
    revoked = None
    try:
        async with _online() as c:
            # 两个 RPC 并行发出（同一条连接上 Telethon 按 msg_id 多路复用），
            # 少一次串行往返——status 是启动路径上最贵的一步（串行 ~1.1s，并行 ~0.6s）。
            # 语义与串行版完全一致：
            #   · 任一请求命中吊销类错误 → 真掉线，清本地回登录页；
            #   · 任一请求报其它错误 → 按网络不可用处理，**保持本地登录态**。
            state_r, me_r = await asyncio.gather(
                c(functions.updates.GetStateRequest()),
                c.get_me(),
                return_exceptions=True,
            )
            for r in (state_r, me_r):
                if isinstance(r, BaseException):
                    if _is_revoked(r):
                        revoked = True
                    else:
                        raise r  # 非吊销错误 → 外层按 offline 处理
            return "valid", _me_dict(me_r), None
    except (asyncio.CancelledError, KeyboardInterrupt, SystemExit):
        raise
    except BaseException as e:  # noqa: BLE001
        if _is_revoked(e):
            revoked = True
        else:
            # 网络层异常（连不上/超时/被墙）→ 信任本地会话
            return "offline", cached_me, str(e) or type(e).__name__
    await _drop_session()
    return "revoked", None, None


# ── 在线命令 ─────────────────────────────────────────────────────────────────

async def _c_status(_args: dict) -> dict:
    from scripts.config import get_db_path, get_data_dir, get_session_path, is_default_api_id

    has_key = tg_net.local_auth_key()
    info = {
        "session_path": get_session_path() + ".session",
        "session_exists": Path(get_session_path() + ".session").exists(),
        "local_session": has_key,  # 本地是否存有登录密钥（不联网即可判定）
        "db_path": str(get_db_path()),
        "db_exists": get_db_path().exists(),
        "data_dir": str(get_data_dir()),
        "default_api": is_default_api_id(),
        "has_login_state": _state_path().exists(),
    }

    # 本地确定没有登录密钥 → 直接回登录页，不发任何网络请求
    # （启动秒出，也避免无谓连接）。
    if has_key is False:
        return {**info, "ok": True, "authorized": False, "me": None}

    outcome, me, net_err = await _probe_session()
    if outcome == "valid":
        _save_state({**_load_state(), "me": me})
        return {**info, "ok": True, "authorized": True, "me": me}
    if outcome == "revoked":
        # 服务端明确注销了本会话（已清本地）→ 这时才需要重新登录
        return {**info, "ok": True, "authorized": False, "me": None, "revoked": True}
    # offline：网络不可用 → **信任本地会话**，保持已登录（不误踢回登录页）
    return {
        **info,
        "ok": True,
        "authorized": True,
        "me": _load_state().get("me"),
        "offline": True,
        "network_error": net_err,
    }


async def _c_send_code(args: dict) -> dict:
    phone = str(args.get("phone", "")).strip()
    if not phone:
        return {"ok": False, "error": "缺少手机号", "etype": "ValueError"}

    # 本地已存登录密钥**且已有完整登录记录** → 先确认，绝不无谓地再走一轮登录：
    # 每多一次手机号登录都是风控事件，而反复登录正是被服务端批量登出的诱因。
    # （必须同时有 me 缓存才探测：正在登录流程中的新密钥尚未注册，
    #   会被误判成 revoked 而清掉验证码 hash。）
    if tg_net.local_auth_key() is not False and _load_state().get("me"):
        outcome, me, net_err = await _probe_session()
        if outcome == "valid":
            return {"ok": True, "already": True, "me": me}
        if outcome == "offline":
            # 网络不可用但本地仍在登录态：按已登录返回，不发起验证码
            return {"ok": True, "already": True, "offline": True, "me": me}
        # revoked → 本地已清理，继续正常发码

    async with _online() as c:
        sent = await c.send_code_request(phone)
        _save_state({
            **_load_state(),
            "phone": phone,
            "phone_code_hash": sent.phone_code_hash,
            "ts": int(time.time()),
        })
        sent_type = type(sent.type).__name__.replace("SentCodeType", "")
        return {"ok": True, "sent": True, "sent_type": sent_type}


async def _c_sign_in(args: dict) -> dict:
    state = _load_state()
    phone = str(args.get("phone") or state.get("phone") or "").strip()
    code = str(args.get("code") or "").strip()
    phone_hash = state.get("phone_code_hash")
    if not phone or not phone_hash:
        return {"ok": False, "error": "请先获取验证码", "etype": "NoLoginState"}
    if not code:
        return {"ok": False, "error": "请输入验证码", "etype": "ValueError"}

    # 本地已有完整登录记录 → 已登录就不再重复 sign-in；
    # 不满足时不能探测（登录流程中的新密钥未注册，会被误判为已吊销）
    if tg_net.local_auth_key() is not False and state.get("me"):
        outcome, me, _err_net = await _probe_session()
        if outcome in ("valid", "offline"):
            return {"ok": True, "already": True, "me": me}

    from telethon.errors import SessionPasswordNeededError

    async with _online() as c:
        try:
            await c.sign_in(phone=phone, code=code, phone_code_hash=phone_hash)
        except SessionPasswordNeededError:
            return {"ok": True, "need_password": True}
        me = await _me(c)
    _save_state({"me": me})  # 只留登录态缓存（验证码 hash 已作废）
    return {"ok": True, "signed_in": True, "me": me}


async def _c_password(args: dict) -> dict:
    password = str(args.get("password") or "")
    if not password:
        return {"ok": False, "error": "请输入两步验证密码", "etype": "ValueError"}

    if tg_net.local_auth_key() is not False and _load_state().get("me"):
        outcome, me, _err_net = await _probe_session()
        if outcome in ("valid", "offline"):
            return {"ok": True, "already": True, "me": me}

    async with _online() as c:
        await c.sign_in(password=password)
        me = await _me(c)
    _save_state({"me": me})
    return {"ok": True, "signed_in": True, "me": me}


async def _c_list_chats(args: dict) -> dict:
    from scripts.client import TGClient

    def _go():
        return TGClient().list_chats(args.get("chat_type") or None)

    return {"ok": True, "chats": await asyncio.to_thread(_go)}


async def _c_sync(args: dict) -> dict:
    from scripts.client import TGClient

    chat = args.get("chat")
    limit = int(args.get("limit") or 1000)

    def _go():
        return TGClient().sync(chat, limit=limit)

    added = await asyncio.to_thread(_go)
    return {"ok": True, "chat": chat, "added": added}


async def _c_refresh(args: dict) -> dict:
    from scripts.client import TGClient

    limit = int(args.get("limit_per_chat") or 500)
    delay = float(args.get("delay") if args.get("delay") is not None else 1.0)
    max_chats = args.get("max_chats")
    max_chats = int(max_chats) if max_chats not in (None, "", 0) else None

    capped: list[str] = []

    def _go():
        return TGClient().refresh(
            limit_per_chat=limit, delay=delay, max_chats=max_chats, capped_out=capped
        )

    result = await asyncio.to_thread(_go)
    total = sum(result.values())
    return {"ok": True, "total": total, "chats": result, "capped": capped}


async def _c_logout(args: dict) -> dict:
    """退出登录：**只清理本机**（断开常驻连接 + 删 session 文件 + 清登录缓存）。

    刻意不调用 auth.logOut —— 脚本永远不在服务端做任何终止操作，
    从机制上保证不会波及手机等其他已登录设备。
    （手机端“活跃会话”里可能残留一条本脚本的旧记录，可随时在手机上手动终止。）
    """
    await _drop_session()
    return {"ok": True, "logged_out": True, "scope": "local"}


# ── 离线命令（本地 SQLite）─────────────────────────────────────────────────

def _client():
    from scripts.client import TGClient
    return TGClient()


def _c_stats(_args: dict) -> dict:
    return {"ok": True, **_client().stats()}


def _c_local_chats(_args: dict) -> dict:
    return {"ok": True, "chats": _client().local_chats()}


def _read_ok(key: str, rows: list, chat, *, with_count: bool = True, limit: int | None = None) -> dict:
    payload: dict = {"ok": True, key: rows if limit is None else rows[:limit]}
    if with_count:
        payload["count"] = len(rows)
    if chat:
        payload["chat"] = chat
    return payload


def _read_missing_sync(key: str, chat: str, note: str, *, with_count: bool = True) -> dict:
    """会话还没同步进本地库：**降级为空结果**而不是报错。

    以前这里抛 ChatNotFoundError → 前端弹「本地库中没有会话…（请先同步）」，
    但用户正是要同步/查看时看到它，且发一条消息把会话写进本地库后才消失，
    体感就是「必须先发消息才能同步」。现在返回空 + needs_sync，
    前端据此自动先同步一次再重读。
    """
    payload: dict = {
        "ok": True,
        key: [],
        "needs_sync": True,
        "chat": chat,
        "note": note,
    }
    if with_count:
        payload["count"] = 0
    return payload


def _guard_chat(runner, key: str, chat, *, with_count: bool = True, limit: int | None = None) -> dict:
    """执行本地读命令；ChatNotFoundError → needs_sync 空结果（见上）。"""
    from scripts.exceptions import ChatNotFoundError

    try:
        rows = runner()
    except ChatNotFoundError as e:
        return _read_missing_sync(key, str(chat or ""), str(e), with_count=with_count)
    return _read_ok(key, rows, chat, with_count=with_count, limit=limit)


def _c_search(args: dict) -> dict:
    return _guard_chat(
        lambda: _client().search(
            str(args.get("keyword") or ""),
            chat=args.get("chat") or None,
            sender=args.get("sender") or None,
            hours=int(args["hours"]) if args.get("hours") else None,
            regex=bool(args.get("regex")),
            limit=int(args.get("limit") or 50),
        ),
        "messages",
        args.get("chat") or None,
    )


def _c_filter(args: dict) -> dict:
    return _guard_chat(
        lambda: _client().filter(
            str(args.get("keywords") or ""),
            chat=args.get("chat") or None,
            hours=int(args["hours"]) if args.get("hours") else None,
        ),
        "messages",
        args.get("chat") or None,
        limit=int(args.get("limit") or 100),
    )


def _c_today(args: dict) -> dict:
    limit = int(args.get("limit") or 5000)
    return _guard_chat(
        lambda: _client().today(chat=args.get("chat") or None, limit=limit),
        "messages",
        args.get("chat") or None,
    )


def _c_recent(args: dict) -> dict:
    return _guard_chat(
        lambda: _client().recent(
            hours=int(args.get("hours") or 24),
            chat=args.get("chat") or None,
            sender=args.get("sender") or None,
            limit=int(args.get("limit") or 100),
        ),
        "messages",
        args.get("chat") or None,
    )


def _c_top_senders(args: dict) -> dict:
    return _guard_chat(
        lambda: _client().top_senders(
            chat=args.get("chat") or None,
            hours=int(args["hours"]) if args.get("hours") else None,
            limit=int(args.get("limit") or 20),
        ),
        "rows",
        args.get("chat") or None,
        with_count=False,
    )


def _c_timeline(args: dict) -> dict:
    return _guard_chat(
        lambda: _client().timeline(
            chat=args.get("chat") or None,
            hours=int(args["hours"]) if args.get("hours") else None,
            granularity=str(args.get("granularity") or "day"),
        ),
        "rows",
        args.get("chat") or None,
        with_count=False,
    )


def _c_delete_chat(args: dict) -> dict:
    removed = _client().delete_chat(str(args.get("chat") or ""))
    return {"ok": True, "removed": removed}


def _c_set_api(args: dict) -> dict:
    """保存 / 清除自定义 API 凭证（写入 ~/.tg-hub/api.json）。"""
    from scripts.config import write_api_config

    msg = write_api_config(
        str(args.get("api_id") or "").strip(),
        str(args.get("api_hash") or "").strip(),
    )
    # 凭证变了 → 丢弃按旧凭证建立的常驻连接，下次联网时按新凭证重建
    try:
        tg_net.run_on_loop(tg_net.reset(), 10)
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "message": msg}


# ── 发送消息 ─────────────────────────────────────────────────────────────────

_MSG_LIMIT = 4000  # Telegram 单条上限 4096 字符，留余量并优先按行切分


def _split_message_text(text: str, limit: int = _MSG_LIMIT) -> list[str]:
    """超长文本切成多条（优先在换行处断开），避免 send_message 超限。"""
    parts: list[str] = []
    rest = text
    while len(rest) > limit:
        cut = rest.rfind("\n", 0, limit)
        if cut < limit // 2:
            cut = limit
        parts.append(rest[:cut])
        rest = rest[cut:].lstrip("\n")
    if rest:
        parts.append(rest)
    return parts or [text]


# 支持的 HTML 格式标签（与前端格式面板一致；vendor/telethon/extensions/html.py 解析）
_HTML_TAG_NAMES = {
    "b", "strong", "i", "em", "u", "s", "del",
    "code", "pre", "a", "blockquote", "span",
}
_HTML_TAG_RE = re.compile(r"</?([A-Za-z][A-Za-z0-9-]*)[^>]*>")


def _has_html_format(text: str) -> bool:
    """消息里是否带格式面板插入的 HTML 标签（避免误伤含 '<' 的普通文本）。"""
    return any(m.group(1).lower() in _HTML_TAG_NAMES for m in _HTML_TAG_RE.finditer(text))


def _split_message_html(text: str, limit: int = _MSG_LIMIT) -> list[str]:
    """带 HTML 标签的超长消息切分：只在标签外断开，避免把标签劈成两半。"""
    parts: list[str] = []
    start = 0
    in_tag = False
    tag_start = -1
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "<":
            if not in_tag:
                tag_start = i
            in_tag = True
        elif ch == ">":
            in_tag = False
        if in_tag:
            if i - tag_start >= 500:  # 真标签不会这么长，按字面文本强制断开
                parts.append(text[start:i])
                start = i
                in_tag = False
        elif i - start >= limit:
            # 此时一定在标签外，任意位置断开都安全；优先在换行处
            nl = text.rfind("\n", start, i)
            cut = nl + 1 if nl >= start + limit // 2 else i
            parts.append(text[start:cut])
            start = cut
        i += 1
    if start < n:
        parts.append(text[start:])
    return parts or [text]


def _balance_html(part: str) -> str:
    """补全本段没闭合的标签，丢掉属于上一段的孤立闭合标签（每段独立合法）。"""
    stack: list[str] = []
    out: list[str] = []
    pos = 0
    for m in _HTML_TAG_RE.finditer(part):
        name = m.group(1).lower()
        if name not in _HTML_TAG_NAMES:
            continue  # 未知标签原样保留（解析时会被忽略）
        out.append(part[pos:m.start()])
        pos = m.end()
        if m.group(0).startswith("</"):
            if name in stack:
                idx = len(stack) - 1 - stack[::-1].index(name)
                while len(stack) > idx:
                    out.append("</%s>" % stack.pop())
            # 不在栈里的闭合标签属于上一段，丢弃
        else:
            stack.append(name)
            out.append(m.group(0))
    out.append(part[pos:])
    while stack:
        out.append("</%s>" % stack.pop())
    return "".join(out)


async def _resolve_send_entity(c, chat: str | None, chat_id=None):
    """把 chat_id（会话列表的 dialog.id，频道/群带 -100 标记）或会话名解析成 entity。

    顺序：数字 ID（精确，避免同名歧义）→ 用户名/邀请链接/session 缓存名
    → 全量 dialogs 精确匹配标题（兜底）。
    """
    for candidate in (chat_id, chat):
        if candidate in (None, ""):
            continue
        try:
            value = int(str(candidate).strip())
        except ValueError:
            continue
        try:
            return await c.get_entity(value)
        except Exception:
            pass
    name = str(chat or "").strip()
    if name:
        try:
            return await c.get_entity(name)
        except Exception:
            pass
        target = name.casefold()
        async for d in c.iter_dialogs():
            if (d.name or "").casefold() == target:
                return d.entity
    raise ValueError(f"找不到会话「{chat or chat_id}」，请先刷新会话列表")


async def _c_send_message(args: dict) -> dict:
    """向会话发送文本消息（以当前登录账号发出，可多条切分，回复可选）。"""
    chat = str(args.get("chat") or "").strip()
    chat_id = args.get("chat_id")
    text = str(args.get("text") or "")
    reply_to = args.get("reply_to")

    if chat == "" and chat_id in (None, ""):
        return {"ok": False, "error": "缺少目标会话", "etype": "ValueError"}
    if text.strip() == "":
        return {"ok": False, "error": "消息内容不能为空", "etype": "ValueError"}

    reply_id = None
    if reply_to not in (None, "", 0):
        try:
            reply_id = int(reply_to)
        except (TypeError, ValueError):
            reply_id = None

    async with _online() as c:
        entity = await _resolve_send_entity(c, chat or None, chat_id)
        # 带格式标签 → HTML 解析发送（引用/遮罩/粗体/斜体/等宽/链接/删除线/下划线/代码块）；
        # 否则保持纯文本，普通文本里的 '<' 不会被当成标签。
        use_html = _has_html_format(text)
        if use_html:
            chunks = [_balance_html(chunk) for chunk in _split_message_html(text)]
        else:
            chunks = _split_message_text(text)
        msgs = []
        for i, chunk in enumerate(chunks):
            msg = await c.send_message(
                entity,
                chunk,
                reply_to=reply_id if i == 0 else None,
                parse_mode="html" if use_html else None,
            )
            msgs.append(msg)

        chat_name = (
            getattr(entity, "title", None)
            or getattr(entity, "first_name", None)
            or chat
            or str(chat_id)
        )
        # 尽力把刚发的消息写入本地库（AI 分析 / 本地消息列表立刻可见；失败不影响发送）
        try:
            from scripts.db import MessageDB

            me = await _me(c)
            rows = [
                dict(
                    msg_id=msg.id,
                    chat_id=entity.id,
                    chat_name=chat_name,
                    sender_id=me["id"],
                    sender_name=me["name"] or None,
                    content=chunk,
                    timestamp=msg.date,
                )
                for msg, chunk in zip(msgs, chunks)
            ]
            with MessageDB() as db:
                db.insert_batch(rows)
        except Exception:
            pass

    return {
        "ok": True,
        "sent": len(msgs),
        "message_ids": [m.id for m in msgs],
        "chat": chat_name,
    }


async def _c_send_messages(args: dict) -> dict:
    """批量发送多条消息到同一会话：一次连接循环发，供 AI 动作批量执行用。

    相比逐条 dispatch send_message（每条一次 Python.run + Telegram 握手），
    这里只建一次连接，条间隔 0.15s，整体快一个数量级。
    """
    chat = str(args.get("chat") or "").strip()
    chat_id = args.get("chat_id")
    raw_texts = args.get("texts")
    if chat == "" and chat_id in (None, ""):
        return {"ok": False, "error": "缺少目标会话", "etype": "ValueError"}
    texts: list[str] = []
    if isinstance(raw_texts, list):
        texts = [str(t) for t in raw_texts if str(t).strip() != ""][:30]
    if not texts:
        return {"ok": False, "error": "消息内容不能为空", "etype": "ValueError"}

    sent_ids: list[int] = []
    failed: list[dict] = []
    async with _online() as c:
        entity = await _resolve_send_entity(c, chat or None, chat_id)
        chat_name = (
            getattr(entity, "title", None)
            or getattr(entity, "first_name", None)
            or chat
            or str(chat_id)
        )
        me = None
        rows = []
        for idx, t in enumerate(texts):
            use_html = _has_html_format(t)
            body = _balance_html(t) if use_html else t
            try:
                msg = await c.send_message(
                    entity, body, parse_mode="html" if use_html else None
                )
                sent_ids.append(msg.id)
                if me is None:
                    try:
                        me = await _me(c)
                    except Exception:
                        me = {}
                rows.append(
                    dict(
                        msg_id=msg.id,
                        chat_id=entity.id,
                        chat_name=chat_name,
                        sender_id=me.get("id"),
                        sender_name=me.get("name") or None,
                        content=body,
                        timestamp=msg.date,
                    )
                )
            except Exception as e:  # noqa: BLE001 单条失败不中断后续
                failed.append({"index": idx, "error": str(e)})
            if idx < len(texts) - 1:
                await asyncio.sleep(0.15)
        if rows:
            try:
                from scripts.db import MessageDB

                with MessageDB() as db:
                    db.insert_batch(rows)
            except Exception:
                pass

    result = {
        "ok": True,
        "sent": len(sent_ids),
        "message_ids": sent_ids,
        "chat": chat_name,
    }
    if failed:
        result["failed"] = failed
    return result


# ── 撤回 / 删除消息 ─────────────────────────────────────────────────────────────

async def _c_delete_messages(args: dict) -> dict:
    """撤回（删除）会话里的消息。

    默认删除「我」在该会话最新发出的 N 条（Telegram 里删除自己发的消息
    即对所有人撤回，且不限时长）；同时把本地库对应记录清掉，
    这样「查看最近消息 / AI 分析」里也不会再出现。
    也可传 message_ids 精确指定要删的消息（跳过条数逻辑）。
    """
    chat = str(args.get("chat") or "").strip()
    chat_id = args.get("chat_id")
    if chat == "" and chat_id in (None, ""):
        return {"ok": False, "error": "缺少目标会话", "etype": "ValueError"}

    try:
        limit = int(args.get("limit"))
    except (TypeError, ValueError):
        limit = 2
    limit = max(1, min(50, limit))

    mine_only = args.get("mine_only")
    mine_only = True if mine_only is None else bool(mine_only)

    ids: list[int] = []
    raw_ids = args.get("message_ids")
    if isinstance(raw_ids, list):
        for item in raw_ids:
            try:
                value = int(item)
            except (TypeError, ValueError):
                continue
            if value > 0:
                ids.append(value)

    async with _online() as c:
        entity = await _resolve_send_entity(c, chat or None, chat_id)
        if not ids:
            # iter 顺序：新 → 旧；只挑我发出的（m.out）直到凑够 limit
            fetched = await c.get_messages(entity, limit=300)
            for msg in fetched:
                if msg is None:
                    continue
                if mine_only and not getattr(msg, "out", False):
                    continue
                ids.append(msg.id)
                if len(ids) >= limit:
                    break
        if not ids:
            return {
                "ok": False,
                "error": "没有可撤回的消息（最近 300 条里没有你发出的消息）",
                "etype": "NotFound",
            }
        await c.delete_messages(entity, ids, revoke=True)
        # AffectedMessages 在部分情况下只有 pts/pts_count、拿不到删除条数，
        # 所以删完再查一遍：已消失的即真正删掉的（顺便确认服务端确实删了）。
        try:
            after = await c.get_messages(entity, ids=ids)
            after_list = after if isinstance(after, list) else [after]
            remaining = sum(1 for item in after_list if item is not None)
            deleted_n = max(0, len(ids) - remaining)
        except Exception:
            # 查询失败时视为全部删除（删除请求本身已成功返回）
            deleted_n = len(ids)

        chat_name = (
            getattr(entity, "title", None)
            or getattr(entity, "first_name", None)
            or chat
            or str(chat_id)
        )
        # 服务端确实删掉了才同步本地库（失败不影响撤回）
        if deleted_n > 0:
            try:
                from scripts.db import MessageDB

                with MessageDB() as db:
                    db.delete_messages(entity.id, ids)
            except Exception:
                pass

    if deleted_n <= 0:
        return {
            "ok": False,
            "error": "没有删除任何消息（消息可能已被删除，或你没有权限删除）",
            "etype": "DeleteFailed",
            "message_ids": ids,
            "chat": chat_name,
        }
    return {
        "ok": True,
        "deleted": deleted_n,
        "message_ids": ids,
        "chat": chat_name,
    }


# ── 退出会话 ─────────────────────────────────────────────────────────────────

async def _c_leave_chat(args: dict) -> dict:
    """退出会话（退群）：频道/超级群 → LeaveChannel；普通群 → DeleteChatUser(me)。

    私聊没有「退群」概念，直接报错（删除私聊历史属于另一回事，未在此实现）。
    退出后该会话自然从 list_chats 消失；本地消息记录保留在「清理」里处理。
    """
    chat = str(args.get("chat") or "").strip()
    chat_id = args.get("chat_id")
    if chat == "" and chat_id in (None, ""):
        return {"ok": False, "error": "缺少目标会话", "etype": "ValueError"}

    async with _online() as c:
        entity = await _resolve_send_entity(c, chat or None, chat_id)
        chat_name = _entity_name(entity, chat, chat_id)
        action = await _leave_entity(c, entity)

    return {"ok": True, "action": action, "chat": chat_name}


def _entity_name(entity, chat="", chat_id=None) -> str:
    return (
        getattr(entity, "title", None)
        or getattr(entity, "first_name", None)
        or str(chat or "")
        or str(chat_id or "")
    )


async def _leave_entity(c, entity) -> str:
    """退出单个会话，返回动作描述；私聊抛 ValueError。"""
    from telethon import functions
    from telethon.tl.types import Channel, Chat, InputUserSelf, User

    if isinstance(entity, Channel):
        await c(functions.channels.LeaveChannelRequest(await c.get_input_entity(entity)))
        return "已退出频道/超级群"
    if isinstance(entity, Chat):
        await c(functions.messages.DeleteChatUserRequest(entity.id, InputUserSelf()))
        return "已退出群"
    if isinstance(entity, User):
        raise ValueError("私聊会话，没有「退群」操作")
    raise ValueError(f"不支持的会话类型：{type(entity).__name__}")


async def _destroy_entity(c, entity) -> str:
    """永久删除自己创建的频道/普通群；非创建者直接拒绝（服务端也会拒绝）。"""
    from telethon import functions
    from telethon.tl.types import Channel, Chat, User

    if isinstance(entity, Channel):
        if not getattr(entity, "creator", False):
            raise PermissionError("你不是该频道的创建者，无法删除（只能退出）")
        await c(functions.channels.DeleteChannelRequest(await c.get_input_entity(entity)))
        return "已永久删除该频道"
    if isinstance(entity, Chat):
        if not getattr(entity, "creator", False):
            raise PermissionError("你不是该群的创建者，无法删除（只能退出）")
        await c(functions.messages.DeleteChatRequest(entity.id))
        return "已永久删除该群"
    if isinstance(entity, User):
        raise ValueError("私聊无法删除")
    raise ValueError(f"不支持的会话类型：{type(entity).__name__}")


async def _c_destroy_chat(args: dict) -> dict:
    """永久删除自己创建的频道/群（不可恢复；非创建者报错）。"""
    chat = str(args.get("chat") or "").strip()
    chat_id = args.get("chat_id")
    if chat == "" and chat_id in (None, ""):
        return {"ok": False, "error": "缺少目标会话", "etype": "ValueError"}

    async with _online() as c:
        entity = await _resolve_send_entity(c, chat or None, chat_id)
        chat_name = _entity_name(entity, chat, chat_id)
        action = await _destroy_entity(c, entity)

    return {"ok": True, "action": action, "chat": chat_name}


async def _c_bulk_leave(args: dict) -> dict:
    """批量退出/删除会话。

    参数：`chats`: [dialog id...]（list_chats 返回的 id，含 -100 标记），
    `action`: "leave"（退出）| "delete"（永久删除，仅创建者）；上限 100 个，
    逐个执行、间隔 0.6s 防风控，单个失败不影响其余。
    返回：`done`（成功名单）、`failed`（失败名单 + 原因）。
    """
    action = "delete" if str(args.get("action") or "") == "delete" else "leave"
    raw = args.get("chats")
    ids: list[int] = []
    if isinstance(raw, list):
        for item in raw[:100]:
            try:
                value = int(item)
            except (TypeError, ValueError):
                continue
            if value:
                ids.append(value)
    if not ids:
        return {"ok": False, "error": "没有要处理的会话（先在列表里勾选/筛选）", "etype": "ValueError"}

    done: list[dict] = []
    failed: list[dict] = []
    async with _online() as c:
        for i, cid in enumerate(ids):
            name = str(cid)
            try:
                entity = await c.get_entity(cid)
                name = _entity_name(entity)
                label = (
                    await _destroy_entity(c, entity)
                    if action == "delete"
                    else await _leave_entity(c, entity)
                )
                done.append({"name": name, "action": label})
            except Exception as e:  # noqa: BLE001 —— 单个失败继续下一个
                failed.append({"name": name, "error": str(e)})
            if i < len(ids) - 1:
                await asyncio.sleep(0.6)

    return {
        "ok": True,
        "action": action,
        "done": done,
        "failed": failed,
        "processed": len(ids),
    }


# ── 加入会话 ─────────────────────────────────────────────────────────────────

def _parse_join_ref(raw: str) -> tuple[str, str]:
    """把用户输入归一成 ("invite", 邀请 hash) 或 ("username", 名字)。

    接受：t.me/+xxx / t.me/joinchat/xxx / 裸 +xxx / t.me/username / @username / 裸用户名。
    """
    import re

    s = raw.strip()
    m = re.search(r"(?:t\.me|telegram\.me)/(?:\+|joinchat/)([A-Za-z0-9_-]+)", s)
    if m:
        return "invite", m.group(1)
    bare = s.lstrip("@")
    if bare.startswith("+") and len(bare) > 1:
        return "invite", bare[1:]
    m = re.search(r"(?:t\.me|telegram\.me)/([A-Za-z][A-Za-z0-9_]{3,})", bare)
    if m:
        return "username", m.group(1)
    if re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{3,}", bare):
        return "username", bare
    raise ValueError("请填写邀请链接（t.me/+xxx）或公开群/频道的 @用户名")


async def _c_join_chat(args: dict) -> dict:
    """加入群组 / 频道：邀请链接（t.me/+xxx、joinchat）或公开 @用户名。

    成功返回加入的会话名与 id；重复加入/链接失效等错误由 _err 映射成人话。
    """
    raw = str(args.get("chat") or "").strip()
    if raw == "":
        return {"ok": False, "error": "请提供邀请链接或 @用户名", "etype": "ValueError"}
    try:
        kind, ref = _parse_join_ref(raw)
    except ValueError as e:
        return {"ok": False, "error": str(e), "etype": "ValueError"}

    from telethon import functions

    async with _online() as c:
        if kind == "invite":
            result = await c(functions.messages.ImportChatInviteRequest(ref))
        else:
            result = await c(functions.channels.JoinChannelRequest(ref))
        chats = getattr(result, "chats", None) or []
        entity = chats[-1] if chats else await c.get_entity(ref)
        chat_name = _entity_name(entity, ref)

    return {"ok": True, "action": "已加入", "chat": chat_name, "id": getattr(entity, "id", None)}


def _c_shutdown(_args: dict) -> dict:
    """脚本退出：断开常驻连接并停掉后台循环，不留任何后台连接。"""
    tg_net.shutdown()
    return {"ok": True, "shutdown": True}


# ── 分发 ─────────────────────────────────────────────────────────────────────

_ONLINE = {
    "status": _c_status,
    "send_code": _c_send_code,
    "sign_in": _c_sign_in,
    "password": _c_password,
    "list_chats": _c_list_chats,
    "sync": _c_sync,
    "refresh": _c_refresh,
    "send_message": _c_send_message,
    "send_messages": _c_send_messages,
    "delete_messages": _c_delete_messages,
    "leave_chat": _c_leave_chat,
    "destroy_chat": _c_destroy_chat,
    "bulk_leave": _c_bulk_leave,
    "join_chat": _c_join_chat,
    "logout": _c_logout,
}

_OFFLINE = {
    "stats": _c_stats,
    "local_chats": _c_local_chats,
    "search": _c_search,
    "filter": _c_filter,
    "today": _c_today,
    "recent": _c_recent,
    "top_senders": _c_top_senders,
    "timeline": _c_timeline,
    "delete_chat": _c_delete_chat,
    "set_api": _c_set_api,
    "shutdown": _c_shutdown,
}

ALL_COMMANDS = sorted(set(_ONLINE) | set(_OFFLINE))

# 各命令默认超时（秒）。前端可通过参数 __timeout 覆盖。
_DEFAULT_TIMEOUTS: dict[str, float] = {
    "status": 45,
    "send_code": 60,
    "sign_in": 60,
    "password": 60,
    "logout": 60,
    "list_chats": 120,
    "sync": 600,
    "refresh": 900,
    "send_message": 90,
    "send_messages": 180,
    "delete_messages": 60,
    "leave_chat": 60,
    "destroy_chat": 60,
    "bulk_leave": 600,
    "join_chat": 120,
    "shutdown": 20,
}


def _run_guarded(fn, timeout: float) -> dict:
    """在守护线程里执行 fn，join 超时则先行返回 Timeout。

    Scripting 的 Python.run 不支持超时（官方文档），且与 Shell.run 共享
    串行队列——命令卡住会冻住整个面板。这里用守护线程 + join 超时兜底：
    超时后主线程先行返回，后台线程继续跑完（daemon，不会阻塞解释器退出）。
    """
    box: dict = {}

    def _worker():
        try:
            box["payload"] = fn()
        except BaseException as e:  # noqa: BLE001
            payload = _err(e)
            payload["trace"] = traceback.format_exc(limit=4)
            box["payload"] = payload

    t = threading.Thread(target=_worker, daemon=True, name="tg-hub-cmd")
    t.start()
    t.join(timeout)
    if t.is_alive():
        return {
            "ok": False,
            "error": (
                f"命令超时（{int(timeout)}s），已中断；"
                "后台仍会继续执行，建议稍后点刷新查看结果"
            ),
            "etype": "Timeout",
        }
    return box.get("payload") or {"ok": False, "error": "命令无返回", "etype": "NoOutput"}


def dispatch(cmd: str, args_json: str = "{}") -> dict:
    """执行命令并打印哨兵 JSON。任何异常都会被捕获并以 JSON 返回。"""
    try:
        args = json.loads(args_json) if args_json else {}
        if not isinstance(args, dict):
            raise ValueError("args must be a JSON object")
        # 前端透传的超时（秒），非法值回退到默认表
        raw_timeout = args.pop("__timeout", None)
        try:
            timeout = (
                float(raw_timeout)
                if raw_timeout not in (None, "")
                else float(_DEFAULT_TIMEOUTS.get(cmd, 60))
            )
        except (TypeError, ValueError):
            timeout = float(_DEFAULT_TIMEOUTS.get(cmd, 60))
        timeout = min(max(timeout, 5.0), 3600.0)
        if cmd in _OFFLINE:
            fn = lambda: _OFFLINE[cmd](args)  # noqa: E731
        elif cmd in _ONLINE:
            # 联网命令一律调度到常驻单连接所在的事件循环上执行：
            # 保证同一登录会话永远只有一条主连接（多连接 = 会话被服务端注销）。
            # 比 UI 超时多留 5s，让 _run_guarded 先返回统一的超时文案。
            fn = lambda: tg_net.run_on_loop(_ONLINE[cmd](args), timeout + 5)  # noqa: E731
        else:
            payload = {"ok": False, "error": f"unknown command: {cmd}", "etype": "UnknownCommand",
                       "commands": ALL_COMMANDS}
            emit(payload)
            return payload
        payload = _run_guarded(fn, timeout)
    except Exception as e:  # noqa: BLE001
        payload = _err(e)
        payload["trace"] = traceback.format_exc(limit=4)
    emit(payload)
    return payload


if __name__ == "__main__":
    _cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    _args = sys.argv[2] if len(sys.argv) > 2 else "{}"
    dispatch(_cmd, _args)
