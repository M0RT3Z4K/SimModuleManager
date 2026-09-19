#!/usr/bin/env python3
"""Regenerate include/sim_directory.h from data/sim_directory.xlsx."""

from __future__ import annotations

import os
import zipfile
import xml.etree.ElementTree as ET

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
PREFIX = "899811290007679"
SERIAL_MIN = 1001
COUNT = 1000

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
XLSX = os.path.join(ROOT, "data", "sim_directory.xlsx")
HEADER = os.path.join(ROOT, "include", "sim_directory.h")


def cell_value(cell: ET.Element, shared: list[str]) -> str:
    t = cell.get("t")
    v = cell.find("m:v", NS)
    val = v.text if v is not None else ""
    if t == "s" and val.isdigit():
        return shared[int(val)]
    return val or ""


def load_rows(path: str) -> list[tuple[str, str]]:
    with zipfile.ZipFile(path) as z:
        shared: list[str] = []
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
        for si in root.findall("m:si", NS):
            shared.append("".join(t.text or "" for t in si.findall(".//m:t", NS)))
        sheet = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
        rows: list[tuple[str, str]] = []
        for row in sheet.findall("m:sheetData/m:row", NS)[1:]:
            vals: dict[str, str] = {}
            for cell in row.findall("m:c", NS):
                ref = cell.get("r") or ""
                col = "".join(ch for ch in ref if ch.isalpha())
                vals[col] = cell_value(cell, shared).strip()
            rows.append((vals.get("A", ""), vals.get("B", "")))
    return rows


def main() -> None:
    rows = load_rows(XLSX)
    msisdn = [""] * COUNT
    for iccid, ms in rows:
        if not iccid.startswith(PREFIX) or len(iccid) != 19:
            raise SystemExit(f"unexpected ICCID: {iccid}")
        serial = int(iccid[len(PREFIX) :])
        index = serial - SERIAL_MIN
        if index < 0 or index >= COUNT:
            raise SystemExit(f"serial out of range: {iccid}")
        if not (ms.isdigit() and len(ms) == 10 and ms.startswith("9")):
            raise SystemExit(f"unexpected MSISDN: {iccid} {ms}")
        msisdn[index] = ms
    if any(not item for item in msisdn):
        missing = [SERIAL_MIN + i for i, item in enumerate(msisdn) if not item]
        raise SystemExit(f"missing serials: {missing[:10]}")

    lines = [
        "#pragma once",
        "",
        "// Generated from data/sim_directory.xlsx (ICCID SCAN + MSISDN).",
        "// Do not edit by hand; regenerate with scripts/gen_sim_directory.py",
        "",
        "#include <Arduino.h>",
        "",
        f'#define SIM_DIR_PREFIX "{PREFIX}"',
        f"#define SIM_DIR_SERIAL_MIN {SERIAL_MIN}",
        f"#define SIM_DIR_COUNT {COUNT}",
        "",
        "// 10-digit national numbers, e.g. 9935814956 -> 989935814956",
        "static const char kSimDirMsisdn[SIM_DIR_COUNT][11] = {",
    ]
    for i, ms in enumerate(msisdn):
        comma = "," if i + 1 < COUNT else ""
        lines.append(f'    "{ms}"{comma}  // {PREFIX}{SERIAL_MIN + i}')
    lines.extend(
        [
            "};",
            "",
            "inline bool lookupPhoneByIccid(const String& iccidDigits, String& phoneOut) {",
            "    String digits;",
            "    digits.reserve(iccidDigits.length());",
            "    for (size_t i = 0; i < iccidDigits.length(); ++i) {",
            "        if (isDigit(iccidDigits.charAt(i))) digits += iccidDigits.charAt(i);",
            "    }",
            "    if (digits.length() >= 19) {",
            "        int tailAt = digits.length() - 19;",
            "        if (digits.substring(tailAt).startsWith(SIM_DIR_PREFIX)) {",
            "            digits = digits.substring(tailAt);",
            "        }",
            "    }",
            "    int at = digits.indexOf(SIM_DIR_PREFIX);",
            "    if (at < 0) return false;",
            "    String rest = digits.substring(at + strlen(SIM_DIR_PREFIX));",
            "    if (rest.length() < 4) return false;",
            "    int serial = rest.substring(0, 4).toInt();",
            "    int index = serial - SIM_DIR_SERIAL_MIN;",
            "    if (index < 0 || index >= SIM_DIR_COUNT) return false;",
            '    phoneOut = String("98") + kSimDirMsisdn[index];',
            "    return true;",
            "}",
            "",
        ]
    )
    with open(HEADER, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    print(f"wrote {HEADER} ({len(msisdn)} numbers)")


if __name__ == "__main__":
    main()
