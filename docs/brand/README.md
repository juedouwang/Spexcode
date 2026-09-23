# Brand assets

**縦縫 — one seam, two hands.** Every asset is split by a hard vertical seam. Left of it is warm cream
washi carrying *Spex* in black sumi dry-brush lettering; right of it is near-black carrying *Code* in
electric-cyan hard-edged pixel type. Above the join sits a `< >` pair, the `<` brushed and the `>` pixelled.
The seam is the idea: the spec is written by a hand, the code is built by a machine, and SpexCode is the
line where they meet without either side bleeding into the other. Tagline: **Specs govern. Agents build.**

Palette (approximate — the artwork is raster): cream `#F3ECDE` · ink `#0E0E10` · cyan `#17E6F0`.
No other hue appears anywhere in the system.

| file | what it is |
| --- | --- |
| `../banner.png` | the README header, 1536×490 (about 3.1:1). GitHub shows it at 720px; the seam sits at the exact centre so it survives both README themes without a `<picture>` switch. |
| `social.png` | GitHub social preview, 1280×640 (2:1 crop of the 16:9 card). |
| `wordmark.png` / `wordmark-notag.png` | the lockup on transparency for light surfaces (with / without the tagline). |
| `wordmark-dark.png` / `wordmark-notag-dark.png` | the same lockups with the brush and tagline turned cream for dark surfaces; the cyan is unchanged. |
| `favicon-source.png` | the favicon master, 1024×1024: a rounded tile cut by a **diagonal** seam — cream upper-left with the brushed `<`, black lower-right with the pixel `>`; corners transparent. |
| `favicon/` | `favicon-{16,32,48,64,128,180,192,512}.png` and a multi-size `favicon.ico`, all derived from the master. |
| `avatar.png` | GitHub organisation / app avatar, 1024×1024 — the same tile as the favicon, so the two read as one identity when shown side by side. |
| `mark.png` | the standalone `< >` mark on transparency, 1024×1024, for inline use in docs at 48px and up. It is deliberately **not** the favicon: at 16px its bare strokes turn to mush, which is why the favicon is a filled tile. |

Rules learned while making the set, worth keeping:

- **A favicon needs a filled ground.** Every transparent candidate lost its black half on dark browser
  chrome and its cream half on light chrome; only tiles and heavy silhouettes survived 16px in both.
- **Text is rendered into the artwork, not set as type.** The lettering *is* the design here, so the
  wordmark files are raster and the exact strings are fixed: `SpexCode` (capital S, capital C, no
  space) and `Specs govern. Agents build.` Changing the tagline means regenerating the lockup.
- **Keep the copy zone flat.** The right two-thirds of the banner and the lower half of the social card
  carry no strokes or texture beyond faint paper tooth; that is what lets badges and text sit under them.

The dashboard's built-in `spexcode` identity preset (`packages/spec-core/src/identity-presets.js`) draws
the same tile as a 24-unit vector chip — cream/black split on the steep seam, a flat black chevron for the
brushed `<`, five cyan blocks for the pixel `>` — so the browser tab, project rows and rail show the
favicon's geometry without loading a raster.

Provenance: the artwork was generated with OpenAI GPT Image 2.5 (via OpenRouter) in a relay of
single-set design sessions supervised through SpexCode, reviewed one set at a time and ranked by
independent judge sessions; the favicon tile was the owner's pick from 27 candidates. Derived files
(favicon sizes, the 2:1 social crop, the dark wordmarks) are deterministic PIL transforms of the masters.
