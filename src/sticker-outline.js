/*
Sticker Outline for Affinity: draws one solid sticker (die-cut) shape behind the selection, grown
outward from the artwork by a set distance.

Version 1.1
Copyright (C) 2026 datatimp
https://github.com/datatimp/affinity-scripts
SPDX-License-Identifier: AGPL-3.0-or-later

Select the artwork (any number of objects or groups) and run the script. A dialog sets the
offset, the colour and whether holes are filled, with a live preview (holes show in the preview
and are filled on OK); OK groups the artwork with one curve object named "Sticker outline" at
the bottom of the group, in one undo step. The artwork itself is not changed.

What counts as artwork: every filled shape, curve and text, and every visible stroke at its full
width (centre, inside and outside alignment are all honoured). Open lines with only a stroke
count as the stroke. Images and adjustments are skipped.

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
// cross itself (which makes Add fail for the whole selection).
function offsetHolds(s, e) {
    const dot = (a, b) => a.x * b.x + a.y * b.y;
    if (dot(sub(e[3], e[0]), sub(s[3], s[0])) <= 0)
        return false;
    if (len(sub(s[1], s[0])) > EPS && dot(sub(e[1], e[0]), sub(s[1], s[0])) < 0)
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
        for (let i = 0; i < ppc.polyCurveCount; ++i) {
            const poly = ppc.getTransformedPolyCurve(i);
            poly.transform(toSpread);
            if (poly.curveCount > 0 && (filled || strokeReach > 0))
                out.push({ poly, filled, strokeReach });
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
function stickerPieces(art, offset) {
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
    for (const { poly, filled, strokeReach } of art) {
        if (filled)
            out.push(poly);
        const curves = poly.curves.toArray ? poly.curves.toArray() : [...poly.curves];
        const paths = curves.map(segmentsOf);
        const fillSigns = filled ? outwardSigns(paths) : null;
        // Each path reaches the offset past its edge, plus however far its stroke reaches.
        const r = offset + strokeReach;
        curves.forEach((curve, ci) => {
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

// The command that adds `polys` behind `target` as selected curve objects in one colour,
// optionally joined with Add and named.
function addBehindCommand(polys, target, colour, join) {
    const { BlendMode } = require('affinity:common');
    const { AddChildNodesCommandBuilder, CompoundCommandBuilder, DocumentCommand } = require('/commands.js');
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
    const compound = CompoundCommandBuilder.create();
    compound.addCommand(builder.createCommand(true));
    if (join)
        compound.addCommand(DocumentCommand.createBoolOpUnion(null));
    compound.addCommand(DocumentCommand.createSetDescription(null, NAME));
    return compound.createCommand();
}

// The sticker's outline as one PolyCurve in spread coordinates, or null if Add could not join
// the pieces. Add only works on objects in the document, so the pieces are added and joined for
// real, the result is read, and both steps are undone: the document ends as it started.
function stickerOutline(doc, art, target, offset, colour, fillHoles) {
    const { PolyCurve } = require('/geometry.js');
    const pieces = stickerPieces(art, offset);
    if (pieces.length == 0)
        return null;
    doc.executeCommand(addBehindCommand(pieces, target, colour, true), false);
    const joined = doc.selection.nodes.toArray();
    let outline = null;
    if (joined.length == 1 && joined[0].polyCurve) {
        const node = joined[0];
        const curves = node.polyCurve.curves.toArray ? node.polyCurve.curves.toArray() : [...node.polyCurve.curves];
        const keep = fillHoles ? outermost(curves.map(segmentsOf)) : curves.map((_, i) => i);
        outline = PolyCurve.create();
        for (const i of keep)
            outline.addCurve(curves[i]);
        outline.transform(node.baseToSpreadTransform);
    }
    doc.history.undo();
    return outline;
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

    const dlg = Dialog.create("Sticker Outline");
    const col = dlg.addColumn();
    const shape = col.addGroup("Outline");
    const offset = shape.addUnitValueEditor("Offset", UnitType.Pixel, doc.units, Math.max(1, size / 25), 0)
        .setNoMaxValue();
    const holes = shape.addSwitch("Fill holes", true);
    const look = col.addGroup("Colour");
    const colour = look.addColourPicker("Colour", RGBA8(255, 255, 255, 255));
    dlg.initialWidth = 340;

    const fill = () => colour.value ?? RGBA8(255, 255, 255, 255);
    // The preview is the joined pieces, shown without touching the document (holes are filled
    // only on OK).
    const preview = () => {
        const pieces = stickerPieces(art, offset.value);
        if (pieces.length)
            doc.executeCommand(addBehindCommand(pieces, target, fill(), true), true);
        else
            doc.clearPreviews();
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
// the new group. The group stays selected.
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
