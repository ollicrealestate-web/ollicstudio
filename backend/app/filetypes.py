"""Works out what an uploaded file really is from its contents, never its name.

Ollic works with images only: PNG and JPEG. A PDF or an IFC model is recognised so the
reason it is refused is clear (export a PNG or JPEG instead). Anything else, anything renamed to look like an accepted type,
and anything truncated or corrupt is rejected with a reason a person can act on.
"""

from __future__ import annotations

from dataclasses import dataclass, field

KINDS = {
    "png": {"mime": "image/png", "ext": "png", "label": "PNG image", "extensions": {"png"}},
    "jpeg": {"mime": "image/jpeg", "ext": "jpg", "label": "JPEG image", "extensions": {"jpg", "jpeg"}},
}
NOT_IMAGES = {
    "pdf": "This is a PDF. Ollic works with images only: export the page as a PNG or JPEG and upload that.",
    "ifc": "This is an IFC model. Ollic works with images only: export a view of the model as a PNG or JPEG and upload that.",
}


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
        return "a ZIP archive"
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


CHECKS = {"png": _check_png, "jpeg": _check_jpeg}


def inspect_upload(data: bytes, filename: str) -> FileCheck:
    if not data:
        raise UploadRejected("The file is empty.", "empty")
    kind = _sniff(data)
    ext = _extension(filename)
    if kind in NOT_IMAGES:
        raise UploadRejected(NOT_IMAGES[kind], "unsupported")
    if kind is None:
        what = _describe_unknown(data)
        if ext == "rvt":
            raise UploadRejected("Revit .rvt files cannot be read. Ollic works with images only: export a view as a PNG or JPEG and upload that.", "unsupported")
        raise UploadRejected(f"This looks like {what}. Upload a PNG or JPEG image.", "unsupported")
    info = KINDS[kind]
    if ext and ext not in info["extensions"]:
        raise UploadRejected(
            f"The file is named .{ext} but its contents are a {info['label']}. Rename it to .{info['ext']} or upload the original file.",
            "renamed",
        )
    details = CHECKS[kind](data)
    return FileCheck(kind=kind, mime=info["mime"], ext=info["ext"], details=details)
