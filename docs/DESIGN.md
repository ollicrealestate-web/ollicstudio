# Design system

The visual direction, tokens and rules for every Ollic page. All of them live in `web/assets/styles.css`.

## Direction

Made with **UI/UX Pro Max** (v2.15.0, `nextlevelbuilder/ui-ux-pro-max-skill`), then adjusted to the owner's brief: black and red.

| Decision | From the skill | Adjusted |
| --- | --- | --- |
| Base style | Dark Mode (OLED): deep black, high-contrast text, minimal glow | Kept |
| Feature layout | Bento Box Grid: mixed-size modular cards, about 22 px radius, 4 → 2 → 1 columns | Kept |
| Landing pattern | Scroll-triggered storytelling: hook, chapters, final call to action | Kept: hero, three steps, outputs, site practice, call to action |
| Palette | Suggested black + gold | **Black + signal red**, the owner's choice |
| Type | Bauhaus Geometric (Outfit), architectural and constructivist | Outfit for everything; IBM Plex Mono for data, labels and stage codes |
| Motion | Stagger reveal, 300–450 ms | 520 ms reveal with a 60 ms stagger; the house line drawing; all off under reduced motion |

The signature details are the faint red blueprint grid behind every page, and the hero's bungalow drawn in red linework stage by stage.

## Tokens

| Token | Value | Use | Contrast |
| --- | --- | --- | --- |
| `--bg` | `#070707` | page | |
| `--surface` / `-2` / `-3` | `#111113` / `#17171a` / `#1e1e22` | cards, inputs, chips | |
| `--line` / `--line-strong` | `#26262b` / `#3a3a41` | borders | |
| `--ink` | `#f4f4f5` | text | 18.3:1 on bg |
| `--muted` | `#a3a3ad` | secondary text | 8.1:1 on bg, 7.2:1 on surface-2 |
| `--red` | `#d42127` | buttons, bars, marks | white text 5.2:1 |
| `--red-hover` | `#b91c22` | button hover | white text 6.5:1 |
| `--red-text` | `#ff4a4f` | red words on black | 6.1:1 on bg, 5.7:1 on cards |
| `--red-soft` on `--red-tint` | `#ff8a8d` on `#2a0c0e` | error text | 8.0:1 |

## Rules (from the skill's pre-delivery checklist)

- SVG icons only, never emoji. Icons are decorative and carry `aria-hidden`, so every icon button also has a text label.
- Every clickable element shows a pointer cursor and a 150–300 ms hover transition.
- Focus is always visible: a 2 px red outline.
- Touch targets are at least 44 px tall.
- Respect `prefers-reduced-motion`: animations and smooth scrolling are switched off, and content is fully visible without JavaScript.
- Check layouts at 375, 768, 1024 and 1440 px, with no horizontal scrolling. Verified at 390 and 1440 px.
- The body text is 16 px with a line height of 1.6, and labels are never smaller than 0.66 rem in mono caps.
