"""Probe: can we reach Telegram MTProto from this device?"""
import asyncio

import vendor_bootstrap  # noqa: F401
from telethon import TelegramClient

from scripts.config import get_api_hash, get_api_id, get_session_path


async def main():
    client = TelegramClient(get_session_path(), get_api_id(), get_api_hash())
    try:
        await asyncio.wait_for(client.connect(), timeout=25)
        authorized = await client.is_user_authorized()
        print("connected:", client.is_connected())
        print("authorized:", authorized)
        if authorized:
            me = await client.get_me()
            print("me:", me.id, me.first_name, me.phone)
    finally:
        if client.is_connected():
            await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
