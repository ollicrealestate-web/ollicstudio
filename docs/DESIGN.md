# Design system

The visual direction, tokens and rules for every Ollic page. They live in `web/assets/styles.css`.

## Direction (24 Oct 2026)

Ollic is a **realistic render studio for architects and designers**. The owner's colours stay: black and signal red. Red is treated as light: the reveal line, the primary action, focus rings and selected text all glow red. Gold (`--gold`) appears only with the golden animation.

- **The one bold moment:** the home page hero is a live render reveal. A red line drawing of a real Ollic render (`web/assets/img/villa-lines.jpg`, made from `villa-render.jpg`) becomes the photoreal render under a line of light that follows the pointer, a finger or the arrow keys (an invisible range input keeps it keyboard and screen-reader friendly). On load, the light sweeps once across and comes to rest.
- **Type:** Archivo (variable, SIL Open Font Licence, self-hosted in `web/vendor/archivo`, Latin subset). Headlines use its wide cut (`font-stretch` 112–125%) like architectural lettering; reading text uses the normal width. No all-caps or monospace labels.
- **Layout:** hero (copy left, reveal right); three services as alternating image and text rows; "How a render is made" as a real four-step sequence; four principles in two quiet columns; a final call to action.
- **Motion answers the visitor:** a red hairline under the header shows scroll progress; the hero picture zooms slightly as you scroll; the steps line fills and lights each step as you scroll through it; a red light follows the pointer on the final call to action; buttons get a passing line of light on hover; sections are uncovered by a light-sweep wipe as they enter. In the studio, each screen rises in when you switch service, new renders "develop" up from dark, running jobs show a scanning red line, and a failed upload shakes once.
- **Selected text** is highlighted red with a soft glow, and a small **Copy** button appears above any selection outside form fields (`web/assets/ui.js`, on both pages).

## Tokens

| Token | Value | Use | Contrast |
| --- | --- | --- | --- |
| `--bg` | `#070707` | page | |
| `--surface` / `-2` / `-3` | `#111113` / `#17171a` / `#1e1e22` | cards, inputs, chips | |
| `--line` / `--line-strong` | `#26262b` / `#3a3a41` | borders | |
| `--ink` | `#f4f4f5` | text | 18.3:1 on bg |
| `--muted` | `#a3a3ad` | secondary text | 8.1:1 on bg, 7.2:1 on surface-2 |
| `--red` | `#d42127` | buttons, lines of light, selection | white text 5.2:1 |
| `--red-hover` | `#b91c22` | button hover | white text 6.5:1 |
| `--red-text` | `#ff4a4f` | red words on black | 6.1:1 on bg |
| `--red-soft` on `--red-tint` | `#ff8a8d` on `#2a0c0e` | error text | 8.0:1 |
| `--gold` | `#ffc46e` | golden animation only | 12:1 on bg |

## Rules

- SVG icons only, never emoji. Icons are decorative and carry `aria-hidden`; every icon button also has a text label.
- Every clickable element shows a pointer cursor and a hover response.
- Focus is always visible: a 2 px red outline.
- Touch targets are at least 44 px tall.
- `prefers-reduced-motion`: every animation and transition is switched off, the hero rests at the half-way reveal, and all content is visible without JavaScript.
- Checked at 390 and 1440 px with no horizontal scrolling.
- Body text 16 px, line height 1.6; lines under about 75 characters.
