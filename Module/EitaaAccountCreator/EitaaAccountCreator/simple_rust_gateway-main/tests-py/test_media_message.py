"""
    python test_media_message.py \
        --token YOUR_TOKEN \
        --image photo.png \
        --channel-id 66132703 \
        --access-hash 450823153
"""

from __future__ import annotations

import argparse
import asyncio
import json
import struct
import sys
import time


SOCKET_PATH = "/tmp/eitaa_service.sock"
DEFAULT_IMEI = "salam__ios"
PART_SIZE = 512 * 1024  # 512 KB — TL rule: must divide 512KB evenly


# ── IPC transport ────────────────────────────────────────────────────────────

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


# ── ID generation ────────────────────────────────────────────────────────────

def generate_ids() -> tuple[str, str]:
    """Return (file_id, random_id) as decimal strings — same logic as the Rust test."""
    now_ms = int(time.time() * 1000)
    now_ns = time.time_ns() % 1_000_000_000
    file_id = ((now_ms << 20) ^ now_ns) & 0x7FFF_FFFF_FFFF_FFFF
    random_id = ((now_ms << 17) ^ ((now_ns * 6364136223846793005) & 0xFFFF_FFFF_FFFF_FFFF)) \
                & 0x7FFF_FFFF_FFFF_FFFF
    return str(file_id), str(random_id)


# ── Main flow ────────────────────────────────────────────────────────────────

async def main(
        token: str,
        imei: str,
        socket_path: str,
        image_path: str,
        channel_id: str,
        access_hash: str,
        caption: str,
) -> int:
    sep = "─" * 60

    # 1. Read the image
    with open(image_path, "rb") as f:
        file_bytes = f.read()
    total_size = len(file_bytes)
    print(f"\n  {sep}")
    print(f"  Image: {image_path}  ({total_size} bytes)")

    # 2. Generate IDs
    file_id, random_id = generate_ids()
    print(f"  file_id={file_id}  random_id={random_id}")

    # 3. Split and upload parts
    parts = [file_bytes[i:i + PART_SIZE] for i in range(0, total_size, PART_SIZE)]
    total_parts = len(parts)
    print(f"  Uploading {total_parts} part(s)…")
    print(f"  {sep}\n")

    for idx, chunk in enumerate(parts):
        resp = await ipc_request(socket_path, {
            "method": "upload.saveFilePart",
            "param": {
                "file_id":   file_id,
                "file_part": idx,
                "bytes":     list(chunk),  # JSON array of u8 values
            },
            "token": token,
            "imei":  imei,
        })

        ok = resp.get("status") == "ok" and resp.get("data", {}).get("_") == "boolTrue"
        tag = "\033[32m✓\033[0m" if ok else "\033[31m✗\033[0m"
        print(f"  {tag} part {idx + 1}/{total_parts}")
        if not ok:
            print(f"  ERROR: {json.dumps(resp, indent=2)}")
            return 1

    # 4. Send the media
    print(f"\n  {sep}")
    print("  Sending messages.sendMedia (inputMediaUploadedPhoto)…")
    print(f"  {sep}\n")

    resp = await ipc_request(socket_path, {
        "method": "messages.sendMedia",
        "param": {
            "flags": 128,  # bit 7 = clear_draft
            "peer": {
                "_":           "inputPeerChannel",
                "channel_id":  channel_id,
                "access_hash": access_hash,
            },
            "media": {
                "_":     "inputMediaUploadedPhoto",
                "flags": 0,
                "file": {
                    "_":            "inputFile",
                    "id":           file_id,
                    "parts":        total_parts,
                    "name":         image_path.split("/")[-1],
                    "md5_checksum": "",
                },
            },
            "message":   caption,
            "random_id": random_id,
        },
        "token": token,
        "imei":  imei,
    })

    print(json.dumps(resp, indent=2, ensure_ascii=False))

    ok = resp.get("status") == "ok"
    resp_type = resp.get("data", {}).get("_", "")
    if ok and "error" not in resp_type.lower():
        print(f"\n  \033[32m✓ OK\033[0m — response type: {resp_type}")
        return 0
    else:
        print(f"\n  \033[31m✗ FAILED\033[0m")
        return 1


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Upload + send media via IPC")
    p.add_argument("--token",       required=True, help="Session token")
    p.add_argument("--image",       required=True, help="Path to image file")
    p.add_argument("--channel-id",  required=True, help="Target channel ID")
    p.add_argument("--access-hash", required=True, help="Target channel access_hash")
    p.add_argument("--caption",     default="test", help="Message caption (default: test)")
    p.add_argument("--imei",        default=DEFAULT_IMEI)
    p.add_argument("--socket",      default=SOCKET_PATH)
    args = p.parse_args()

    sys.exit(asyncio.run(main(
        token=args.token,
        imei=args.imei,
        socket_path=args.socket,
        image_path=args.image,
        channel_id=args.channel_id,
        access_hash=args.access_hash,
        caption=args.caption,
    )))