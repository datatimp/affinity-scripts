/*
Block Shadow for Affinity: adds a solid, flat block shadow (a "long shadow") behind each selected
object.

Version 1.0
Copyright (C) 2026 datatimp
https://github.com/datatimp/affinity-scripts
SPDX-License-Identifier: AGPL-3.0-or-later

Select one or more objects and run the script. A dialog sets the depth, direction and colour, with
a live preview; OK groups each selected object with one curve object named "Block shadow" at the
bottom of its group, all in one undo step. The objects themselves are not changed.

Works on curves, shapes, artistic and frame text, and groups (a group gets one shadow for all its
contents). The shadow follows the objects' fill outlines: strokes are not included, so expand a
thick stroke first (Layer > Expand Stroke) if it should cast a shadow too.

How it works: the shadow is exactly the area the object's outline sweeps as it slides along the
shadow direction (the Minkowski sum of the shape and a line segment). Each Bezier segment of the
outline is split where its tangent runs parallel to the direction, so every piece sweeps a simple
band: the segment, a straight edge, the segment moved, and a straight edge back. The object plus
all its bands, joined with Add (boolean union), is the shadow. No stacked copies, no
approximation: the result is one clean vector shape.

Written against Affinity's scripting API (beta, Affinity 3.3).
*/

'use strict';

// BLOCK-SHADOW-MATH-BEGIN (plain JavaScript, no Affinity APIs)

// Points are {x, y}; a cubic Bezier segment is an array of four points [start, c1, c2, end].

const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const addVec = (p, v) => ({ x: p.x + v.x, y: p.y + v.y });

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

// BLOCK-SHADOW-MATH-END

const NAME = "Block shadow";

// Every closed outline of the node in spread coordinates, as PolyCurves. Containers (groups)
// contribute their children's outlines.
function collectOutlines(node, out) {
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
    const sources = nodes.map(node => ({ node, outlines: collectOutlines(node, []) }));
    if (sources.every(s => s.outlines.length == 0)) {
        alert("The selection has no outlines to cast a shadow (images and adjustments don't).");
        return;
    }

    // A default depth of a tenth of the selection's size.
    let size = 0;
    for (const node of nodes) {
        const box = node.getSpreadBaseBox(false);
        size = Math.max(size, box.width, box.height);
    }

    const dlg = Dialog.create("Block Shadow");
    const col = dlg.addColumn();
    const shape = col.addGroup("Shadow");
    const depth = shape.addUnitValueEditor("Depth", UnitType.Pixel, doc.units, Math.max(1, size / 10), 0)
        .setNoMaxValue();
    const angle = shape.addUnitValueEditor("Direction (°)", UnitType.Number, UnitType.Number, -45, -180, 180)
        .setPrecision(1).setShowPopupSlider(true);
    const look = col.addGroup("Colour");
    const colour = look.addColourPicker("Colour", RGBA8(0, 0, 0, 255));
    dlg.initialWidth = 340;

    const settings = () => ({ depth: depth.value, angle: angle.value, colour: colour.value ?? RGBA8(0, 0, 0, 255) });
    // The preview is the joined pieces behind each object, shown without touching the document.
    const preview = () => {
        const cmd = shadowCommand(sources, settings());
        if (cmd)
            doc.executeCommand(cmd, true);
        else
            doc.clearPreviews();
    };
    dlg.onControlValueChangedHandler = preview;
    preview();
    const result = dlg.runModal();
    doc.clearPreviews();
    if ((result?.value ?? result) != DialogResult.Ok.value)
        return;
    const s = settings();
    const shadows = shadowOutlines(doc, sources, s);
    if (shadows.length == 0) {
        alert("A depth of zero casts no shadow.");
        return;
    }
    doc.executeCommand(groupedCommand(doc, shadows, s.colour), false);
}

// The finished shadow of each source as one PolyCurve in spread coordinates: [{node, poly}].
// Add only works on objects in the document, so the pieces are added and joined for real, each
// result is read, and the step is undone: the document ends as it started.
function shadowOutlines(doc, sources, settings) {
    const cmd = shadowCommand(sources, settings);
    if (!cmd)
        return [];
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

// The command that groups each object with its shadow, the shadow (named NAME, in `colour`) at
// the bottom of the group, all in one undo step.
function groupedCommand(doc, shadows, colour) {
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
        // With no target, nodes go into the selected container, which is the new group. Its
        // Inside_AtFront is the front of its child list, which is the bottom of the stack.
        const builder = AddChildNodesCommandBuilder.create();
        builder.setInsertionMode(InsertionMode.Inside_AtFront);
        builder.addNode(def);
        compound.addCommand(DocumentCommand.createGroupNodes(Selection.create(doc, [node])));
        compound.addCommand(builder.createCommand(false));
    }
    return compound.createCommand();
}

main();
