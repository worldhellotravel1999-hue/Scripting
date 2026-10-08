"""
Configuration — 直接从环境变量读取，移除 python-dotenv 依赖。

改造来源：jackwener/tg-cli
https://github.com/jackwener/tg-cli/blob/main/src/tg_cli/config.py

主要改动：
- 移除 python-dotenv，改为直接读取环境变量
- 默认 session/db 路径改为 /var/minis/workspace/tg-hub/
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

# API 凭证**必须是用户自己的**（2026-10-06 移除公共凭证 api_id=2040 兜底）：
# 没有配置就直接报错，引导到登录页填写，避免公共凭证带来的批量登出风控。

# 默认数据目录：存放在 home 目录下，跨 session 复用
_DEFAULT_DATA_DIR = Path.home() / ".tg-hub"

_NO_API_MSG = (
    "尚未配置 API 凭证（公共凭证已移除）：请到 my.telegram.org 创建应用，"
    "把 api_id / api_hash 填到登录页"
)


def _api_json_path() -> Path:
    return get_data_dir() / "api.json"


def _coerce_api_id(raw: str) -> int:
    try:
        return int(raw)
    except (TypeError, ValueError):
        raise ValueError(f"api_id 不是有效数字：{raw!r}") from None


def _resolve_api() -> tuple[int, str]:
    """返回 (api_id, api_hash)。优先级：~/.tg-hub/api.json > 环境变量。

    2026-10-06 事故：环境里残留的占位凭证 TG_API_ID=123456 /
    TG_API_HASH=0123…（Shell Environment 注入）曾以高优先级**覆盖**
    用户在登录页保存的真实凭证，导致 SendCodeRequest 报
    “The api_id/api_hash combination is invalid”。
    修复：面板保存的 api.json 永远优先，env 仅作无文件时的兜底，
    这样陈旧 env 再也无法顶掉用户填的凭证。

    凭证必须成对配置且**必须是用户自己的**——公共凭证已删除，
    两者都没有时抛 ValueError（登录页会先引导填写凭证）。
    """
    file_id = file_hash = ""
    p = _api_json_path()
    if p.exists():
        try:
            data = json.loads(p.read_text())
            file_id = str(data.get("api_id") or "").strip()
            file_hash = str(data.get("api_hash") or "").strip()
        except Exception as e:  # noqa: BLE001
            raise ValueError(f"api.json 解析失败：{e}（可在面板“API 凭证”里重新保存或清除）") from None
    if file_id or file_hash:
        if not (file_id and file_hash):
            raise ValueError("api.json 中 api_id 与 api_hash 必须成对配置")
        return _coerce_api_id(file_id), file_hash

    env_id = os.environ.get("TG_API_ID", "").strip()
    env_hash = os.environ.get("TG_API_HASH", "").strip()
    if env_id or env_hash:
        if not (env_id and env_hash):
            raise ValueError("TG_API_ID 与 TG_API_HASH 必须成对配置")
        return _coerce_api_id(env_id), env_hash

    raise ValueError(_NO_API_MSG)


def api_configured() -> bool:
    """是否已配置自己的 api_id/api_hash（api.json 或环境变量）。"""
    try:
        _resolve_api()
        return True
    except ValueError:
        return False


def get_api_id() -> int:
    return _resolve_api()[0]


def get_api_hash() -> str:
    return _resolve_api()[1]


def write_api_config(api_id: str, api_hash: str) -> str:
    """保存 / 清除自定义凭证（~/.tg-hub/api.json，0600 原子写）。返回结果消息。"""
    p = _api_json_path()
    if not api_id and not api_hash:
        try:
            p.unlink(missing_ok=True)
        except OSError as e:
            raise ValueError(f"清除失败：{e}") from None
        return "已清除自定义凭证；下次进入登录页会要求重新填写 api_id / api_hash（已有登录会话不受影响）"
    if not api_id or not api_hash:
        raise ValueError("api_id 与 api_hash 必须成对填写（或同时留空以清除）")
    n_id = _coerce_api_id(api_id)
    if len(api_hash) < 16:
        raise ValueError("api_hash 看起来不正确（应为 32 位十六进制字符串）")
    tmp = p.parent / f"api.json.{os.getpid()}-{time.time_ns()}.tmp"
    tmp.write_text(json.dumps({"api_id": n_id, "api_hash": api_hash}, ensure_ascii=False, indent=2))
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, p)
    return "已保存自定义凭证（如登录失效请重新登录）"


def get_device_model() -> str:
    return os.environ.get("TG_DEVICE_MODEL", "Desktop")


def get_system_version() -> str:
    return os.environ.get("TG_SYSTEM_VERSION", "macOS 15.3")


def get_app_version() -> str:
    return os.environ.get("TG_APP_VERSION", "5.12.1")


def get_lang_code() -> str:
    return os.environ.get("TG_LANG_CODE", "en")


def get_system_lang_code() -> str:
    return os.environ.get("TG_SYSTEM_LANG_CODE", "en-US")


# ── 多账号注册表（2026-10-07）───────────────────────────────────────────
# accounts.json = {"current": sid, "pending": {sid, prev}|null,
#                  "list": [{sid, phone, name, username, user_id, at}]}
#   · sid == "default" 沿用旧 session 名（TG_SESSION_NAME/tg_hub）与
#     login_state.json —— 老用户零迁移；其他账号为 <sid>.session /
#     login_state.<sid>.json，互不干扰。
#   · pending = “添加账号”中途（新 slot 已激活但未登录成功），
#     可 cancel 回 prev；脚本重启后仍可识别。
#   · 每次读写都落盘（文件极小），不缓存进模块 —— config 会被指纹 reload。

_DEFAULT_SID = "default"


def _accounts_path() -> Path:
    return get_data_dir() / "accounts.json"


def _accounts_bak_path() -> Path:
    return _accounts_path().with_name(_accounts_path().name + ".bak")


def load_accounts() -> dict:
    reg: dict = {}
    p = _accounts_path()
    if p.exists():
        try:
            reg = json.loads(p.read_text())
        except Exception:  # noqa: BLE001 — 损坏则尝试上一次成功保存的备份
            try:
                reg = json.loads(_accounts_bak_path().read_text())
            except Exception:  # noqa: BLE001 — 都不行才重建空表（不阻断启动）
                reg = {}
    if not isinstance(reg, dict):
        reg = {}
    reg.setdefault("current", _DEFAULT_SID)
    reg.setdefault("list", [])
    reg.setdefault("pending", None)
    if not isinstance(reg["list"], list):
        reg["list"] = []
    if reg.get("pending") is not None and not isinstance(reg["pending"], dict):
        reg["pending"] = None
    if not isinstance(reg.get("current"), str) or not reg["current"]:
        reg["current"] = _DEFAULT_SID
    return reg


def save_accounts(reg: dict) -> None:
    p = _accounts_path()
    # 先把当前**可解析**的版本落一份备份（last-known-good）：并发写坏/写穿时
    # load_accounts 能回退到它，不至于把整个多账号列表弄丢。
    try:
        if p.exists():
            raw = p.read_text()
            json.loads(raw)
            _accounts_bak_path().write_text(raw)
    except Exception:  # noqa: BLE001 — 备份失败不阻断保存
        pass
    # tmp 加唯一后缀：两个写者共用固定 tmp 名时会交错截断，os.replace 可能
    # 发布半截 JSON，或因 tmp 被对方换走直接 FileNotFoundError。
    tmp = p.with_name(f"{p.name}.{os.getpid()}-{time.time_ns()}.tmp")
    tmp.write_text(json.dumps(reg, ensure_ascii=False))
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, p)


def active_sid() -> str:
    return load_accounts().get("current") or _DEFAULT_SID


def session_path_for(sid: str) -> str:
    """账号 → session 基路径（不带 .session 后缀）。default 沿用旧命名。"""
    name = os.environ.get("TG_SESSION_NAME", "tg_hub") if sid == _DEFAULT_SID else sid
    return str(get_data_dir() / name)


def state_path_for(sid: str) -> Path:
    """账号 → 登录态缓存文件（me / phone_code_hash，按账号隔离）。"""
    if sid == _DEFAULT_SID:
        return get_data_dir() / "login_state.json"
    return get_data_dir() / f"login_state.{sid}.json"


def upsert_account(me: dict) -> str:
    """把当前账号的 me 写进注册表（登录成功 / status 探测成功时调用）。

    同时清掉指向当前 sid 的 pending（添加流程完成）。返回当前 sid。
    """
    reg = load_accounts()
    sid = reg["current"]
    idx = next((i for i, a in enumerate(reg["list"]) if a.get("sid") == sid), None)
    old = reg["list"][idx] if idx is not None else {}
    entry = {
        **old,
        "sid": sid,
        "phone": (me or {}).get("phone") or old.get("phone") or "",
        "name": (me or {}).get("name") or old.get("name") or "",
        "username": (me or {}).get("username") or old.get("username") or "",
        "user_id": (me or {}).get("id") or old.get("user_id"),
        "at": int(time.time()),
    }
    pending = reg.get("pending")
    clear_pending = bool(pending and isinstance(pending, dict) and pending.get("sid") == sid)
    # 原位更新 + 内容无变化不落盘（审计 #32）：status 是启动/前台高频命令，
    # 以前每次探测成功都 remove+append 全量重写 accounts.json。
    same = (
        idx is not None
        and not clear_pending
        and all(old.get(k) == entry.get(k) for k in ("phone", "name", "username", "user_id"))
    )
    if same:
        return sid
    if idx is not None:
        reg["list"][idx] = entry  # 原位替换，保持列表相对顺序
    else:
        reg["list"].append(entry)
    if clear_pending:
        reg["pending"] = None
    save_accounts(reg)
    return sid


def unregister_current() -> str | None:
    """当前账号失效/退出：从注册表移除，current 落到剩余第一个账号。

    返回新 current 的 sid（有其他账号时）；否则 None（回到 default 未登录）。
    """
    reg = load_accounts()
    sid = reg["current"]
    reg["list"] = [a for a in reg["list"] if a.get("sid") != sid]
    if reg.get("pending") and reg["pending"].get("sid") == sid:
        reg["pending"] = None
    try:
        state_path_for(sid).unlink(missing_ok=True)
    except OSError:
        pass
    if reg["list"]:
        reg["current"] = reg["list"][0].get("sid") or _DEFAULT_SID
        save_accounts(reg)
        return reg["current"]
    reg["current"] = _DEFAULT_SID
    save_accounts(reg)
    return None


def get_data_dir() -> Path:
    raw = os.environ.get("TG_DATA_DIR", "")
    d = Path(raw).expanduser() if raw else _DEFAULT_DATA_DIR
    d.mkdir(parents=True, exist_ok=True)
    return d


def get_session_path() -> str:
    # 多账号（2026-10-07）：session 文件按「当前账号 sid」取。
    # sid == "default"（或注册表为空）保持旧名 TG_SESSION_NAME/tg_hub，
    # 老用户的 session 文件零迁移；其他账号为 <sid>.session。
    return session_path_for(active_sid())


def get_db_path() -> Path:
    # 多账号：本地消息库按账号隔离（default 沿用 messages.db，零迁移；
    # 其他账号 messages.<sid>.db），统计/已同步 不跨账号串。
    raw = os.environ.get("TG_DB_PATH", "")
    if raw:
        p = Path(raw).expanduser()
        p.parent.mkdir(parents=True, exist_ok=True)
        return p
    return db_path_for(active_sid())


def db_path_for(sid: str) -> Path:
    """账号 → 本地消息库路径（与 TG_DB_PATH 无关，供移除账号时删文件用）。"""
    if sid == _DEFAULT_SID:
        return get_data_dir() / "messages.db"
    return get_data_dir() / f"messages.{sid}.db"
