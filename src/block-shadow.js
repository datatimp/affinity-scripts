/*
Block Shadow for Affinity: adds a solid, flat block shadow (a "long shadow") behind each selected
object.

Version 1.6.1
Copyright (C) 2026 datatimp
https://github.com/datatimp/affinity-scripts
SPDX-License-Identifier: AGPL-3.0-or-later

Select one or more objects and run the script. A dialog sets the depth, direction, gap and
colour, with a live preview; OK groups each selected object with one curve object named "Block
shadow" at the bottom of its group, all in one undo step. The objects themselves are not changed.

Works on curves, shapes, artistic and frame text, and groups (a group gets one shadow for all its
contents). The shadow follows the objects' fill outlines: strokes are not included, so expand a
thick stroke first (Layer > Expand Stroke) if it should cast a shadow too.

Gap: an empty band of an even width between the object and its shadow, the same on every edge at
any direction. Its corners follow the object's own: a sharp corner stays sharp (mitered), a
rounded one stays rounded. A very sharp point, like the tip of a thin star, would push its
mitered corner far out, so past four times the gap it's cut off flat instead (bevelled), as
Affinity does with a stroke's miter limit. The gap is empty, not white: whatever is behind shows
through. The gap can't be more than the depth: the dialog pulls a bigger gap back to the depth.

How it works: the shadow is exactly the area the object's outline sweeps as it slides along the
shadow direction (the Minkowski sum of the shape and a line segment). Each Bezier segment of the
outline is split where its tangent runs parallel to the direction, so every piece sweeps a simple
band: the segment, a straight edge, the segment moved, and a straight edge back. The object plus
all its bands, joined with Add (boolean union), is the shadow. No stacked copies, no
approximation: the result is one clean vector shape.

For a gap, the object is grown outward by the gap: a band from each short piece of its outline
out to the offset curve, on the side away from its fill, plus a mitered wedge at each outward
corner, all joined with Add. That grown shape is cut out of the shadow with Subtract. Add and
Subtract only work on objects in the document, so each step is done for real, its result read,
and the step undone; the document ends as it started.

Written against Affinity's scripting API (beta, Affinity 3.3).
*/

'use strict';

// BLOCK-SHADOW-MATH-BEGIN (plain JavaScript, no Affinity APIs)

// Points are {x, y}; a cubic Bezier segment is an array of four points [start, c1, c2, end].

const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const addVec = (p, v) => ({ x: p.x + v.x, y: p.y + v.y });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const len = (v) => Math.hypot(v.x, v.y);
const dot = (a, b) => a.x * b.x + a.y * b.y;
const EPS = 1e-7;

// Splits a segment at t (de Casteljau) into [left, right].
function splitSegment(s, t) {
    const a = lerp(s[0], s[1], t), b = lerp(s[1], s[2], t), c = lerp(s[2], s[3], t);
    const d = lerp(a, b, t), e = lerp(b, c, t), f = lerp(d, e, t);
    return [[s[0], a, d, f], [f, e, c, s[3]]];
}

// The t values in (0, 1), ascending, where the segment's tangent is parallel to v: the roots of
// cross(B'(t), v), a quadratic in t.
function parallelTangents(s, v) {
    const cross = (p, q) => (q.x - p.x) * v.y - (q.y - p.y) * v.x;
    const a = cross(s[0], s[1]), b = cross(s[1], s[2]), c = cross(s[2], s[3]);
    const A = a - 2 * b + c, B = 2 * (b - a), C = a;
    const roots = [];
    const scale = Math.max(Math.abs(A), Math.abs(B), Math.abs(C));
    if (scale == 0)
        return roots;
    if (Math.abs(A) < 1e-9 * scale) {
        if (Math.abs(B) > 1e-9 * scale)
            roots.push(-C / B);
    }
    else {
        const disc = B * B - 4 * A * C;
        if (disc >= 0) {
            const r = Math.sqrt(disc);
            roots.push((-B - r) / (2 * A), (-B + r) / (2 * A));
        }
    }
    return roots.filter(t => t > 1e-6 && t < 1 - 1e-6).sort((x, y) => x - y);
}

// The segment cut into pieces whose tangent never turns past the direction v, so that each piece
// sweeps a band that does not cross itself.
function sweepablePieces(s, v) {
    const pieces = [];
    let rest = s, done = 0;
    for (const t of parallelTangents(s, v)) {
        const [left, right] = splitSegment(rest, (t - done) / (1 - done));
        pieces.push(left);
        rest = right;
        done = t;
    }
    pieces.push(rest);
    return pieces;
}

// The shadow's offset vector for a depth and a direction in degrees (0 = right, 90 = up, as in a
// protractor; the document's y axis points down).
function shadowVector(depth, angleDeg) {
    const rad = angleDeg * Math.PI / 180;
    return { x: depth * Math.cos(rad), y: -depth * Math.sin(rad) };
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
    for (let i = 1; i < ds.length; ++i)
        total += angleBetween(ds[i - 1], ds[i]);
    return total;
}

const angleBetween = (a, b) => Math.abs(Math.atan2(a.x * b.y - a.y * b.x, dot(a, b)));

// The segment cut in halves until each piece turns by at most `maxTurn` radians and is no longer
// than `maxLength` (both keep the offset curve of each piece accurate).
function shortPieces(s, maxTurn, maxLength, depth = 0) {
    const chord = len(sub(s[3], s[0])) + len(sub(s[1], s[0])) + len(sub(s[2], s[3]));
    if (depth >= 8 || (turning(s) <= maxTurn && chord <= maxLength))
        return [s];
    const [l, r] = splitSegment(s, 0.5);
    return shortPieces(l, maxTurn, maxLength, depth + 1)
        .concat(shortPieces(r, maxTurn, maxLength, depth + 1));
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

// True when the offset of a piece runs the same way as the piece. On the inside of a bend
// tighter than the offset, the offset curve folds back on itself, and a band built from it would
// cross itself (which makes Add fail for the whole selection). On a bend only a little looser
// than the offset, the middle leg of the offset's control polygon can turn back while both end
// legs still run the right way; that band has a tiny loop and breaks Add too, so all three legs
// are checked.
function offsetHolds(s, e) {
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

// For each path of a filled shape (each given as its segments), +1 or -1: the sign of the offset
// that moves its edge away from the fill. A path enclosed by an odd number of the others is a
// hole, whose outside is its own inside.
function outwardSigns(paths) {
    const polys = paths.map(p => flatten(p, 32));
    return paths.map((segments, i) => {
        if (polys[i].length < 3)
            return 0;
        const enclosing = polys.filter((other, j) =>
            j != i && other.length > 2 && inside(polys[i][0], other)).length;
        const hole = enclosing % 2 == 1;
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

// How far a mitered gap corner may reach from its corner, in gaps, before it's bevelled.
const MITER_LIMIT = 4;

// The corner patch where a path turns at `node` from direction dIn to dOut, for a gap of r
// (signed as in offsetPiece) whose outward side follows normalOf(d) * sign(r): a mitered wedge
// out to where the two offset edges meet, or a bevel past the miter limit. Null where the path
// turns inward or hardly turns at all (there the bands already meet or overlap). Returns an
// array of points, a closed polygon.
function cornerPatch(node, dIn, dOut, r) {
    if (angleBetween(dIn, dOut) < Math.PI / 180)
        return null;
    const outwardIn = along({ x: 0, y: 0 }, normalOf(dIn), Math.sign(r));
    if (dot(dOut, outwardIn) >= 0)
        return null;
    const p1 = along(node, normalOf(dIn), r), p2 = along(node, normalOf(dOut), r);
    const m = meet(p1, dIn, p2, dOut);
    if (m && len(sub(m, node)) <= MITER_LIMIT * Math.abs(r))
        return [node, p1, m, p2];
    return [node, p1, p2];
}

// BLOCK-SHADOW-MATH-END

const NAME = "Block shadow";
const WORKING = "Block shadow (working)";

// Every closed outline of the node in spread coordinates, as PolyCurves. Containers (groups)
// contribute their children's outlines. Hidden objects don't show, so they cast no shadow and
// don't push the gap out (a hidden old shadow in a group once did).
function collectOutlines(node, out) {
    if (node.isVisible === false)
        return out;
    const ci = node.curvesInterface;
    if (ci) {
        const ppc = ci.polyPolyCurves;
        const toSpread = node.baseToSpreadTransform;
        for (let i = 0; i < ppc.polyCurveCount; ++i) {
            const poly = ppc.getTransformedPolyCurve(i);
            poly.transform(toSpread);
            if (poly.curveCount > 0)
                out.push(poly);
        }
        return out;
    }
    if (node.children)
        for (const child of node.children)
            collectOutlines(child, out);
    return out;
}

// The group a Block Shadow run made, if `node` is one or sits directly in one: {group, old}, where
// old holds the group's existing Block shadow curves. Running the script again on such a group
// (or on its object, or its old shadow) replaces the shadow inside it instead of wrapping the
// group in yet another group. Null otherwise.
function shadowGroupOf(node) {
    const oldShadows = (group) => [...(group.children ?? [])].filter(c => c.description == NAME);
    // Only a group counts: a layer can hold a shadow too, once its group is ungrouped.
    if (node.isGroupNode === true && oldShadows(node).length)
        return { group: node, old: oldShadows(node) };
    const parent = node.parent;
    if (parent?.isGroupNode === true && oldShadows(parent).length)
        return { group: parent, old: oldShadows(parent) };
    return null;
}

// The source for one selected node: {node, outlines, old}. A node already in a Block Shadow group
// becomes that whole group, its art being everything in it except the old shadow (`old`).
function sourceFor(node) {
    const sg = shadowGroupOf(node);
    if (!sg)
        return { node, outlines: collectOutlines(node, []), old: [] };
    const outlines = [];
    for (const child of sg.group.children)
        if (!sg.old.some(o => o.isSameNode(child)))
            collectOutlines(child, outlines);
    return { node: sg.group, outlines, old: sg.old };
}

// A curve's segments as [start, c1, c2, end] arrays. A fill closes an open curve with a straight
// line, so an open curve gets that closing segment too.
function closedSegments(curve) {
    const segs = curve.beziers.toArray().map(b => [b.start, b.c1, b.c2, b.end]);
    if (segs.length && !curve.isClosed) {
        const a = segs[segs.length - 1][3], b = segs[0][0];
        if (len(sub(a, b)) > EPS)
            segs.push([a, lerp(a, b, 1 / 3), lerp(a, b, 2 / 3), b]);
    }
    return segs;
}

// The pieces whose union is the shadow of `outlines` moved by v: the outlines themselves and one
// band per sweepable piece of every segment.
function shadowPieces(outlines, v) {
    const { CurveBuilder, PolyCurve } = require('/geometry.js');
    const pieces = [];
    for (const poly of outlines) {
        pieces.push(poly);
        for (const curve of poly.curves) {
            for (const bz of curve.beziers.toArray()) {
                for (const s of sweepablePieces([bz.start, bz.c1, bz.c2, bz.end], v)) {
                    const e = s.map(p => addVec(p, v));
                    const band = CurveBuilder.create().beginXY(s[0].x, s[0].y)
                        .addBezierXY(s[1].x, s[1].y, s[2].x, s[2].y, s[3].x, s[3].y)
                        .lineToXY(e[3].x, e[3].y)
                        .addBezierXY(e[2].x, e[2].y, e[1].x, e[1].y, e[0].x, e[0].y)
                        .close().createCurve();
                    const p = PolyCurve.create();
                    p.addCurve(band);
                    pieces.push(p);
                }
            }
        }
    }
    return pieces;
}

// The pieces whose union is `outlines` grown outward by `gap` with mitered corners: the outlines
// themselves, a band from each short piece of every path out to its offset on the side away from
// the fill, and a corner patch wherever a path turns outward. Where a band would fold over
// itself, a rectangle along the piece's chord stands in for it.
function grownPieces(outlines, gap) {
    const { CurveBuilder, PolyCurve } = require('/geometry.js');
    const out = [];
    const single = (curve) => { const p = PolyCurve.create(); p.addCurve(curve); return p; };
    const polygon = (pts) => {
        const b = CurveBuilder.create().beginXY(pts[0].x, pts[0].y);
        for (const p of pts.slice(1))
            b.lineToXY(p.x, p.y);
        return single(b.close().createCurve());
    };
    const band = (s, e) => single(CurveBuilder.create().beginXY(s[0].x, s[0].y)
        .addBezierXY(s[1].x, s[1].y, s[2].x, s[2].y, s[3].x, s[3].y)
        .lineToXY(e[3].x, e[3].y)
        .addBezierXY(e[2].x, e[2].y, e[1].x, e[1].y, e[0].x, e[0].y)
        .close().createCurve());
    const slab = (s, side) => {
        const chord = sub(s[3], s[0]);
        if (len(chord) < EPS)
            return null;
        const n = normalOf(chord);
        return polygon([s[0], s[3], along(s[3], n, side), along(s[0], n, side)]);
    };
    for (const poly of outlines) {
        out.push(poly);
        const curves = poly.curves.toArray ? poly.curves.toArray() : [...poly.curves];
        const paths = curves.map(closedSegments);
        const signs = outwardSigns(paths);
        paths.forEach((segs, ci) => {
            if (signs[ci] == 0)
                return;
            const r = signs[ci] * gap;
            const pieces = [];
            for (const seg of segs)
                for (const s of shortPieces(seg, Math.PI / 12, Math.max(gap, 1)))
                    if (endTangents(s)[0])
                        pieces.push(s);
            pieces.forEach((s, i) => {
                const e = offsetPiece(s, r);
                const piece = e && offsetHolds(s, e) ? band(s, e) : slab(s, r);
                if (piece)
                    out.push(piece);
                // The join where the previous piece (the path is closed) meets this one.
                const prev = pieces[(i + pieces.length - 1) % pieces.length];
                const patch = cornerPatch(s[0], endTangents(prev)[1], endTangents(s)[0], r);
                if (patch)
                    out.push(polygon(patch));
            });
        });
    }
    return out;
}

// One command that adds a shadow behind each source ({node, outlines}): its pieces are added
// selected behind the object, joined with Add and named. Null when there is nothing to draw.
function shadowCommand(sources, settings) {
    const { BlendMode } = require('affinity:common');
    const { AddChildNodesCommandBuilder, CompoundCommandBuilder, DocumentCommand } = require('/commands.js');
    const { InsertionMode } = require('/document.js');
    const { FillDescriptor } = require('/fills.js');
    const { LineStyleDescriptor } = require('/linestyle.js');
    const { PolyCurveNodeDefinition } = require('/nodes.js');

    const v = shadowVector(settings.depth, settings.angle);
    if (Math.hypot(v.x, v.y) < 1e-6)
        return null;
    const fill = FillDescriptor.createSolid(settings.colour, BlendMode.Normal);
    const none = FillDescriptor.createNone();
    const noLine = LineStyleDescriptor.createDefault(0);
    const compound = CompoundCommandBuilder.create();
    let count = 0;
    for (const { node, outlines } of sources) {
        if (outlines.length == 0)
            continue;
        const builder = AddChildNodesCommandBuilder.create();
        builder.setInsertionTarget(node);
        builder.setInsertionMode(InsertionMode.Behind);
        // The pieces are in spread coordinates. A definition's transform is its placement on
        // the spread even when it lands inside a rotated group, so none is set.
        for (const poly of shadowPieces(outlines, v))
            builder.addNode(PolyCurveNodeDefinition.create(poly, fill, none, noLine, none));
        compound.addCommand(builder.createCommand(true));
        compound.addCommand(DocumentCommand.createBoolOpUnion(null));
        compound.addCommand(DocumentCommand.createSetDescription(null, NAME));
        ++count;
    }
    return count ? compound.createCommand() : null;
}

function main() {
    const { Dialog, DialogResult } = require('/dialog.js');
    const { Document } = require('/document.js');
    const { RGBA8 } = require('/colours.js');
    const { UnitType } = require('/units.js');

    const doc = Document.current;
    if (!doc) {
        alert("Block Shadow needs an open document.");
        return;
    }
    const nodes = doc.selection.nodes.toArray();
    if (nodes.length == 0) {
        alert("Select one or more objects to give a block shadow.");
        return;
    }
    // Two selected things in the same Block Shadow group (say the object and its old shadow) are
    // one source.
    const sources = [];
    for (const node of nodes) {
        const source = sourceFor(node);
        if (!sources.some(s => s.node.isSameNode(source.node)))
            sources.push(source);
    }
    if (sources.every(s => s.outlines.length == 0)) {
        alert("The selection has no outlines to cast a shadow (images and adjustments don't).");
        return;
    }

    // A default depth of a tenth of the selection's size, rounded to a whole pixel.
    let size = 0;
    for (const node of nodes) {
        const box = node.getSpreadBaseBox(false);
        size = Math.max(size, box.width, box.height);
    }

    const dlg = Dialog.create("Block Shadow");
    const col = dlg.addColumn();
    const shape = col.addGroup("Shadow");
    const depth = shape.addUnitValueEditor("Depth", UnitType.Pixel, doc.units,
        Math.max(1, Math.round(size / 10)), 0).setNoMaxValue();
    const angle = shape.addUnitValueEditor("Direction (°)", UnitType.Number, UnitType.Number, -45, -180, 180)
        .setPrecision(1).setShowPopupSlider(true);
    const gap = shape.addUnitValueEditor("Gap", UnitType.Pixel, doc.units, 0, 0).setNoMaxValue();
    const look = col.addGroup("Colour");
    const colour = look.addColourPicker("Colour", RGBA8(0, 0, 0, 255));
    dlg.initialWidth = 340;

    const settings = () => ({
        depth: depth.value, angle: angle.value, gap: gap.value,
        colour: colour.value ?? RGBA8(0, 0, 0, 255),
    });
    // Without a gap, the preview is the joined pieces behind each object, shown without touching
    // the document. With one, the finished shadows are worked out (each step undone) and shown.
    // The old preview is cleared first: without that, the first preview vanishes when the dialog
    // opens and nothing shows until a value changes.
    const preview = () => {
        // A gap as deep as the shadow leaves nothing of it, so the gap can't pass the depth: a
        // bigger gap is pulled back, and lowering the depth pulls the gap down with it.
        if (gap.value > depth.value)
            gap.value = depth.value;
        doc.clearPreviews();
        const s = settings();
        const cmd = s.gap > 0 ? finishedPreviewCommand(finishedShadows(doc, sources, s), s.colour)
            : shadowCommand(sources, s);
        // An old shadow being replaced is left out of the preview, as it will be on OK.
        if (cmd)
            doc.executeCommand(withoutOldShadows(doc, sources, cmd), true);
    };
    dlg.onControlValueChangedHandler = preview;
    preview();
    const result = dlg.runModal();
    doc.clearPreviews();
    if ((result?.value ?? result) != DialogResult.Ok.value)
        return;
    const s = settings();
    const shadows = finishedShadows(doc, sources, s);
    if (shadows.length == 0) {
        alert(s.gap > 0 ? "No shadow is left: the gap takes up the whole shadow, or Affinity " +
            "couldn't cut the gap. Try a smaller or slightly different gap."
            : "A depth of zero casts no shadow.");
        return;
    }
    doc.executeCommand(groupedCommand(doc, shadows, s.colour, sources), false);
}

// `cmd` followed by deleting every old shadow the sources replace, as one command. Just `cmd` when
// nothing is being replaced.
function withoutOldShadows(doc, sources, cmd) {
    const { CompoundCommandBuilder, DocumentCommand } = require('/commands.js');
    const { Selection } = require('/selections.js');
    const old = sources.flatMap(s => s.old);
    if (old.length == 0)
        return cmd;
    const compound = CompoundCommandBuilder.create();
    compound.addCommand(cmd);
    compound.addCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, old), false));
    return compound.createCommand();
}

// Adds each item's polys ({node, polys}) behind its node, joins them with Add or Subtract (the
// first poly is kept and the rest cut from it), reads each result, and undoes the step: the
// document ends as it started. Returns [{node, poly}] for the items whose operation gave exactly
// one non-empty shape.
function joinedOutlines(doc, items, subtract) {
    const { BlendMode } = require('affinity:common');
    const { AddChildNodesCommandBuilder, CompoundCommandBuilder, DocumentCommand } = require('/commands.js');
    const { InsertionMode } = require('/document.js');
    const { FillDescriptor } = require('/fills.js');
    const { LineStyleDescriptor } = require('/linestyle.js');
    const { PolyCurveNodeDefinition } = require('/nodes.js');
    const { RGBA8 } = require('/colours.js');

    const live = items.filter(item => item.polys.length > 0);
    if (live.length == 0)
        return [];
    const fill = FillDescriptor.createSolid(RGBA8(0, 0, 0, 255), BlendMode.Normal);
    const none = FillDescriptor.createNone();
    const noLine = LineStyleDescriptor.createDefault(0);
    const compound = CompoundCommandBuilder.create();
    for (const { node, polys } of live) {
        // Each poly is inserted directly behind the object, so each one added lands below the
        // ones before it. Adding them in reverse puts the first poly at the bottom, the one
        // Subtract keeps.
        const builder = AddChildNodesCommandBuilder.create();
        builder.setInsertionTarget(node);
        builder.setInsertionMode(InsertionMode.Behind);
        for (const poly of [...polys].reverse())
            builder.addNode(PolyCurveNodeDefinition.create(poly, fill, none, noLine, none));
        compound.addCommand(builder.createCommand(true));
        compound.addCommand(subtract ? DocumentCommand.createBoolOpSubtract(null)
            : DocumentCommand.createBoolOpUnion(null));
        compound.addCommand(DocumentCommand.createSetDescription(null, WORKING));
    }
    doc.executeCommand(compound.createCommand(), false);
    const out = [];
    for (const { node } of live) {
        // The result sits directly behind its object. If the operation failed, several pieces
        // are left there, all named WORKING, and the item is dropped.
        const siblings = node.parent ? [...node.parent.children] : [];
        const i = siblings.findIndex(n => n.isSameNode(node));
        let count = 0;
        for (let j = i - 1; j >= 0 && siblings[j].description == WORKING; --j)
            ++count;
        const result = i > 0 ? siblings[i - 1] : null;
        if (count == 1 && result.polyCurve && result.polyCurve.curveCount > 0) {
            const poly = result.polyCurve.clone();
            poly.transform(result.baseToSpreadTransform);
            out.push({ node, poly });
        }
    }
    doc.history.undo();
    return out;
}

// The finished shadow of each source as one PolyCurve in spread coordinates: [{node, poly}]. With
// a gap, each object grown by the gap is cut out of its shadow.
function finishedShadows(doc, sources, settings) {
    const cmd = shadowCommand(sources, settings);
    if (!cmd)
        return [];
    const shadows = shadowOutlines(doc, sources, cmd);
    if (!(settings.gap > 0) || shadows.length == 0)
        return shadows;
    const outlinesOf = (node) => sources.find(s => s.node.isSameNode(node)).outlines;
    const grown = joinedOutlines(doc,
        shadows.map(({ node }) => ({ node, polys: grownPieces(outlinesOf(node), settings.gap) })), false);
    const cuts = [];
    for (const { node, poly } of shadows) {
        const g = grown.find(item => item.node.isSameNode(node));
        if (g)
            cuts.push({ node, polys: [poly, g.poly] });
    }
    return joinedOutlines(doc, cuts, true);
}

// The joined shadow of each source as one PolyCurve in spread coordinates: [{node, poly}]. Add
// only works on objects in the document, so `cmd` (from shadowCommand) adds and joins the pieces
// for real, each result is read, and the step is undone: the document ends as it started.
function shadowOutlines(doc, sources, cmd) {
    doc.executeCommand(cmd, false);
    const out = [];
    for (const { node } of sources) {
        // Each shadow was added directly behind its object, so it is the sibling before it.
        const siblings = node.parent ? [...node.parent.children] : [];
        const i = siblings.findIndex(n => n.isSameNode(node));
        const shadow = i > 0 ? siblings[i - 1] : null;
        if (shadow && shadow.description == NAME && shadow.polyCurve) {
            const poly = shadow.polyCurve.clone();
            poly.transform(shadow.baseToSpreadTransform);
            out.push({ node, poly });
        }
    }
    doc.history.undo();
    return out;
}

// A preview of finished shadows: each added behind its object in `colour`.
function finishedPreviewCommand(shadows, colour) {
    const { BlendMode } = require('affinity:common');
    const { AddChildNodesCommandBuilder, CompoundCommandBuilder } = require('/commands.js');
    const { InsertionMode } = require('/document.js');
    const { FillDescriptor } = require('/fills.js');
    const { LineStyleDescriptor } = require('/linestyle.js');
    const { PolyCurveNodeDefinition } = require('/nodes.js');

    if (shadows.length == 0)
        return null;
    const fill = FillDescriptor.createSolid(colour, BlendMode.Normal);
    const none = FillDescriptor.createNone();
    const noLine = LineStyleDescriptor.createDefault(0);
    const compound = CompoundCommandBuilder.create();
    for (const { node, poly } of shadows) {
        const builder = AddChildNodesCommandBuilder.create();
        builder.setInsertionTarget(node);
        builder.setInsertionMode(InsertionMode.Behind);
        builder.addNode(PolyCurveNodeDefinition.create(poly, fill, none, noLine, none));
        compound.addCommand(builder.createCommand(false));
    }
    return compound.createCommand();
}

// The command that groups each object with its shadow, the shadow (named NAME, in `colour`) at
// the bottom of the group, all in one undo step. A source that is already a Block Shadow group
// keeps its group: its old shadow is deleted and the new one goes in at the bottom.
function groupedCommand(doc, shadows, colour, sources) {
    const { BlendMode } = require('affinity:common');
    const { AddChildNodesCommandBuilder, CompoundCommandBuilder, DocumentCommand } = require('/commands.js');
    const { InsertionMode } = require('/document.js');
    const { FillDescriptor } = require('/fills.js');
    const { LineStyleDescriptor } = require('/linestyle.js');
    const { PolyCurveNodeDefinition } = require('/nodes.js');
    const { Selection } = require('/selections.js');

    const fill = FillDescriptor.createSolid(colour, BlendMode.Normal);
    const none = FillDescriptor.createNone();
    const noLine = LineStyleDescriptor.createDefault(0);
    const compound = CompoundCommandBuilder.create();
    for (const { node, poly } of shadows) {
        const def = PolyCurveNodeDefinition.create(poly, fill, none, noLine, none);
        def.userDescription = NAME;
        // Inside_AtFront is the front of a group's child list, which is the bottom of the stack.
        const builder = AddChildNodesCommandBuilder.create();
        builder.setInsertionMode(InsertionMode.Inside_AtFront);
        builder.addNode(def);
        const old = sources.find(s => s.node.isSameNode(node))?.old ?? [];
        if (old.length) {
            compound.addCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, old), false));
            builder.setInsertionTarget(node);
        }
        else {
            // With no target, the shadow goes into the selected container: the new group.
            compound.addCommand(DocumentCommand.createGroupNodes(Selection.create(doc, [node])));
        }
        compound.addCommand(builder.createCommand(false));
    }
    return compound.createCommand();
}

main();
