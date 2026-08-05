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
 * Violations come back as lint errors with the offending text + numbers, so
 * the author's repair round gets concrete, fixable feedback.
 *
 * A single shared browser serves the whole batch (launch ~1s, per-comp
 * ~300ms). Fails open: if Chrome is unavailable, returns ok (the textual
 * linter still applies).
 */
'use strict';

const fs = require('fs');

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

function _page(html, css, timeline) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
html,body{margin:0;padding:0;background:#05080f;}
#stage{position:relative;width:1920px;height:1080px;overflow:visible;}
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
        await page.setContent(_page(comp.html, comp.css, comp.timeline), { waitUntil: 'load', timeout: 15000 });

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
        const errors = await page.evaluate((SAFE) => {
            const out = [];
            const stage = document.getElementById('stage');
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
        }, TITLE_SAFE);

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
 * captureHeroFrame(comp, ns, duration) → base64 JPEG of the rendered hero
 * frame (timeline primed + seeked to 45%), or null if Chrome is unavailable.
 * Used by the author's perfectionist pass: the vision model reviews the
 * ACTUAL rendered pixels like an art director.
 */
async function captureHeroFrame(comp, ns, duration) {
    const browser = await _getBrowser();
    if (!browser) return null;
    let page;
    try {
        page = await browser.newPage();
        await page.setContent(_page(comp.html, comp.css, comp.timeline), { waitUntil: 'load', timeout: 15000 });
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

module.exports = { visualLint, captureHeroFrame, closeVisualLint, TITLE_SAFE };
