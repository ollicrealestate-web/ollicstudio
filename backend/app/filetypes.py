"""Works out what an uploaded file really is from its contents, never its name.

Version 1 accepts PNG, JPEG, PDF and IFC (IFC2X3, IFC4, IFC4X3), as the brief's
Module B lists. Anything else, anything renamed to look like an accepted type,
and anything truncated or corrupt is rejected with a reason a person can act on.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

KINDS = {
    "png": {"mime": "image/png", "ext": "png", "label": "PNG image", "extensions": {"png"}},
    "jpeg": {"mime": "image/jpeg", "ext": "jpg", "label": "JPEG image", "extensions": {"jpg", "jpeg"}},
    "pdf": {"mime": "application/pdf", "ext": "pdf", "label": "PDF document", "extensions": {"pdf"}},
    "ifc": {"mime": "application/x-step", "ext": "ifc", "label": "IFC model", "extensions": {"ifc"}},
}
SUPPORTED_SCHEMAS = ("IFC2X3", "IFC4", "IFC4X3")


@dataclass(frozen=True)
class FileCheck:
    kind: str
    mime: str
    ext: str
    details: dict = field(default_factory=dict)


class UploadRejected(Exception):
    def __init__(self, reason: str, code: str):
        super().__init__(reason)
        self.reason = reason
        self.code = code


def _extension(name: str) -> str:
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def _sniff(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if data[:1024].lstrip().startswith(b"%PDF-"):
        return "pdf"
    head = data[:64].lstrip(b"\xef\xbb\xbf \t\r\n")
    if head.upper().startswith(b"ISO-10303-21;"):
        return "ifc"
    return None


def _describe_unknown(data: bytes) -> str:
    if data.startswith(b"PK\x03\x04"):
        return "a ZIP archive (zipped IFC and Office files are not accepted yet)"
    if data.startswith(b"AC10"):
        return "an AutoCAD DWG drawing"
    if data[:4] in (b"RIFF",) and data[8:12] == b"WEBP":
        return "a WebP image"
    if data[4:12] in (b"ftypheic", b"ftypheix", b"ftypmif1"):
        return "an HEIC photo"
    try:
        data[:2048].decode("utf-8")
        return "a text file"
    except UnicodeDecodeError:
        return "a file type this app does not read"


def _check_png(data: bytes) -> dict:
    if len(data) < 33 or data[12:16] != b"IHDR":
        raise UploadRejected("This PNG is damaged: its header is missing.", "corrupt")
    if b"IEND" not in data[-12:]:
        raise UploadRejected("This PNG is incomplete. It may not have finished uploading or saving; export it again.", "corrupt")
    width, height = int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    if not width or not height:
        raise UploadRejected("This PNG has no picture in it (zero width or height).", "corrupt")
    return {"width": width, "height": height}


def _check_jpeg(data: bytes) -> dict:
    if not data.rstrip(b"\x00").endswith(b"\xff\xd9"):
        raise UploadRejected("This JPEG is incomplete. Export or download it again.", "corrupt")
    return {}


def _check_pdf(data: bytes) -> dict:
    if b"%%EOF" not in data[-2048:]:
        raise UploadRejected("This PDF is incomplete or damaged. Save or export it again.", "corrupt")
    if b"/Encrypt" in data:
        raise UploadRejected("This PDF is password-protected. Remove the password and upload it again.", "encrypted")
    pages = len(re.findall(rb"/Type\s*/Page[^s]", data))
    return {"pages": pages} if pages else {}


def _check_ifc(data: bytes) -> dict:
    header = data[:20000].decode("latin-1", errors="replace")
    match = re.search(r"FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'", header, re.IGNORECASE)
    if not match:
        raise UploadRejected("This IFC file has no schema in its header, so it cannot be read.", "corrupt")
    schema = match.group(1).upper()
    if not schema.startswith(SUPPORTED_SCHEMAS):
        raise UploadRejected(f"This IFC uses the {schema} schema. Export it as IFC2X3 or IFC4 instead.", "unsupported_schema")
    if b"END-ISO-10303-21;" not in data[-4096:].upper():
        raise UploadRejected("This IFC file is incomplete: it does not end properly. Export it again.", "corrupt")
    return {"schema": schema}


CHECKS = {"png": _check_png, "jpeg": _check_jpeg, "pdf": _check_pdf, "ifc": _check_ifc}


def inspect_upload(data: bytes, filename: str) -> FileCheck:
    if not data:
        raise UploadRejected("The file is empty.", "empty")
    kind = _sniff(data)
    ext = _extension(filename)
    if kind is None:
        what = _describe_unknown(data)
        if ext == "rvt":
            raise UploadRejected("Revit .rvt files cannot be read directly. In Revit, use File > Export > IFC and upload the .ifc file.", "unsupported")
        raise UploadRejected(f"This looks like {what}. Upload a PNG, JPEG, PDF or IFC file.", "unsupported")
    info = KINDS[kind]
    if ext and ext not in info["extensions"]:
        raise UploadRejected(
            f"The file is named .{ext} but its contents are a {info['label']}. Rename it to .{info['ext']} or upload the original file.",
            "renamed",
        )
    details = CHECKS[kind](data)
    return FileCheck(kind=kind, mime=info["mime"], ext=info["ext"], details=details)
