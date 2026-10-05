"""验证 _sync_all 签名与调用一致性 + capped_out 引用。"""
import inspect
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import vendor_bootstrap  # noqa: E402,F401
from scripts import client  # noqa: E402

print("signature:", inspect.signature(client._sync_all))
src = inspect.getsource(client._sync_all)
print("_sync_all contains capped_out ref:", "capped_out" in src)
src2 = inspect.getsource(client.TGClient.sync_all)
print("sync_all passes capped_out kwarg:", "capped_out=capped_out" in src2)
