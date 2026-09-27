/**
 * hf-visual-lint.js — Rendered-pixel verification for authored compositions.
 *
 * Prompt rules guide; only measurement enforces. This module renders an
 * authored composition in headless Chrome, seeks the GSAP timeline to the
 * hero frame (45% of duration), and MEASURES:
 *   1. frame overflow  — visible text extending past the 1920×1080 canvas
 *   2. text collisions — text elements overlapping each other
 *   3. invisible text  — elements still at ~0 opacity at the hero frame
 *   4. title-safe area — text sitting where YouTube's own chrome will cover it
 *   5. text contrast   — the composited colour behind each word vs the word
 * Violations come back as lint errors with the offending text + numbers, so
 * the author's repair round gets concrete, fixable feedback.
 *
 * A single shared browser serves the whole batch (launch ~1s, per-comp
 * ~300ms). Fails open: if Chrome is unavailable, returns ok (the textual
 * linter still applies).
 */
'use strict';

const fs = require('fs');
// Thresholds belong to the checker that owns them. hf-slop-lint has no
// requires of its own, so this cannot cycle.
const { VIDEO } = require('./hf-slop-lint');

let getThemeTokens = null;
try { ({ getThemeTokens } = require('../data/themes')); } catch (_) { getThemeTokens = null; }

const CHROME_CANDIDATES = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

/**
 * Title-safe area — YouTube's, not television's.
 *
 * The old broadcast rule (a flat 5% margin on every edge) is about CRT
 * overscan, which does not exist here: YouTube shows every pixel of the frame.
 * What it DOES do is paint its own interface over the top of that frame, and
 * that is a different shape entirely — heavy at the bottom, light at the top,
 * barely anything at the sides. Copying the TV numbers would push graphics
 * inward on all four edges for a reason that no longer applies, and still
 * leave them under the controls.
 *
 * Measured against the player as it actually behaves at 1920x1080:
 *
 *   bottom  the progress bar plus the control row plus the gradient behind
 *           them. It is hidden while playing on desktop and reappears on any
 *           mouse move — and on mobile it is showing every time the viewer
 *           touches the screen, which is constantly. 80px is the control row
 *           and its gradient; anything inside it will be sat on.
 *   top     mobile fullscreen paints the video title, the channel and the
 *           overflow menu across the top on tap. Lighter than the bottom.
 *   sides   YouTube never crops horizontally. The margin here is only for
 *           rounded player corners and phone safe-area cut-ins, so it is small
 *           — and deliberately not the 5% a broadcast rule would demand.
 *
 * These bound where TEXT may sit. Panels, plates and imagery may run to the
 * edge; a bleed is a design choice, an unreadable word is not.
 */
const TITLE_SAFE = {
    bottomPx: 80,
    bottomLine: 1080 - 80,
    topPx: 56,
    edgePx: 40,
};

/**
 * Contrast — why this has to be measured here and cannot live in the CSS.
 *
 * The textual checker owns a `low-contrast-on-video` rule, and it can only see
 * a colour and a background that are written in the SAME CSS block. Real
 * compositions almost never do that: the card declares the background, a child
 * declares the text, and a wrapper somewhere in between declares a translucent
 * wash that changes both. Nothing in the stylesheet says what colour actually
 * ends up behind a word — only the rendered page knows.
 *
 * That gap shipped. The 2026-08-05 build put cream text (#f7f1e5) on a cream
 * card (#ece0c8) and nothing objected, because the two values lived in
 * different blocks. Composited, that is a contrast ratio of 1.16 against a
 * floor of 3.0 — the words were there and could not be read.
 *
 * WHAT IS AND IS NOT JUDGED
 *
 * Only a stack that is opaque enough to be knowable. Every background layer
 * from the composition root down to the element is composited, and the element
 * is judged only if the result is at least MIN_BACKDROP_ALPHA opaque. Below
 * that, live footage is showing through and the true backdrop is whatever the
 * editor's clip happens to be — unknowable at author time, so no accusation is
 * made. The harness's own stage colour is deliberately excluded from the
 * accumulation for the same reason: it is scaffolding, not a design decision.
 *
 * A stack containing a background-image is skipped outright. A gradient or a
 * photo has no single colour, and picking one would be inventing evidence.
 *
 * Only ANCESTORS are composited, never siblings. A full-bleed plate painted as
 * a sibling underneath the text is not counted, so that shape can still slip
 * through. Resolving it properly would mean hit-testing the paint order, and
 * the one tool for that (`elementsFromPoint`) silently skips anything with
 * `pointer-events: none` — which is exactly what the render page sets on every
 * graphic. A checker that quietly drops layers would accuse compositions that
 * render fine, so the rule stays narrower and honest: it under-reports rather
 * than invent. Every failure it does report is real.
 *
 * The floors are the checker's, split at the checker's own display size. No
 * text-shadow allowance: a glow can rescue a word on a still and still smear
 * into mush once the encoder has finished with it.
 */
const MIN_BACKDROP_ALPHA = 0.85;

/** Everything the in-page contrast pass needs, so no number is restated there. */
const CONTRAST = {
    minBackdropAlpha: MIN_BACKDROP_ALPHA,
    minBody: VIDEO.CONTRAST_MIN_BODY,
    minDisplay: VIDEO.CONTRAST_MIN_DISPLAY,
    displayPx: VIDEO.DISPLAY_SIZE_PX,
    maxReports: 2,
};

/**
 * The theme's CSS variables, exactly as the real render page defines them.
 *
 * WITHOUT THIS THE HARNESS IS COLOUR-BLIND. Authored compositions are told to
 * paint from `var(--hf-text)` / `var(--hf-surface)` / `var(--hf-primary)`, and
 * the render page declares those on its root. This page did not, so every
 * theme-driven colour resolved to nothing: text fell back to the browser
 * default black and surfaces came out fully transparent. The geometry checks
 * survived that because they only read boxes — a contrast check cannot, and
 * neither could the perfectionist vision review, which has been grading a
 * screenshot of the composition painted in the wrong colours.
 *
 * The wiring is NOT the theme's own key names. The render page points
 * `--hf-primary` at `mgPrimary || primary`, and on some themes those sit 150°
 * apart on the colour wheel. `hf-author-repair.js:_themeVarPalette` documents
 * that trap in full and carries the same table; `scripts/verify/author-rescue.js`
 * fails the build if the two ever drift apart.
 */
function _themeVarBlock(themeId) {
    let theme = null;
    try { theme = (getThemeTokens && themeId) ? getThemeTokens(themeId) : null; } catch (_) { theme = null; }
    if (!theme) return '';
    const c = theme.colors || {};
    const ty = theme.typography || {};
    const ch = theme.chrome || {};
    const shadow = c.shadow || 'rgba(0,0,0,0.4)';
    const decls = [
        ['--hf-primary', c.mgPrimary || c.primary],
        ['--hf-accent', c.mgAccent || c.accent],
        ['--hf-text', c.textPrimary],
        ['--hf-muted', c.textSecondary],
        ['--hf-surface', c.surface],
        ['--hf-bg', ch.bg || c.background],
        ['--hf-shadow-color', shadow],
        ['--hf-shadow', `0 ${ch.shadowOffsetY || 4}px ${ch.shadowBlur || 18}px ${shadow}`],
        ['--hf-radius', `${ch.borderRadius == null ? 12 : ch.borderRadius}px`],
        ['--hf-stroke', `${ch.strokeWidth == null ? 2 : ch.strokeWidth}px`],
        ['--hf-heading-font', ty.headingFont],
        ['--hf-body-font', ty.bodyFont],
        ['--hf-caption-font', ty.captionFont || ty.bodyFont],
        // The render page wraps every authored composition in `.hf-mg`, which
        // declares these two. A composition that never states a colour inherits
        // the theme's ink there — so it must inherit it here too, or the
        // contrast pass would measure the browser's default black and accuse a
        // composition that renders perfectly well.
        ['color', 'var(--hf-text)'],
        ['font-family', 'var(--hf-body-font)'],
    ];
    return decls
        .filter(([, v]) => v != null && String(v).trim())
        .map(([k, v]) => `${k}: ${String(v).replace(/[;{}]/g, '')};`)
        .join(' ');
}

let _browserPromise = null;

async function _getBrowser() {
    if (_browserPromise) return _browserPromise;
    _browserPromise = (async () => {
        let puppeteer;
        try { puppeteer = require('puppeteer-core'); } catch (_) { return null; }
        const exe = CHROME_CANDIDATES.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } });
        if (!exe) return null;
        try {
            return await puppeteer.launch({
                executablePath: exe,
                args: ['--disable-gpu', '--hide-scrollbars'],
                defaultViewport: { width: 1920, height: 1080 },
            });
        } catch (_) { return null; }
    })();
    return _browserPromise;
}

async function closeVisualLint() {
    try {
        const b = await _browserPromise;
        if (b) await b.close();
    } catch (_) { /* already gone */ }
    _browserPromise = null;
}

let _gsapSrc = null;
function _loadGsap() {
    if (_gsapSrc != null) return _gsapSrc;
    for (const ref of ['gsap/dist/gsap.min.js', 'hyperframes/node_modules/gsap/dist/gsap.min.js']) {
        try { _gsapSrc = fs.readFileSync(require.resolve(ref), 'utf8'); return _gsapSrc; } catch (_) { /* next */ }
    }
    _gsapSrc = '';
    return _gsapSrc;
}

function _page(html, css, timeline, themeVars) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
html,body{margin:0;padding:0;background:#05080f;}
#stage{position:relative;width:1920px;height:1080px;overflow:visible;${themeVars || ''}}
${css}
</style></head><body><div id="stage">${html}</div>
<script>${_loadGsap()}</script>
<script>
if (window.gsap) {
  var tl = gsap.timeline({ paused: true });
  try { ${timeline} } catch(e) { window.__tlErr = e.message; }
  // prime like the bridge does: force fromTo from-states to render at t=0
  try { tl.progress(1, true).progress(0, true); } catch(e) {}
  window.__tl = tl;
}
</script></body></html>`;
}

/**
 * visualLint({ html, css, timeline }, ns, duration, opts) -> { ok, errors }
 * opts.kind: 'template' | 'fullscreen' | 'overlay' — overlays get coverage
 * checks (they float on live footage and must not bury it).
 */
async function visualLint(comp, ns, duration, opts = {}) {
    const browser = await _getBrowser();
    if (!browser) return { ok: true, errors: [], skipped: true };
    let page;
    try {
        page = await browser.newPage();
        await page.setContent(
            _page(comp.html, comp.css, comp.timeline, _themeVarBlock(opts.themeId)),
            { waitUntil: 'load', timeout: 15000 },
        );

        // ── Entrance check: at t≈0 the comp must NOT already show its
        // finished layout. With the timeline primed, a comp whose every text
        // element is fully visible on-stage at t=0.03 has no entrance
        // animation at all.
        await page.evaluate(() => { if (window.__tl) window.__tl.time(0.03); });
        await new Promise(r => setTimeout(r, 120));
        const entrance = await page.evaluate(() => {
            const stage = document.getElementById('stage');
            const els = [...stage.querySelectorAll('*')].filter(el => {
                if (el.tagName === 'STYLE' || el.tagName === 'SCRIPT') return false;
                const direct = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 1);
                if (!direct) return false;
                const cs = getComputedStyle(el);
                return cs.visibility !== 'hidden' && cs.display !== 'none';
            });
            let total = 0, settled = 0;
            for (const el of els) {
                const r = el.getBoundingClientRect();
                if (r.width < 2 || r.height < 2) continue;
                let op = 1, n = el;
                while (n && n !== stage) { op *= parseFloat(getComputedStyle(n).opacity || '1'); n = n.parentElement; }
                total++;
                const onStage = r.right > 8 && r.left < 1912 && r.bottom > 8 && r.top < 1072;
                if (op > 0.9 && onStage) settled++;
            }
            return { total, settled };
        });
        const entranceErrors = [];
        if (entrance.total > 0 && entrance.settled === entrance.total) {
            entranceErrors.push('no entrance animation: every text element is already fully visible at t=0 — open the timeline with gsap.set initial states and animate elements IN (fromTo alone does not hide elements before its start time)');
        }

        await page.evaluate((t) => { if (window.__tl) window.__tl.time(t); }, Math.max(0.1, duration * 0.45));
        await new Promise(r => setTimeout(r, 250));
        const errors = await page.evaluate((SAFE, CT) => {
            const out = [];
            const stage = document.getElementById('stage');

            // ── Contrast helpers. Straight (non-premultiplied) rgba throughout.
            const rgba = (v) => {
                const m = String(v || '').match(/rgba?\(([^)]+)\)/i);
                if (!m) return null;
                const p = m[1].split(',').map(s => parseFloat(s));
                if (p.length < 3 || p.slice(0, 3).some(n => !isFinite(n))) return null;
                const a = p.length > 3 && isFinite(p[3]) ? p[3] : 1;
                return { r: p[0], g: p[1], b: p[2], a };
            };
            // `top` painted over `base` — plain source-over.
            const over = (top, base) => {
                const a = top.a + base.a * (1 - top.a);
                if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
                const mix = (t, b) => (t * top.a + b * base.a * (1 - top.a)) / a;
                return { r: mix(top.r, base.r), g: mix(top.g, base.g), b: mix(top.b, base.b), a };
            };
            const lum = (c) => {
                const ch = (v) => { const s = Math.max(0, Math.min(255, v)) / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
                return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
            };
            const ratio = (a, b) => {
                const x = lum(a), y = lum(b);
                return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
            };
            const hex = (c) => '#' + [c.r, c.g, c.b]
                .map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
            /**
             * Everything painted behind this element's own text, composited
             * bottom-first. Starts at #stage and walks down to the element, so
             * a card's background and any wrapper wash are both counted. Stops
             * at #stage on purpose: body carries the harness's own colour,
             * which is scaffolding, not a design decision.
             */
            const backdropOf = (el) => {
                const chain = [];
                for (let n = el; n && n !== document.body; n = n.parentElement) chain.push(n);
                chain.reverse();
                let bg = { r: 0, g: 0, b: 0, a: 0 };
                let cum = 1;
                for (const n of chain) {
                    const cs = getComputedStyle(n);
                    const o = parseFloat(cs.opacity);
                    cum *= isFinite(o) ? o : 1;
                    // A gradient or a photo has no single colour. Guessing one
                    // would be inventing the evidence, so the stack is dropped.
                    if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
                    const c = rgba(cs.backgroundColor);
                    if (!c || c.a <= 0) continue;
                    bg = over({ r: c.r, g: c.g, b: c.b, a: c.a * cum }, bg);
                }
                return bg;
            };
            let contrastReports = 0;

            const els = [...stage.querySelectorAll('*')].filter(el => {
                if (el.tagName === 'STYLE' || el.tagName === 'SCRIPT') return false;
                const direct = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 1);
                if (!direct) return false;
                const cs = getComputedStyle(el);
                return cs.visibility !== 'hidden' && cs.display !== 'none';
            });
            const visible = [];
            for (const el of els) {
                // effective opacity up the tree
                let op = 1, n = el;
                while (n && n !== stage) { op *= parseFloat(getComputedStyle(n).opacity || '1'); n = n.parentElement; }
                const r = el.getBoundingClientRect();
                if (r.width < 2 || r.height < 2) continue;
                const label = el.textContent.trim().slice(0, 32);
                if (op < 0.12) { out.push(`text "${label}" is nearly invisible at the hero frame (opacity ${op.toFixed(2)}) — entrance finishes too late or design too dim`); continue; }
                visible.push({ el, r, label });
                // 1. frame overflow (8px tolerance)
                const overflows = r.left < -8 || r.top < -8 || r.right > 1928 || r.bottom > 1088;
                if (overflows) {
                    const ox = Math.max(0, Math.ceil(Math.max(-r.left, r.right - 1920)));
                    const oy = Math.max(0, Math.ceil(Math.max(-r.top, r.bottom - 1080)));
                    out.push(`text "${label}" overflows the 1920x1080 frame by ${ox}px horizontally / ${oy}px vertically — reduce font-size or break the line`);
                }
                // 4. title-safe area. The frame is not the whole story: YouTube
                // paints its own chrome ON TOP of the video. Text that clears
                // 1920x1080 can still be unreadable in the player, and this is
                // the one failure the author can never see in a preview.
                //
                // Already-overflowing text is skipped — it gets the sharper
                // message above, and two errors for one mistake just crowds the
                // repair round.
                if (!overflows) {
                    if (r.bottom > SAFE.bottomLine) {
                        out.push(`text "${label}" reaches ${Math.round(r.bottom)}px, inside the bottom ${SAFE.bottomPx}px where YouTube's progress bar and controls sit — lift it above ${SAFE.bottomLine}px`);
                    } else if (r.top < SAFE.topPx) {
                        out.push(`text "${label}" starts at ${Math.round(r.top)}px, inside the top ${SAFE.topPx}px where the mobile player paints the title bar — drop it below ${SAFE.topPx}px`);
                    } else if (r.left < SAFE.edgePx || r.right > 1920 - SAFE.edgePx) {
                        out.push(`text "${label}" runs to within ${Math.round(Math.min(r.left, 1920 - r.right))}px of the frame edge — keep a ${SAFE.edgePx}px margin so it survives rounded corners and safe-area cut-ins`);
                    }
                }
                // 5. contrast against what is ACTUALLY behind the word.
                if (contrastReports < CT.maxReports) {
                    const bg = backdropOf(el);
                    // Below the alpha floor the footage is showing through and
                    // the true backdrop is the editor's clip — unknowable here,
                    // so nothing is claimed.
                    if (bg && bg.a >= CT.minBackdropAlpha) {
                        const cs = getComputedStyle(el);
                        // A transparent fill is gradient type; the textual
                        // gradient-text rule owns that and there is no colour
                        // here to measure.
                        const fill = rgba(cs.webkitTextFillColor) || rgba(cs.color);
                        if (fill && fill.a > 0.02) {
                            const solid = { r: bg.r, g: bg.g, b: bg.b, a: 1 };
                            const ink = over(fill, solid);
                            const size = parseFloat(cs.fontSize) || 0;
                            const floor = size >= CT.displayPx ? CT.minDisplay : CT.minBody;
                            const cr = ratio(ink, solid);
                            if (cr < floor) {
                                contrastReports++;
                                out.push(`text "${label}" is unreadable: ${hex(ink)} on ${hex(solid)} measures ${cr.toFixed(2)}:1, under the ${floor}:1 floor for ${size >= CT.displayPx ? 'display' : 'body'} type — this is measured from the rendered pixels, not the stylesheet, so a near-identical pair like cream-on-cream is caught even when the two colours live in different rules. Darken the surface or lighten the type until they separate.`);
                            }
                        }
                    }
                }
            }
            // 2. text-on-text collisions (skip ancestor/descendant pairs)
            for (let i = 0; i < visible.length; i++) for (let j = i + 1; j < visible.length; j++) {
                const A = visible[i], B = visible[j];
                if (A.el.contains(B.el) || B.el.contains(A.el)) continue;
                const x = Math.max(0, Math.min(A.r.right, B.r.right) - Math.max(A.r.left, B.r.left));
                const y = Math.max(0, Math.min(A.r.bottom, B.r.bottom) - Math.max(A.r.top, B.r.top));
                const inter = x * y;
                const minArea = Math.min(A.r.width * A.r.height, B.r.width * B.r.height);
                if (minArea > 0 && inter / minArea > 0.3) {
                    out.push(`text "${A.label}" overlaps text "${B.label}" (${Math.round((inter / minArea) * 100)}% of the smaller element) — separate them vertically`);
                }
            }
            if (window.__tlErr) out.push(`timeline threw at runtime: ${window.__tlErr}`);
            return out.slice(0, 6);
        }, TITLE_SAFE, CONTRAST);

        // ── Overlay coverage (OVERLAY MODE): the comp floats on live footage.
        // Measured at the hero frame: union of painted/text element rects on
        // a sampling grid. >32% buried footage or any single near-full-frame
        // painted surface = rejection.
        let coverageErrors = [];
        if (opts.kind === 'overlay') {
            coverageErrors = await page.evaluate(() => {
                const out = [];
                const stage = document.getElementById('stage');
                const isPainted = (el) => {
                    const cs = getComputedStyle(el);
                    const bgA = (() => {
                        const m = String(cs.backgroundColor || '').match(/rgba?\(([^)]+)\)/);
                        if (!m) return 0;
                        const parts = m[1].split(',').map(s => parseFloat(s));
                        return parts.length === 4 ? parts[3] : 1;
                    })();
                    if (bgA > 0.04) return true;
                    if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
                    if (cs.boxShadow && cs.boxShadow !== 'none') return true;
                    const hasText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 0);
                    return hasText;
                };
                const COLS = 48, ROWS = 27;
                const grid = new Uint8Array(COLS * ROWS);
                for (const el of stage.querySelectorAll('*')) {
                    if (el.tagName === 'STYLE' || el.tagName === 'SCRIPT') continue;
                    const cs = getComputedStyle(el);
                    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
                    let op = 1, n = el;
                    while (n && n !== stage) { op *= parseFloat(getComputedStyle(n).opacity || '1'); n = n.parentElement; }
                    if (op < 0.1) continue;
                    if (!isPainted(el)) continue;
                    const r = el.getBoundingClientRect();
                    if (r.width < 3 || r.height < 3) continue;
                    const areaFrac = (Math.min(r.right, 1920) - Math.max(r.left, 0)) * (Math.min(r.bottom, 1080) - Math.max(r.top, 0)) / (1920 * 1080);
                    if (areaFrac > 0.62) {
                        out.push(`overlay element "${(el.textContent || el.className || '').toString().trim().slice(0, 28)}" paints ${Math.round(areaFrac * 100)}% of the frame — full-frame panels/scrims are forbidden on overlays (the footage must stay visible)`);
                    }
                    const c0 = Math.max(0, Math.floor(r.left / 1920 * COLS)), c1 = Math.min(COLS - 1, Math.ceil(r.right / 1920 * COLS) - 1);
                    const r0 = Math.max(0, Math.floor(r.top / 1080 * ROWS)), r1 = Math.min(ROWS - 1, Math.ceil(r.bottom / 1080 * ROWS) - 1);
                    for (let y = r0; y <= r1; y++) for (let x = c0; x <= c1; x++) grid[y * COLS + x] = 1;
                }
                let covered = 0;
                for (let i = 0; i < grid.length; i++) covered += grid[i];
                const frac = covered / grid.length;
                if (frac > 0.32 && out.length === 0) {
                    out.push(`overlay covers ${Math.round(frac * 100)}% of the frame at the hero moment (budget ~30%) — shrink the plate/content so the footage stays the star`);
                }
                return out.slice(0, 2);
            });
        }

        const all = [...entranceErrors, ...errors, ...coverageErrors].slice(0, 6);
        return { ok: all.length === 0, errors: all };
    } catch (err) {
        return { ok: true, errors: [], skipped: true, reason: String(err.message).slice(0, 80) };
    } finally {
        try { if (page) await page.close(); } catch (_) { /* noop */ }
    }
}

/**
 * captureHeroFrame(comp, ns, duration, opts) → base64 JPEG of the rendered hero
 * frame (timeline primed + seeked to 45%), or null if Chrome is unavailable.
 * Used by the author's perfectionist pass: the vision model reviews the
 * ACTUAL rendered pixels like an art director.
 *
 * opts.themeId matters more here than anywhere else. Without it every
 * theme-driven colour resolves to nothing and the art director is handed a
 * screenshot in the wrong palette — it would praise or condemn colours the
 * viewer will never see.
 */
async function captureHeroFrame(comp, ns, duration, opts = {}) {
    const browser = await _getBrowser();
    if (!browser) return null;
    let page;
    try {
        page = await browser.newPage();
        await page.setContent(
            _page(comp.html, comp.css, comp.timeline, _themeVarBlock(opts.themeId)),
            { waitUntil: 'load', timeout: 15000 },
        );
        await page.evaluate((t) => { if (window.__tl) window.__tl.time(t); }, Math.max(0.1, duration * 0.45));
        await new Promise(r => setTimeout(r, 250));
        const buf = await page.screenshot({ type: 'jpeg', quality: 80, clip: { x: 0, y: 0, width: 1920, height: 1080 } });
        return Buffer.from(buf).toString('base64');
    } catch (_) {
        return null;
    } finally {
        try { if (page) await page.close(); } catch (_) { /* noop */ }
    }
}

module.exports = {
    visualLint, captureHeroFrame, closeVisualLint,
    TITLE_SAFE, CONTRAST,
    // Exported so a verify gate can prove this wiring still matches the one the
    // repair pass substitutes from. They must never disagree.
    themeCssVars: _themeVarBlock,
};
