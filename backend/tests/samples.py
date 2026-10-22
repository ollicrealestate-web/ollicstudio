"""Small but genuine sample files for upload tests."""

import struct
import zlib


def png(width: int = 4, height: int = 3) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + b"\xff\x88\x44" * width for _ in range(height))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def jpeg() -> bytes:
    return bytes.fromhex("ffd8ffe000104a46494600010100000100010000") + b"\x00" * 64 + b"\xff\xd9"


def pdf(pages: int = 1) -> bytes:
    kids = " ".join(f"{3 + i} 0 R" for i in range(pages))
    objs = [b"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj", f"2 0 obj << /Type /Pages /Kids [{kids}] /Count {pages} >> endobj".encode()]
    objs += [f"{3 + i} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >> endobj".encode() for i in range(pages)]
    return b"%PDF-1.4\n" + b"\n".join(objs) + b"\ntrailer << /Root 1 0 R >>\n%%EOF\n"


def ifc(schema: str = "IFC4") -> bytes:
    return (
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');\n"
        "FILE_NAME('house.ifc','2026-10-22T10:00:00',(''),(''),'','','');\n"
        f"FILE_SCHEMA(('{schema}'));\nENDSEC;\nDATA;\n#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'House',$,$,$,$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n"
    ).encode()
