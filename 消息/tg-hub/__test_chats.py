import importlib
import json
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
if BASE not in sys.path:
    sys.path.insert(0, BASE)

# 常驻解释器会缓存旧模块，先清掉自有模块再重载
for _name in list(sys.modules):
    if _name == "tg_api" or _name.startswith("scripts"):
        sys.modules.pop(_name, None)

import tg_api  # noqa: E402

res = tg_api.dispatch("list_chats", "{}")
chats = (res or {}).get("chats") or []
print("count:", len(chats))
ok = bool(chats) and "date" in chats[0] and "preview" in chats[0] and "unread" in chats[0]
for c in chats[:4]:
    print(json.dumps(c, ensure_ascii=False)[:260])
print("PASS" if ok else "FAIL")

try:
    Script.exit(0 if ok else 1)  # noqa: F821
except NameError:
    sys.exit(0 if ok else 1)
