# 后端离线回归 runner（按 api.ts 指纹逻辑的 reload 顺序刷新自有模块，
# 刻不清 tg_net——它是常驻连接状态，pop 会丢连接）。可复跑：
#   python3 _run_backend_tests.py            # 全部
#   python3 _run_backend_tests.py __test_accounts.py   # 指定
import importlib
import os
import runpy
import sys

ROOT = os.path.realpath(os.path.join(os.path.dirname(__file__), "tg-hub"))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

for name in (
    "scripts.config",
    "scripts.exceptions",
    "scripts.db",
    "scripts.client",
    "scripts",
    "tg_session",
    "tg_api",
):
    mod = sys.modules.get(name)
    if mod is not None:
        try:
            importlib.reload(mod)
        except Exception as e:  # noqa: BLE001
            print(f"reload failed: {name}: {e!r}")

TESTS = sys.argv[1:] or [
    "__test_accounts.py",
    "__test_bg_locks.py",
    "__test_fix.py",
    "__test_chats.py",
    "__test_me_avatar.py",
    "__test_checkin.py",
]

failed = 0
for t in TESTS:
    path = os.path.join(ROOT, t)
    if not os.path.exists(path):
        print(f"SKIP {t} (missing)")
        continue
    print(f"===== {t} =====")
    try:
        runpy.run_path(path, run_name="__main__")
    except SystemExit as e:
        if e.code not in (0, None):
            failed += 1
            print(f"EXIT {t}: {e.code}")
    except Exception as e:  # noqa: BLE001
        failed += 1
        print(f"ERROR {t}: {e!r}")

print(f"RUNNER FAILED: {failed}")
