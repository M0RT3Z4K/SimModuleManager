"""
    python test_ipc.py --token YOUR_SESSION_TOKEN
    python test_ipc.py --token YOUR_SESSION_TOKEN --socket /tmp/eitaa_service.sock
"""

from __future__ import annotations

import argparse
import asyncio
import json
import struct
import sys


SOCKET_PATH = "/tmp/eitaa_service.sock"
DEFAULT_IMEI = "salam__ios"


async def ipc_request(
        socket_path: str,
        payload: dict,
) -> dict:
    """
    Connect to the gateway Unix socket, send a length-prefixed JSON frame,
    read back the length-prefixed JSON response, and return it as a dict.
    """
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


async def main(token: str, imei: str, socket_path: str) -> int:
    payload = {
        "method": "messages.getHistory",
        "param": {
            "peer":        {"_": "inputPeerSelf"},
            "offset_id":   0,
            "offset_date": 0,
            "add_offset":  0,
            "limit":       3,
            "max_id":      0,
            "min_id":      0,
            "hash":        0,
            "flags":       0,
        },
        "token": token,
        "imei":  imei,
    }

    sep = "─" * 60
    print(f"\n  {sep}")
    print("  messages.getHistory  (inputPeerSelf, limit=3)")
    print(f"  {sep}\n")

    try:
        resp = await ipc_request(socket_path, payload)
    except FileNotFoundError:
        print(f"  ERROR: socket not found at {socket_path}")
        print("  Is the gateway running?")
        return 1
    except Exception as exc:
        print(f"  ERROR: {exc}")
        return 1

    print(json.dumps(resp, indent=2, ensure_ascii=False))

    ok = resp.get("status") == "ok"
    print(f"\n  {sep}")
    tag = "\033[32m✓ OK\033[0m" if ok else "\033[31m✗ FAILED\033[0m"
    print(f"  Status: {tag}")
    print(f"  {sep}\n")

    return 0 if ok else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Simple IPC test for messages.getHistory")
    parser.add_argument("--token",  required=True, help="Session token")
    parser.add_argument("--imei",   default=DEFAULT_IMEI, help=f"Device IMEI (default: {DEFAULT_IMEI})")
    parser.add_argument("--socket", default=SOCKET_PATH, help=f"Unix socket path (default: {SOCKET_PATH})")
    args = parser.parse_args()

    sys.exit(asyncio.run(main(args.token, args.imei, args.socket)))