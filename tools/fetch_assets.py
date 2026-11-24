"""Fetches the material textures (ambientCG, CC0) and the extra 3D libraries (npm) the realistic viewer needs,
into the repository, with a record of where each came from and its licence. Run by .github/workflows/fetch-assets.yml
(GitHub's machines can reach these sites); the results are committed so the app serves them itself.

Textures: one 1K JPEG set per entry (colour, normal (OpenGL), roughness, ambient occlusion), in
web/assets/materials/tex/<set>/, plus tex/sources.json and tools/out/contact.jpg (a sheet of all colours, to check)."""

import io, json, os, sys, tarfile, urllib.request, urllib.parse, zipfile
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
CFG = json.loads((ROOT / "tools/material_sets.json").read_text())
TEX = ROOT / "web/assets/materials/tex"
UA = {"User-Agent": "OllicStudio-asset-fetch/1.0 (CC0 library build)"}


def get(url, tries=3):
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            if k == tries - 1:
                raise
            print("retry", url, e)


def search(q, n=12):
    out, seen = [], set()
    for one in (q if isinstance(q, list) else [q]):
        url = "https://ambientcg.com/api/v2/full_json?" + urllib.parse.urlencode({"type": "Material", "q": one, "sort": "Popular", "limit": n, "include": "downloadData,tagData,imageData"})
        for a in json.loads(get(url)).get("foundAssets", []):
            if a["assetId"] not in seen:
                seen.add(a["assetId"]); out.append(a)
    return out


def preview(asset):
    imgs = asset.get("previewImage") or {}
    url = imgs.get("128-PNG") or imgs.get("256-PNG") or next(iter(imgs.values()), None)
    try:
        return Image.open(io.BytesIO(get(url))).convert("RGB") if url else None
    except Exception:  # noqa: BLE001
        return None


def zip_url(asset, res="1K-JPG"):
    for folder in (asset.get("downloadFolders") or {}).values():
        for cat in (folder.get("downloadFiletypeCategories") or {}).values():
            for d in cat.get("downloads", []):
                if d.get("attribute") == res:
                    return d.get("fullDownloadPath") or d.get("downloadLink")
    return None


def save(img, path, q=86, gray=False, size=1024):
    img = img.convert("L" if gray else "RGB")
    if img.size != (size, size):
        img = img.resize((size, size), Image.LANCZOS)
    img.save(path, "JPEG", quality=q, optimize=True, progressive=True)


def fetch_textures(only=None):
    TEX.mkdir(parents=True, exist_ok=True)
    src_path = TEX / "sources.json"
    sources = json.loads(src_path.read_text()) if src_path.exists() else {}
    used = {v["asset"] for v in sources.values()}
    cands = []
    for key, s in CFG["sets"].items():
        if only and key not in only:
            continue
        if key in sources and (TEX / key / "color.jpg").exists() and not s.get("prefer") or (s.get("prefer") and sources.get(key, {}).get("asset") == s.get("prefer")):
            continue
        found = search(s["q"])
        cands.append((key, found[:10]))
        pick = next((a for a in found if a["assetId"] == s.get("prefer")), None) or next((a for a in found if a["assetId"] not in used and zip_url(a)), None)
        if not pick:
            print("NOTHING FOR", key, s["q"]); continue
        data = get(zip_url(pick))
        z = zipfile.ZipFile(io.BytesIO(data))
        files = {n.lower(): n for n in z.namelist()}
        def find(*words):
            for low, n in files.items():
                if low.endswith((".jpg", ".png")) and all(w in low for w in words):
                    return Image.open(io.BytesIO(z.read(n)))
            return None
        color = find("_color"); normal = find("normalgl") or find("_normal"); rough = find("_roughness"); ao = find("ambientocclusion")
        if color is None:
            print("NO COLOUR MAP", key, pick["assetId"]); continue
        d = TEX / key; d.mkdir(exist_ok=True)
        save(color, d / "color.jpg")
        if normal is not None: save(normal, d / "normal.jpg", q=90)
        if rough is not None: save(rough, d / "rough.jpg", gray=True, size=512)
        if ao is not None: save(ao, d / "ao.jpg", gray=True, size=512)
        sources[key] = {"asset": pick["assetId"], "title": pick.get("displayName") or pick["assetId"], "page": f"https://ambientcg.com/view?id={pick['assetId']}",
                        "licence": "CC0 1.0 (public domain)", "author": "ambientCG (Lennart Demes)", "maps": sorted(p.stem for p in d.glob("*.jpg")),
                        "query": s["q"], "candidates": [a["assetId"] for a in found[:8]]}
        used.add(pick["assetId"])
        print("ok", key, pick["assetId"], sources[key]["maps"])
    src_path.write_text(json.dumps(sources, indent=1, sort_keys=True))
    # a contact sheet to check the picks by eye
    keys = sorted(k for k in sources if (TEX / k / "color.jpg").exists())
    cols, cell = 6, 256
    sheet = Image.new("RGB", (cols * cell, ((len(keys) + cols - 1) // cols) * (cell + 22)), "white")
    dr = ImageDraw.Draw(sheet)
    for i, k in enumerate(keys):
        im = Image.open(TEX / k / "color.jpg").resize((cell, cell))
        x, y = (i % cols) * cell, (i // cols) * (cell + 22)
        sheet.paste(im, (x, y)); dr.text((x + 4, y + cell + 4), f"{k} = {sources[k]['asset']}", fill="black")
    sheet.save(ROOT / "tools/contact.jpg", quality=80)
    # the other candidates for each set, to choose better ones by eye (set "prefer" in material_sets.json)
    if cands:
        cs = Image.new("RGB", (10 * 132 + 150, len(cands) * 150), "white"); dr = ImageDraw.Draw(cs)
        for r, (key, found) in enumerate(cands):
            dr.text((4, r * 150 + 60), key, fill="black")
            for c, a in enumerate(found):
                im = preview(a)
                if im is not None:
                    cs.paste(im.resize((128, 128)), (150 + c * 132, r * 150))
                dr.text((150 + c * 132, r * 150 + 132), a["assetId"], fill="black")
        cs.save(ROOT / "tools/candidates.jpg", quality=80)


def fetch_vendor():
    for spec, files in CFG["vendor"].items():
        name, ver = spec.rsplit("@", 1)
        meta = json.loads(get(f"https://registry.npmjs.org/{name}/{ver}"))
        tgz = tarfile.open(fileobj=io.BytesIO(get(meta["dist"]["tarball"])), mode="r:gz")
        for f in files:
            m = tgz.extractfile("package/" + f)
            if m is None:
                print("MISSING", spec, f); continue
            if name == "three":
                out = ROOT / "web/vendor/three/addons" / f.replace("examples/jsm/", "")
            else:
                out = ROOT / "web/vendor" / name / Path(f).name
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(m.read())
            print("ok", spec, f, "->", out.relative_to(ROOT))


if __name__ == "__main__":
    what = sys.argv[1:] or ["vendor", "textures"]
    if "vendor" in what:
        fetch_vendor()
    if "textures" in what:
        fetch_textures([w.split("=", 1)[1] for w in what if w.startswith("only=")] or None)
