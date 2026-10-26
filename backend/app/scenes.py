"""Scene presets: how the render is staged around the architect's building (light, sky, setting, planting,
life, camera and mood), as written recipes. The building, its geometry and its approved materials always
come from the model and the project look; a scene never changes them.

The exterior scenes were written on 26 Oct 2026 from a study of twenty published architectural renders
the owner collected as the quality bar. Only the scene qualities were described (no building, brand or
image is copied or stored). Nine aerial scenes and the planting rule were added the same day from a second
study of nine aerial renders. Interior, site plan and estate scenes are Ollic's own starters.

A project keeps one scene (a preset, or one Claude reads from the architect's own reference picture) in its
look, so every view, walkthrough shot and stage is staged the same way.
"""

from __future__ import annotations

RENDER_TYPES = {
    "exterior": {"name": "Exterior", "rule": "An exterior view of the building in its setting, at a true photographic eye level or the given camera."},
    "interior": {"name": "Interior", "rule": "An interior view: keep every wall, opening, ceiling height, stair and built-in exactly as in the model; furnish and light "
                 "it as a finished, lived-in space; windows show a believable outside view; true verticals, no fish-eye distortion."},
    "site_plan": {"name": "Site plan", "rule": "A rendered SITE PLAN seen straight from above (orthographic, north up as given): keep the building footprint, plot "
                  "boundary, driveways, paths, parking and setbacks exactly to scale as in the drawing or model; render roofs, paving, lawns, "
                  "planting, trees with soft shadows, water and cars in plan view; no perspective, no text or labels."},
    "estate": {"name": "Estate layout", "rule": "An ESTATE / MASTERPLAN view of several plots: keep the road layout, plot sizes, house positions and orientations "
               "and the number of houses exactly as in the drawing or model; every house of the same type identical; render streets, "
               "pavements, street trees, landscaping, cars and a few people; no extra or missing houses, no text or labels."},
}

# id: (name, render type, one line for the picker, the recipe sent with every render)
SCENES = {
    # ---------------------------------------------------------------- exterior (from the study)
    "golden_driveway": ("Golden Hour Driveway", "exterior", "Low warm sun, dappled tree shadows, cars in the carport, uplit planting.",
        "Late-afternoon golden-hour sun low from the side, long soft shadows and dappled leaf shadows across the facade from an overhanging tree "
        "at the frame edge; clear blue sky with a few thin clouds; warm recessed downlights glowing in the soffits; a paved driveway and stepped "
        "stone entry, lush layered planting with agaves, palms and ferns lit by small ground uplights, a large natural boulder; two or three "
        "premium cars parked under the carport; eye-level camera at about 1.6 m, 24-28 mm lens, gentle two-point perspective, true verticals."),
    "blue_hour": ("Blue Hour Glow", "exterior", "Deep blue dusk sky, warm glowing interiors, lit palms and steps.",
        "Blue hour just after sunset: deep blue sky fading to soft pink and orange clouds near the horizon; every window glowing warm with "
        "furnished, lit interiors; warm LED cove lines and soffit downlights; uplit palm trees and planting; lit step nosings on the entry stair; "
        "a smooth driveway with a few premium cars catching reflections; frontal or slight three-quarter view from the street, 28-35 mm lens, "
        "calm and luxurious mood."),
    "terraced_dusk": ("Terraced Garden, Soft Dusk", "exterior", "Pale evening sky, stone stair with backlit risers, layered planters.",
        "Soft evening light under a pale, clear sky; a wide stone staircase rising through terraced planters with backlit risers and warm "
        "under-step lighting; cascading planting, ornamental grasses and palms; warm timber soffits glowing with downlights; glass balustrades "
        "with interior light behind; smooth paved driveway in the foreground; low three-quarter camera looking slightly up, 24 mm lens."),
    "cinematic_street": ("Cinematic Street, Golden Light", "exterior", "Low sun, tree branches framing the shot, a car at the kerb, film look.",
        "Cinematic golden light just before sunset, warm haze; olive-tree branches and leaves out of focus in the foreground framing the top of "
        "the shot; shallow depth of field; a sleek sports car parked at the kerb in front; low boundary wall with gravel and dry planting; warm "
        "highlights and soft long shadows; camera at standing height across the street, 50 mm lens, filmic colour."),
    "frontal_clear": ("Frontal Elevation, Clear Sky", "exterior", "Straight-on facade, bright blue sky, crisp shadows, palms.",
        "A straight-on frontal view of the facade, centred and symmetrical, verticals perfectly straight; bright midday sun, deep blue sky with "
        "soft scattered clouds; crisp shadows from the overhangs; tree shadows falling across the road in the foreground; neat lawn strip and "
        "low planting, palms at the sides; one premium car parked in the driveway; camera across the street at 1.6 m, 35 mm lens."),
    "overcast_wet": ("Moody Overcast, Wet Street", "exterior", "Grey sky, rain-wet paving with reflections, warm cove lights.",
        "Moody overcast evening, soft grey clouds, no direct sun; rain-wet paving and street with sharp reflections of the warm lights; warm LED "
        "cove lighting under each slab edge and soffit; interiors softly lit; potted trees and planters on the balconies; a car parked in front "
        "reflecting in the wet ground; tree branches at the top corner; frontal view from the street, 35 mm lens, calm, premium mood."),
    "twilight_tower": ("Twilight Residential Tower", "exterior", "Clear twilight, every apartment lit, street rising past the building.",
        "Clear twilight sky graded from pale blue to warm near the horizon; every apartment window glowing warm with visible furniture and "
        "plants on the balconies; planters along each balcony edge; trees and a landscaped base lit with uplights; a sloping street with a few "
        "parked cars; neighbouring blocks plain and quiet; low three-quarter view from the pavement, 24 mm lens, perfectly vertical lines."),
    "aerial_golden": ("Aerial, Hazy Golden Hour", "exterior", "Drone view in warm haze over wide landscape, cypress and pool.",
        "High three-quarter drone view in warm, hazy golden-hour light; a wide landscape stretching to a soft horizon; native shrubs, rocks, "
        "tall cypress trees around the building; terraces with outdoor furniture and a still pool reflecting the sky; long soft shadows; "
        "atmospheric depth; 24 mm aerial camera."),
    "desert_courtyard": ("Desert Courtyard Oasis", "exterior", "Strong clear sun, palms, still reflecting pools, stepping stones.",
        "Strong clear midday sun in a cloudless deep-blue sky; crisp palm-frond shadows across warm stone walls; still reflecting pools with "
        "floating stepping stones leading to the entrance; tall date palms, olive trees and sculptural desert planting in large pots; one person "
        "walking towards the door, seen from behind; low camera near the water surface, 24 mm lens, serene resort mood."),
    "coastal_drone": ("Coastal Drone Overview", "exterior", "High drone view, neighbourhood, palm-lined road, sea on the horizon.",
        "High drone view at about 45 degrees in soft bright daylight under a light overcast sky; the building in its neighbourhood with a "
        "palm-lined road, pavements, a few cars and people walking; neighbouring houses with terracotta and flat roofs; lush gardens; the sea "
        "and beach on the horizon; true colours, 24 mm aerial lens."),
    "entrance_close": ("Entrance Close-up, Lush Garden", "exterior", "Eye-level detail at the front door, soft daylight, rich planting.",
        "A close eye-level view of the entrance: the front door, the canopy above and the materials in sharp detail; soft warm daylight; lush "
        "tropical planting, ornamental grasses and lawn in the foreground; stepping pavers leading to the door; a slim house-number post; part of "
        "the carport with a parked car; 35 mm lens, shallow depth of field on the planting."),
    "estate_evening": ("Estate Street, Soft Evening", "exterior", "Row of houses along a curving paved drive, evening light.",
        "Soft evening light after sunset, gentle overcast sky; the houses repeating along a curving paved private drive; warm soffit and "
        "entrance lights on; clipped hedges and round shrubs, mature trees; premium cars parked in front of several houses and one driving in; "
        "low three-quarter view down the street, 28 mm lens, vanishing perspective."),
    "real_photo": ("Real Photo, Just Built", "exterior", "Like a phone photo of the finished house: natural, unstyled.",
        "Looks like a real photograph of the just-finished building taken on a good phone camera: natural late-afternoon light, light blue sky, "
        "freshly laid turf and young planting, a clean paved driveway, a neighbouring wall and tree at the edge; no added people or cars; "
        "slightly wide lens from the street, honest everyday colours, no stylised lighting."),
    "dry_garden": ("Dry Garden, Warm Morning", "exterior", "Xeriscape with boulders and gravel, olive tree, warm low sun.",
        "Warm low morning sun from the side with soft shadows; pale clear sky; a dry garden of gravel, natural boulders, ornamental grasses, "
        "agaves and a young olive tree casting a lacy shadow on the facade; a paved driveway on one side; timber and stone textures glowing in "
        "the warm light; eye-level three-quarter view, 28 mm lens."),
    "desert_sunset": ("Desert Villa Sunset", "exterior", "Low dramatic angle, sunset glow, wide forecourt, desert planting.",
        "Dramatic low camera close to the ground, 20 mm lens; warm sunset light grazing the facade and making the glazing glow; clear sky "
        "fading from blue to warm; a wide polished stone forecourt; low desert planting, agaves and acacia trees; interiors lit warm behind "
        "full-height glass; bold, premium mood."),
    "resort_evening": ("Resort Evening, Pool Terrace", "exterior", "Glowing planters, candles, pool and sunken lounge at dusk.",
        "Evening just after sunset with a deep blue sky and a few pink clouds; the building fully lit inside and out with warm wall lights and "
        "soffit downlights; a wide terrace with steps lit by small step lights; glowing white planters with tropical plants; a sunken lounge "
        "with cushions and candles in glass beside a still pool; symmetrical view from the pool, 24 mm lens, five-star resort mood."),
    "bright_daylight": ("Bright Real-Estate Daylight", "exterior", "Wide lens, saturated blue sky and clouds, green lawn.",
        "Bright midday sun, saturated blue sky with big white cumulus clouds; a perfectly kept green lawn with stepping-stone path and white "
        "pebbles; a young palm in front; strong clean shadows; wide-angle real-estate camera close to the ground, 18-20 mm lens, vivid but "
        "natural colours."),
    # ---------------------------------------------------------------- aerial (from a second study, 26 Oct 2026)
    "valley_misty": ("Valley Masterplan, Misty Light", "estate", "High aerial over a valley, mountains in haze, low cloud in front.",
        "Very high aerial view at about 50 degrees over a wide green valley in soft early-evening light; layered mountains fading into warm "
        "haze and drifting cloud on the horizon; wisps of low cloud blurring the bottom corners of the frame; the development sitting in a "
        "dense mosaic of mature trees of many sizes and shades of green; winding roads and lanes lined with trees; warm lights just coming on "
        "in buildings, a turquoise pool catching the sky; fields, ponds and bare earth around the edges; strong atmospheric depth, 35 mm aerial lens."),
    "rooftop_gardens": ("Golden Rooftop Gardens", "exterior", "Elevated corner view at sunset, life on balconies, canal and trees.",
        "Elevated three-quarter view from about the height of the roof, warm low sunset light raking across the facades; a pale peach sky with "
        "a flock of birds; balconies and terraces full of life: people dining and talking, outdoor furniture, umbrellas, potted trees and "
        "flowering plants spilling over the rails; green and wildflower roofs; a tree-lined canal or promenade below with people walking; "
        "the city and treetops fading into warm haze behind; 28 mm lens, rich, inviting mood."),
    "urban_drone_sunset": ("Urban Drone, Soft Sunset", "exterior", "Real drone photo look, mature park trees, city and hills behind.",
        "Looks like a real drone photograph at about 40 degrees in soft, low sunset light with a pale hazy sky; the building surrounded by "
        "mature park trees with full, irregular canopies; a wide road with young street trees, lamp posts and one or two cars; neat verges and "
        "paths; the existing city of mixed roofs and a forested hill behind, fading in haze; natural, slightly muted photographic colour, "
        "no stylised lighting, 35 mm lens."),
    "parkland_pines": ("Parkland Aerial, Umbrella Pines", "exterior", "Building set in rolling lawn with umbrella pines, bright day.",
        "High three-quarter drone view in bright, warm daylight; the building set in rolling, well-kept lawn with natural colour variation; "
        "groups of mature umbrella pines and broadleaf trees with soft shadows; planters with trailing greenery on every terrace edge; a "
        "winding footpath and a broad entrance stair; open, calm parkland feel, 24 mm aerial lens."),
    "green_campus": ("Green Campus, Summer Sun", "estate", "Buildings among dense deciduous trees, curving paths, crisp sun.",
        "Steep aerial view at about 55 degrees in crisp, clear summer sun with defined but soft shadows; buildings spread among dense, "
        "full-canopy deciduous trees of varied heights and greens; green and solar roofs; curving stone paths and plazas with lamp posts, "
        "benches and lawns; a hedge-lined road and parking at the edge; vivid but natural colour, 35 mm aerial lens."),
    "hillside_forest": ("Hillside Forest Sunset", "exterior", "Building on a slope against dense forest, warm sun flare, tropical plants.",
        "Slightly elevated view from across a sloping hillside at sunset; the sun low on the right with a soft warm flare and glowing peach "
        "clouds; a dense backdrop of tall, layered forest trees; lush tropical planting, banana plants, ferns and wild grass on the slope; "
        "rocks half-buried in the grass; warm interiors and small uplights glowing; dark foreground shrubs framing the bottom of the frame; "
        "24 mm lens, cinematic, serene mood."),
    "waterfront_topdown": ("Waterfront Top-down, Late Sun", "estate", "Near-vertical view over a canal, boats, warm low light shafts.",
        "Near top-down drone view, about 75 degrees, in warm late-afternoon light with soft shafts of sun through the trees; a canal or "
        "water channel with small boats and jetties; patterned promenades, green strips and clipped trees; people walking; parked cars and "
        "cafe umbrellas; buildings with glowing amber windows and planted roof terraces; deep, rich contrast, 35 mm lens."),
    "suburb_sunset": ("Tropical Suburb Sunset Drone", "estate", "Drone over a leafy neighbourhood at sunset, palms and hedges.",
        "Drone view at about 45 degrees at sunset with a warm orange sky; a leafy neighbourhood of houses with hip roofs and pools; "
        "tall palms and dense, varied tropical trees stretching to the horizon; clipped hedges and neat lawns along curving streets with "
        "white kerbs; soft warm light on the roofs; real photographic colour, 28 mm aerial lens."),
    "terraced_green_city": ("Terraced Green City, Daylight", "exterior", "Aerial of a tower and podium with planted terraces, plaza.",
        "High three-quarter aerial in clear, warm daylight with a light haze; stepped terraces and roofs planted with trees, lawns and "
        "shrubs; a busy plaza with a fountain and people; palm-lined road and parking with cars; the city spreading behind to the horizon "
        "in haze; 28 mm aerial lens, bright and optimistic mood."),
    # ---------------------------------------------------------------- interior (Ollic starters)
    "interior_morning": ("Soft Morning Living Room", "interior", "Soft daylight through sheer curtains, calm neutral styling.",
        "Soft morning daylight through sheer curtains, gentle shadows; neutral, calm styling with a linen sofa, timber and stone accents, a rug, "
        "books and a few plants; a believable garden view outside; eye-level camera at 1.2-1.4 m, 24 mm lens, true verticals."),
    "interior_evening": ("Warm Evening Interior", "interior", "Warm lamps and cove lights, dusk outside the windows.",
        "Evening: deep blue dusk outside the windows; warm cove lighting, pendant and table lamps; rich textures, velvet and timber; a set "
        "dining table or styled kitchen island; reflections in the glass; eye-level camera, 24 mm lens, intimate luxury mood."),
    "interior_kitchen": ("Bright Kitchen and Dining", "interior", "Crisp daylight, styled island, fresh and clean.",
        "Crisp bright daylight from large windows; a styled kitchen island with stools, a fruit bowl, a vase of greenery; clean stone and "
        "timber surfaces; soft reflections; one-point or slight two-point view, 24 mm lens."),
    "interior_lobby": ("Hotel-Style Lobby", "interior", "Double height, warm accent lighting, polished stone, a few people.",
        "A double-height lobby with polished stone floors reflecting warm accent and cove lighting; sculptural pendant; large plants; a few "
        "well-dressed people for scale, softly blurred; symmetrical low camera, 20 mm lens."),
    # ---------------------------------------------------------------- site plan and estate (Ollic starters)
    "site_plan_day": ("Illustrative Site Plan", "site_plan", "Top-down, soft shadows, lawns, trees, paving, cars.",
        "Straight top-down view in soft daylight from the south-west with gentle shadows; roofs in their real materials; driveways and paths "
        "in pavers, lawns, layered planting and tree canopies with soft shadows; a pool if there is one; cars parked in plan view; plot "
        "boundary walls and gates; clean presentation style, true scale."),
    "estate_aerial": ("Estate Aerial, Daylight", "estate", "High three-quarter view of the whole estate, streets and greenery.",
        "High three-quarter aerial view of the whole estate in bright late-morning light; tree-lined streets and pavements, green verges, "
        "front gardens, a park or play area if planned; cars on driveways and a few on the streets; people walking; gate house at the "
        "entrance; soft long shadows; neighbouring land plain and quiet, 28 mm aerial lens."),
    "estate_plan": ("Estate Masterplan Top-down", "estate", "Straight top-down masterplan with landscaping and shadows.",
        "Straight top-down masterplan view in soft daylight; all plots, roofs, roads, pavements, landscaping, trees and open spaces in a "
        "clean illustrative presentation style with soft shadows; true layout and scale; no text, numbers or labels."),
}


def scene_list() -> list[dict]:
    return [{"id": k, "name": v[0], "type": v[1], "blurb": v[2]} for k, v in SCENES.items()]


def scene_text(scene_id: str | None, custom: str = "") -> str:
    if custom:
        return custom
    s = SCENES.get(scene_id or "")
    return s[3] if s else ""


# Every outdoor render: planting is what most often gives an AI render away, so it is spelt out every time.
GREENERY = ("PLANTING must look like a real photograph: mature trees with irregular, natural canopies of different species, heights and "
            "shades of green (never identical clone trees or one flat saturated green); light passing through the leaves and soft shadows "
            "under every canopy; lawns with natural colour variation and edges; shrubs, grasses and ground cover layered and slightly "
            "overgrown, spilling over planters and kerbs; trees partly overlapping roads, paths and the edges of buildings without hiding "
            "the architecture; distant trees softening into atmospheric haze.")


def type_rule(render_type: str | None) -> str:
    kind = render_type if render_type in RENDER_TYPES else ("interior" if render_type == "interior" else "exterior")
    rule = RENDER_TYPES[kind]["rule"]
    return rule if kind == "interior" else rule + " " + GREENERY


# ---------------------------------------------------------------- Claude reads a scene from a reference picture
SCENE_SYSTEM = (
    "You are an architectural visualisation director. Study the reference picture and describe ONLY its scene and photography, so the "
    "same scene can be used around a DIFFERENT building: time of day, sun direction and quality of light, sky, artificial lighting "
    "(soffits, coves, uplights, glowing interiors), ground surfaces and wetness, planting and landscaping, entourage (cars, people, "
    "props), surroundings, camera position, height and lens, depth of field, colour grade and mood. Never describe the building's "
    "shape, materials or design, and never mention brands, names, text or watermarks seen in the picture. Also say whether it is an "
    "exterior, interior, site plan or estate view. "
    'Answer with JSON only: {"name": "a short name, 2-5 words", "type": "exterior|interior|site_plan|estate", '
    '"recipe": "one paragraph of 60-120 words, in the style of a render brief"}'
)
