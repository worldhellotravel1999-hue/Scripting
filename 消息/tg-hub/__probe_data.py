#!/usr/bin/env python3
"""探查 tg-hub 数据目录与消息库状态。"""
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scripts.config import get_data_dir, get_db_path, get_session_path  # noqa: E402

d = get_data_dir()
print("data_dir:", d)
p = get_db_path()
print("db:", p, p.exists())
try:
    print("files:", sorted(os.listdir(d))[:40])
except Exception as e:
    print("list err", e)
print("session:", get_session_path() + ".session", os.path.exists(get_session_path() + ".session"))
if p.exists():
    c = sqlite3.connect(str(p))
    print("rows:", c.execute("select count(*) from messages").fetchone()[0])
    try:
        print("chats:", c.execute(
            "select chat_id, chat_name, count(*) from messages group by chat_id order by 3 desc limit 10"
        ).fetchall())
    except Exception as e:
        print("chatq err", e)
    try:
        print("sender_null:", c.execute("select count(*) from messages where sender_name is null").fetchone()[0])
        print("me_rows:", c.execute(
            "select sender_id, sender_name, count(*) from messages group by sender_id order by 3 desc limit 8"
        ).fetchall())
    except Exception as e:
        print("senderq err", e)
