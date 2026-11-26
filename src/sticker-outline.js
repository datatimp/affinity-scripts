/*
Sticker Outline for Affinity: draws one solid sticker (die-cut) shape behind the selection, grown
outward from the artwork by a set distance.

Version 1.2.1
Copyright (C) 2026 datatimp
https://github.com/datatimp/affinity-scripts
SPDX-License-Identifier: AGPL-3.0-or-later

Select the artwork (any number of objects or groups) and run the script. A dialog sets the
offset, the colour and whether holes are filled, with a live preview; OK groups the artwork with one curve object named "Sticker outline" at
the bottom of the group, in one undo step. The artwork itself is not changed. Only the selection is
outlined; nothing else in the document is looked at or changed.

What counts as artwork: every filled shape, curve and text, and every visible stroke at its full
width (centre, inside and outside alignment are all honoured). A stroke with a pressure profile,
tapered or drawn with a pen, counts at the width the pressure gives it at each point. Open lines
with only a stroke count as the stroke. Images and adjustments are skipped.

How it works: the outline is everything within the offset distance of the artwork (the Minkowski
sum of the artwork and a circle), with round corners as a cutter needs. Each Bezier segment is
cut into short pieces; each piece contributes a band out to its offset curve (outside only for a
filled shape, both sides for a stroke; where a tight inside bend would fold the band over itself,
a rectangle along the piece's chord stands in), and circles round the corners, the open ends and
every half radius or so along the way. The artwork plus all of these, joined with Add
(boolean union), is the outline. With "Fill holes" on, any hole left inside (the counter of an
O, a gap between letters) is dropped, so each piece of the sticker is solid. Pieces of art too
far apart to touch stay separate pieces; raise the offset to join them.

Add only works on objects in the document, so on OK the pieces are added and joined, the
result is read, both steps are undone, and the finished outline is added as one object.

Written against Affinity's scripting API (beta, Affinity 3.3).
*/

'use strict';

// The script version, shown in its dialog title. Keep it the same as the Version line at the top
// and the script name in Affinity.
const VERSION = "1.2.1";

// STICKER-MATH-BEGIN (plain JavaScript, no Affinity APIs)

// Points are {x, y}; a cubic Bezier segment is an array of four points [start, c1, c2, end].

const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const len = (v) => Math.hypot(v.x, v.y);
const EPS = 1e-7;

function splitSegment(s, t) {
    const a = lerp(s[0], s[1], t), b = lerp(s[1], s[2], t), c = lerp(s[2], s[3], t);
    const d = lerp(a, b, t), e = lerp(b, c, t), f = lerp(d, e, t);
    return [[s[0], a, d, f], [f, e, c, s[3]]];
}

// The first non-zero direction among the candidates, or null for a segment that is one point.
function firstDirection(...vs) {
    for (const v of vs)
        if (len(v) > EPS)
            return v;
    return null;
}

// Start and end tangent directions, falling back past handles that sit on their node.
function endTangents(s) {
    const d0 = firstDirection(sub(s[1], s[0]), sub(s[2], s[0]), sub(s[3], s[0]));
    const d2 = firstDirection(sub(s[3], s[2]), sub(s[3], s[1]), sub(s[3], s[0]));
    return [d0, d2];
}

// How far the segment's direction turns, in radians, measured along its control polygon.
function turning(s) {
    const ds = [sub(s[1], s[0]), sub(s[2], s[1]), sub(s[3], s[2])].filter(v => len(v) > EPS);
    let total = 0;
    for (let i = 1; i < ds.length; ++i) {
        const a = ds[i - 1], b = ds[i];
        total += Math.abs(Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y));
    }
    return total;
}

// The segment cut in halves until each piece turns by at most `maxTurn` radians and is no longer
// than `maxLength` (both keep the offset curve of each piece accurate).
function shortPieces(s, maxTurn, maxLength, depth = 0) {
    const chord = len(sub(s[3], s[0])) + len(sub(s[1], s[0])) + len(sub(s[2], s[3]));
    if (depth >= 8 || (turning(s) <= maxTurn && chord <= maxLength))
        return [s];
    const [l, r] = splitSegment(s, 0.5);
    return shortPieces(l, maxTurn, maxLength, depth + 1).concat(shortPieces(r, maxTurn, maxLength, depth + 1));
}

const normalOf = (d) => { const l = len(d); return { x: d.y / l, y: -d.x / l }; };
const along = (p, n, r) => ({ x: p.x + n.x * r, y: p.y + n.y * r });

// Where the lines p + t·d and q + u·e meet, or null when they are (nearly) parallel.
function meet(p, d, q, e) {
    const den = d.x * e.y - d.y * e.x;
    if (Math.abs(den) < 1e-9 * len(d) * len(e))
        return null;
    const t = ((q.x - p.x) * e.y - (q.y - p.y) * e.x) / den;
    return { x: p.x + d.x * t, y: p.y + d.y * t };
}

// The piece offset by r (signed: which side follows the normal of its direction), by moving each
// leg of its control polygon out by r and meeting the moved legs (Tiller and Hanson). Accurate
// for the short, gently turning pieces shortPieces makes. Null for a piece that is one point.
function offsetPiece(s, r) {
    const [d0, d2] = endTangents(s);
    if (!d0)
        return null;
    const d1 = firstDirection(sub(s[2], s[1]), sub(s[3], s[0]));
    const n0 = normalOf(d0), n1 = normalOf(d1), n2 = normalOf(d2);
    const p0 = along(s[0], n0, r), p3 = along(s[3], n2, r);
    const m1 = along(s[1], n1, r), m2 = along(s[2], n1, r);
    // A handle on its node stays on the moved node.
    const c1 = len(sub(s[1], s[0])) < EPS ? p0 : (meet(p0, d0, m1, d1) ?? along(s[1], n0, r));
    const c2 = len(sub(s[3], s[2])) < EPS ? p3 : (meet(p3, d2, m2, d1) ?? along(s[2], n2, r));
    return [p0, c1, c2, p3];
}

// Even-odd point-in-polygon test; `poly` is an array of points.
function inside(pt, poly) {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a.y > pt.y) != (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x)
            hit = !hit;
    }
    return hit;
}

function pointAt(s, t) {
    const u = 1 - t;
    return {
        x: u * u * u * s[0].x + 3 * u * u * t * s[1].x + 3 * u * t * t * s[2].x + t * t * t * s[3].x,
        y: u * u * u * s[0].y + 3 * u * u * t * s[1].y + 3 * u * t * t * s[2].y + t * t * t * s[3].y,
    };
}

// Points along a closed path's segments, `per` per segment.
function flatten(segments, per = 8) {
    const pts = [];
    for (const s of segments)
        for (let i = 0; i < per; ++i)
            pts.push(pointAt(s, i / per));
    return pts;
}

// True when the offset of a piece runs the same way as the piece. On the inside of a bend
// tighter than the offset, the offset curve folds back on itself, and a band built from it would
// cross itself (which makes Add fail for the whole selection). On a bend only a little looser
// than the offset, the middle leg of the offset's control polygon can turn back while both end
// legs still run the right way; that band has a tiny loop and breaks Add too (the inside bend
// of a u did, at most offsets near 31 px), so all three legs are checked.
function offsetHolds(s, e) {
    const dot = (a, b) => a.x * b.x + a.y * b.y;
    if (dot(sub(e[3], e[0]), sub(s[3], s[0])) <= 0)
        return false;
    if (len(sub(s[1], s[0])) > EPS && dot(sub(e[1], e[0]), sub(s[1], s[0])) < 0)
        return false;
    if (len(sub(s[2], s[1])) > EPS && dot(sub(e[2], e[1]), sub(s[2], s[1])) < 0)
        return false;
    if (len(sub(s[3], s[2])) > EPS && dot(sub(e[3], e[2]), sub(s[3], s[2])) < 0)
        return false;
    return true;
}

// For each path of a filled shape (each given as its segments), +1 or -1: the sign of the offset
// that moves its edge away from the fill. A path enclosed by an odd number of the others is a
// hole, whose outside is its own inside.
function outwardSigns(paths) {
    const polys = paths.map(p => flatten(p, 32));
    return paths.map((segments, i) => {
        if (polys[i].length < 3)
            return 0;
        const hole = polys.filter((other, j) => j != i && other.length > 2 && inside(polys[i][0], other)).length % 2 == 1;
        // A point just beside the middle of the first segment that has a direction.
        for (const s of segments) {
            const [d0] = endTangents(s);
            if (!d0)
                continue;
            const mid = pointAt(s, 0.5);
            const [a, b] = splitSegment(s, 0.5);
            const d = firstDirection(sub(b[1], a[3]), sub(b[3], a[0]));
            const step = Math.max(1e-3, 1e-3 * len(sub(s[3], s[0])) + 1e-3);
            const probe = along(mid, normalOf(d), step);
            const towardOwnInside = inside(probe, polys[i]);
            return towardOwnInside == hole ? 1 : -1;
        }
        return 0;
    });
}

// The indexes of the paths that no other path encloses (each path given as its segments): the
// outside edges of a shape, without its holes or the islands inside them.
function outermost(paths) {
    const polys = paths.map(p => flatten(p, 16));
    return paths.map((_, i) => i).filter(i =>
        polys[i].length > 0 && !polys.some((other, j) => j != i && other.length > 2 && inside(polys[i][0], other)));
}

// For each path of a filled shape (each given as its segments), whether it is a hole: a path
// enclosed by an odd number of the others.
function holeFlags(paths) {
    const polys = paths.map(p => flatten(p, 16));
    return polys.map((poly, i) => poly.length > 2 &&
        polys.filter((other, j) => j != i && other.length > 2 && inside(poly[0], other)).length % 2 == 1);
}

// How far `pt` is from the nearest edge of the polygon `poly`.
function edgeDistance(pt, poly) {
    let best = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[j], ab = sub(poly[i], a), ap = sub(pt, a);
        const l2 = ab.x * ab.x + ab.y * ab.y;
        const t = l2 > 0 ? Math.max(0, Math.min(1, (ap.x * ab.x + ap.y * ab.y) / l2)) : 0;
        best = Math.min(best, len(sub(ap, { x: ab.x * t, y: ab.y * t })));
    }
    return best;
}

// True when every point inside the closed polygon `poly` lies within `r` of its edge, so growing
// the edge inward by r fills it completely. Checked on a grid, with a margin of one grid step so
// a point between the grid points can't be missed.
function closesUp(poly, r) {
    if (poly.length < 3)
        return true;
    const xs = poly.map(p => p.x), ys = poly.map(p => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const step = Math.max(r / 4, Math.hypot(x1 - x0, y1 - y0) / 200);
    for (let x = x0; x <= x1; x += step)
        for (let y = y0; y <= y1; y += step) {
            const pt = { x, y };
            if (inside(pt, poly) && edgeDistance(pt, poly) > r - step)
                return false;
        }
    return true;
}

// A stroke's pressure profile as a function from how far along the path it is (0 to 1) to the
// share of the line weight drawn there, read from the profile's Bezier segments (x along the
// path, y the share). Null when the profile is flat at full weight, as on a plain stroke.
function pressureFunction(segments) {
    if (!segments.length || segments.every(s => s.every(p => Math.abs(p.y - 1) < 1e-6)))
        return null;
    return (x) => {
        const seg = segments.find(s => x <= s[3].x) ?? segments[segments.length - 1];
        // The profile runs left to right, so x rises with t: find x's t by halving.
        let lo = 0, hi = 1;
        for (let i = 0; i < 30; ++i) {
            const mid = (lo + hi) / 2;
            if (pointAt(seg, mid).x < x)
                lo = mid;
            else
                hi = mid;
        }
        return Math.max(0, pointAt(seg, (lo + hi) / 2).y);
    };
}

// STICKER-MATH-END

const NAME = "Sticker outline";

// Every filled outline and stroked path of the node in spread coordinates, as
// {poly, filled, strokeReach}: strokeReach is how far the stroke reaches past the path (0 for
// none). Containers (groups) contribute their children.
function collectArt(node, out) {
    if (node.isVisible === false)
        return out;
    const ci = node.curvesInterface;
    if (ci) {
        const ppc = ci.polyPolyCurves;
        const toSpread = node.baseToSpreadTransform;
        // A fill or stroke can be set but have no colour (fill type None), and then it doesn't
        // show. Text keeps its fill on its glyphs, so the text node itself reports none.
        const shows = (descriptor) => String(descriptor?.fill?.fillType ?? "None") != "None";
        const filled = node.isTextNode === true || (node.hasBrushFill === true && shows(node.brushFillDescriptor));
        let strokeReach = 0;
        if (node.hasPenFill && shows(node.penFillDescriptor) && node.lineWeight > 0) {
            // StrokeAlignment: centre reaches half the weight out, outside the whole weight,
            // inside none.
            const align = String(node.strokeAlignment);
            strokeReach = /outside/i.test(align) ? node.lineWeight : /inside/i.test(align) ? 0 : node.lineWeight / 2;
        }
        // A pressure profile (a tapered stroke, or a brush stroke drawn with a pen) makes the
        // stroke narrower than its line weight along some of its length.
        let pressure = null;
        if (strokeReach > 0) {
            const profile = node.lineStyleDescriptor?.pressure;
            if (profile && !profile.isEmpty)
                pressure = pressureFunction(segmentsOf(profile));
        }
        for (let i = 0; i < ppc.polyCurveCount; ++i) {
            const poly = ppc.getTransformedPolyCurve(i);
            poly.transform(toSpread);
            if (poly.curveCount > 0 && (filled || strokeReach > 0))
                out.push({ poly, filled, strokeReach, pressure });
        }
        return out;
    }
    if (node.children)
        for (const child of node.children)
            collectArt(child, out);
    return out;
}

function segmentsOf(curve) {
    return curve.beziers.toArray().map(b => [b.start, b.c1, b.c2, b.end]);
}

// The pieces whose union is the sticker: the filled art itself and, for every short piece of
// every path, a band out to the offset curve plus circles at corners and ends, all reaching
// `offset` (plus the stroke's reach) from the path. A filled shape's edges get a band on their
// outside only (the inside is filled already); a stroke gets one each side. Where a band would
// fold over itself, a rectangle along the piece's chord stands in for it.
// A hole the offset fills completely anyway is left out of its shape, which goes in solid: that
// replaces many bands and circles crowding into the hole, which can make Add fail (the counter of
// an O did). With `fillHoles` (used only for the preview of pieces Add couldn't join), every
// hole is left out that way.
function stickerPieces(art, offset, fillHoles) {
    const { Curve, CurveBuilder, PolyCurve, Rectangle } = require('/geometry.js');
    const out = [];
    const single = (curve) => { const p = PolyCurve.create(); p.addCurve(curve); return p; };
    // Two identical (or all but identical) circles make Add fail for the whole selection, so a
    // circle is skipped when one of the same size is already within a hundredth of its radius.
    const placed = new Map();
    const circle = (c, r) => {
        const cell = r / 100;
        const key = (x, y) => `${r}:${x}:${y}`;
        const cx = Math.round(c.x / cell), cy = Math.round(c.y / cell);
        for (let dx = -1; dx <= 1; ++dx)
            for (let dy = -1; dy <= 1; ++dy)
                if (placed.has(key(cx + dx, cy + dy)))
                    return null;
        placed.set(key(cx, cy), true);
        return single(Curve.createEllipse(new Rectangle(c.x - r, c.y - r, 2 * r, 2 * r)));
    };
    const push = (p) => { if (p) out.push(p); };
    const band = (s, e) => single(CurveBuilder.create().beginXY(s[0].x, s[0].y)
        .addBezierXY(s[1].x, s[1].y, s[2].x, s[2].y, s[3].x, s[3].y)
        .lineToXY(e[3].x, e[3].y)
        .addBezierXY(e[2].x, e[2].y, e[1].x, e[1].y, e[0].x, e[0].y)
        .close().createCurve());
    // Everything within `side` of the piece's chord, on one side of it: the stand-in for a band
    // that would fold over itself. A piece is short and turns little, so its chord is close to it.
    const slab = (s, side) => {
        const chord = sub(s[3], s[0]);
        if (len(chord) < EPS)
            return null;
        const n = normalOf(chord);
        const a = along(s[3], n, side), b = along(s[0], n, side);
        return single(CurveBuilder.create().beginXY(s[0].x, s[0].y).lineToXY(s[3].x, s[3].y)
            .lineToXY(a.x, a.y).lineToXY(b.x, b.y).close().createCurve());
    };
    const angleBetween = (a, b) => Math.abs(Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y));
    // A stroke with a pressure profile: everything within the offset plus the stroke's reach at
    // that point along the path. Each short piece gets a four-sided band on each side of its
    // chord, as wide at each end as the pressure there makes it and square to the path at each
    // end, and a circle at each joint.
    const tapered = (segments, closed, strokeReach, pressure) => {
        const maxR = offset + strokeReach;
        const pieces = [];
        for (const seg of segments)
            for (const s of shortPieces(seg, Math.PI / 24, Math.max(maxR / 2, 1)))
                if (len(sub(s[3], s[0])) > EPS)
                    pieces.push(s);
        const total = pieces.reduce((t, s) => t + len(sub(s[3], s[0])), 0);
        if (total < EPS)
            return;
        const reachAt = (d) => offset + strokeReach * pressure(Math.min(1, d / total));
        let done = 0, lastCircle = null, lastR = 0;
        for (const s of pieces) {
            const l = len(sub(s[3], s[0]));
            const r0 = reachAt(done), r1 = reachAt(done + l);
            if (r0 > 0 && (!lastCircle || len(sub(s[0], lastCircle)) >= Math.min(r0, lastR) / 2)) {
                push(circle(s[0], r0));
                lastCircle = s[0];
                lastR = r0;
            }
            // Each end of the band is square to the path there, not to the chord, so neighbouring
            // bands share the very same edge. Edges at a sliver of an angle make Add fail.
            const [d0, d2] = endTangents(s);
            const n0 = normalOf(d0), n2 = normalOf(d2);
            for (const k of [1, -1]) {
                const a = along(s[3], n2, k * r1), b = along(s[0], n0, k * r0);
                push(single(CurveBuilder.create().beginXY(s[0].x, s[0].y).lineToXY(s[3].x, s[3].y)
                    .lineToXY(a.x, a.y).lineToXY(b.x, b.y).close().createCurve()));
            }
            done += l;
        }
        const endR = reachAt(total);
        if (!closed && endR > 0)
            push(circle(pieces[pieces.length - 1][3], endR));
    };
    for (const { poly, filled, strokeReach, pressure } of art) {
        const curves = poly.curves.toArray ? poly.curves.toArray() : [...poly.curves];
        const paths = curves.map(segmentsOf);
        const fillSigns = filled ? outwardSigns(paths) : null;
        // Each path reaches the offset past its edge, plus however far its stroke reaches.
        const r = offset + strokeReach;
        // The holes to fill solid, and anything inside them: those paths are left out of the
        // shape altogether, so the shape goes in already solid (a solid O). Adding a filled
        // copy of the hole on top instead lays one curve exactly on another, which breaks Add.
        let dropped = curves.map(() => false);
        if (filled && !pressure) {
            const holes = holeFlags(paths);
            const polys = paths.map(p => flatten(p, 16));
            const solid = curves.map((curve, ci) =>
                curve.isClosed && holes[ci] && (fillHoles || closesUp(polys[ci], r)));
            dropped = curves.map((_, ci) => solid[ci] ||
                solid.some((s, hi) => s && hi != ci && polys[ci].length > 0 && inside(polys[ci][0], polys[hi])));
        }
        if (filled) {
            if (dropped.some(d => d)) {
                const kept = PolyCurve.create();
                curves.forEach((curve, ci) => { if (!dropped[ci]) kept.addCurve(curve); });
                out.push(kept);
            }
            else
                out.push(poly);
        }
        curves.forEach((curve, ci) => {
            if (pressure) {
                tapered(paths[ci], curve.isClosed, strokeReach, pressure);
                return;
            }
            if (dropped[ci])
                return;
            const closedFill = filled && curve.isClosed && fillSigns[ci] != 0;
            if (r <= 0)
                return;
            const sides = closedFill ? [fillSigns[ci] * r] : [r, -r];
            // A circle rounds each corner. Along smooth runs the bands meet edge to edge and need
            // none, but one every half radius or so is kept as cover. Circles much closer than
            // that overlap at such shallow angles that Add can fail on them (the tight centre of
            // a spiral did).
            let last = null, lastDir = null, lastCircle = null;
            for (const seg of paths[ci]) {
                for (const s of shortPieces(seg, Math.PI / 12, Math.max(r, 1))) {
                    if (len(sub(s[3], s[0])) < EPS && len(sub(s[1], s[0])) < EPS && len(sub(s[2], s[0])) < EPS)
                        continue;
                    const [d0, d2] = endTangents(s);
                    const corner = !lastDir || angleBetween(lastDir, d0) > Math.PI / 180;
                    if (corner || !lastCircle || len(sub(s[0], lastCircle)) >= r / 2) {
                        push(circle(s[0], r));
                        lastCircle = s[0];
                    }
                    last = s[3];
                    lastDir = d2;
                    for (const side of sides) {
                        const e = offsetPiece(s, side);
                        push(e && offsetHolds(s, e) ? band(s, e) : slab(s, side));
                    }
                }
            }
            // A closed path's last node is its first; an open one needs its end capped too.
            if (last && !curve.isClosed)
                push(circle(last, r));
        });
    }
    return out;
}

// The sticker's outline as one PolyCurve in spread coordinates, or null if Add could not join
// the pieces. Add only works on objects in the document, so the pieces are added and joined for
// real, the result is read, and both steps are undone: the document ends as it started.
// Add can fail on one exact offset and work a hair either side of it, so a failed join is tried
// again at offsets a few hundredths of a pixel away, far too little to see.
function stickerOutline(doc, art, target, offset, colour, fillHoles) {
    for (const nudge of [0, 0.01, -0.01, 0.03, -0.03, 0.07]) {
        const outline = joinedOutline(doc, art, target, Math.max(0.01, offset + nudge), colour, fillHoles);
        if (outline)
            return outline;
    }
    return null;
}

// The pieces are never selected, so the Node tool never draws their nodes. They go in behind
// `target` unselected, then Add joins them by an explicit list of those nodes, and the same
// command selects the artwork again so the joined curve isn't selected either. Both steps are
// undone: the document ends as it started.
function joinedOutline(doc, art, target, offset, colour, fillHoles) {
    const { PolyCurve } = require('/geometry.js');
    const { CompoundCommandBuilder, DocumentCommand } = require('/commands.js');
    const { Selection } = require('/selections.js');
    // The same pieces with Fill holes on or off: the holes are filled afterwards, by keeping
    // only the outer edges of the joined result.
    const pieces = stickerPieces(art, offset, false);
    if (pieces.length == 0)
        return null;
    const selected = doc.selection.nodes.toArray();
    const parent = parentOf(doc.spreads.current ?? doc.spreads.first, target);
    if (!parent)
        return null;
    const count = [...parent.children].length;
    // Behind the target means just before it in its container's child list.
    const behind = () => {
        const kids = [...parent.children];
        const at = kids.findIndex(n => n.isSameNode(target));
        return { kids, at };
    };
    doc.executeCommand(addPiecesCommand(pieces, target, colour), false);
    let outline = null;
    let steps = 1;
    const added = behind();
    if (added.kids.length == count + pieces.length && added.at >= pieces.length) {
        const nodes = added.kids.slice(added.at - pieces.length, added.at);
        const compound = CompoundCommandBuilder.create();
        compound.addCommand(DocumentCommand.createBoolOpUnion(Selection.create(doc, nodes)));
        compound.addCommand(DocumentCommand.createSetSelection(Selection.create(doc, selected)));
        doc.executeCommand(compound.createCommand(), false);
        steps = 2;
        // Joined, the pieces are one node, just behind the target.
        const joined = behind();
        const node = joined.kids.length == count + 1 && joined.at >= 1 ? joined.kids[joined.at - 1] : null;
        if (node && node.polyCurve) {
            const curves = node.polyCurve.curves.toArray ? node.polyCurve.curves.toArray() : [...node.polyCurve.curves];
            const keep = fillHoles ? outermost(curves.map(segmentsOf)) : curves.map((_, i) => i);
            outline = PolyCurve.create();
            for (const i of keep)
                outline.addCurve(curves[i]);
            outline.transform(node.baseToSpreadTransform);
        }
    }
    for (let i = 0; i < steps; ++i)
        doc.history.undo();
    return outline;
}

// The command that adds `polys` behind `target` as curve objects in one colour, without
// selecting them.
function addPiecesCommand(polys, target, colour) {
    const { BlendMode } = require('affinity:common');
    const { AddChildNodesCommandBuilder } = require('/commands.js');
    const { InsertionMode } = require('/document.js');
    const { FillDescriptor } = require('/fills.js');
    const { LineStyleDescriptor } = require('/linestyle.js');
    const { PolyCurveNodeDefinition } = require('/nodes.js');

    const fill = FillDescriptor.createSolid(colour, BlendMode.Normal);
    const none = FillDescriptor.createNone();
    const noLine = LineStyleDescriptor.createDefault(0);
    const builder = AddChildNodesCommandBuilder.create();
    builder.setInsertionTarget(target);
    builder.setInsertionMode(InsertionMode.Behind);
    for (const poly of polys)
        builder.addNode(PolyCurveNodeDefinition.create(poly, fill, none, noLine, none));
    return builder.createCommand(false);
}

// The container that holds `node`, searching down from `root`.
function parentOf(root, node) {
    for (const child of root.children ?? []) {
        if (child.isSameNode(node))
            return root;
        const found = parentOf(child, node);
        if (found)
            return found;
    }
    return null;
}

// The selected node lowest in the stacking order, so the sticker goes behind all of the art.
function backmost(spread, selected) {
    let found = null;
    const walk = (node) => {
        for (const child of node.children ?? []) {
            if (found)
                return;
            if (selected.some(s => s.isSameNode(child))) {
                found = child;
                return;
            }
            walk(child);
        }
    };
    walk(spread);
    return found ?? selected[0];
}

function main() {
    const { Dialog, DialogResult } = require('/dialog.js');
    const { Document } = require('/document.js');
    const { RGBA8 } = require('/colours.js');
    const { UnitType } = require('/units.js');

    const doc = Document.current;
    if (!doc) {
        alert("Sticker Outline needs an open document.");
        return;
    }
    const nodes = doc.selection.nodes.toArray();
    if (nodes.length == 0) {
        alert("Select the artwork to put on a sticker.");
        return;
    }
    const art = [];
    for (const node of nodes)
        collectArt(node, art);
    if (art.length == 0) {
        alert("The selection has no shapes, text or strokes to outline (images and adjustments don't count).");
        return;
    }
    const target = backmost(doc.spreads.current ?? doc.spreads.first, nodes);

    let size = 0;
    for (const node of nodes) {
        const box = node.getSpreadBaseBox(false);
        size = Math.max(size, box.width, box.height);
    }

    const dlg = Dialog.create(`Sticker Outline v${VERSION}`);
    const col = dlg.addColumn();
    const shape = col.addGroup("Outline");
    // A default offset of a 25th of the selection's size, rounded to a whole pixel.
    const offset = shape.addUnitValueEditor("Offset", UnitType.Pixel, doc.units, Math.max(1, Math.round(size / 25)), 0)
        .setNoMaxValue();
    const holes = shape.addSwitch("Fill holes", false);
    const look = col.addGroup("Colour");
    const colour = look.addColourPicker("Colour", RGBA8(255, 255, 255, 255));
    dlg.initialWidth = 340;

    const fill = () => colour.value ?? RGBA8(255, 255, 255, 255);
    // The preview is the finished outline itself, joined the same way as on OK (without
    // selecting anything), then shown as one unselected curve without touching the document.
    // If Add can't join the pieces, they show unjoined.
    const preview = () => {
        doc.clearPreviews();
        const outline = stickerOutline(doc, art, target, offset.value, fill(), holes.value);
        const polys = outline ? [outline] : stickerPieces(art, offset.value, holes.value);
        if (polys.length == 0)
            return;
        doc.executeCommand(addPiecesCommand(polys, target, fill()), true);
    };
    dlg.onControlValueChangedHandler = preview;
    preview();
    const result = dlg.runModal();
    doc.clearPreviews();
    if ((result?.value ?? result) != DialogResult.Ok.value)
        return;
    // The finished outline: one curve object, grouped with the artwork at the bottom of the
    // group, in one undo step.
    const outline = stickerOutline(doc, art, target, offset.value, fill(), holes.value);
    if (outline)
        doc.executeCommand(groupedCommand(doc, outline, nodes, fill()), false);
    else
        alert("Affinity could not join the outline's pieces. Try a slightly different offset.");
}

// The command that groups `nodes` and adds `poly` (named NAME, in `colour`) as the bottom of
// the new group, in one undo step. The group stays selected.
function groupedCommand(doc, poly, nodes, colour) {
    const { BlendMode } = require('affinity:common');
    const { AddChildNodesCommandBuilder, CompoundCommandBuilder, DocumentCommand } = require('/commands.js');
    const { InsertionMode } = require('/document.js');
    const { FillDescriptor } = require('/fills.js');
    const { LineStyleDescriptor } = require('/linestyle.js');
    const { PolyCurveNodeDefinition } = require('/nodes.js');
    const { Selection } = require('/selections.js');

    const none = FillDescriptor.createNone();
    const def = PolyCurveNodeDefinition.create(poly, FillDescriptor.createSolid(colour, BlendMode.Normal), none,
        LineStyleDescriptor.createDefault(0), none);
    def.userDescription = NAME;
    // With no target, nodes go into the selected container, which is the new group. Its
    // Inside_AtFront is the front of its child list, which is the bottom of the stack.
    const builder = AddChildNodesCommandBuilder.create();
    builder.setInsertionMode(InsertionMode.Inside_AtFront);
    builder.addNode(def);
    const compound = CompoundCommandBuilder.create();
    compound.addCommand(DocumentCommand.createGroupNodes(Selection.create(doc, nodes)));
    compound.addCommand(builder.createCommand(false));
    return compound.createCommand();
}

main();
