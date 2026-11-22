"""Opens the DXF files written by the phase 8 browser test with ezdxf (an independent CAD library) and audits them."""
import glob
import sys

import ezdxf

files = glob.glob(f"{sys.argv[1] if len(sys.argv) > 1 else 'out/sketch'}/*.dxf")
assert files, "no DXF files found: run tests/sketch/e2e_phase8.mjs first"
for f in files:
    doc = ezdxf.readfile(f)
    auditor = doc.audit()
    msp = doc.modelspace()
    lines, arcs, texts = (len(msp.query(t)) for t in ("LINE", "ARC", "TEXT"))
    assert not auditor.has_errors, f"{f}: {[str(e) for e in auditor.errors]}"
    assert lines > 20 and arcs >= 1 and texts >= 2, f"{f}: {lines} lines, {arcs} arcs, {texts} texts"
    print(f"ok   {f}: opens in ezdxf {ezdxf.__version__}, audit clean, {lines} lines, {arcs} arcs, {texts} texts, units {doc.header.get('$INSUNITS')}")
