"""Opens the IFC written by the phase 8 browser test with IfcOpenShell (an independent IFC library), checks it
against the IFC4 schema, and checks that every object has geometry IfcOpenShell can build."""
import glob
import sys

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.validate

files = glob.glob(f"{sys.argv[1] if len(sys.argv) > 1 else 'out/sketch'}/*.ifc")
assert files, "no IFC files found: run tests/sketch/e2e_phase8.mjs first"
for f in files:
    model = ifcopenshell.open(f)
    log = ifcopenshell.validate.json_logger()
    ifcopenshell.validate.validate(model, log)
    errors = [s for s in log.statements if s.get("level", "").lower() == "error"]
    assert not errors, f"{f}: {errors[:5]}"
    settings = ifcopenshell.geom.settings()
    products = [p for p in model.by_type("IfcProduct") if p.Representation]
    for p in products:
        shape = ifcopenshell.geom.create_shape(settings, p)
        assert len(shape.geometry.faces) > 0, f"{p.is_a()} {p.Name} has no faces"
    counts = {t: len(model.by_type(t)) for t in ("IfcBuildingStorey", "IfcWall", "IfcSlab", "IfcRoof", "IfcDoor", "IfcWindow", "IfcBuildingElementProxy")}
    print(f"ok   {f}: IFC4 schema valid (IfcOpenShell {ifcopenshell.version}), geometry builds for all {len(products)} objects: {counts}")
