// The Ollic material library, shared by the Studio viewer and Ollic Sketch. Each material is a texture set
// (photographed surfaces from ambientCG, CC0 public domain, fetched by tools/fetch_assets.py into ./tex/<set>/)
// or a plain surface, with a tint, its real-world size and how shiny or metallic it is. Tiles are drawn over their
// base surface at their exact size, so a 600 x 600 tile is 600 mm on the wall. Ids match Ollic Sketch's.
//
// size: metres one repeat of the texture covers. tile: { w, h, grout (mm), groutColor, offset (0.5 = running bond) }.
// words: what IFC material names it answers to (Revit and ArchiCAD names), as a regular expression.

const P = (id, name, color, words, extra = {}) => ({ id, name, category: "Paint and render", cls: "paint", set: "plaster-fine", size: 1.6, color, rough: 0.85, words, ...extra });
export const MATERIALS = [
  // ---- paint and render (the paint colour tints a fine plaster surface)
  P("mt-paint-white", "Painted render - white", "#f2efe8", "white paint|paint.*white|emulsion|interior finish|plaster.*white|white render"),
  P("mt-paint-offwhite", "Painted render - warm off-white", "#e8dfcd", "off.?white|ivory|cream|magnolia"),
  P("mt-paint-sand", "Painted render - sand", "#d6c39f", "sand colou?r|beige paint|buff paint"),
  P("mt-paint-grey", "Painted render - light grey", "#c7c7c2", "grey paint|gray paint|light grey|light gray"),
  P("mt-paint-charcoal", "Painted render - charcoal", "#3d3e41", "charcoal|anthracite|dark grey paint|dark gray paint|black paint"),
  P("mt-paint-terracotta", "Painted render - terracotta", "#b8674a", "terracotta paint|terra cotta paint|rust paint"),
  P("mt-paint-olive", "Painted render - olive", "#7d7a52", "olive|green paint"),
  P("mt-paint-blue", "Painted render - dusty blue", "#7b8fa3", "blue paint"),
  P("mt-paint-taupe", "Painted render - taupe", "#9a8c7c", "taupe|mushroom|stone colou?r paint"),
  P("mt-paint-mint", "Painted render - pale mint", "#c9d8c7", "mint|sage"),
  P("mt-paint-yellow", "Painted render - soft yellow", "#e6cf8b", "yellow paint|ochre paint"),
  P("mt-render-sand", "Sand-cement render (unpainted)", "#c9c3b6", "sand.?cement|cement render|render|stucco|plaster(?!.*board)|scratch coat", { set: "render-sand", size: 1.5, cls: "plaster", rough: 0.95 }),
  P("mt-render-tyrolean", "Tyrolean textured render", "#e9e4da", "tyrolean|textured render|textured finish|roughcast|pebble.?dash", { set: "render-tyrolean", size: 1.2, cls: "plaster", rough: 0.97 }),
  P("mt-plasterboard", "Plasterboard (painted)", "#f1f0ec", "plasterboard|gypsum|drywall|ceiling board|pop ceiling", { size: 2.0, rough: 0.9 }),
  // ---- stone
  { id: "mt-travertine", name: "Travertine stone", category: "Stone", cls: "stone", set: "travertine", size: 1.2, color: "#ffffff", rough: 0.55, words: "travertine" },
  { id: "mt-granite-grey", name: "Granite - grey", category: "Stone", cls: "stone", set: "granite-grey", size: 1.0, color: "#ffffff", rough: 0.35, words: "granite(?!.*black)" },
  { id: "mt-granite-black", name: "Granite - black", category: "Stone", cls: "stone", set: "granite-grey", size: 1.0, color: "#4a4a4c", rough: 0.25, words: "black granite|granite.*black|absolute black" },
  { id: "mt-marble-white", name: "Marble - white", category: "Stone", cls: "stone", set: "marble-white", size: 1.4, color: "#ffffff", rough: 0.2, words: "white marble|marble.*white|carrara|calacatta|statuario" },
  { id: "mt-marble-beige", name: "Marble - beige", category: "Stone", cls: "stone", set: "marble-beige", size: 1.4, color: "#ffffff", rough: 0.25, words: "marble|crema|botticino" },
  { id: "mt-stone-dark", name: "Dark slate stone", category: "Stone", cls: "stone", set: "slate", size: 1.2, color: "#ffffff", rough: 0.6, words: "slate|basalt|dark stone" },
  { id: "mt-sandstone", name: "Sandstone", category: "Stone", cls: "stone", set: "sandstone", size: 1.5, color: "#ffffff", rough: 0.85, words: "sandstone|limestone|stone cladding|natural stone|ashlar" },
  { id: "mt-terrazzo", name: "Terrazzo", category: "Stone", cls: "stone", set: "terrazzo", size: 1.0, color: "#ffffff", rough: 0.3, words: "terrazzo" },
  { id: "mt-stone-wall", name: "Rough stone wall", category: "Stone", cls: "stone", set: "stone-wall", size: 2.0, color: "#ffffff", rough: 0.9, words: "rubble|random stone|stone wall|fieldstone|rock" },
  // ---- tiles (drawn at their exact size over a base surface)
  { id: "mt-tile-porcelain-white-600", name: "Porcelain tile 600 x 600 - white", category: "Tiles", cls: "tile", set: "marble-white", size: 1.4, color: "#f4f2ee", rough: 0.18, tile: { w: 600, h: 600, grout: 3, groutColor: "#d8d4cc" }, words: "porcelain|floor tile|tile.*600|polished tile|vitrified" },
  { id: "mt-tile-porcelain-grey-600", name: "Porcelain tile 600 x 600 - grey", category: "Tiles", cls: "tile", set: "concrete-polished", size: 2.0, color: "#a9a8a4", rough: 0.3, tile: { w: 600, h: 600, grout: 3, groutColor: "#8e8d89" }, words: "grey tile|gray tile|concrete.look tile" },
  { id: "mt-tile-porcelain-beige-600x1200", name: "Porcelain tile 600 x 1200 - beige", category: "Tiles", cls: "tile", set: "marble-beige", size: 1.4, color: "#efe6d6", rough: 0.22, tile: { w: 1200, h: 600, grout: 2, groutColor: "#d9cdb9" }, words: "large format tile|1200|beige tile" },
  { id: "mt-tile-marble-600", name: "Marble tile 600 x 600", category: "Tiles", cls: "tile", set: "marble-white", size: 1.4, color: "#ffffff", rough: 0.12, tile: { w: 600, h: 600, grout: 2, groutColor: "#e2dfd9" }, words: "marble tile" },
  { id: "mt-tile-ceramic-white-300", name: "Ceramic wall tile 300 x 600 - white", category: "Tiles", cls: "tile", set: null, size: 1, color: "#f6f6f3", rough: 0.08, tile: { w: 600, h: 300, grout: 2, groutColor: "#cfcfcb" }, words: "ceramic|wall tile|glazed tile|bathroom tile|kitchen tile|tiling" },
  { id: "mt-tile-ceramic-grey-300", name: "Ceramic floor tile 300 x 300 - grey", category: "Tiles", cls: "tile", set: "concrete-polished", size: 2.0, color: "#9a9893", rough: 0.4, tile: { w: 300, h: 300, grout: 3, groutColor: "#7f7d78" }, words: "300 ?x ?300|small tile" },
  { id: "mt-tile-terrazzo-400", name: "Terrazzo tile 400 x 400", category: "Tiles", cls: "tile", set: "terrazzo", size: 1.0, color: "#ffffff", rough: 0.3, tile: { w: 400, h: 400, grout: 2, groutColor: "#cfcac0" }, words: "terrazzo tile" },
  { id: "mt-tile-travertine-600x300", name: "Travertine tile 600 x 300", category: "Tiles", cls: "tile", set: "travertine", size: 1.2, color: "#ffffff", rough: 0.5, tile: { w: 600, h: 300, grout: 3, groutColor: "#cbbfa6", offset: 0.5 }, words: "travertine tile|stone tile" },
  { id: "mt-tile-slate-cladding", name: "Slate cladding tile 600 x 150", category: "Tiles", cls: "tile", set: "slate", size: 1.2, color: "#ffffff", rough: 0.6, tile: { w: 600, h: 150, grout: 4, groutColor: "#2f3032", offset: 0.5 }, words: "cladding tile|split face|ledgestone|stacked stone" },
  { id: "mt-tile-wood-look", name: "Wood-look tile 200 x 1200", category: "Tiles", cls: "tile", set: "wood-floor", size: 1.5, color: "#ffffff", rough: 0.35, tile: { w: 1200, h: 200, grout: 2, groutColor: "#5b4636", offset: 0.33 }, words: "wood.?look tile|wood effect tile|plank tile" },
  // ---- timber
  { id: "mt-timber-teak", name: "Wood-look composite - teak", category: "Timber", cls: "wood", set: "wood-teak", size: 1.0, color: "#c89a6a", rough: 0.55, words: "teak|wpc|composite|timber cladding|wood cladding|slat" },
  { id: "mt-timber-walnut", name: "Wood-look composite - walnut", category: "Timber", cls: "wood", set: "wood-dark", size: 1.0, color: "#ffffff", rough: 0.5, words: "walnut|wenge|dark wood|ebony" },
  { id: "mt-timber-iroko", name: "Iroko", category: "Timber", cls: "wood", set: "wood-teak", size: 1.0, color: "#a9784c", rough: 0.55, words: "iroko|afzelia|doussie" },
  { id: "mt-timber-mahogany", name: "Mahogany", category: "Timber", cls: "wood", set: "wood-dark", size: 1.0, color: "#c07a5a", rough: 0.45, words: "mahogany|sapele|cherry|redwood" },
  { id: "mt-timber-oak", name: "Oak", category: "Timber", cls: "wood", set: "wood-floor", size: 1.5, color: "#ffffff", rough: 0.5, words: "oak|ash|beech|maple|birch|pine|timber|wood|parquet|floorboard|laminate|veneer|plywood" },
  { id: "mt-timber-planks", name: "Timber planks (weathered)", category: "Timber", cls: "wood", set: "wood-planks", size: 2.0, color: "#ffffff", rough: 0.7, words: "planks|boards|decking|deck" },
  // ---- brick and block
  { id: "mt-brick-red", name: "Face brick - red", category: "Brick and block", cls: "brick", set: "brick-red", size: 1.0, color: "#ffffff", rough: 0.9, words: "brick(?!.*(white|buff|yellow))|facing brick|face brick|clay brick|masonry" },
  { id: "mt-brick-buff", name: "Face brick - buff", category: "Brick and block", cls: "brick", set: "brick-buff", size: 1.0, color: "#ffffff", rough: 0.9, words: "buff brick|white brick|yellow brick|light brick" },
  { id: "mt-block-concrete", name: "Concrete block (fair-faced)", category: "Brick and block", cls: "brick", set: "block-concrete", size: 1.2, color: "#ffffff", rough: 0.95, words: "block|cmu|sandcrete|hollow block|blockwork" },
  // ---- concrete
  { id: "mt-concrete", name: "Fair-face concrete", category: "Concrete", cls: "concrete", set: "concrete-fairface", size: 2.4, color: "#ffffff", rough: 0.9, words: "concrete|cast.?in.?situ|in.?situ|reinforced|rc slab|precast|cement" },
  { id: "mt-concrete-polished", name: "Polished concrete", category: "Concrete", cls: "concrete", set: "concrete-polished", size: 2.4, color: "#ffffff", rough: 0.25, words: "polished concrete|screed|power.?float|epoxy" },
  { id: "mt-concrete-board", name: "Board-marked concrete", category: "Concrete", cls: "concrete", set: "concrete-board", size: 2.0, color: "#ffffff", rough: 0.9, words: "board.?marked|board.?formed|shuttered concrete|formwork" },
  { id: "mt-concrete-dark", name: "Dark concrete", category: "Concrete", cls: "concrete", set: "concrete-fairface", size: 2.4, color: "#6e6e6c", rough: 0.85, words: "dark concrete|charcoal concrete" },
  // ---- roofing
  { id: "mt-roof-stonecoated-red", name: "Stone-coated roof tiles - red", category: "Roofing", cls: "roof", set: "roof-tiles", size: 1.5, color: "#b2513a", rough: 0.8, words: "stone.?coated|roof tile|roofing tile|shingle(?!.*(black|grey|gray))|metro tile" },
  { id: "mt-roof-stonecoated-black", name: "Stone-coated roof tiles - black", category: "Roofing", cls: "roof", set: "roof-tiles", size: 1.5, color: "#3a3a3c", rough: 0.8, words: "black roof|grey roof tile|gray roof tile|black shingle" },
  { id: "mt-roof-stonecoated-coffee", name: "Stone-coated roof tiles - coffee", category: "Roofing", cls: "roof", set: "roof-tiles", size: 1.5, color: "#6a4e3a", rough: 0.8, words: "brown roof|coffee roof|chocolate" },
  { id: "mt-roof-longspan-grey", name: "Long-span aluminium roofing - grey", category: "Roofing", cls: "roof", set: "roof-metal", size: 1.2, color: "#9ea3a8", rough: 0.4, metal: 0.6, words: "long.?span|aluminium roof|aluminum roof|metal roof|corrugated|roofing sheet|profiled sheet|zinc roof" },
  { id: "mt-roof-longspan-red", name: "Long-span aluminium roofing - red", category: "Roofing", cls: "roof", set: "roof-metal", size: 1.2, color: "#8f3a2f", rough: 0.45, metal: 0.4, words: "red long.?span|red roofing sheet" },
  { id: "mt-roof-longspan-blue", name: "Long-span aluminium roofing - blue", category: "Roofing", cls: "roof", set: "roof-metal", size: 1.2, color: "#3a5a7e", rough: 0.45, metal: 0.4, words: "blue roof" },
  { id: "mt-roof-clay", name: "Clay roof tiles", category: "Roofing", cls: "roof", set: "roof-tiles", size: 1.5, color: "#c9764e", rough: 0.85, words: "clay tile|terracotta tile|spanish tile|pantile" },
  { id: "mt-roof-membrane", name: "Roof membrane / flat roof", category: "Roofing", cls: "roof", set: "concrete-fairface", size: 2.4, color: "#8b8b88", rough: 0.9, words: "membrane|bitumen|waterproof|flat roof|felt" },
  // ---- metal
  { id: "mt-alu-black", name: "Black aluminium", category: "Metal", cls: "metal", set: "metal-painted", size: 1.0, color: "#2a2b2d", rough: 0.45, metal: 0.6, words: "black alumin|black metal|powder.?coat.*black|black frame|anodi[sz]ed black" },
  { id: "mt-alu-bronze", name: "Bronze aluminium", category: "Metal", cls: "metal", set: "metal-painted", size: 1.0, color: "#6b5236", rough: 0.4, metal: 0.65, words: "bronze|champagne|gold alumin|brass" },
  { id: "mt-alu-silver", name: "Silver aluminium", category: "Metal", cls: "metal", set: "metal-brushed", size: 0.8, color: "#c9ccd0", rough: 0.35, metal: 0.85, words: "alumin(i?)um|mill finish|anodi[sz]ed|window frame|mullion|curtain wall frame" },
  { id: "mt-steel-brushed", name: "Brushed steel", category: "Metal", cls: "metal", set: "metal-brushed", size: 0.8, color: "#ffffff", rough: 0.3, metal: 0.9, words: "stainless|brushed steel|chrome|inox" },
  { id: "mt-steel-painted", name: "Painted steel", category: "Metal", cls: "metal", set: "metal-painted", size: 1.0, color: "#5a5f63", rough: 0.5, metal: 0.4, words: "steel|iron|metal|galvani[sz]ed|structural steel|rhs|chs" },
  { id: "mt-zinc", name: "Zinc / titanium-zinc", category: "Metal", cls: "metal", set: "metal-brushed", size: 0.8, color: "#8d9396", rough: 0.55, metal: 0.7, words: "zinc|titanium zinc|lead" },
  { id: "mt-copper", name: "Copper", category: "Metal", cls: "metal", set: "metal-brushed", size: 0.8, color: "#b87351", rough: 0.4, metal: 0.9, words: "copper|corten|weathering steel" },
  // ---- glass
  { id: "mt-glass-clear", name: "Clear glass", category: "Glass", cls: "glass", set: null, size: 1, color: "#bcd9e6", rough: 0.03, opacity: 0.35, words: "glass(?!.*(tint|frost|reflect|bronze|grey|gray|obscur|sandblast))|glazing|glazed|pane|vision panel" },
  { id: "mt-glass-tinted", name: "Tinted glass - grey", category: "Glass", cls: "glass", set: null, size: 1, color: "#56646c", rough: 0.03, opacity: 0.55, words: "tint|grey glass|gray glass|smoked|bronze glass|solar glass" },
  { id: "mt-glass-reflective", name: "Reflective glass - blue", category: "Glass", cls: "glass", set: null, size: 1, color: "#3c6a8c", rough: 0.02, opacity: 0.7, metal: 0.5, words: "reflective|mirror glass|blue glass|curtain wall glass" },
  { id: "mt-glass-frosted", name: "Frosted glass", category: "Glass", cls: "glass", set: null, size: 1, color: "#e3edf1", rough: 0.35, opacity: 0.75, words: "frost|obscur|sandblast|satin glass|privacy glass|translucent" },
  // ---- landscape
  { id: "mt-grass", name: "Grass lawn", category: "Landscape", cls: "grass", set: "grass", size: 2.0, color: "#ffffff", rough: 1, words: "grass|lawn|turf|landscap" },
  { id: "mt-paving-interlock", name: "Interlocking paving stones", category: "Landscape", cls: "paving", set: "paving", size: 1.5, color: "#ffffff", rough: 0.85, words: "interlock|paving|paver|cobble|driveway|walkway" },
  { id: "mt-gravel", name: "Gravel", category: "Landscape", cls: "paving", set: "gravel", size: 1.5, color: "#ffffff", rough: 0.95, words: "gravel|chippings|pebble|aggregate" },
  { id: "mt-asphalt", name: "Asphalt", category: "Landscape", cls: "asphalt", set: "asphalt", size: 2.5, color: "#ffffff", rough: 0.95, words: "asphalt|tarmac|road" },
  { id: "mt-soil", name: "Planting soil and plants", category: "Landscape", cls: "grass", set: "soil", size: 2.0, color: "#ffffff", rough: 1, words: "soil|earth|planting|planter|topsoil|garden" },
  { id: "mt-water", name: "Pool water", category: "Landscape", cls: "glass", set: null, size: 1, color: "#3f8fa8", rough: 0.02, opacity: 0.6, words: "water|pool" },
  // ---- other
  { id: "mt-fabric", name: "Fabric / upholstery", category: "Other", cls: "furniture", set: "fabric", size: 0.6, color: "#ffffff", rough: 0.95, words: "fabric|upholster|textile|cushion|carpet|rug" },
  { id: "mt-plastic-white", name: "White plastic / uPVC", category: "Other", cls: "paint", set: null, size: 1, color: "#f0f0ee", rough: 0.4, words: "upvc|pvc|plastic|acrylic|resin|sanitary|porcelain fixture|ceramic fixture|vitreous" },
  { id: "mt-rubber-black", name: "Black rubber / gasket", category: "Other", cls: "paint", set: null, size: 1, color: "#1d1d1f", rough: 0.9, words: "rubber|gasket|seal|epdm|neoprene" },
  { id: "mt-light-line", name: "Warm light line", category: "Other", cls: "paint", set: null, size: 1, color: "#ffd9a0", rough: 0.5, emissive: "#ffb347", words: "light line|led strip|cove light" },
];

// Ollic Sketch materials that keep their own names in exported IFCs (same ids, same names)
const BY_ID = new Map(MATERIALS.map(m => [m.id, m]));
export const materialById = id => BY_ID.get(id) || null;
export const CATEGORIES = [...new Set(MATERIALS.map(m => m.category))];

/** The plain, untextured stand-in for each class, used when a name says nothing and only the colour is known. */
export const BY_CLASS = { paint: "mt-paint-white", plaster: "mt-render-sand", concrete: "mt-concrete", stone: "mt-sandstone", brick: "mt-brick-red", tile: "mt-tile-ceramic-white-300",
  wood: "mt-timber-oak", metal: "mt-alu-silver", glass: "mt-glass-clear", roof: "mt-roof-longspan-grey", grass: "mt-grass", paving: "mt-paving-interlock", asphalt: "mt-asphalt",
  furniture: "mt-fabric", ceramic: "mt-plastic-white", space: null };
/** Classes whose look keeps the architect's colour when only the class is known (paint takes any colour). */
export const TINTABLE = new Set(["paint", "plaster", "concrete", "metal", "glass", "roof", "furniture", "ceramic"]);
