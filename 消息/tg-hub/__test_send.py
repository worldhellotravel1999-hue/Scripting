"""离线验证 send_message：参数校验 / 文本切分 / 命令注册（不联网）。"""
import json
import sys

sys.path.insert(0, ".")
import importlib

sys.modules.pop("tg_api", None)  # 常驻解释器可能缓存旧副本
import tg_api

tg_api = importlib.reload(tg_api)

r = tg_api.dispatch("send_message", "{}")
print("empty:", r["ok"], r.get("error"))
r2 = tg_api.dispatch("send_message", json.dumps({"chat": "foo"}))
print("no-text:", r2["ok"], r2.get("error"))

parts = tg_api._split_message_text("a" * 9000)
print("split:", [len(p) for p in parts])
parts2 = tg_api._split_message_text(("x" * 3990 + "\n") * 3)
print("split-lines:", [len(p) for p in parts2])

print(
    "registered:",
    "send_message" in tg_api.ALL_COMMANDS,
    tg_api._DEFAULT_TIMEOUTS.get("send_message"),
)
