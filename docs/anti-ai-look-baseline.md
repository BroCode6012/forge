# Anti-AI-Look — Step 1 Baseline Scorecard

Measured 2026-08-02 against three real finished HyperFrames builds.
Method: the Impeccable detector (deterministic, zero AI cost) run over each
build's generated `index.html`, plus a direct audit of all 8 themes via
`getThemeTokens()`.

Raw scan artifacts: `temp/slop-audit/`.

---

## 1. Static scan of the generated render page

**32 findings per build — identical across all three builds.** Identical counts
across three unrelated videos proves these are *structural*: they come from the
engine's own stylesheet, not from per-video variation.

| Rule | Count | Verdict |
|---|---|---|
| overused-font | 18 | genuine |
| side-tab | 9 | genuine |
| border-accent-on-rounded | 2 | genuine |
| codex-grid-background | 1 | FALSE POSITIVE (`.hf-fx-embera` = deliberate ember particles) |
| dark-glow | 1 | FALSE POSITIVE (offset elevation shadow, not a zero-offset halo) |
| radial-halo | 1 | FALSE POSITIVE (`.hf-fx-flare` = deliberate lens flare) |

**29 of 32 are genuine.** The 3 false positives are all from the intentional
film-FX library — which is exactly why we port a *tuned* ruleset instead of
running the upstream detector blindly.

### side-tab — the #1 AI tell, baked into the engine base stylesheet

Eight of the nine sites are in `hyperframes-bridge.js`'s own CSS, so **every
card in every video** gets it:

| Generated line | Selector | Declaration |
|---|---|---|
| 168 | `.hf-copy-shell` | `border-left: 8px solid var(--hf-primary)` |
| 189 | `.hf-agentic-layout-focus-panel` | `border-left` accent |
| 246 | `.hf-type-callout.hf-variant-minimal` | `border-left: 6px solid var(--hf-accent)` |
| 247 | `.hf-type-callout.hf-variant-accent` | `border-left-width: 16px` |
| 268 | `.hf-agentic-layout-map-explainer` | `border-left: 7px` |
| 372 | `.hf-map-caption` | `border-left: 8px` |
| 418 | `.hf-progress-shell` | `border-left: 8px` |
| 424 | `.hf-type-listicle-counter.hf-variant-ribbon` | `border-left: 12px solid var(--hf-accent)` |

The ninth (generated line 1976, `border-left: 4px solid #c2571b`) is inside an
**AI-authored composition** — the author copied the pattern it saw in the base
stylesheet, and hardcoded the hex while doing it.

### overused-font

`Inter` is the page default (generated line 12, from `hyperframes-bridge.js:4445`).
Plus `@font-face` declarations for Lato, Montserrat, Open Sans, Roboto Condensed,
and 13 `font-family: Lato...` uses inside compositions.

The detector's real overused set (17 entries, read from
`shared/constants.mjs`) is broader than the public docs list:
`inter, roboto, open sans, lato, montserrat, arial, helvetica, fraunces,
instrument sans, instrument serif, geist, geist sans, geist mono, mona sans,
plus jakarta sans, space grotesk, recoleta`.

---

## 2. Theme audit — all 8 themes

| Theme | mgStyle | bg / text / primary / accent | Overused font in a primary slot | Notes |
|---|---|---|---|---|
| crime | cinematic | #000000 / #FFFFFF / #dc143c / #ffd700 | — | Oswald + Barlow Condensed |
| history | elegant | #0a0a0a / #FFFFFF / #d4af37 / #c0c0c0 | — | `glow: true` (dark-glow tell) |
| modern | bold | #0a0a0a / #FFFFFF / **#00ccff / #00ff88** | — | clearest cyan-on-dark AI palette |
| minimal | minimal | #1a1a1a / #FFFFFF / #8B4513 / #87CEEB | — | borderline sky accent on dark |
| standard | clean | #1a1a1a / #FFFFFF / #0066cc / #00cc66 | **heading + stat: Montserrat** | borderline blue/green on dark |
| warm-editorial | editorial-light | #ece0c8 / #2c2218 / #c2571b / #a8662e | **body + caption: Lato** | cream/beige surface |
| luxury | minimal | #0b0a07 / #f5efe2 / #d4b46a / #f0e3bc | **body + caption: Lato** | |
| nature | minimal | #0e1f16 / #f2f7ec / #3fae6a / #b7d77a | **body + caption: Lato** | |

Good news: 7 of 8 themes already use distinctive display faces (Oswald, Bebas
Neue, Playfair Display, Lora, Libre Baskerville, Barlow Condensed). The overuse
is concentrated in **body/caption slots** (Lato in 3 themes) and **standard's
Montserrat**.

---

## 3. Sameness evidence (feeds Step 4 — video-native rules)

From the build's own graphics report (20 graphics):

- `byStyle: { editorial-light: 20 }` — one style for the whole video
- `byComposition: { agentic: 20 }` — one composition source
- `byAnimation: { fadeSlide: 6, "fade-slide": 4, ... }` — **the same motion
  under two spellings.** 10 of 20 graphics enter identically, while the report
  makes it look like variety.
- every resolved entry carries `shadowStrength: 0.55`
- `byLayout` is genuinely varied: split-panel 5, cinematic-title 4, data-focus 4,
  evidence-board 3, lower-third 2, focus-panel 2

---

## 4. `writeDesign()` is out of sync with reality

`hyperframes-bridge.js:5571` writes a `DESIGN.md` with a **hardcoded** palette:
violet `#7c3aed` + sky `#0ea5e9` on near-black `#050505`, with Tailwind slate
`#0f172a`/`#f8fafc`/`#cbd5e1`. That is the textbook AI palette, and it ignores
the real theme entirely — the shipped file said `Current Theme: science` while
every graphic actually resolved `themeId: warm-editorial`.

Step 3's lever: generate DESIGN.md from `getThemeTokens()` and then enforce it.

---

# Step 2 — Adopt: what the gate found once it could see

Step 1 measured with the upstream detector. Step 2 ported a **tuned** ruleset
into the repo (`src/render/hf-slop-lint.js` — 32 rules, 16 blocking / 16
advisory) and wired it into the verify harness as
`scripts/verify/slop-lint.js`. Zero AI, zero network, zero browser. Kill switch
`HF_SLOP_LINT=0`.

**The gate now sits at 0 hard findings** with two known advisories that Step 3
owns (`ai-color-palette`, `radial-halo`).

## 2.1 There are THREE stylesheets, not one

The single biggest reason the earlier measurement was incomplete. A shipped page
carries styling from three places, emitted on three different conditions:

| Layer | Source | Emitted when |
|---|---|---|
| base stylesheet | `hyperframes-bridge.js` | always |
| graphic shells | `graphic-shells.js` → `buildGraphicShellCss()` | **always** (no argument, no guard) |
| per-item composition | authored comps | only when graphics exist |

The gate's fixture comment used to claim the shell layer arrived "only once a
graphic actually needs a shell". That was false, and a false justification is
worse than none — it tells the next reader the fixture is load-bearing for a
reason it is not. Corrected.

## 2.2 The doubled mark — a rule that was right and still lost

The shell layer already carried a reset that stood every engine mark down before
drawing its own. It was written two classes deep
(`.hf-shell-enabled .hf-shell-target::after`). The engine's per-variant marks are
written three classes deep (type, then variant, then the copy box). **CSS gives
the win to the more specific rule, so the reset lost every time.**

Consequence: a shelled callout drew the shell's tab *and* its own bar. Two
unrelated accent marks on one card, on every card. Each rule reads as correct in
isolation, which is why review never caught it — only a rendered-pixel probe did.

Fixed by making the reset unbeatable (`content: none !important`) and raising the
four shell accents by one class so they still come through. This covers all five
engine variant marks, not the three originally identified, and survives any
variant mark added later.

## 2.3 `pos-center` is not a placement signal

Every agentic graphic carries `pos-center` — including lower thirds explicitly
marked `hf-agentic-safe-bottom-left`. A centring rule keyed on it therefore
centred the accent on **every graphic in the video**. A screenshot caught a
bottom-left lower third with its rule floating over the middle of its own title.

The class list looked correct right up until it was read past the point where the
shell classes start — they are appended last, so a truncated dump hides exactly
the interesting part. Centring is now keyed on real safe-zone/layout classes, and
`pos-center` is scoped to the legacy markup where it genuinely drives placement.

## 2.4 A verify assertion that pinned the tell it was meant to prevent

`scripts/verify/graphic-shells.js` asserted the underline accent by reading
`borderBottomWidth > 0`. A border-bottom spans the whole box — a full-width bar
welded to the edge of a text block, which is the single most recognisable
generated-design tell. The accent is a short `::after` rule now, so the
assertion failed and would have forced the bar back.

Rewritten to assert what actually matters, and made stricter: the accent must
render, must be ≤4px tall, must span <90% of the card, and must **not** also draw
a border (two marks for one accent).

## 2.5 Shell variety: measured on real builds, not the fixture

A synthetic probe showed 12 of 14 graphics collapsing onto the same shell recipe,
which would have been a serious sameness tell. **It was a fixture artifact.** The
recipe picker scores against mood / text-strategy / layout / safe-zone / item
count and breaks ties with a hash jitter capped at 0.65; a fixture that supplies
none of those inputs makes every graphic score identically, and the jitter cannot
separate them.

Measured against a real finished build (20 graphics) instead:

| Axis | Real distribution |
|---|---|
| shell accent | tab 1, bracket 1, rail 1, underline 1, none 1 — **all five used** |
| shell surface | solid 1, none 2, soft 1, outline 1 |
| shell geometry | slanted 1, square 3, rounded 1 |
| agentic motion | stamp, gauge-fill, slide-up, ticker-count, pop-in — 5 distinct |
| agentic layout | cinematic-title 1, data-focus 2, lower-third 1, focus-panel 1 |

Shell variety is genuinely healthy. **The lesson is about method, not the
picker: a starved fixture manufactures sameness, so sameness must only ever be
judged on real build output.**

## 2.6 What that measurement DID surface (feeds Step 4)

Of 20 graphics on a real page:

- **5 are shelled, 5 are agentic, 11 are neither** — more than half of every
  video's graphics are drawn by the engine's own base CSS. That is why the eight
  engine/legacy accent marks were normalised alongside the shell's, from 5–6px
  edge bars to 3–4px type-sized marks. A shelled and an unshelled graphic in the
  same video must not read as two different design systems.
- **type repetition is the real sameness tell**: `key-takeaway` appears 5 times
  and `comparison-card` 3 times — 8 of 20 graphics are just two types. This is a
  stronger signal than anything in the shell layer, and it is Step 4's problem,
  not Step 2's.

---

# Step 3 — Themes become enforceable contracts

Steps 1–2 asked one question of every graphic: *is this a cliché?* That question
has the same answer on every project on earth, which is exactly why the rules
were portable enough to borrow in the first place.

Step 3 asks a different one: **did this graphic use the palette and the
typefaces that this particular video already committed to?**

The distinction matters because the two failures look identical on a still and
completely different in motion. A graphic in a typeface the video never uses
anywhere else is not ugly. It is simply *from a different video* — and a viewer
reads that as carelessness several seconds before they could name what is wrong.

## 3.1 The last two hardcoded colours

Step 2 closed four places where the engine painted a fixed colour instead of the
theme's. Two survived, and both were found by re-running the scan rather than by
reading code:

| Element | Was | Why it mattered |
|---|---|---|
| map pin labels | fixed near-white on near-black | The one element on the whole stage that ignored the theme. On a light theme it inverted against its own map. |
| comparison sub-text | fixed light slate | The last literal of a palette that had already been cleaned off everything around it. |

Both now read the theme's own text and muted tokens. The engine stylesheet
scans at **zero findings and zero advisories.**

## 3.2 The glow that had to go — and the one that stayed

The scan had been flagging a soft coloured halo behind the headline plate.
Resolving it needed a distinction the rule cannot make on its own:

- **A coloured glow behind a card is decoration.** Nothing in the physical world
  lights up from behind a solid card, which is why it reads as generated on
  sight. It was redundant here anyway — the 82%-opaque plate underneath is what
  actually separates the text from the footage. Replaced with a shallow
  one-direction tonal shift: a flat surface lit from above, which is what a real
  card does.
- **A near-black wash over footage is a legibility device**, not decoration.
  Those stay, and the rule correctly ignores them, because it tests for colour
  intensity and a near-black wash has none.

## 3.3 The contract is derived, never written down twice

Each theme already declares its typefaces, its palette and its corner radius.
The contract is **read from those declarations** rather than restated in a
second table.

That is the whole design. A second table would be a thing to forget to update;
this way, adding a theme extends the contract for free and the two can never
drift apart.

Enforced on three axes:

| Axis | Flags |
|---|---|
| **typefaces** | A face this theme never declares — in `font-family` or the `font` shorthand |
| **palette** | A colour whose hue is more than 25° from every colour the theme declares |
| **corner radius** | A corner rounder than the theme's own, past tolerance |

## 3.4 The radius rule is one-directional — and that came from measurement

Checked against 92 real authored graphics on a theme declaring a 10px radius.
The author consistently writes **1px, 2px, 3px** — *harder* corners than the
theme asks for, never softer.

That is an editorial choice, and a good one. A near-square corner is nobody's
idea of generated design; the failure this rule exists to catch runs the other
way, corners inflating until every card is a soft-edged capsule.

So only *rounder than declared* counts as drift. **A symmetric rule would have
flagged all 92 of those graphics and taught the author to soften its corners —
the precise opposite of the point.** This is the clearest case so far of a rule
that would have been actively harmful if written from intuition instead of from
the real output.

## 3.5 What the contract deliberately does NOT cover

The plan said "fonts, colours, radii, spacing". Two of those were dropped, on
purpose, and it is worth saying why rather than quietly leaving them out:

- **Spacing** — the themes declare none. Inventing a per-theme spacing scale
  here would mean making up design decisions the project has never made. The
  existing "every gap is the same size" rule already catches the real failure,
  and spacing *sameness across scenes* is Step 4's job anyway.
- **Shadow and border width** — the themes do declare these, but in real CSS a
  shadow or a border does a dozen unrelated jobs, so checking them against a
  contract would be mostly noise. The existing rule for the tell-tale
  thin-border-plus-wide-shadow combination already covers the cliché.

## 3.6 Wired into the maker, not just the report

Step 2's rules were only ever consumed by the commit gate — they described the
output without being able to change it. Step 3 is where that closes.

The contract now runs **inside the graphic author**, at both points where a
graphic can change:

1. in the repair round, *before* the expensive rendered-pixel check — there is
   no point rendering a frame we already know uses the wrong typeface;
2. again after the art-director refine pass, which is the one round that could
   previously introduce drift with no deterministic check behind it.

A failure comes back as a specific instruction ("this colour is not in this
video's palette; the palette is …"), so the author fixes it the same way it
fixes everything else. Without a theme the contract goes quiet and the universal
rules still apply, so a graphic with no theme degrades rather than fails.
`HF_THEME_CONTRACT=0` turns it off.

The author's version tag moved to `v17-theme-contract`, because **a cache that
outlives the check that approved it is how a fix quietly undoes itself.**
Measured before making that change: 0 of 92 cached graphics fail the new rules,
so in practice nothing that was passing gets re-billed.

## 3.7 Proving the gate is not decoration

A gate that always says OK is indistinguishable from a gate that is broken. The
three contract rules are inert against the engine stylesheet — correctly, since
it spends theme tokens rather than literal values and there is no single theme
to hold it to. So they get their own proof, against all **8 real themes** and
not a mock, checking three separate ways this could silently rot:

1. it **catches** drift on all three axes — otherwise the gate is decoration;
2. it **passes** each theme's own values — otherwise it blocks every good
   graphic and someone switches it off within a week;
3. it goes **quiet** with no theme — otherwise it starts failing the engine
   stylesheet.

Each assertion was then confirmed load-bearing by simulating the deletion of the
rule behind it and checking that the proof actually fails.

## 3.8 A real bug the gate caught on its way past

The full commit gate failed at a check that had nothing to do with the theme
work — and it turned out not to be a test problem at all.

Every authored graphic is re-checked at render time, and part of that check runs
the graphic's animation code in a sandbox under a time limit, to catch a runaway
loop. The limit was 100ms.

| | |
|---|---|
| What the check actually costs | **~2 ms** |
| The limit it was given | 100 ms |
| One-off sandbox setup, idle machine | 3 – 29 ms |
| One-off sandbox setup, all cores busy | up to **92 ms** |
| One-off sandbox setup, seen in the wild | **425 ms** |

The limit was not measuring the graphic. It was mostly measuring how long
Windows took to hand over a fresh sandbox — and when it lost that race, the
graphic was declared unsafe and **silently dropped from the video.** On a busy
machine, for no reason but scheduling.

Fixed at the cause, smallest first: the one-off setup cost is now paid once up
front, outside any limit, which removes the variance instead of hiding it behind
a bigger number; the limit itself moved to 2s (~1000× the real work, and still
instant at catching a genuine runaway loop next to a multi-minute render); and a
*timeout specifically* — not a syntax error, which will simply repeat — is
retried once, so a timeout now means "this code is pathological" rather than
"the machine was busy".

Re-measured under full CPU saturation afterwards: **4 of 12 runs would have
blown the old limit, and all 12 pass the new one.** A genuine infinite loop is
still rejected.

This is worth recording as a pattern rather than a one-off. It is the second
time in this work that **a wall-clock limit was sized against a fast machine and
quietly changed the behaviour on a slow one** — the other being a verify
scenario that waited a flat 2 seconds for a background process, and so passed
alone and failed inside the full suite. Both are now bounded by the thing they
are actually waiting for, not by a guess.

---

# Step 4 — Video-native rules

Steps 1–3 all judge **one graphic**. That is the whole shape of a page-level
detector: it opens a document and asks whether *this* document looks generated.

A video is not a document. It is a sequence, watched in time, and the strongest
generated tell in it is invisible to any check that only ever sees one item at a
time — **twelve individually well-made graphics that all enter the same way, all
hold for the same length, and all arrive on the same beat.** Each one passes.
The video still reads as a machine.

So Step 4 adds two things a page checker structurally cannot have: a second
linter that judges the **whole video**, and three rules about what happens to a
frame *after* it leaves here — YouTube's encoder and YouTube's own interface.

## 4.1 The sequence linter — 8 rules

| Rule | What it catches | Severity |
|---|---|---|
| motion-monotony | one entrance animation dominates the video | warn |
| pace-monotony | one animation speed dominates | warn |
| layout-monotony | one layout dominates | warn |
| type-monotony | one graphic type dominates | warn |
| metronome-timing | every graphic holds for the same length | warn |
| metronome-spacing | graphics arrive on a fixed beat | warn |
| unreadable-in-time | more text than the hold time allows | error |
| back-to-back-repeat | the same treatment twice in a row | warn |

`unreadable-in-time` is the only `error`, and deliberately so: it is the only
one of the eight that is a **defect** rather than a matter of taste. If 104
characters need 6.7 seconds to read and the graphic holds for 3.8, the viewer
did not read it. That is not a style opinion, it is a broken graphic.

Reading speed is set at **17 characters per second** — the lower end of the
BBC/Netflix subtitle range, chosen low on purpose because our graphics are read
*while the viewer is also watching footage*, not in silence.

## 4.2 The dominance ratio — and the flat percentage that was thrown away

The first version of the monotony rules used a flat threshold: fire when one
option takes more than 60% of the graphics. It was wrong, and the reason matters
more than the fix.

**60% of a two-option axis is normal. 60% of a fourteen-option axis is a
machine.** A flat percentage cannot tell those apart, so it either screams at
healthy videos or sleeps through sick ones — and every time the vocabulary grew,
the number would need re-tuning by hand.

What replaced it compares the winner to **an even share of the vocabulary the
video itself demonstrated**:

```
dominance = (times the top option was used) / (graphics / distinct options used)
```

An even spread scores 1.0. The rule fires above 2.0 — the top option used twice
as often as its fair share. This is self-calibrating: the same rule handles a
2-option axis and a 14-option axis, and it never needs re-tuning when new
animations, layouts or types are added, because the video's own vocabulary is
the yardstick.

The run-length check underneath it got the same treatment: a run of identical
graphics only counts as a run when it is **longer than an even share**, so three
in a row out of six is nothing and three in a row out of thirty is a problem.

Both clock rules (`metronome-timing`, `metronome-spacing`) use **coefficient of
variation** — spread as a fraction of the average — for the same reason. It is
scale-free, so a video of 3-second graphics and a video of 12-second graphics
are held to the same standard without two numbers to maintain.

## 4.3 One rule that was written, measured, and then agreed with the code

`layout-monotony` was written expecting to fire. It does not, on real builds —
Step 1 had already measured `byLayout` as genuinely varied (split-panel 5,
cinematic-title 4, data-focus 4, evidence-board 3, lower-third 2, focus-panel 2)
across a 20-graphic video.

The rule stays anyway, because it costs nothing and it is the regression guard
for the one axis currently in good health. But it is recorded here as a case
where **the measurement contradicted the expectation and the measurement won.**
The tempting move — lowering the threshold until layout "showed a problem" too —
would have manufactured a finding out of a healthy system.

## 4.4 Sameness can only be judged on real output

A fixture is a handful of hand-written graphics. Hand-written graphics are
samey, because whoever wrote them was demonstrating one thing.

> **A starved fixture manufactures sameness, so sameness must only ever be
> judged on real build output.**

This is why the sequence linter's proof does two different jobs and keeps them
apart: fixtures prove each rule *can* fire and *can* stay quiet on the geometry
it is supposed to ignore, and the numbers about how the project actually behaves
come from real finished builds only. A fixture is never allowed to be evidence
about the project.

## 4.5 The live probe — and the defect it immediately found

The rules were then run end-to-end: a deliberately monotonous 12-graphic plan
pushed through the **real** render path, on the real generated page, with the
report read back off disk exactly as the build writes it.

It worked — 7 of 8 rules fired, and the report showed the timing and text-length
numbers being populated from live data rather than from anything the test had
staged.

It also exposed a defect no fixture would have: `unreadable-in-time` printed the
**same finding eight times**, because the per-graphic rules walk every graphic
and this video's graphics genuinely shared one fault. The repeat count is useful
information; the repetition is not. Identical findings now merge into one line
carrying "— and 7 more like it", which took the probe from 14 findings to 7.

This is the second time in this work that running the real path found something
the tests could not. It is cheap and it keeps paying.

## 4.6 Surviving the codec — three rules no web checker has a reason to have

Everything up to here judges a still frame as it leaves the renderer. These
three judge what **YouTube's encoder** does to it afterwards.

**Contrast** uses WCAG's own two floors — 4.5 for body text, 3.0 for large
display text — *unchanged*, with no invented "video margin" added on top. The
reasoning is one line: compression only ever *removes* contrast, so a graphic
that fails the still-image floor cannot possibly pass after encoding. The
large-text carve-out is real here too, and the proof asserts it in both
directions: the same two colours pass at 96px and fail at 26px.

Translucent panels are flattened onto **mid-grey** before measuring, because in
a video a 70%-opacity panel does not sit on a background the stylesheet knows
about — it sits on *footage*, which changes every frame. Assuming a helpful
backdrop is exactly how unreadable text ships.

**Stroke survival** replaced a flat font-weight cutoff with a derivation. "Weight
under 200" is fine on a 110px headline and fatal on a 24px caption, so the
honest measure is the size a normal-weight face would need to draw the same
stroke: `size x weight / 400`. When that lands under the minimum text size we
already enforce, the strokes are as thin as text we already refuse to put on
screen.

**Saturated hues on fine detail.** Video is stored with colour at half
resolution in both directions, so a saturated red or magenta carried by *thin*
detail — text, hairlines — smears at the edges, while the identical colour as a
large fill is untouched. The rule is therefore scoped to text and to strokes of
2px or less, and the proof asserts that the same colour as a panel fill or a 6px
bar is left alone.

### The exemption that was measured, not assumed

That rule flagged two shipped themes on its first run: **crime** on its crimson
and **modern** on its orange-red. Both are deliberate brand anchors — the colour
those themes exist to be.

The easy fix was to weaken the threshold until they fell out of the band, which
would also have stopped catching the thing the rule is for. Instead the theme's
**own declared palette is exempt**, read from the same contract Step 3 already
derives. So the rule now catches exactly its real target: *a composition
inventing a saturated hue nobody chose.* Adding a ninth theme extends the
exemption for free, and there is no second list to drift.

This is the same lesson as the radius rule in §3.4, from the other side: **a
rule that argues with a deliberate decision teaches the author to abandon it.**

## 4.7 Title-safe — YouTube's player, not a 1985 television

The broadcast rule is a flat 5% margin on all four edges. It is about CRT
overscan, which does not exist here — YouTube shows every pixel of the frame.

What YouTube *does* do is paint its own interface on top of that frame, and that
is a completely different shape:

| Edge | Reserved | Why |
|---|---|---|
| bottom | 80px | progress bar, control row and the gradient behind them — always showing on mobile, one mouse-move away on desktop |
| top | 56px | the mobile title bar, channel name and overflow menu |
| sides | 40px | rounded player corners and phone cut-ins only — nothing is ever cropped horizontally |

Copying the TV numbers would have pushed graphics inward on all four edges for a
reason that no longer applies, **and still left them sitting under the
controls.** The gate asserts the asymmetry itself — bottom heavier than top,
sides lightest — so a future "improvement" back to the symmetric broadcast
margin fails loudly instead of quietly.

The load-bearing assertion is the negative one: **a correctly-designed
lower-third at 880px must not be flagged.** A 5% rule would have flagged it, and
a rule that argues with correct design is switched off within a week.

Only *text* is governed. Panels, plates and imagery may bleed to the edge — a
bleed is a design choice, an unreadable word is not. Text that already overflows
the frame gets the sharper overflow message instead of both, because one mistake
should produce one instruction.

This check runs in headless Chrome, so it needs a browser. Without one it skips
**loudly** and passes — a machine with no browser must not turn a green gate
red, but it must not pretend it verified anything either.

## 4.8 What Step 4 measured that Step 5 will act on

The live probe surfaced findings that are not test artifacts and not rules to
tune — they are facts about the system:

- **Animation speed is never varied.** Every graphic in the probe resolved to a
  single speed, and the real 20-graphic build resolved to `normal` twenty times
  out of twenty. The vocabulary exists; nothing spends it.
- **The two-spellings problem is real and now handled.** `fadeSlide` and
  `fade-slide` are the same motion under two names, which made the build's own
  report *look* varied while half the video entered identically. The sequence
  linter collapses spellings before counting, so it sees the sameness the report
  was hiding.
- **Type repetition remains the strongest sameness signal** — 8 of 20 graphics
  in the real build were just two types.

These are evidence, gathered before touching a single instruction string, and
they are what Step 5 gets to argue from.

## 4.9 The fourth time the same bug appeared — and the shape of the real fix

Registering the three new gates into `npm run verify` made the whole gate fail.
Not on any of them. On `vision-serve-window`, a GPU check that has nothing to do
with graphics, and which passed 22/22 when run on its own.

That is the §3.8 pattern for the fourth time in this work: **a wall-clock limit
sized against an idle machine quietly changes behaviour on a busy one.** The
check waited a flat 30 seconds for a background process ladder to write two
entries. Measured on an idle machine it needed 14–20 seconds — a 1.5x margin,
which sounds fine and is not, because "idle" is not a property of the code.

The script's own log said where the time went:

```
[serve] vLLM exited (code 1) after 3s at window 16384
```

Three seconds per rung, for a stub that exits instantly. A rung is about eight
process spawns, and on Windows a spawn is not free.

### Three fixes, each one wrong until the last

**Attempt 1 — a stall budget instead of a wall clock.** Any new byte written by
the ladder resets the clock; only silence counts against it. A slow machine
takes longer and still passes; a stuck ladder still fails. This is the right
shape and it fixed the failure that started all this.

It is also not sufficient, and a saturation test proved it. A stall budget only
helps when there are *intermediate* events to reset it. Two of the scenarios
wait for the launch line — which is the *first* event. Nothing precedes it, so
there is nothing to reset against, and the stall budget silently degenerates
back into the wall clock it replaced.

**Attempt 2 — measure the spawn cost and scale the budget by it.** A spawn was
measured at **227ms idle** on this machine and ~425ms with all twelve cores
pegged. So the budget stopped being a duration and became *a count of the work
being waited on*: 300 spawns' worth, priced at today's rate.

That hung the check for five minutes. The mistake: it scaled **every** wait,
including the scenarios that assert *nothing happens*. Those budgets are dead
time by definition — stretching them proves nothing and multiplies the gate's
runtime by the number of negative scenarios.

**Attempt 3 — scale only the positive waits.** A wait with a predicate ("keep
looking until the launch line appears") breaks the instant its event lands, so
a generous budget there is **free**: it is only ever spent on a run that was
going to fail anyway. A wait with no predicate keeps its small fixed budget.

### The rule this leaves behind

> A timeout is a guess about a machine. Express the bound in the unit that
> actually varies — spawns, bytes written, events observed — and measure that
> unit at the moment you need it. Then a slow machine is slow, not broken.
>
> And scale only the waits that can end early. Stretching a wait that is
> *supposed* to time out just makes the gate slower at reaching the same answer.

### What it cost, honestly

The check now passes 22/22 alone and inside the full gate, but it takes about
four to seven minutes. Almost none of that is the harness: each invocation of
the shell script *under test* costs 25–70 seconds, because it is spawn-heavy
and a spawn costs 227ms here. The harness waits are milliseconds on success.
That is a property of the subject, not the test, and it is recorded here rather
than hidden so nobody later "optimises" the budgets and reintroduces the bug.

---

# 5. Teach the makers

Steps 1–4 built judges. A judge that is never wired back into a maker just
produces a well-documented samey video, so Step 5 is where measurement turns
into instruction — and it went **last on purpose**. Every change below points at
a specific line in §3 or §4.8. Nothing here was changed because it looked
improvable.

## 5.1 Motion the author can be graded on

§4.8's first finding was that **animation speed is never varied** — twenty
graphics, one speed, twenty times. The vocabulary existed; nothing spent it.

The composition author now carries a **measured motion signature** in its style
ledger: not the label it asked for, but the opening span and beat count read
back out of the GSAP timeline it actually wrote. `AUTHOR_VERSION` moved to
`v18-measured-motion`, which invalidates `.hf-authored-cache.json` and re-bills
the author — deliberately, and recorded here so it is never mistaken for an
accident.

## 5.2 A label is not a measurement

Stamping measured motion immediately exposed something worse than a gap.

For an authored composition, the `animation` and `speed` fields in the visual
report are resolved **from the plan**. They describe a renderer that never runs.
The generated page proves it twice: there is no CSS rule matching
`.hf-anim-spring-scale`, and the runtime explicitly branches on
`item.authored && item.kind === 'overlay'` to replace the default entrance with
a plain opacity gate *so the default slide/scale enter can't fight the authored
motion*.

Every authored composition therefore carries the identical pair. Counting them
produced the verdict *"all 6 graphics use the speed 1"* about a video whose
graphics opened at 0.22s, 1.10s, 0.45s, 0.85s, 0.30s and 1.35s — a monotony
conviction against the single most varied thing in the sequence.

> **A stale label lies louder than a missing one.** Absence is silent; a
> confident wrong verdict sends the next fix in the wrong direction.

So the labels are now dropped exactly like an unrecorded field, and those
graphics are judged on `opening-metronome` — the seconds they actually took.
Same rule, different evidence.

### The predicate had to be the renderer's, not a near-miss of it

The first version of the stamp fired whenever a composition existed and the
fixed renderer wasn't preferred. The renderer's real test is stricter: no safe
layout, no fixed-renderer preference, validation passed, **and** a stage or
overlay slot. A composition rejected at the safety gate falls back to the fixed
renderer, whose motion genuinely *is* its label — stamping measured timings onto
it would have graded a timeline that never ran. The exact inversion of the bug
being fixed.

The answer already existed inside `buildMgMarkup` and was already named
`authoredCompositionWillRender`; it was just answered privately, 600 lines after
the report was written. It is now a shared pure helper, `authoredRenderPlan`,
with the warning and the bookkeeping left behind with the renderer, because only
the renderer is entitled to have side effects. One answer, two callers, no
drift.

The end-to-end proof shows it working in both directions: a comp whose timeline
ends at 1.35s on a 1.10s hold is rejected at the gate, reports **no** measured
motion, and is correctly graded on its label.

## 5.3 The strongest tell was not a taste failure

§3 measured `key-takeaway` at **5 of 20 graphics** — the single strongest
machine signal on the page. Tracing it found two separate causes, and neither
was an agent choosing badly.

**The coverage-rescue picker could only ever return one answer.** It was a pure
duration ladder: any scene of 3s or more became a `keyTakeaway`, every single
time, because the function had no idea what the video had already placed. A
monoculture by construction.

It now picks the **least-used eligible card** — the ladder still decides what
the scene is long enough to hold, and the video's own running tally decides
which of those to use. That tally covers every template already placed, not just
rescues, so a video whose AI pass already chose two takeaway cards gets a
chapter card here without anyone having to say so. No cap, no quota, no
per-niche table. First-wins tie-breaking means an **empty video is unchanged**:
a long scene is still a `keyTakeaway`.

**The template selector was choosing every card blind to every other card.** It
was handed the already-placed templates and used only the *times* inside them,
never the types — while the MG author has had exactly this awareness
(`ALREADY PLACED: …`) for as long as it has existed. That asymmetry was the
whole defect. The selector is now told what this video has already put on
screen, with counts, and the card it has leaned on hardest is discouraged by
name. The block is conditional, so a video with nothing placed yet gets the
prompt it always got, byte for byte.

### Why counts, and why by name

A variety fix has one specific failure mode: it drifts into a quota, and a quota
is just a different machine tell. The line is therefore **evidence, not a rule**
— it names whichever card *this* video over-used. The gate proves that by
over-using each card in turn and demanding the warning follow.

## 5.4 The gate — `scripts/verify/graphic-variety.js`

`video-lint` grades the finished sequence. This grades the code that chooses.
Twelve assertions, zero AI (the one model call is stubbed before the module that
binds it is loaded, so no path through the file can bill), covering both
directions:

| Must happen | Must **not** happen |
|---|---|
| six rescues rotate across all eligible cards | a card the scene is too short to hold gets used anyway |
| a different distribution gives a different answer | the empty-video behaviour changes |
| the selector is told what is on screen, with counts | a fixed rotation order passes for real self-correction |
| the over-used card is discouraged by name | the warning is pinned to one card type |

Reverting both fixes turns 8 of those into failures, including the measured
defect verbatim: *"six coverage rescues produced only 1 distinct card: keyTakeaway
… this is the measured 5×key-takeaway defect"*. A gate that cannot fail is
decoration.

Writing that negative proof also caught two assertions that were **passing on
the broken code**: a spread check that scored six identical cards as perfectly
balanced (it was counting only the types that appeared, so zeros were invisible),
and an `ok()` printed outside the loop that produced it. Both fixed. The lesson
is the one §2.4 already recorded — a gate is not verified until it has been
watched failing.

## 5.5 What Step 5 deliberately did NOT change

**The effects / look director.** Step 4 measured no defect there. The base-look
rules, the one-era-family constraint and the single-grade-owner rule all held on
real output, and `verify-effects` passes on every one of them. Changing its
instructions would have meant re-billing a director and invalidating its cache
to fix a problem no measurement found.

This is recorded rather than silently skipped, because "we planned to touch it
and then didn't" is exactly the kind of decision that gets re-litigated later by
someone reading the plan instead of the evidence.

## 5.6 What is still unproven

Everything above is gated, and every gate has been watched failing. But three
claims can only be settled by a real build:

- whether the author, now graded on measured motion, actually *spends* the
  speed vocabulary rather than merely being able to be caught not spending it;
- whether type repetition drops from 5-of-20 on a real script, rather than on a
  probe;
- what the `v18` cache invalidation costs in practice.

Until that build runs, this section documents mechanisms that work, not outcomes
that have been observed.
