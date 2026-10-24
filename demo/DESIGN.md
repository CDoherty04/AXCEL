# DESIGN.md: BEC credit dashboard

Status: approved direction. Every page builds from this file.
Replaces the earlier calm version (rounded, gray, small type). We dropped it because it read as generic and low-impact.

## Subject, audience, job

- **Subject:** a credit dashboard for one person and the AI agents that spend on their behalf.
- **Audience:** hackathon judges first, then borrowers.
- **Primary job:** make the score traceable at a glance. A viewer sees the score, how much credit is used, and what each agent did.
- **Lead with:** the score. It is the one large color plane on the screen.

## Direction: bold, brutalist, premium

Structure is shown, not hidden: heavy type, square corners, flat planes of color, thick rules. Premium comes from restraint: precise spacing, a strong type scale, few colors, and every heavy element earning its place.

## Less text (core rule)

Keep words on screen to a minimum so nothing feels cluttered.

- Panel headings: one to three words. No subtitles, no explanatory sentences under headings.
- Table cells: a word or a number. If a cell needs a sentence, move the sentence behind a click (row detail), not onto the page.
- One note per screen at most, and only where a user could make a mistake without it.
- Buttons name the action in one or two words: "Pay installment," "Revoke."
- Labels never repeat what a heading already says. Show the network once in the top bar, not on every panel.
- Prefer a number, a bar or a status word over a description.
- When in doubt, cut it.

## Color

Base:

| Token | Hex | Use |
| --- | --- | --- |
| `page` | `#FFFFFF` | page background |
| `ink` | `#241A44` | text, rules, top band (deep violet from the banner, not a tinted black) |
| `muted` | `#5B5470` | secondary text |
| `tint` | `#F3F1F7` | table header rows |
| `line` | `#D9D5E6` | row dividers only |

Banner colors, each with one job:

| Token | Hex | Job |
| --- | --- | --- |
| `violet` | `#B482FD` | the score plane, network tag |
| `periwinkle` | `#B5CBFC` | agent 1 in the credit bar |
| `pink` | `#E78ECA` | agent 2 in the credit bar |
| `orange` | `#EA5F0F` | something due soon |
| `brick` | `#B03008` text, `#FCEBE5` row tint | refused or failed |

Rules:

- One large color plane per screen: the violet score block. No other panel gets a color fill.
- Status is never color alone. Pair it with a word ("Refused," "Settled").
- No gradients in the UI.
- Text on violet is `ink`. Never use periwinkle, pink or orange as text.

## Type

- **Display:** Archivo, wide (stretch 112 to 122%), weight 700 to 850. Headings and big numbers.
- **Text and tables:** Public Sans, 400 to 600, tabular numbers on all figures.
- **Hashes and addresses only:** IBM Plex Mono.
- **Scale:** 14 / 15 / 20 / 32 / 96 / 176 px. 176 is the score, 96 is the credit used.
- **Banned:** Inter and Geist, all-caps labels, tracked eyebrows, one accented word in a headline, `→` on links, `01 / 02 / 03` markers unless the content is a real sequence.

## Shape and layout

- Square corners everywhere. Radius is 0.
- A 3px `ink` frame around the hero. A 6px `ink` rule above each section heading. Row dividers are 1px `line`.
- Left-aligned, max width 1200 px, 40 px side padding, 72 px between sections.
- Order: top band, hero (score and credit used), then tables: score breakdown, agents, purchases, repayments.
- Tables over cards. No grid of identical boxes.
- Buttons: 48 px tall, 2px `ink` outline, square. Primary is filled `ink` with white text. Secondary is outlined.

## Not allowed

- Offset drop shadows, glows, glass or blur.
- Rotated, sticker or badge-style elements.
- Pill shapes and rounded buttons.
- Emoji, and mixed icon sets. One stroke icon set only if icons are needed.
- Thick borders on every table or every panel.
- Fade-and-slide entrances, hover effects on rows, count-up numbers.
- Invented stats. Every figure is sample data until the backend replaces it, and the top bar says "Sample data."

## Motion

Only in response to an action: the credit bar fills when a purchase settles, a row appears when an event arrives. One optional moment, pending approval: the tier block changes when the score crosses from B to A.

## Copy

Sentence case, plain verbs, short. Errors say what happened and what to do, in a few words ("Refused: over limit").

## Self-review against known tells

- Cream and clay: not used.
- Near-black with a neon accent: not used. The dark tone is a deep violet, and color sits in flat planes.
- Purple gradient: not used. Violet is flat.
- Broadsheet hairlines and dense columns: avoided. Structure comes from a few thick rules and large type.
- Neo-brutalist template (thick black borders on everything, offset shadows, pills, stickers): the "Not allowed" list blocks it.
- SaaS card kit: avoided.
- Zero border radius is itself a listed default. Here it is a deliberate choice for this brief, so mark it as intended if a scanner flags it.

## Before merge

- Scan with `avoid-ai-design` or Impeccable in detect mode, and review against Vercel's web-design-guidelines.
- Keyboard focus visible, reduced motion respected, contrast checked on every color pairing.
