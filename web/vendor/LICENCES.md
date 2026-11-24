# What is vendored here, and under which licence

Everything the browser loads is served from our own server (no CDN at runtime). Each folder keeps its own licence file.

| Folder | What | Version | Licence |
|---|---|---|---|
| `three/` | 3D engine and its add-ons (loaders, post-processing, exporters, SMAA, SSR, TAA) | 0.169.0 | MIT (`three/LICENSE`) |
| `three-mesh-bvh/` | Fast ray tests, needed by the path tracer | 0.8.3 | MIT (`three-mesh-bvh/LICENSE`) |
| `three-gpu-pathtracer/` | Path tracing for Photo mode | 0.0.23 | MIT (`three-gpu-pathtracer/LICENSE`) |
| `web-ifc/` | IFC reader in the browser | see `web-ifc/VERSION.txt` | MPL-2.0 (`web-ifc/LICENSE.md`) |
| `mp4-muxer/` | Writes MP4 videos in the browser | | MIT (`mp4-muxer/LICENSE`) |
| `archivo/` | Typeface | | SIL Open Font Licence |

Material textures (`web/assets/materials/tex/`) are from ambientCG, CC0 1.0 (public domain). The source page, author
and licence of every texture set are recorded in `web/assets/materials/tex/sources.json`. They are fetched by
`tools/fetch_assets.py` (run by the "Fetch material textures" workflow on a `fetch-assets/...` branch).
