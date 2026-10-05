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

# Telegram Desktop 内置公共凭证（仅作兜底，不推荐长期使用）
_DEFAULT_API_ID   = 2040
_DEFAULT_API_HASH = "b18441a1ff607e10a989891a5462e627"

# 上游 tg-cli 采用的 Telegram Desktop 5.x 指纹
_DEFAULT_DEVICE_MODEL = "Desktop"
_DEFAULT_SYSTEM_VERSION = "macOS 15.3"
_DEFAULT_APP_VERSION = "5.12.1"
_DEFAULT_LANG_CODE = "en"
_DEFAULT_SYSTEM_LANG_CODE = "en-US"

# 默认数据目录：存放在 home 目录下，跨 session 复用
_DEFAULT_DATA_DIR = Path.home() / ".tg-hub"


def _api_json_path() -> Path:
    return get_data_dir() / "api.json"


def _coerce_api_id(raw: str) -> int:
    try:
        return int(raw)
    except (TypeError, ValueError):
        raise ValueError(f"api_id 不是有效数字：{raw!r}") from None


def _resolve_api() -> tuple[int, str]:
    """返回 (api_id, api_hash)。优先级：环境变量 > ~/.tg-hub/api.json > 公共凭证。

    凭证必须成对配置；只配一半或 api.json 损坏时抛 ValueError（
    明确报错而不是静默降级回公共凭证）。
    """
    env_id = os.environ.get("TG_API_ID", "").strip()
    env_hash = os.environ.get("TG_API_HASH", "").strip()
    if env_id or env_hash:
        if not (env_id and env_hash):
            raise ValueError("TG_API_ID 与 TG_API_HASH 必须成对配置")
        return _coerce_api_id(env_id), env_hash

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
    return _DEFAULT_API_ID, _DEFAULT_API_HASH


def is_default_api_id() -> bool:
    """Return True if NOT using a custom api_id/api_hash pair."""
    return _resolve_api() == (_DEFAULT_API_ID, _DEFAULT_API_HASH)


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
        return "已清除自定义凭证，恢复公共凭证"
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
    return os.environ.get("TG_DEVICE_MODEL", _DEFAULT_DEVICE_MODEL)


def get_system_version() -> str:
    return os.environ.get("TG_SYSTEM_VERSION", _DEFAULT_SYSTEM_VERSION)


def get_app_version() -> str:
    return os.environ.get("TG_APP_VERSION", _DEFAULT_APP_VERSION)


def get_lang_code() -> str:
    return os.environ.get("TG_LANG_CODE", _DEFAULT_LANG_CODE)


def get_system_lang_code() -> str:
    return os.environ.get("TG_SYSTEM_LANG_CODE", _DEFAULT_SYSTEM_LANG_CODE)


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
