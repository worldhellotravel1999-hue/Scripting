"""当前账号头像（可复跑）：python3 tg-hub/__test_me_avatar.py

status 探测成功后 me 必须带 avatar 字段，且指向 ~/.tg-hub/avatars/<photo_id>.jpg
里真实存在的非空图片（面板账号页用它替换默认小人图标）。
离线/未登录时降级为提示，不计入失败。
"""
import os
import sys
import time

HERE = os.path.dirname(os.path.realpath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

# 常驻解释器：先拋掉旧模块，否则测的是上一版代码（tg_net 不能动，见其文件头）
for _n in ("tg_api", "scripts", "scripts.config", "scripts.db",
           "scripts.exceptions", "scripts.client"):
    sys.modules.pop(_n, None)

import tg_api  # noqa: E402

failed = 0


def check(name: str, cond: bool, extra="") -> None:
    global failed
    tag = "PASS" if cond else "FAIL"
    if not cond:
        failed += 1
    print(f"  [{tag}] {name}" + (f" — {extra}" if extra else ""))


print("== status → me.avatar ==")
t0 = time.monotonic()
res = tg_api.dispatch("status", "{}") or {}
dt = time.monotonic() - t0
me = res.get("me") or {}
avatar = me.get("avatar") or ""
print(f"  status {dt:.2f}s ok={res.get('ok')} authorized={res.get('authorized')} "
      f"offline={res.get('offline')} name={me.get('name')!r}")
print(f"  avatar={avatar!r}")

check("status ok", res.get("ok") is True, str(res.get("error")))

if not res.get("authorized"):
    print("  （未登录/无凭证：跳过头像断言）")
elif res.get("offline"):
    print("  （离线：用登录缓存的 me，若缓存里没有 avatar 属预期，跳过断言）")
else:
    check("me.avatar 非空", bool(avatar))
    check("avatar 文件存在", bool(avatar) and os.path.isfile(avatar), avatar)
    check("avatar 是非空文件",
          bool(avatar) and os.path.isfile(avatar) and os.path.getsize(avatar) > 0,
          f"{os.path.getsize(avatar) if avatar and os.path.isfile(avatar) else 0}B")

    # 二次探测应命中缓存（不再下载）
    t1 = time.monotonic()
    res2 = tg_api.dispatch("status", "{}") or {}
    dt2 = time.monotonic() - t1
    check("二次 status 仍带 avatar", bool((res2.get("me") or {}).get("avatar")),
          f"{dt2:.2f}s")

print(f"\nFAILED:{failed}")
sys.exit(1 if failed else 0)
