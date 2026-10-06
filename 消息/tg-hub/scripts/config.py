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
    tmp = p.parent / "api.json.tmp"
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


def get_data_dir() -> Path:
    raw = os.environ.get("TG_DATA_DIR", "")
    d = Path(raw).expanduser() if raw else _DEFAULT_DATA_DIR
    d.mkdir(parents=True, exist_ok=True)
    return d


def get_session_path() -> str:
    name = os.environ.get("TG_SESSION_NAME", "tg_hub")
    return str(get_data_dir() / name)


def get_db_path() -> Path:
    raw = os.environ.get("TG_DB_PATH", "")
    if raw:
        p = Path(raw).expanduser()
        p.parent.mkdir(parents=True, exist_ok=True)
        return p
    return get_data_dir() / "messages.db"
