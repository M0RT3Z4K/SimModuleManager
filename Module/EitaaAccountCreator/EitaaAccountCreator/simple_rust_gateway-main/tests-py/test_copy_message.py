"""
    python3 test_copy_message.py \
        --token  \
        --imei  \
        --src-channel-id 37 \
        --src-access-hash 2424832 \
        --dst-channel-id 66132703 \
        --dst-access-hash 450823153 \
        --message-id 45755 \
        --caption "test"
"""

from __future__ import annotations

import argparse
import asyncio
import json
import struct
import sys


SOCKET_PATH = "/tmp/eitaa_service.sock"
DEFAULT_IMEI = "salam__ios"


async def ipc_request(socket_path: str, payload: dict) -> dict:
    reader, writer = await asyncio.open_unix_connection(socket_path)

    data = json.dumps(payload).encode()
    writer.write(struct.pack("<I", len(data)) + data)
    await writer.drain()

    header = await reader.readexactly(4)
    length = struct.unpack("<I", header)[0]
    body = await reader.readexactly(length)

    writer.close()
    await writer.wait_closed()
    return json.loads(body)


async def main(
        token: str,
        imei: str,
        socket_path: str,
        src_channel_id: str,
        src_access_hash: str,
        dst_channel_id: str,
        dst_access_hash: str,
        message_id: int,
        caption: str,
) -> int:
    sep = "─" * 60

    print(f"\n  {sep}")
    print(f"  messages.copyMessage  (msg {message_id} → dst channel {dst_channel_id})")
    print(f"  {sep}\n")

    try:
        resp = await ipc_request(socket_path, {
            "method": "messages.copyMessage",
            "param": {
                "from_peer": {
                    "_":           "inputPeerChannel",
                    "channel_id":  src_channel_id,
                    "access_hash": src_access_hash,
                },
                "to_peer": {
                    "_":           "inputPeerChannel",
                    "channel_id":  dst_channel_id,
                    "access_hash": dst_access_hash,
                },
                "message_id": message_id,
                "caption":    caption,
            },
            "token": token,
            "imei":  imei,
        })
    except FileNotFoundError:
        print(f"  ERROR: socket not found at {socket_path}")
        return 1
    except Exception as exc:
        print(f"  ERROR: {exc}")
        return 1

    print(json.dumps(resp, indent=2, ensure_ascii=False))

    ok = resp.get("status") == "ok"
    resp_type = resp.get("data", {}).get("_", "")

    print(f"\n  {sep}")
    if ok and "error" not in resp_type.lower():
        print(f"  \033[32m✓ OK\033[0m — response type: {resp_type}")
    else:
        print(f"  \033[31m✗ FAILED\033[0m")
    print(f"  {sep}\n")

    return 0 if ok else 1


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Copy a message via IPC")
    p.add_argument("--token",           required=True, help="Session token")
    p.add_argument("--src-channel-id",  required=True, help="Source channel ID")
    p.add_argument("--src-access-hash", required=True, help="Source channel access_hash")
    p.add_argument("--dst-channel-id",  required=True, help="Destination channel ID")
    p.add_argument("--dst-access-hash", required=True, help="Destination channel access_hash")
    p.add_argument("--message-id",      required=True, type=int, help="Message ID to copy")
    p.add_argument("--caption",         default="test", help="Caption for the copied message")
    p.add_argument("--imei",            default=DEFAULT_IMEI)
    p.add_argument("--socket",          default=SOCKET_PATH)
    args = p.parse_args()

    sys.exit(asyncio.run(main(
        token=args.token,
        imei=args.imei,
        socket_path=args.socket,
        src_channel_id=args.src_channel_id,
        src_access_hash=args.src_access_hash,
        dst_channel_id=args.dst_channel_id,
        dst_access_hash=args.dst_access_hash,
        message_id=args.message_id,
        caption=args.caption,
    )))