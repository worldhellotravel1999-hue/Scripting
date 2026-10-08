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
    # 审计 #9：真正调用 parse 的是 `utils.sanitize_parse_mode('html')` → 返回
    # `telethon/utils.py` 顶部 `from .extensions import html` 首次导入时绑定的
    # **模块对象**。若常驻解释器先加载了另一副本的 utils，它的 `html` 还是
    # 旧模块，上面的锁定对 send_message(parse_mode='html') 不生效（遮罩/水印
    # 静默降级）。这里把已加载的 utils.html 也指回本副本。
    _utils = _sys.modules.get("telethon.utils")
    if _utils is not None:
        _u_html = getattr(_utils, "html", None)
        _u_file = os.path.realpath(str(getattr(_u_html, "__file__", "") or ""))
        if _u_file != _html_file:
            _cur2 = _sys.modules.get("telethon.extensions.html")
            if _cur2 is not None and os.path.realpath(str(getattr(_cur2, "__file__", "") or "")) == _html_file:
                _utils.html = _cur2
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
        # allow_nan=False：裸 NaN/Infinity 是非法 JSON，前端 JSON.parse 会直接抛；
        # 走 _sanitize 重写成 null，比让面板拿到 ParseError 强。
        line = SENTINEL + json.dumps(obj, ensure_ascii=False, default=str, allow_nan=False)
    except (ValueError, TypeError):
        try:
            line = SENTINEL + json.dumps(_sanitize(obj), ensure_ascii=False, default=str)
        except Exception:
            line = SENTINEL + '{"ok": false, "error": "result not serializable"}'
    try:
        print(line, flush=True)
    except Exception:
        # 孤立代理符等导致 print 编码失败时，至少把结构化错误吐出去，
        # 否则 api.ts 扫不到哨兵行 → 报「无响应」。
        try:
            print(SENTINEL + '{"ok": false, "error": "result not printable", "etype": "EncodeError"}', flush=True)
        except Exception:
            pass


def _sanitize(obj):
    """json.dumps(allow_nan=False) 失败后的降级：把 NaN/Inf 折成 null。"""
    if isinstance(obj, float):
        return None if (obj != obj or obj in (float("inf"), float("-inf"))) else obj
    if isinstance(obj, dict):
        return {k: _sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitize(v) for v in obj]
    return obj


# ── 通用工具 ─────────────────────────────────────────────────────────────────

def _state_path() -> Path:
    # 登录态缓存（me / phone_code_hash）按「当前账号」隔离：
    # default 账号沿用 login_state.json（老用户零迁移），其他账号各自一个文件。
    from scripts.config import active_sid, state_path_for

    return state_path_for(active_sid())


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
    # tmp 加唯一后缀：固定 tmp 名在并发写时会交错截断（见 config.save_accounts）
    tmp = p.with_name(f"{p.name}.{os.getpid()}-{time.time_ns()}.tmp")
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


def _sync_account(me: dict | None) -> None:
    """探测/登录拿到 me → 回写多账号注册表（顺带清掉指向本账号的 pending）。"""
    if not me:
        return
    try:
        from scripts.config import upsert_account
        upsert_account(me)
    except Exception:  # noqa: BLE001 — 注册表失败不影响登录主流程
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


async def _me_avatar(c, user) -> str:
    """当前账号头像 → 本地路径（面板用它替换默认小人图标）。

    缓存：~/.tg-hub/avatars/<photo_id>.jpg（与会话列表同一套缓存，
    换头像会换 photo_id → 自动重新下载）；未缓存则现场下载一次。
    头像是锦上添花：任何失败/超时都返回 ""，绝不影响 status 主流程。
    """
    try:
        from scripts.client import _avatar_target

        cached, todo = _avatar_target(user)
        if cached:
            return cached
        if not todo:
            return ""
        tmp = todo + ".tmp"
        try:
            # 先下到临时文件再原子改名：下载中途被取消/断网不会留下半个文件，
            # 否则下次会被当成「已缓存」展示出坏图。
            await asyncio.wait_for(c.download_profile_photo(user, file=tmp), 15)
            if os.path.isfile(tmp) and os.path.getsize(tmp) > 0:
                os.replace(tmp, todo)
                return todo
        finally:
            try:
                Path(tmp).unlink(missing_ok=True)
            except OSError:
                pass
    except Exception:  # noqa: BLE001 —— 头像失败只表现为继续用默认图标
        return ""
    return ""


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
            # 审计 #11：先**收集完**两个结果再定性——以前逐个 raise，前一个
            # 已命中吊销、后一个恰好是网络错时会被 raise 覆盖成 offline，
            # 死会话继续当已登录（弱网下两结果一吊销一网络错并不罕见）。
            # 吊销是服务端的确定性结论，优先于网络层猜测。
            errors = [r for r in (state_r, me_r) if isinstance(r, BaseException)]
            for r in errors:
                if _is_revoked(r):
                    revoked = True
            if not revoked and errors:
                raise errors[0]  # 非吊销错误 → 外层按 offline 处理
            # 2026-10-06 修复：以前这里直接 return "valid", _me_dict(me_r)——
            # 当密钥已被服务端注销时 GetState 抛 AuthKeyUnregisteredError 而
            # get_me() 返回 None，`_me_dict(None)` 的 AttributeError 会被外层
            # 当成网络错误 → 报 offline（“已按本地登录状态继续”），死会话被当成
            # 活会话，登录页因此反复报错。现在先收口 revoked 再谈 valid。
            if revoked:
                pass  # 落到 try 之后的清理分支
            elif me_r is None:
                # 连得上、请求也正常返回，却拿不到自己 → 服务端不认这把密钥
                revoked = True
            else:
                me = _me_dict(me_r)
                me["avatar"] = await _me_avatar(c, me_r)  # 缓存命中时零成本
                return "valid", me, None
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

async def _c_status(args: dict) -> dict:
    from scripts.config import (
        active_sid,
        api_configured,
        get_db_path,
        get_data_dir,
        get_session_path,
        load_accounts,
    )

    # local=true：启动路径专用——只做本地判定（凭证/密钥/登录缓存），
    # **不发任何网络请求**，毫秒级返回。联网复核（吊销/离线检测）由前端
    # 在进入主界面后用普通 status 后台补跑，慢网络不再卡启动遮罩。
    local_only = bool(args.get("local"))

    has_key = tg_net.local_auth_key()
    has_api = api_configured()
    reg = load_accounts()  # 多账号注册表（一次读取）
    info = {
        "session_path": get_session_path() + ".session",
        "session_exists": Path(get_session_path() + ".session").exists(),
        "local_session": has_key,  # 本地是否存有登录密钥（不联网即可判定）
        "db_path": str(get_db_path()),
        "db_exists": get_db_path().exists(),
        "data_dir": str(get_data_dir()),
        "has_api": has_api,  # 是否已配置自己的 api_id/api_hash（公共凭证已移除）
        "has_login_state": _state_path().exists(),
        # 多账号：当前 sid + 账号列表（含 has_session 标记）+ 是否处于“添加账号”中途
        "account_sid": active_sid(),
        "accounts": _accounts_info(),
        "adding": reg.get("pending") is not None,
    }

    # 没有凭证就无法连接 Telegram（公共凭证已删除）→ 先要求在登录页填凭证，
    # 不发任何网络请求。
    if not has_api:
        return {**info, "ok": True, "authorized": False, "me": None, "need_api": True}

    # 本地确定没有登录密钥 → 直接回登录页，不发任何网络请求
    # （启动秒出，也避免无谓连接）。
    if has_key is False:
        return {**info, "ok": True, "authorized": False, "me": None}

    # 正在登录流程中（已发码、尚未 sign_in）：新密钥还没在服务端注册，
    # 探测必然拿到 AuthKeyUnregisteredError —— **绝不能当 revoked 处理**：
    # 清理会连带删掉 login_state 里的 phone_code_hash，验证码直接作废。
    # （get_me() 返回 None 同理，见 _probe_session 的 me_r is None 分支。）
    st = _load_state()
    if st.get("phone_code_hash") and not st.get("me"):
        return {**info, "ok": True, "authorized": False, "me": None, "logging_in": True}

    # 本地模式 + 本地明确有密钥 → 直接按已登录返回（me 用登录缓存），
    # 密钥文件读不出来（None）时仍需联网探测才能定论。
    if local_only and has_key is True:
        _sync_account(st.get("me"))  # 本地快路径也回写注册表（老用户首次迁移）
        return {
            **info,
            "ok": True,
            "authorized": True,
            "me": st.get("me"),
            "local_only": True,
        }

    outcome, me, net_err = await _probe_session()
    if outcome == "valid":
        _save_state({**_load_state(), "me": me})
        _sync_account(me)
        return {**info, "ok": True, "authorized": True, "me": me}
    if outcome == "revoked":
        # 服务端明确注销了本会话（已清本地）→ 从注册表移除本账号并回落：
        # 还有其他账号 → 自动切到下一个再探一次（每次回落注册表都变短，必然终止）；
        # 没有其他账号 → 回登录页。
        from scripts.config import unregister_current

        fallback = unregister_current()
        if fallback:
            return await _c_status(args)
        # 审计 #10：info 是探测**前**的快照，此刻 session 已删、注册表已更新，
        # 原样返回会把 session_exists=True / 刚被移除的账号列表原封不动带给前端。
        st2 = _load_state()
        return {
            **info,
            "session_exists": Path(get_session_path() + ".session").exists(),
            "local_session": tg_net.local_auth_key(),
            "has_login_state": _state_path().exists(),
            "account_sid": active_sid(),
            "accounts": _accounts_info(),
            "adding": load_accounts().get("pending") is not None,
            "ok": True,
            "authorized": False,
            "me": None,
            "revoked": True,
        }
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
    from scripts.config import api_configured

    phone = str(args.get("phone", "")).strip()
    if not phone:
        return {"ok": False, "error": "缺少手机号", "etype": "ValueError"}
    if not api_configured():
        return {
            "ok": False,
            "error": "尚未配置 API 凭证，请先填写 api_id / api_hash",
            "etype": "NoApiConfig",
        }

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
    _sync_account(me)
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
    _sync_account(me)
    return {"ok": True, "signed_in": True, "me": me}


async def _c_list_chats(args: dict) -> dict:
    from scripts.client import TGClient

    def _go():
        return TGClient().list_chats(args.get("chat_type") or None)

    return {"ok": True, "chats": await asyncio.to_thread(_go)}


# sync 与 refresh 共用一个单飞名额（写同一批本地库、拉同一段历史）：
# 超时后台命令还在跑时，再来一条同类直接报 Busy，不并行。
_SYNC_GROUP = "sync-refresh"


async def _c_sync(args: dict) -> dict:
    from scripts.client import TGClient

    chat = args.get("chat")
    limit = int(args.get("limit") or 1000)

    if not tg_net.try_hold(_SYNC_GROUP):
        return {
            "ok": False,
            "error": "上一条同步/刷新仍在后台执行，请稍后再试",
            "etype": "Busy",
        }

    def _go():
        return TGClient().sync(chat, limit=limit)

    try:
        added = await asyncio.to_thread(_go)
    finally:
        tg_net.release_hold(_SYNC_GROUP)
    return {"ok": True, "chat": chat, "added": added}


async def _c_refresh(args: dict) -> dict:
    from scripts.client import TGClient

    limit = int(args.get("limit_per_chat") or 500)
    delay = float(args.get("delay") if args.get("delay") is not None else 1.0)
    max_chats = args.get("max_chats")
    max_chats = int(max_chats) if max_chats not in (None, "", 0) else None

    if not tg_net.try_hold(_SYNC_GROUP):
        return {
            "ok": False,
            "error": "上一条同步/刷新仍在后台执行，请稍后再试",
            "etype": "Busy",
        }

    capped: list[str] = []

    def _go():
        return TGClient().refresh(
            limit_per_chat=limit, delay=delay, max_chats=max_chats, capped_out=capped
        )

    try:
        result = await asyncio.to_thread(_go)
    finally:
        tg_net.release_hold(_SYNC_GROUP)
    total = sum(result.values())
    return {"ok": True, "total": total, "chats": result, "capped": capped}


async def _c_logout(args: dict) -> dict:
    """退出**当前账号**：只清理本机（断常驻连接 + 删该账号 session/state + 注销册表项）。

    刻意不调用 auth.logOut —— 脚本永远不在服务端做任何终止操作，
    从机制上保证不会波及手机等其他已登录设备。
    多账号（2026-10-07）：若还有其他已注册账号则自动切回第一个（返回 switched_to），
    否则落到 default 未登录态（回登录页）。
    本地消息库跨账号共用，不随退出删除。
    """
    from scripts.config import load_accounts, unregister_current

    sid_before = load_accounts().get("current")
    await _drop_session()  # 删**当前 sid** 的 session 文件 + 其 state（此时 current 仍是它）
    unregister_current()  # 从注册表移除，current 回落到第一个剩余账号或 default
    remaining = [a for a in (load_accounts().get("list") or []) if a.get("sid") != sid_before]
    return {
        "ok": True,
        "logged_out": True,
        "scope": "local",
        "switched_to": remaining[0].get("sid") if remaining else None,
    }


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
    """执行本地读命令；ChatNotFoundError → needs_sync 空结果（见上）。

    按**类名**捕获而不是按类对象：scripts.db 在 reload 时绑定异常类，指纹
    重载一旦把 exceptions 排到 db 之后（2026-10-07 实测 api.ts 就是这个顺序），
    两代 ChatNotFoundError 身份不同，`except ChatNotFoundError` 永远匹配不上，
    needs_sync 降级静默失效、前端直接弹「本地库中没有会话」硬错误。
    顺序已修，这里再兑一道（类名判定对类身份错位免疫）。
    """
    try:
        rows = runner()
    except Exception as e:  # noqa: BLE001
        if type(e).__name__ != "ChatNotFoundError":
            raise
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
    # 空串守卫：db.find_chats 对空串的部分匹配会命中全部会话，库里只有 1 个时
    # 就是把它整个删掉（审计 #8）。这里直接拒绝空值，不给它进 resolve 的机会。
    chat = str(args.get("chat") or "").strip()
    if not chat:
        raise ValueError("请提供要删除本地记录的会话名（或 chat_id）")
    removed = _client().delete_chat(chat)
    return {"ok": True, "removed": removed}


def _c_set_api(args: dict) -> dict:
    """保存 / 清除自定义 API 凭证（写入 ~/.tg-hub/api.json）。"""
    from scripts.config import write_api_config

    msg = write_api_config(
        str(args.get("api_id") or "").strip(),
        str(args.get("api_hash") or "").strip(),
    )
    # 凭证变了，但**本地已有登录密钥时绝不立即断开重建连接**：
    # 断开后下一条命令马上重连，若服务端还没关掉旧连接就会两条连接并行
    # → AUTH_KEY_DUPLICATED → 会话被吊销 → 被迫手机号重新登录；
    # 而反复手机号登录正是服务端「批量登出全部设备（含手机）」的诱因。
    # 凭证只在新建客户端时读取，已登录会话的常规命令并不需要它；
    # 退出登录 / 会话被吊销 / 空闲 300s 断开后，下次联网自然按新凭证重建。
    if tg_net.local_auth_key() is not True:
        try:
            tg_net.run_on_loop(tg_net.reset(), 10)
        except Exception:  # noqa: BLE001
            pass
    else:
        msg += "；当前已登录，登录会话保持不变，新凭证在重新登录后生效"
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


# ── 多账号（2026-10-07，学 IPA-Tool 账号切换）────────────────────────────

def _sid_has_key(sid: str) -> bool:
    """只读探测某账号的 session 文件是否存有登录密钥（不联网）。"""
    import sqlite3

    from scripts.config import session_path_for

    p = Path(session_path_for(str(sid)) + ".session")
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
        return False


def _accounts_info() -> list[dict]:
    """注册表账号列表 + current/has_session 标记（前端菜单/账号页用）。"""
    from scripts.config import load_accounts

    reg = load_accounts()
    cur = reg.get("current")
    return [
        {**a, "current": a.get("sid") == cur, "has_session": _sid_has_key(a.get("sid"))}
        for a in (reg.get("list") or [])
    ]


def _accounts_payload() -> dict:
    from scripts.config import load_accounts

    reg = load_accounts()
    return {
        "account_sid": reg.get("current"),
        "accounts": _accounts_info(),
        "adding": reg.get("pending") is not None,
    }


def _purge_account_files(sid: str) -> None:
    """删除某账号的 session / 登录态（含 sqlite 伴生文件）。

    本地消息库**不删**（与旧版 logout 语义一致：退出只掉登录，
    同步过的数据保留；误删不可恢复）。
    """
    from scripts.config import session_path_for, state_path_for

    bases = [
        Path(session_path_for(str(sid)) + ".session"),
        state_path_for(str(sid)),
    ]
    for base in bases:
        for p in (base, Path(str(base) + "-wal"), Path(str(base) + "-shm"), Path(str(base) + "-journal")):
            try:
                p.unlink(missing_ok=True)
            except OSError:
                pass


def _drop_pending(reg: dict) -> dict:
    """放弃 pending：slot（未注册，不在 list）删残留文件；
    list 内的真实账号（重登中途）只回滚标记、保留登录态缓存。"""
    pend = reg.get("pending")
    if not pend:
        return reg
    psid = str(pend.get("sid"))
    known = {str(a.get("sid")) for a in (reg.get("list") or [])}
    if psid not in known:
        _purge_account_files(psid)
    reg["pending"] = None
    return reg


async def _c_account_switch(args: dict) -> dict:
    """切换到注册表里的另一个账号（丢弃常驻连接，下次按新 session 建链）。

    · 切到**有效**账号：直接换；若有 pending（添加中途 slot）先丢弃。
    · 切到**会话已失效**的账号：进入“重新登录”态（pending{sid, prev}）——
      登录成功自动注册回列表；登录页的「取消」可回滚到 prev，不会把人困死。
    """
    from scripts.config import load_accounts, save_accounts

    sid = str(args.get("sid") or "").strip()
    reg = load_accounts()
    if not sid:
        return {"ok": False, "error": "缺少账号 sid", "etype": "ValueError"}
    known = {str(a.get("sid")) for a in (reg.get("list") or [])}
    if sid not in known:
        return {"ok": False, "error": "账号不存在", "etype": "ValueError"}

    _drop_pending(reg)  # 放弃未完成的添加（slot 删文件；真实账号只回标记）

    if sid == reg.get("current"):
        save_accounts(reg)
        return {"ok": True, "noop": True, **_accounts_payload()}

    if not _sid_has_key(sid):
        # 会话已失效 → 置为 pending 进入重登流程（登录页出「取消」可回 prev）
        reg["pending"] = {"sid": sid, "prev": reg.get("current"), "at": int(time.time())}
        reg["current"] = sid
        save_accounts(reg)
        await tg_net.reset()
        return {"ok": True, "relogin": True, "account_sid": sid, **_accounts_payload()}

    reg["current"] = sid
    save_accounts(reg)
    await tg_net.reset()  # 旧账号连接必须先断，否则新命令会拿到旧 session 的客户端
    return {"ok": True, "account_sid": sid, **_accounts_payload()}


async def _c_account_add_begin(_args: dict) -> dict:
    """开始“添加账号”：开一个全新空 slot 并设为当前，丢弃旧连接。

    随后的 send_code/sign_in/password 都落在新 slot 的 session 上；
    登录成功后 _sync_account 把它注册进列表并清掉 pending。
    失败/中途退出 → account_cancel_add 回滚到 prev。
    """
    from scripts.config import load_accounts, save_accounts, session_path_for

    reg = load_accounts()
    if reg.get("pending"):
        # 上次添加中途退出（重启后仍在）→ 复用现有 slot，不重复开
        return {"ok": True, "already": True, **_accounts_payload()}
    base = f"acc{int(time.time())}"
    sid = base
    taken = {str(a.get("sid")) for a in (reg.get("list") or [])}
    n = 1
    while sid in taken or Path(session_path_for(sid) + ".session").exists():
        n += 1
        sid = f"{base}_{n}"
    reg["pending"] = {"sid": sid, "prev": reg.get("current"), "at": int(time.time())}
    reg["current"] = sid
    save_accounts(reg)
    await tg_net.reset()
    return {"ok": True, "account_sid": sid, **_accounts_payload()}


async def _c_account_add_cancel(_args: dict) -> dict:
    """取消“添加账号”/ 中止重登：回到 prev 账号。

    slot（未注册）连文件一起删；list 内的重登账号只回滚标记（保留其缓存）。
    """
    from scripts.config import load_accounts, save_accounts

    reg = load_accounts()
    pend = reg.get("pending")
    if not pend:
        return {"ok": True, "noop": True, **_accounts_payload()}
    prev = str(pend.get("prev") or "default")
    known = {str(a.get("sid")) for a in (reg.get("list") or [])}
    if prev not in known and prev != "default":
        prev = reg["list"][0].get("sid") if reg.get("list") else "default"
    _drop_pending(reg)
    reg["current"] = prev
    save_accounts(reg)
    await tg_net.reset()
    return {"ok": True, "account_sid": prev, **_accounts_payload()}


async def _c_account_remove(args: dict) -> dict:
    """移除非当前账号：删注册表项 + session/登录态/本地库文件（需前端确认）。"""
    from scripts.config import load_accounts, save_accounts

    sid = str(args.get("sid") or "").strip()
    reg = load_accounts()
    if not sid:
        return {"ok": False, "error": "缺少账号 sid", "etype": "ValueError"}
    if sid == reg.get("current"):
        return {"ok": False, "error": "当前账号请用「退出登录」移除", "etype": "ValueError"}
    if sid not in {str(a.get("sid")) for a in (reg.get("list") or [])}:
        return {"ok": False, "error": "账号不存在", "etype": "ValueError"}
    if reg.get("pending") and str(reg["pending"].get("sid")) == sid:
        reg["pending"] = None
    reg["list"] = [a for a in (reg.get("list") or []) if str(a.get("sid")) != sid]
    save_accounts(reg)
    _purge_account_files(sid)
    # 移除的是非当前账号 → 常驻连接不受影响，无需 reset
    return {"ok": True, **_accounts_payload()}


# ── 机器人签到（AI 视觉模拟点击，娱乐功能）────────────────────────────────────
#
# 本地库同步只存纯文本（scripts/client.py::_fetch_history 跳过无 caption 的图片，
# 也不存 reply_markup），而签到要看的恰恰是机器人回复里的**图片 + 内联按钮**，
# 所以走实时抓取：
#   bot_checkin_probe  发一条指令（默认 /start）→ 等机器人回复 → 返回文本 /
#                      图片（base64）/ 内联按钮（callback data 用 base64 透传）
#   bot_checkin_act    按 AI 的决策点内联按钮（GetBotCallbackAnswer）或补发一条
#                      文本，再抓后续回复
# 「哪个是签到按钮」「签到是否成功」全部由前端 AI 看图判断，后端不写死业务。

_BOT_IMG_BYTES_MAX = 4 * 1024 * 1024   # 单张图片回传上限（超过只报 skipped）
_BOT_WAIT_GRACE = 1.5                  # 收到回复后再静默这么久才提前收口


def _bot_has_image(m) -> bool:
    """这条消息是否带可看图的媒体（照片 / 图片类文档）。"""
    try:
        if m.photo is not None:
            return True
        f = m.file
        mime = (getattr(f, "mime_type", "") or "") if f is not None else ""
        return mime.startswith("image/")
    except Exception:  # noqa: BLE001 媒体探测失败按无图处理
        return False


def _bot_buttons(m) -> list:
    """内联键盘 → [[{text,kind,data|url}…]…]；callback data 走 base64 透传。"""
    import base64 as _b64

    from telethon import types

    rm = getattr(m, "reply_markup", None)
    out = []
    for row in getattr(rm, "rows", None) or []:
        cells = []
        for b in getattr(row, "buttons", None) or []:
            text = str(getattr(b, "text", "") or "").strip()
            if isinstance(b, types.KeyboardButtonCallback):
                cells.append({
                    "text": text,
                    "kind": "callback",
                    "data": _b64.b64encode(bytes(b.data or b"")).decode(),
                })
            elif isinstance(b, types.KeyboardButtonUrl):
                cells.append({"text": text, "kind": "url", "url": str(b.url or "")})
            else:
                # 回复键盘（点了等于把文字发出去）→ 前端走 mode=text
                cells.append({"text": text, "kind": "text"})
        if cells:
            out.append(cells)
    return out


async def _bot_payload(c, m, with_image: bool) -> dict:
    """单条机器人消息 → 面板可直接消费的字典。"""
    import base64 as _b64

    img = None
    if with_image and not m.out and _bot_has_image(m):
        try:
            size = int(getattr(m.file, "size", 0) or 0) if m.file else 0
        except Exception:  # noqa: BLE001
            size = 0
        if size > _BOT_IMG_BYTES_MAX:
            img = {"mime": "image/*", "data": "", "skipped": True}
        else:
            try:
                raw = await c.download_media(m, bytes)
            except Exception:  # noqa: BLE001 图片失败不影响文本/按钮
                raw = None
            if raw:
                if len(raw) > _BOT_IMG_BYTES_MAX:
                    img = {"mime": "image/*", "data": "", "skipped": True}
                else:
                    mime = None
                    try:
                        mime = m.file and m.file.mime_type
                    except Exception:  # noqa: BLE001
                        mime = None
                    img = {
                        "mime": str(mime or "image/jpeg"),
                        "data": _b64.b64encode(bytes(raw)).decode(),
                    }
    return {
        "id": int(m.id),
        "text": str(m.message or ""),
        "out": bool(m.out),
        "buttons": _bot_buttons(m),
        "image": img,
    }


async def _bot_wait(c, entity, min_id: int, wait) -> list[dict]:
    """等 min_id 之后的新消息：有回复就再静默 _BOT_WAIT_GRACE 秒收口，
    没回复最多等 wait 秒（1~30）。图片最多回传 2 张（按最新优先）。"""
    try:
        wait_s = float(wait)
    except (TypeError, ValueError):
        wait_s = 6.0
    wait_s = min(max(wait_s, 1.0), 30.0)
    deadline = time.time() + wait_s
    got: dict[int, object] = {}
    last_new = 0.0
    while True:
        try:
            fresh = [m async for m in c.iter_messages(entity, min_id=min_id, limit=10)]
        except Exception:  # noqa: BLE001 单次轮询失败 → 重试到超时
            fresh = []
        added = 0
        for m in fresh:
            if m.id not in got:
                got[m.id] = m
                added += 1
        if added:
            last_new = time.time()
        now = time.time()
        if got and last_new and now - last_new >= _BOT_WAIT_GRACE:
            break
        if now >= deadline:
            break
        await asyncio.sleep(0.35)
    # 最新在前下载图片（预算 2 张），最后翻回时间正序
    budget = 2
    out = []
    for m in sorted(got.values(), key=lambda x: x.id, reverse=True):
        want = budget > 0 and not m.out and _bot_has_image(m)
        p = await _bot_payload(c, m, want)
        if want and p["image"] and p["image"].get("data"):
            budget -= 1
        out.append(p)
    out.reverse()
    return out


async def _c_bot_checkin_probe(args: dict) -> dict:
    """向机器人发指令（默认 /start）并抓取它的回复（文本/图片/内联按钮）。"""
    chat = str(args.get("chat") or "").strip()
    text = str(args.get("text") or "/start").strip() or "/start"
    if not chat:
        return {"ok": False, "error": "缺少机器人用户名", "etype": "ValueError"}
    async with _online() as c:
        entity = await _resolve_send_entity(c, chat, None)
        sent = await c.send_message(entity, text, parse_mode=None)
        msgs = await _bot_wait(c, entity, int(sent.id), args.get("wait", 6))
    return {
        "ok": True,
        "chat": str(getattr(entity, "username", None) or getattr(entity, "title", None) or chat),
        "sent_id": int(sent.id),
        "messages": msgs,
    }


async def _c_bot_checkin_read(args: dict) -> dict:
    """只读抓取：after_id 之后的最新消息（什么都不发）。

    probe/act 的结果在传输层丢失时（Python.run 偶发拿不到哨兵行 → 前端报
    「无响应」）用它恢复现场：不重发 /start、不重复点击，直接把机器人最新
    回复交给 AI 继续判。
    """
    chat = str(args.get("chat") or "").strip()
    if not chat:
        return {"ok": False, "error": "缺少机器人用户名", "etype": "ValueError"}
    try:
        after_id = int(args.get("after_id"))
    except (TypeError, ValueError):
        after_id = 0
    async with _online() as c:
        entity = await _resolve_send_entity(c, chat, None)
        msgs = await _bot_wait(c, entity, after_id, args.get("wait", 10))
    return {
        "ok": True,
        "chat": str(getattr(entity, "username", None) or getattr(entity, "title", None) or chat),
        "messages": msgs,
    }


async def _c_bot_checkin_act(args: dict) -> dict:
    """执行 AI 决策的一步：mode=click 点内联按钮，mode=text 发送文本回复。"""
    from telethon import functions

    chat = str(args.get("chat") or "").strip()
    mode = str(args.get("mode") or "click").strip().lower()
    if not chat:
        return {"ok": False, "error": "缺少机器人用户名", "etype": "ValueError"}
    answer: dict | None = None
    msgs: list[dict] = []
    async with _online() as c:
        entity = await _resolve_send_entity(c, chat, None)
        if mode == "click":
            import base64 as _b64

            try:
                msg_id = int(args.get("msg_id"))
                data = _b64.b64decode(str(args.get("data") or ""), validate=True)
            except (TypeError, ValueError):
                return {"ok": False, "error": "按钮参数无效（msg_id/data）", "etype": "ValueError"}
            try:
                ans = await c(functions.messages.GetBotCallbackAnswerRequest(
                    peer=entity, msg_id=msg_id, data=data))
            except Exception as e:  # noqa: BLE001 按钮过期/机器人超时也算一步结果
                answer = {"error": str(e) or type(e).__name__}
            else:
                answer = {
                    "message": str(getattr(ans, "message", None) or ""),
                    "url": str(getattr(ans, "url", None) or ""),
                }
            try:
                min_id = int(args.get("after_id"))
            except (TypeError, ValueError):
                min_id = 0
            msgs = await _bot_wait(c, entity, min_id or msg_id, args.get("wait", 4))
            # 机器人常靠**编辑原消息**反馈结果（不发新消息）：按 id 回读一次，
            # 让 AI 能看到点完之后的最新文案/按钮。
            try:
                ref = await c.get_messages(entity, ids=msg_id)
            except Exception:  # noqa: BLE001
                ref = None
            if ref is not None:
                by_id = {p["id"]: p for p in msgs}
                p = await _bot_payload(c, ref, not ref.out and _bot_has_image(ref))
                p["refetched"] = True
                by_id[p["id"]] = p
                msgs = [by_id[k] for k in sorted(by_id)]
        else:
            text = str(args.get("text") or "").strip()
            if not text:
                return {"ok": False, "error": "回复内容不能为空", "etype": "ValueError"}
            sent = await c.send_message(entity, text, parse_mode=None)
            msgs = await _bot_wait(c, entity, int(sent.id), args.get("wait", 6))
    return {
        "ok": True,
        "mode": mode,
        "chat": str(getattr(entity, "username", None) or getattr(entity, "title", None) or chat),
        "answer": answer,
        "messages": msgs,
    }


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
    "account_switch": _c_account_switch,
    "account_add_begin": _c_account_add_begin,
    "account_add_cancel": _c_account_add_cancel,
    "account_remove": _c_account_remove,
    "bot_checkin_probe": _c_bot_checkin_probe,
    "bot_checkin_act": _c_bot_checkin_act,
    "bot_checkin_read": _c_bot_checkin_read,
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
    "account_switch": 60,
    "account_add_begin": 60,
    "account_add_cancel": 60,
    "account_remove": 60,
    "bot_checkin_probe": 60,
    "bot_checkin_act": 60,
    "bot_checkin_read": 60,
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
