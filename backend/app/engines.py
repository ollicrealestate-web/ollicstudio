"""The options customers choose from, under Ollic's own names (the AI behind each stays hidden).
Standard render and Premium render are unchanged; the others are added beside them. An option
whose service is not connected is still listed, marked so, and cannot be chosen."""

IMAGE_ENGINES = {
    # id: Ollic name, what it is good at, cost note, the model behind it (server only)
    "swift": {"name": "Ollic Swift", "blurb": "Fast and sharp. Best for edits, material and furniture swaps, and clean line drawings.",
              "price": "about $0.05 an image", "model": "gemini-nano-banana-2.1"},
    "ultra": {"name": "Ollic Ultra", "blurb": "Highest realism and detail, for final presentation images.",
              "price": "about $0.13 an image", "model": "gemini-3-pro-image"},
    "studio": {"name": "Ollic Studio", "blurb": "Uses up to 10 reference images to match a style closely.",
               "price": "about $0.05 an image", "model": "flux-3", "soon": True},
    "vs": {"name": "Ollic VS", "blurb": "Precise edits that keep the building exactly as it is; quick style, material and lighting changes.",
           "price": "about $0.04 an image", "model": "fal-ai/flux-pro/kontext"},
}
VIDEO_ENGINES = {
    "motion": {"name": "Ollic Motion", "blurb": "One shot from the gold wireframe to the finished building: start and end frame, 3 to 15 s, optional sound.",
               "price": "about $0.08 to $0.17 a second"},
    "cinema": {"name": "Ollic Cinema", "blurb": "Film-quality camera moves and light.", "price": "about $0.12 a second", "soon": True},
    "reel": {"name": "Ollic Reel", "blurb": "Social-media style reels with sound.", "price": "about $0.14 a second", "soon": True},
    "vs": {"name": "Ollic VS", "blurb": "Start and end frame clips, 4 to 15 s, with natural sound. Higher cost.",
           "price": "about $0.30 a second (720p), $0.68 (1080p)"},
}
# AI walkthroughs from the architect's model: an exact guide video becomes a photoreal shot
FILM_ENGINES = {
    "path": {"name": "Ollic Path", "blurb": "Follows your camera move and your building closely; best for walkthroughs and fly-arounds, up to 10 s a shot.",
             "price": "about $0.28 a second"},
    "path_plus": {"name": "Ollic Path Plus", "blurb": "Richer light and life (people, cars); slightly freer with fine detail. Up to 10 s a shot.",
                  "price": "about $0.17 a second"},
}
PAID_TIERS = {"premium", "swift", "ultra", "studio", "vs"}
