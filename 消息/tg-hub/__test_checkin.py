"""机器人签到后端命令（可复跑）：python3 tg-hub/__test_checkin.py

bot_checkin_probe / bot_checkin_act 是纯离线可测的部分：
  - 命令注册（_ONLINE / ALL_COMMANDS / 默认超时）
  - 内联键盘 → 面板结构（callback data 走 base64，可逆）
  - 消息 → 面板 payload（文字 / 按钮 / 图片 base64）
  - _bot_wait 的轮询收口与「最多回传 2 张图」预算
  - 参数校验（缺 chat / 空文本）不触网即报错
联网的真发 /start、真点按钮需真机回归，不在本文件范围。
"""
import asyncio
import base64
import os
import sys
from types import SimpleNamespace

HERE = os.path.dirname(os.path.realpath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

# 常驻解释器：先拋掉旧模块，否则测的是上一版代码（tg_net 不能动，见其文件头）
for _n in ("tg_api", "scripts", "scripts.config", "scripts.db",
           "scripts.exceptions", "scripts.client"):
    sys.modules.pop(_n, None)

import tg_api  # noqa: E402
from telethon import types  # noqa: E402

failed = 0


def check(name: str, cond: bool, extra="") -> None:
    global failed
    tag = "PASS" if cond else "FAIL"
    if not cond:
        failed += 1
    print(f"  [{tag}] {name}" + (f" — {extra}" if extra else ""))


print("== 命令注册 ==")
check("probe 在 _ONLINE", "bot_checkin_probe" in tg_api._ONLINE)
check("act 在 _ONLINE", "bot_checkin_act" in tg_api._ONLINE)
check("read（只读恢复）在 _ONLINE", "bot_checkin_read" in tg_api._ONLINE)
check("probe/act/read 在 ALL_COMMANDS",
      {"bot_checkin_probe", "bot_checkin_act", "bot_checkin_read"} <= set(tg_api.ALL_COMMANDS))
check("默认超时已登记",
      tg_api._DEFAULT_TIMEOUTS.get("bot_checkin_probe", 0) > 0
      and tg_api._DEFAULT_TIMEOUTS.get("bot_checkin_act", 0) > 0
      and tg_api._DEFAULT_TIMEOUTS.get("bot_checkin_read", 0) > 0)


print("== 内联键盘解析 ==")
markup = types.ReplyInlineMarkup(rows=[
    types.KeyboardButtonRow(buttons=[
        types.KeyboardButtonCallback(text=" 签到 ", data=b"checkin\x00\xff"),
        types.KeyboardButtonCallback(text="我的积分", data=b"score"),
    ]),
    types.KeyboardButtonRow(buttons=[
        types.KeyboardButtonUrl(text="官网", url="https://example.com"),
        types.KeyboardButton(text="菜单"),
    ]),
])
msg = SimpleNamespace(id=101, message="今天也来签到吧", out=False,
                      reply_markup=markup, photo=None, file=None)
rows = tg_api._bot_buttons(msg)
check("两行按钮", len(rows) == 2, str(len(rows)))
check("callback 带 data 且 base64 可逆",
      rows[0][0]["kind"] == "callback"
      and base64.b64decode(rows[0][0]["data"]) == b"checkin\x00\xff",
      str(rows[0][0]))
check("文案去空格", rows[0][0]["text"] == "签到", rows[0][0]["text"])
check("url 按钮", rows[1][0] == {"text": "官网", "kind": "url",
                                 "url": "https://example.com"}, str(rows[1][0]))
check("纯文本按钮归为 text", rows[1][1]["kind"] == "text", str(rows[1][1]))
check("无键盘时返回空表", tg_api._bot_buttons(SimpleNamespace(reply_markup=None)) == [])


class FakeClient:
    """只实现 _bot_payload / _bot_wait 用到的两个方法。"""

    def __init__(self, batches, image_bytes=b""):
        self.batches = list(batches)   # 每次 iter_messages 返回一批（供多次轮询）
        self.image_bytes = image_bytes
        self.polls = 0

    async def iter_messages(self, entity, min_id=0, limit=10):
        batch = self.batches[min(self.polls, len(self.batches) - 1)] if self.batches else []
        self.polls += 1
        for m in batch:
            if m.id > min_id:
                yield m

    async def download_media(self, m, file):
        assert file is bytes, "必须走内存下载（file=bytes）"
        return self.image_bytes


def make_msg(mid, text, out=False, image=False, buttons=None):
    return SimpleNamespace(
        id=mid, message=text, out=out, reply_markup=buttons,
        photo=object() if image else None,
        file=SimpleNamespace(mime_type="image/png", size=len(b"IMG")) if image else None,
    )


print("== 消息 payload ==")


async def payload_cases():
    c = FakeClient([], image_bytes=b"IMGDATA")
    with_img = await tg_api._bot_payload(c, make_msg(7, "看图", image=True), True)
    without = await tg_api._bot_payload(c, make_msg(8, "纯文字"), True)
    out_msg = await tg_api._bot_payload(
        c, make_msg(9, "我发的", out=True, image=True), True)
    return with_img, without, out_msg


with_img, without, out_msg = asyncio.run(payload_cases())
check("图片 base64 可逆",
      with_img["image"] is not None
      and base64.b64decode(with_img["image"]["data"]) == b"IMGDATA"
      and with_img["image"]["mime"] == "image/png",
      str(with_img["image"]))
check("无图消息 image=None", without["image"] is None)
check("自己发的消息不下载图", out_msg["image"] is None)
check("文字/按钮字段齐全",
      with_img["id"] == 7 and with_img["text"] == "看图" and with_img["buttons"] == [],
      str(with_img))


print("== _bot_wait 轮询收口 + 图片预算 ==")
old_grace = tg_api._BOT_WAIT_GRACE
tg_api._BOT_WAIT_GRACE = 0.05
try:
    batch = [
        make_msg(103, "第三条", image=True),
        make_msg(102, "第二条", image=True),
        make_msg(101, "第一条", image=True),
        make_msg(100, "我发的 /start", out=True),
    ]
    client = FakeClient([batch], image_bytes=b"IMGDATA")
    msgs = asyncio.run(tg_api._bot_wait(client, object(), 100, 1.2))
    ids = [m["id"] for m in msgs]
    check("按时间正序返回", ids == sorted(ids), str(ids))
    check("只收 min_id 之后的", 100 not in ids and ids == [101, 102, 103], str(ids))
    got_imgs = [m["id"] for m in msgs if m.get("image")]
    check("最多回传 2 张图", len(got_imgs) == 2, str(got_imgs))
    check("最新那条优先带图", msgs[-1]["id"] == 103 and msgs[-1]["image"] is not None,
          str(msgs[-1]["id"]))
    check("预算用尽后不再下载", msgs[0]["id"] == 101 and msgs[0]["image"] is None,
          str(msgs[0]))
    check("轮询次数有限", client.polls <= 6, str(client.polls))
finally:
    tg_api._BOT_WAIT_GRACE = old_grace


print("== 参数校验（不触网）==")
res_probe = asyncio.run(tg_api._c_bot_checkin_probe({}))
res_probe2 = asyncio.run(tg_api._c_bot_checkin_probe({"chat": "  "}))
res_act = asyncio.run(tg_api._c_bot_checkin_act({}))
res_read = asyncio.run(tg_api._c_bot_checkin_read({}))
check("probe 缺 chat 报错",
      res_probe.get("ok") is False and "用户名" in str(res_probe.get("error")),
      str(res_probe))
check("probe 空白 chat 报错", res_probe2.get("ok") is False, str(res_probe2))
check("act 缺 chat 报错", res_act.get("ok") is False, str(res_act))
check("read 缺 chat 报错", res_read.get("ok") is False, str(res_read))
check("错误带 etype", res_probe.get("etype") == "ValueError",
      str(res_probe.get("etype")))

print(f"FAILED: {failed}")
sys.exit(1 if failed else 0)
