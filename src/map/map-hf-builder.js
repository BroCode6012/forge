/**
 * map-hf-builder.js — Generate smooth, accurate map graphics for HyperFrames.
 *
 * Pure builder: given an authoritative MapScene (mapMode + renderAssets), it
 * returns HTML markup (real basemap <img> + projected real-OSM SVG paths +
 * route + pins/labels) plus a serializable animation spec the HyperFrames
 * runtime turns into GSAP tweens. Camera is a CSS transform on the map-world
 * layer → GPU-composited 60fps (the reason the GSAP approach is smoother than
 * a canvas redraw). Same tileZ Mercator projection as the basemap stitch, so
 * borders/pins land pixel-accurate.
 *
 * No DOM, no canvas, no network — safe to call from the build pipeline.
 *
 *   buildMapHF(mapScene, { id, W, H, duration, style }) ->
 *     { ok, basemapFile, imgW, imgH, html, anim } | { ok:false }
 */
'use strict';

const BORDER_COLORS = {
    satellite: ['#00e0ff', '#ff7a3d', '#46ff9b', '#ffd24a'],
    political: ['#0a84ff', '#e0322b', '#1f9d55', '#b8860b'],
    dark:      ['#00d4ff', '#ff6040', '#40ff90', '#f0c040'],
    light:     ['#2060c0', '#d04030', '#1f9d55', '#b8860b'],
    natural:   ['#1f9d55', '#d08030', '#2060c0', '#b8860b'],
};
const ROUTE_COLOR = { satellite: '#ffe680', political: '#0a84ff', dark: '#00d4ff', light: '#2060c0', natural: '#d08030' };

function buildProjection(mapView, IMG_W, IMG_H) {
    const TILE = 512;
    const z = Math.max(2, Math.floor(mapView.zoom));
    const n = Math.pow(2, z);
    const cTileX = ((mapView.lon + 180) / 360) * n;
    const cLatRad = mapView.lat * Math.PI / 180;
    const cTileY = (1 - Math.log(Math.tan(cLatRad) + 1 / Math.cos(cLatRad)) / Math.PI) / 2 * n;
    const oPx = cTileX * TILE - IMG_W / 2, oPy = cTileY * TILE - IMG_H / 2;
    const toX = (lon) => ((lon + 180) / 360) * n * TILE - oPx;
    const toY = (lat) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n * TILE - oPy; };
    return { toX, toY };
}

const polysOf = (g) => !g ? [] : g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];

function geomToPath(geom, toX, toY) {
    let d = '';
    for (const poly of polysOf(geom)) for (const ring of poly) {
        if (!ring || ring.length < 3) continue;
        d += `M${toX(ring[0][0]).toFixed(1)} ${toY(ring[0][1]).toFixed(1)}`;
        for (let i = 1; i < ring.length; i++) d += `L${toX(ring[i][0]).toFixed(1)} ${toY(ring[i][1]).toFixed(1)}`;
        d += 'Z';
    }
    return d;
}
function geomPerim(geom, toX, toY) {
    let L = 0;
    for (const poly of polysOf(geom)) for (const ring of poly) for (let i = 1; i < ring.length; i++) {
        L += Math.hypot(toX(ring[i][0]) - toX(ring[i - 1][0]), toY(ring[i][1]) - toY(ring[i - 1][1]));
    }
    return Math.ceil(L);
}
function geomBounds(geom, toX, toY, b) {
    for (const poly of polysOf(geom)) for (const ring of poly) for (const pt of ring) {
        const x = toX(pt[0]), y = toY(pt[1]);
        if (x < b.mnX) b.mnX = x; if (y < b.mnY) b.mnY = y;
        if (x > b.mxX) b.mxX = x; if (y > b.mxY) b.mxY = y;
    }
}

// Camera keyframe → CSS transform values. transform-origin is 0,0; a basemap
// point (px,py) at scale S maps to screen (X + px*S, Y + py*S). We center the
// target and clamp so the basemap always covers the viewport (no black bars).
function camKeyframe(px, py, S, W, H, IMG_W, IMG_H) {
    let X = W / 2 - px * S, Y = H / 2 - py * S;
    X = Math.min(0, Math.max(W - IMG_W * S, X));
    Y = Math.min(0, Math.max(H - IMG_H * S, Y));
    return { x: +X.toFixed(1), y: +Y.toFixed(1), scale: +S.toFixed(4) };
}

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function buildMapHF(mapScene, opts = {}) {
    const ra = mapScene && mapScene.renderAssets;
    if (!ra || !ra.mapView) return { ok: false };
    const W = opts.W || 1920, H = opts.H || 1080;
    const id = opts.id || 'map';
    const duration = Math.max(2, opts.duration || 8);
    const style = opts.style || mapScene.mapStyle || 'satellite';
    const mode = mapScene.mapMode || 'locator';
    const IMG_W = (ra.bigMapSize && ra.bigMapSize.w) || opts.imgW || W;
    const IMG_H = (ra.bigMapSize && ra.bigMapSize.h) || opts.imgH || H;
    const { toX, toY } = buildProjection(ra.mapView, IMG_W, IMG_H);
    const palette = BORDER_COLORS[style] || BORDER_COLORS.satellite;
    const routeCol = ROUTE_COLOR[style] || ROUTE_COLOR.satellite;

    const osm = (ra.osmBoundaries || []).filter(o => o && o.feature && o.feature.geometry);
    const pins = ((ra.mapView.pins) || []).map(p => ({ name: p.name, x: toX(p.lon), y: toY(p.lat) }));
    const route = (ra.routeGeometry || []).map(g => ({ x: toX(g.lon), y: toY(g.lat) }));
    const isRoute = (mode === 'route' || ra.routePath) && route.length >= 2;

    // ── SVG overlay ──
    const defs = `<filter id="${id}-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;

    let routeSvg = '', routeLen = 0;
    if (isRoute) {
        let d = `M${route[0].x.toFixed(1)} ${route[0].y.toFixed(1)}`;
        for (let i = 1; i < route.length; i++) { d += `L${route[i].x.toFixed(1)} ${route[i].y.toFixed(1)}`; routeLen += Math.hypot(route[i].x - route[i - 1].x, route[i].y - route[i - 1].y); }
        routeLen = Math.ceil(routeLen);
        routeSvg = `<path id="${id}-route-glow" d="${d}" fill="none" stroke="${routeCol}" stroke-width="8" vector-effect="non-scaling-stroke" stroke-linecap="round" opacity="0.35" filter="url(#${id}-glow)"/>`
                 + `<path id="${id}-route-dash" d="${d}" fill="none" stroke="${routeCol}" stroke-width="3" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-dasharray="14 9"/>`;
    }

    const borderSpecs = [];
    const borderSvg = osm.map((o, i) => {
        const col = palette[i % palette.length];
        const d = geomToPath(o.feature.geometry, toX, toY);
        const L = geomPerim(o.feature.geometry, toX, toY);
        borderSpecs.push({ i, dashLen: L });
        // Broadcast cartography stack (GEOLayers-style):
        //   1. faint area tint (7%) — presence without washing out terrain
        //   2. inner glow band — wide blurred stroke CLIPPED to the polygon
        //      interior: highlight hugs the border and fades inward
        //   3. dark casing under the core line — seats the line on any terrain
        //   4. bright core line — crisp, screen-constant width, draw-on reveal
        return `<clipPath id="${id}-clip-${i}"><path d="${d}"/></clipPath>`
            + `<g id="${id}-bd-${i}" opacity="0">`
            + `<path d="${d}" fill="${col}" fill-opacity="0.07"/>`
            + `<path d="${d}" clip-path="url(#${id}-clip-${i})" fill="none" stroke="${col}" stroke-width="14" stroke-opacity="0.20" filter="url(#${id}-glow)"/>`
            + `<path d="${d}" fill="none" stroke="rgba(2,8,18,0.7)" stroke-width="3.2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`
            + `<path id="${id}-bd-stroke-${i}" d="${d}" fill="none" stroke="${col}" stroke-width="1.8" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-dasharray="${L}" stroke-dashoffset="${L}"/>`
            + `</g>`;
    }).join('');

    const pinSpecs = [];
    const pinSvg = pins.slice(0, 8).map((p, i) => {
        const col = palette[i % palette.length];
        const labW = p.name.length * 17 + 26;
        pinSpecs.push({ i, x: +p.x.toFixed(1), y: +p.y.toFixed(1) });
        return `<g id="${id}-pin-${i}" opacity="0">`
            + `<circle id="${id}-ring-${i}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2" fill="none" stroke="${routeCol}" stroke-width="2"/>`
            + `<circle id="${id}-pindot-${i}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="10" fill="${col}" filter="url(#${id}-glow)"/>`
            + `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="#fff"/>`
            + `<g id="${id}-lbl-${i}"><rect x="${(p.x + 16).toFixed(1)}" y="${(p.y - 20).toFixed(1)}" width="${labW}" height="38" rx="5" fill="rgba(6,11,20,0.85)"/>`
            + `<text x="${(p.x + 28).toFixed(1)}" y="${(p.y + 6).toFixed(1)}" fill="#fff" font-family="Arial, sans-serif" font-size="26" font-weight="800" letter-spacing="0.04em">${esc(p.name.toUpperCase())}</text></g>`
            + `</g>`;
    }).join('');

    const html =
`<div id="${id}-tilt" class="hf-map-tilt" style="position:absolute;inset:0;transform-style:preserve-3d;">
<div id="${id}-mw" class="hf-map-world" style="width:${IMG_W}px;height:${IMG_H}px;">
  <img class="hf-map-base" src="${esc(opts.basemapRel || ra.mapImageFile || '')}" alt="">
  <svg class="hf-map-svg" viewBox="0 0 ${IMG_W} ${IMG_H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
    <defs>${defs}</defs>
    ${routeSvg}${borderSvg}${pinSvg}
  </svg>
</div>
</div>`;

    // ── Camera keyframes ──
    // Largest-ring bbox of one OSM feature (mainland framing — outlying
    // islands don't drag the frame). Shared by overall fit + journey frames.
    const largestRingBBox = (o) => {
        let best = null, bestArea = -1;
        for (const poly of polysOf(o.feature.geometry)) {
            const ring = poly[0];
            if (!ring || ring.length < 3) continue;
            let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
            for (const pt of ring) { const x = toX(pt[0]), y = toY(pt[1]); if (x < mnx) mnx = x; if (y < mny) mny = y; if (x > mxx) mxx = x; if (y > mxy) mxy = y; }
            const area = (mxx - mnx) * (mxy - mny);
            if (area > bestArea) { bestArea = area; best = { mnx, mny, mxx, mxy }; }
        }
        return best;
    };
    // Frame (center + zoom) for a subject-name set — pins + border bboxes.
    const frameFor = (names) => {
        const set = new Set((names || []).map(n => String(n).toLowerCase().trim()).filter(Boolean));
        if (!set.size) return null;
        const bb = { mnX: Infinity, mnY: Infinity, mxX: -Infinity, mxY: -Infinity };
        let hits = 0;
        for (const p of pins) {
            if (!set.has(String(p.name || '').toLowerCase().trim())) continue;
            bb.mnX = Math.min(bb.mnX, p.x); bb.mnY = Math.min(bb.mnY, p.y);
            bb.mxX = Math.max(bb.mxX, p.x); bb.mxY = Math.max(bb.mxY, p.y);
            hits++;
        }
        for (const o of osm) {
            if (!set.has(String(o.name || '').toLowerCase().trim())) continue;
            const r = largestRingBBox(o);
            if (!r) continue;
            bb.mnX = Math.min(bb.mnX, r.mnx); bb.mnY = Math.min(bb.mnY, r.mny);
            bb.mxX = Math.max(bb.mxX, r.mxx); bb.mxY = Math.max(bb.mxY, r.mxy);
            hits++;
        }
        if (!hits || !isFinite(bb.mnX)) return null;
        const cx = (bb.mnX + bb.mxX) / 2, cy = (bb.mnY + bb.mxY) / 2;
        const spanX = Math.max(1, bb.mxX - bb.mnX), spanY = Math.max(1, bb.mxY - bb.mnY);
        // degenerate bbox (single pin) → fixed readable zoom-in
        const zoom = (spanX < 8 && spanY < 8)
            ? 1.5
            : Math.min(2.0, Math.min(W / (spanX * 1.6), H / (spanY * 1.6)));
        return camKeyframe(cx, cy, Math.max(0.85, zoom), W, H, IMG_W, IMG_H);
    };

    const segs = Array.isArray(mapScene.segments) && mapScene.segments.length > 1
        ? mapScene.segments
            .map(s => ({ ...s, start: Math.max(0, Math.min(duration, Number(s.start) || 0)), end: Math.max(0, Math.min(duration, Number(s.end) || 0)) }))
            .filter(s => s.end - s.start > 0.6)
        : null;

    const camera = [];
    if (segs) {
        // ── JOURNEY camera: one continuous map, the camera visits each
        // segment's frame in sync with the narration. Opens wide over the
        // whole journey, holds (slow start), then glides segment to segment
        // with long eased moves. ──
        const allNames = segs.flatMap(s => s.subjects || []);
        const overall = frameFor(allNames) || camKeyframe(IMG_W / 2, IMG_H / 2, 1, W, H, IMG_W, IMG_H);
        // widen the establishing frame a touch
        const opening = { ...overall, s: Math.max(0.8, overall.s * 0.9) };
        camera.push({ ...opening, at: 0, dur: 0, ease: 'none', set: true });
        let prevFrame = opening;
        segs.forEach((seg, i) => {
            const f = frameFor(seg.subjects) || prevFrame;
            const segDur = seg.end - seg.start;
            // glide starts just before the narration beat, arrives ~1/3 in;
            // first move waits for the slow-start hold (never instant).
            const moveStart = i === 0 ? Math.max(0.8, seg.start) : Math.max(camera[camera.length - 1].at + camera[camera.length - 1].dur - 0.2, seg.start - 0.4);
            const arrive = Math.min(seg.end - 0.3, Math.max(moveStart + 1.2, seg.start + segDur * 0.35));
            camera.push({ ...f, at: +moveStart.toFixed(2), dur: +(arrive - moveStart).toFixed(2), ease: 'power2.inOut' });
            prevFrame = f;
        });
    } else if (isRoute) {
        // travel the corridor: long hold, then glide to mid and end with
        // gentle easing — the camera must never be moving on frame one.
        const wpFor = (frac) => { const idx = Math.min(route.length - 1, Math.round(frac * (route.length - 1))); return route[idx]; };
        const a = route[0], b = wpFor(0.5), c = route[route.length - 1];
        const k0 = camKeyframe(a.x, a.y, 1.22, W, H, IMG_W, IMG_H);
        const k1 = camKeyframe(b.x, b.y, 1.08, W, H, IMG_W, IMG_H);
        const k2 = camKeyframe(c.x, c.y, 1.18, W, H, IMG_W, IMG_H);
        const hold = Math.min(1.1, duration * 0.16);
        camera.push({ ...k0, at: 0, dur: 0, ease: 'none', set: true });
        camera.push({ ...k1, at: hold, dur: Math.max(1.2, duration * 0.34), ease: 'power2.inOut' });
        camera.push({ ...k2, at: hold + Math.max(1.2, duration * 0.36), dur: Math.max(1.2, duration * 0.42), ease: 'power3.inOut' });
    } else {
        // region/locator/comparison: fit bbox of borders (else pins), gentle push-in + drift.
        // CAMERA FRAMES THE MAINLAND: each feature contributes only its
        // LARGEST ring's bounds — distant outlying islands (Canaries for
        // Spain, overseas territories) no longer drag the bbox out and
        // shrink the country into a corner. All rings still DRAW.
        const bb = { mnX: Infinity, mnY: Infinity, mxX: -Infinity, mxY: -Infinity };
        for (const o of osm) {
            const bestRing = largestRingBBox(o);
            if (bestRing) {
                bb.mnX = Math.min(bb.mnX, bestRing.mnx); bb.mnY = Math.min(bb.mnY, bestRing.mny);
                bb.mxX = Math.max(bb.mxX, bestRing.mxx); bb.mxY = Math.max(bb.mxY, bestRing.mxy);
            }
        }
        if (!isFinite(bb.mnX)) for (const p of pins) { bb.mnX = Math.min(bb.mnX, p.x); bb.mnY = Math.min(bb.mnY, p.y); bb.mxX = Math.max(bb.mxX, p.x); bb.mxY = Math.max(bb.mxY, p.y); }
        if (!isFinite(bb.mnX)) { bb.mnX = 0; bb.mnY = 0; bb.mxX = IMG_W; bb.mxY = IMG_H; }
        const cx = (bb.mnX + bb.mxX) / 2, cy = (bb.mnY + bb.mxY) / 2;
        const spanX = Math.max(1, bb.mxX - bb.mnX), spanY = Math.max(1, bb.mxY - bb.mnY);
        const headroom = pins.length <= 1 ? 1.9 : 1.4;
        const fit = Math.min(2.0, Math.min(W / (spanX * headroom), H / (spanY * headroom))); // capped: unbounded fit on tiny bboxes (single strait) zoomed past readability
        const k0 = camKeyframe(cx, cy, fit, W, H, IMG_W, IMG_H);
        const k1 = camKeyframe(cx + spanX * 0.04, cy, fit * 1.10, W, H, IMG_W, IMG_H);
        // hold the establishing frame, then one long eased push-in — never
        // moving on frame one.
        const hold = Math.min(0.9, duration * 0.14);
        camera.push({ ...k0, at: 0, dur: 0, ease: 'none', set: true });
        camera.push({ ...k1, at: hold, dur: Math.max(1.5, duration - hold), ease: 'sine.inOut' });
    }

    // ── Element animation timings ──
    // With journey segments, each pin/border appears WHEN ITS NARRATION BEAT
    // arrives (the camera is gliding there at that moment); otherwise the
    // classic gentle stagger.
    const segStartByName = new Map();
    if (segs) {
        for (const seg of segs) {
            for (const n of (seg.subjects || [])) {
                const key = String(n).toLowerCase().trim();
                if (key && !segStartByName.has(key)) segStartByName.set(key, seg.start);
            }
        }
    }
    const elementAt = (name, fallbackAt) => {
        if (!segs) return fallbackAt;
        const s = segStartByName.get(String(name || '').toLowerCase().trim());
        return s == null ? fallbackAt : +Math.max(0.4, Math.min(duration - 1, s + 0.45)).toFixed(2);
    };
    const borders = borderSpecs.map((b, i) => ({
        id: `${id}-bd-${i}`, stroke: `${id}-bd-stroke-${i}`, dashLen: b.dashLen,
        at: elementAt(osm[i] && osm[i].name, +(0.4 + i * (isRoute ? duration * 0.28 : 0.6)).toFixed(2)),
        dur: 1.4,
    }));
    const pinsAnim = pinSpecs.map((p, i) => ({
        grp: `${id}-pin-${i}`, dot: `${id}-pindot-${i}`, ring: `${id}-ring-${i}`, lbl: `${id}-lbl-${i}`, x: p.x, y: p.y,
        at: elementAt(pins[i] && pins[i].name, +(0.6 + i * (isRoute ? duration * 0.28 : 0.32)).toFixed(2)),
    }));

    const anim = {
        worldId: `${id}-mw`,
        // 3D pitch (GEOLayers-style): flat at start, tilts in gently. The
        // agent/modes own the angle; tilt lives on a separate wrapper so the
        // 2D camera math is untouched.
        tilt: { id: `${id}-tilt`, deg: isRoute ? 9 : 15, at: 0.25, dur: Math.min(2.6, duration * 0.5) },
        camera,
        route: isRoute ? { glow: `${id}-route-glow`, dash: `${id}-route-dash`, len: routeLen, at: 0.5, dur: duration * 0.7 } : null,
        borders,
        pins: pinsAnim,
    };

    return { ok: true, basemapFile: ra.mapImageFile || null, imgW: IMG_W, imgH: IMG_H, mode, html, anim };
}

// Build the GSAP timeline code (string) from an anim spec, scoped to a paused
// timeline variable `tl`. Used by the HyperFrames runtime. Kept here so the
// builder and runtime never drift. `offset` shifts every position to the MG's
// absolute start time on the master timeline (0 for standalone previews).

// ── ZOOM ADAPTATION SYSTEM ──────────────────────────────────────────────
// One central curve for how overlay components respond to camera zoom S:
//   screenSize ∝ (S/S0)^k   clamped to [min,max] × base size
// k=0 → constant screen size (frozen), k=1 → fully world-locked (scales
// with the map). Labels/pins use k≈0.35: zooming in makes them grow gently
// (anchored feel), zooming out shrinks them gently — never balloons, never
// vanishes. Border strokes stay k=0 via vector-effect=non-scaling-stroke.
// FUTURE COMPONENTS (icons, badges, callouts): register a kind here and
// apply overlayScaleFor() in the timeline generator — nothing else needed.
const ZOOM_ADAPT = {
    pin: { k: 0.35, min: 0.72, max: 1.55 },
};
function overlayScaleFor(S, S0, kind) {
    const c = ZOOM_ADAPT[kind] || ZOOM_ADAPT.pin;
    const factor = Math.max(c.min, Math.min(c.max, Math.pow(S / Math.max(0.0001, S0), c.k)));
    return factor / S; // world-space scale that yields the desired screen factor
}
function buildMapTimelineJS(anim, offset = 0, timelineVar = 'tl') {
    const timeline = /^[A-Za-z_$][\w$]*$/.test(String(timelineVar || '')) ? String(timelineVar) : 'tl';
    const at = (t) => (offset + t).toFixed(3);
    const L = [];
    L.push(`(function(){ var w="#"+CSS.escape(${JSON.stringify(anim.worldId)});`);
    if (anim.tilt) {
        L.push(`gsap.set("#${anim.tilt.id}",{transformPerspective:1150,transformOrigin:"50% 62%",rotationX:0});`);
        L.push(`${timeline}.to("#${anim.tilt.id}",{rotationX:${anim.tilt.deg},duration:${anim.tilt.dur.toFixed(2)},ease:"sine.inOut"},${(offset + anim.tilt.at).toFixed(3)});`);
    }
    L.push(`if(!document.querySelector(w))return;`);
    L.push(`gsap.set(w,{transformOrigin:"0px 0px"});`);
    for (const k of anim.camera) {
        if (k.set) L.push(`${timeline}.set(w,{x:${k.x},y:${k.y},scale:${k.scale}},${at(0)}); gsap.set(w,{x:${k.x},y:${k.y},scale:${k.scale}});`);
        else L.push(`${timeline}.to(w,{x:${k.x},y:${k.y},scale:${k.scale},duration:${k.dur.toFixed(3)},ease:"${k.ease}"},${at(k.at)});`);
    }
    if (anim.route) {
        L.push(`${timeline}.fromTo("#${anim.route.glow}",{strokeDasharray:${anim.route.len},strokeDashoffset:${anim.route.len}},{strokeDashoffset:0,duration:${anim.route.dur.toFixed(3)},ease:"none"},${at(anim.route.at)});`);
        L.push(`${timeline}.fromTo("#${anim.route.dash}",{strokeDashoffset:${anim.route.len}},{strokeDashoffset:0,duration:${anim.route.dur.toFixed(3)},ease:"none"},${at(anim.route.at)});`);
    }
    for (const b of anim.borders) {
        L.push(`${timeline}.set("#${b.id}",{opacity:1},${at(b.at)});`);
        L.push(`${timeline}.to("#${b.stroke}",{strokeDashoffset:0,duration:${b.dur},ease:"power2.inOut"},${at(b.at)});`);
    }
    for (const p of anim.pins) {
        // Zoom-adaptive counter-scale: pins+labels follow the central
        // ZOOM_ADAPT curve — screen size grows/shrinks gently with the
        // camera (k=0.35), clamped so it never balloons ("STRAIT" filling
        // the frame) and never vanishes. Synced to every camera keyframe.
        const camKfs = anim.camera || [];
        const s0 = camKfs.length ? camKfs[0].scale : 1;
        L.push(`gsap.set("#${p.grp}",{svgOrigin:"${p.x} ${p.y}",scale:${overlayScaleFor(s0, s0, 'pin').toFixed(4)}});`);
        for (const k of camKfs) {
            if (k.set) continue;
            L.push(`${timeline}.to("#${p.grp}",{scale:${overlayScaleFor(k.scale, s0, 'pin').toFixed(4)},duration:${k.dur.toFixed(3)},ease:"${k.ease}"},${at(k.at)});`);
        }
        L.push(`${timeline}.set("#${p.grp}",{opacity:1},${at(p.at)});`);
        L.push(`${timeline}.fromTo("#${p.dot}",{scale:0,transformOrigin:"${p.x}px ${p.y}px"},{scale:1,duration:0.5,ease:"back.out(2.4)"},${at(p.at)});`);
        L.push(`${timeline}.fromTo("#${p.ring}",{attr:{r:4},opacity:0.8},{attr:{r:55},opacity:0,duration:1.2,ease:"power3.out"},${at(p.at + 0.1)});`);
        L.push(`${timeline}.fromTo("#${p.lbl}",{opacity:0},{opacity:1,duration:0.4},${at(p.at + 0.15)});`);
    }
    L.push(`})();`);
    return L.join('\n');
}

module.exports = { buildMapHF, buildMapTimelineJS, buildProjection };
