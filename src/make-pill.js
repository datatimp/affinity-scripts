/*
Make Pill for Affinity: makes a pill (a rounded shape with a line of text on it) with set
padding around the text, like padding in web and UI design, and refits existing pills.

Version 1.0
Copyright (C) 2026 datatimp
https://github.com/datatimp/affinity-scripts
SPDX-License-Identifier: AGPL-3.0-or-later

The script does one of two things, depending on what's selected when you run it.

Make a pill (no pill selected): a dialog asks for the text and the left, right, top and bottom
padding in pixels, with a live preview; OK adds a group named "Pill" holding a fully rounded
rectangle with a 2 px black stroke and no fill, and the text, centred, as artistic text on top,
in one undo step. The rectangle is an ordinary shape, so its corners, fill and stroke stay
editable.
If a piece of text is selected, the new pill copies its font and size and is placed just below
it; otherwise it uses Affinity's default text style and lands in the middle of the spread.

Refit pills (one or more pills selected): the same dialog without the text box; OK resizes every
selected pill's shape around its text, in one undo step. The text never moves. Run it after
changing a pill's words, font or size, since Affinity doesn't keep the shape fitted. A pill is a
group holding one shape and one piece of text, artistic or frame; a shape and a text selected
on their own, ungrouped, count as one pill too.

How the pill is fitted:
- Width: the letters themselves plus the left and right padding, from the left edge of the
  first letter to the right edge of the last, so every pill gets the same visible gap whatever
  its text.
- Height: the font's cap height plus the top and bottom padding. It's the font that's measured,
  not the word, so every pill with the same font and size comes out the same height.
- Up and down: the shape is centred on the letters, descenders included, the way Affinity's
  Align Vertical Centre centres text. For a word in capitals, the top and bottom padding land
  exactly above the capitals and below the baseline; a word with descenders (g, p, y) rises a
  little so it's centred as a whole. Uneven top and bottom padding move the shape by half the
  difference.
The padding runs to the shape's path; a stroke sits half inside and half outside that.

How it works: the text's letter outlines give its edges. Affinity's scripting API doesn't report
a font's cap height, so the script measures it: it adds two probe texts in the pill text's own
font and size, an "H" and a copy of the text, both with their baseline at a known height, reads
their outlines, and undoes the step. The "H" gives the cap height; the copy, compared with the
real text, gives the scale if the text object has been scaled. A refit then moves and scales the
shape onto its new box. Affinity redraws a shape from its settings after scaling, so a pill's
round ends stay round and corner radii aren't stretched.

Limits: one line of text per pill. Pills that are rotated or skewed are skipped. Text typed into
a shape itself is skipped too, since Affinity places that text and the script can't centre it;
select it and run the script to make a new pill in the same font instead.

Written against Affinity's scripting API (beta, Affinity 3.3).
*/

'use strict';

// The script version, shown in its dialog title. Keep it the same as the Version line at the top
// and the script name in Affinity.
const VERSION = "1.0";

// PILL-MATH-BEGIN (plain JavaScript, no Affinity APIs)

// Boxes are {l, t, r, b} in spread pixels; y points down. Padding is {left, right, top, bottom}.
// A probe is {copyInk, capInk}: the ink boxes of a copy of the text and of an "H", each set with
// its baseline at y = 0.

const unionBox = (a, b) => a ? {
    l: Math.min(a.l, b.l), t: Math.min(a.t, b.t), r: Math.max(a.r, b.r), b: Math.max(a.b, b.b)
} : b;

const shiftBox = (box, dx, dy) => ({ l: box.l + dx, t: box.t + dy, r: box.r + dx, b: box.b + dy });

// An existing text's ink box and cap height in spread pixels, from its own ink box and its
// probe. The copy's ink height against the text's own gives the scale, in case the text object
// is scaled.
function textMetrics(ink, probe) {
    const scale = (ink.b - ink.t) / (probe.copyInk.b - probe.copyInk.t);
    return { ink, capHeight: -probe.capInk.t * scale };
}

// The same for a new text that will be placed with its baseline origin at (x, y).
function newTextMetrics(probe, x, y) {
    return { ink: shiftBox(probe.copyInk, x, y), capHeight: -probe.capInk.t };
}

// The shape's box. Left and right: the ink's edges pushed out by their padding. Height: the cap
// height plus the top and bottom padding, the same for every pill in a font and size. Up and
// down, the box is centred on the ink, as Affinity's Align Vertical Centre does, then nudged by
// half the difference between bottom and top padding. For a word in capitals the ink runs from
// cap height to baseline, so top and bottom padding land exactly; a word with descenders rises
// to centre its ink, descenders included.
function paddedBox(metrics, pad) {
    const height = metrics.capHeight + pad.top + pad.bottom;
    const middle = (metrics.ink.t + metrics.ink.b) / 2 + (pad.bottom - pad.top) / 2;
    return {
        l: metrics.ink.l - pad.left,
        r: metrics.ink.r + pad.right,
        t: middle - height / 2,
        b: middle + height / 2,
    };
}

// The size of the pill a new text would get, from its probe.
function newPillSize(probe, pad) {
    const box = paddedBox(newTextMetrics(probe, 0, 0), pad);
    return { width: box.r - box.l, height: box.b - box.t };
}

// The baseline origin for new text whose pill should have its top-left corner at (left, top).
function originForPillAt(probe, pad, left, top) {
    const box = paddedBox(newTextMetrics(probe, 0, 0), pad);
    return { x: left - box.l, y: top - box.t };
}

// PILL-MATH-END

const NAME = "Pill";
const STROKE_WIDTH = 2;     // pixels: two printer dots at 300 dpi
const GAP = 20;             // pixels between selected text and a new pill placed below it

// The ink box of a node's outlines in spread coordinates, or null when it has none.
function inkBox(node) {
    const ci = node.curvesInterface;
    if (!ci)
        return null;
    const ppc = ci.polyPolyCurves;
    const toSpread = node.baseToSpreadTransform;
    let box = null;
    for (let i = 0; i < ppc.polyCurveCount; ++i) {
        const poly = ppc.getTransformedPolyCurve(i);
        poly.transform(toSpread);
        if (poly.curveCount == 0)
            continue;
        const b = poly.boundingBox;
        box = unionBox(box, { l: b.x, t: b.y, r: b.x + b.width, b: b.y + b.height });
    }
    return box;
}

// A story builder holding `text` in the glyph attributes `atts`, centred. New pills and their
// probes share this, so a probe's ink lines up with the new text's.
function centredStory(atts, text) {
    const { ParagraphAlignXType } = require('/paragraphatts.js');
    const { StoryBuilder } = require('/storybuilder.js');

    const sb = StoryBuilder.create();
    const para = sb.paragraphAtts;
    para.alignXType = ParagraphAlignXType.Centre;
    sb.setParagraphAtts(para);
    sb.setGlyphAtts(atts);
    sb.addText(text);
    return sb;
}

const isText = node => node.isArtTextNode || node.isFrameTextNode;
const anyText = node => isText(node) || node.isShapeTextNode;
const firstGlyphAtts = node => [...node.story.glyphAttRuns][0].glyphAtts;

// True when a node's transform only moves and scales it: no rotation or skew.
function isUpright(node) {
    const t = node.transform;
    return Math.abs(t.xAxis.y) < 1e-9 && Math.abs(t.yAxis.x) < 1e-9;
}

// Why a selected object was skipped, with how the message words it for one object and for more.
const NOT_A_PILL = ["object that isn't a pill", "objects that aren't pills"];
const TEXT_IN_SHAPE = ["text typed inside a shape", "texts typed inside shapes"];
const ROTATED = ["rotated or skewed pill", "rotated or skewed pills"];

// The pills in the selection as [{shape, text}], plus the selected objects that were skipped as
// [{name, why}], `why` being one of the reasons above.
function findPills(nodes) {
    const pills = [], skipped = [];
    const skip = (node, why) => skipped.push({ name: node.description, why });
    const loose = [];
    for (const node of nodes) {
        if (node.isGroupNode) {
            const children = [...node.children];
            const shapes = children.filter(c => c.isShapeNode);
            const texts = children.filter(isText);
            if (shapes.length == 1 && texts.length == 1)
                pills.push({ node, shape: shapes[0], text: texts[0] });
            else
                skip(node, NOT_A_PILL);
            continue;
        }
        loose.push(node);
    }
    const shapes = loose.filter(c => c.isShapeNode);
    const texts = loose.filter(isText);
    if (loose.length == 2 && shapes.length == 1 && texts.length == 1)
        pills.push({ node: texts[0], shape: shapes[0], text: texts[0] });
    else
        for (const node of loose)
            skip(node, node.isShapeTextNode ? TEXT_IN_SHAPE : NOT_A_PILL);
    const upright = [];
    for (const pill of pills) {
        if (isUpright(pill.shape) && isUpright(pill.text))
            upright.push(pill);
        else
            skip(pill.node, ROTATED);
    }
    return { pills: upright, skipped };
}

// "1 pill", "2 pills" and so on, from a [one, many] wording.
const count = (n, [one, many]) => `${n} ${n == 1 ? one : many}`;

// The message after a refit: how many pills were refit, then each kind of skipped object, by name.
function refitMessage(refitCount, skipped) {
    const lines = [`Refit ${count(refitCount, ["pill", "pills"])}.`];
    for (const why of [NOT_A_PILL, TEXT_IN_SHAPE, ROTATED]) {
        const names = skipped.filter(s => s.why == why).map(s => s.name);
        if (names.length)
            lines.push(`Skipped ${count(names.length, why)}: ${names.join(", ")}.`);
    }
    return lines.join("\n");
}

// Measures probe texts: for each job {atts, text}, a copy of the text and an "H" in those glyph
// attributes, both with their baseline at (0, 0). Probes have to be real objects to have
// outlines, so they're added, read and undone in one step: the document ends as it started.
// Returns probes in job order, null for a job whose text has no letters.
function measureProbes(doc, jobs) {
    const { AddChildNodesCommandBuilder } = require('/commands.js');
    const { ArtTextNodeDefinition } = require('/nodes.js');

    const probe = (atts, text) =>
        ArtTextNodeDefinition.createFromStoryBuilder({ x: 0, y: 0 }, centredStory(atts, text));
    const kinds = [null, "H"];
    const builder = AddChildNodesCommandBuilder.create();
    for (const { atts, text } of jobs)
        for (const kind of kinds)
            builder.addNode(probe(atts, kind ?? text));
    doc.executeCommand(builder.createCommand(true), false);
    const added = doc.selection.nodes.toArray();
    const out = jobs.map((job, k) => {
        const [copyInk, capInk] = kinds.map((kind, j) => {
            const node = added[kinds.length * k + j];
            return node ? inkBox(node) : null;
        });
        return copyInk && capInk ? { copyInk, capInk } : null;
    });
    doc.history.undo();
    return out;
}

// Each pill's shape with its text's metrics: [{shape, metrics}], leaving out pills whose text
// has no letters.
function measurePills(doc, pills) {
    const inks = pills.map(p => inkBox(p.text));
    const withInk = pills.filter((p, i) => inks[i]);
    if (withInk.length == 0)
        return [];
    const jobs = withInk.map(p => ({ atts: firstGlyphAtts(p.text), text: p.text.text.trim() }));
    const probes = measureProbes(doc, jobs);
    const out = [];
    withInk.forEach((pill, k) => {
        if (probes[k])
            out.push({ shape: pill.shape, metrics: textMetrics(inkBox(pill.text), probes[k]) });
    });
    return out;
}

// One command that moves and scales each shape onto its padded box, or null for none.
function refitCommand(doc, measured, pad) {
    const { CompoundCommandBuilder, DocumentCommand } = require('/commands.js');
    const { Transform } = require('/geometry.js');
    const { Selection } = require('/selections.js');

    const compound = CompoundCommandBuilder.create();
    let count = 0;
    for (const { shape, metrics } of measured) {
        const from = shape.getExactSpreadBaseBox();
        const to = paddedBox(metrics, pad);
        if (from.width <= 0 || from.height <= 0 || to.r - to.l <= 0 || to.b - to.t <= 0)
            continue;
        const sx = (to.r - to.l) / from.width, sy = (to.b - to.t) / from.height;
        const xf = Transform.createTranslate(to.l, to.t)
            .multiply(Transform.createScale(sx, sy))
            .multiply(Transform.createTranslate(-from.x, -from.y));
        compound.addCommand(DocumentCommand.createTransform(Selection.create(doc, [shape]), xf));
        ++count;
    }
    return count ? compound.createCommand() : null;
}

// A fully rounded rectangle: every corner round, at the largest relative radius.
function pillShape() {
    const { ShapeRectangle } = require('/shapes.js');
    const { ShapeCornerType } = require('affinity:geometry');

    const shape = ShapeRectangle.create();
    shape.useSingleRadius = true;
    // A corner's type has to be set before its radius, or the radius is ignored.
    for (const corner of [shape.topLeft, shape.topRight, shape.bottomLeft, shape.bottomRight]) {
        corner.cornerType = ShapeCornerType.Round;
        corner.setRadius(0.5, 1, 1);
    }
    return shape;
}

// The command that adds a new pill: the shape and the text, grouped and named, in one step.
function makeCommand(atts, text, origin, metrics, pad) {
    const { BlendMode } = require('affinity:common');
    const { AddChildNodesCommandBuilder, CompoundCommandBuilder, DocumentCommand } = require('/commands.js');
    const { RGBA8 } = require('/colours.js');
    const { FillDescriptor } = require('/fills.js');
    const { LineStyleDescriptor } = require('/linestyle.js');
    const { ArtTextNodeDefinition, ShapeNodeDefinition } = require('/nodes.js');

    const box = paddedBox(metrics, pad);
    if (box.r - box.l <= 0 || box.b - box.t <= 0)
        return null;
    const stroke = FillDescriptor.createSolid(RGBA8(0, 0, 0, 255), BlendMode.Normal);
    const rect = { x: box.l, y: box.t, width: box.r - box.l, height: box.b - box.t };

    // Added in this order, the shape ends up behind the text.
    const builder = AddChildNodesCommandBuilder.create();
    builder.addNode(ShapeNodeDefinition.create(pillShape(), rect, null, stroke,
        LineStyleDescriptor.createDefault(STROKE_WIDTH), null));
    builder.addNode(ArtTextNodeDefinition.createFromStoryBuilder(origin, centredStory(atts, text)));
    const compound = CompoundCommandBuilder.create();
    compound.addCommand(builder.createCommand(true));
    compound.addCommand(DocumentCommand.createGroupNodes(null));
    compound.addCommand(DocumentCommand.createSetDescription(null, NAME));
    return compound.createCommand();
}

// The glyph attributes and placement for a new pill: copied from the first selected text and
// placed below it, or Affinity's default text style in the middle of the spread.
function newPillSource(doc, nodes) {
    const { StoryBuilder } = require('/storybuilder.js');

    const textNode = nodes.find(anyText);
    if (textNode) {
        const box = textNode.getSpreadBaseBox(false);
        return {
            atts: firstGlyphAtts(textNode),
            text: textNode.text.trim(),
            place: (probe, pad) => originForPillAt(probe, pad, box.x, box.y + box.height + GAP),
        };
    }
    const sb = StoryBuilder.create();
    sb.setToArtisticTextDefaultStyle(doc.dpi, doc.format);
    const spread = doc.currentSpread.getSpreadBaseBox(false);
    const cx = spread.x + spread.width / 2, cy = spread.y + spread.height / 2;
    return {
        atts: sb.glyphAtts,
        text: "",
        place: (probe, pad) => {
            const size = newPillSize(probe, pad);
            return originForPillAt(probe, pad, cx - size.width / 2, cy - size.height / 2);
        },
    };
}

function main() {
    const { Dialog, DialogResult } = require('/dialog.js');
    const { Document } = require('/document.js');
    const { UnitType } = require('/units.js');

    const doc = Document.current;
    if (!doc) {
        alert("Make Pill needs an open document.");
        return;
    }
    const nodes = doc.selection.nodes.toArray();
    const { pills, skipped } = findPills(nodes);
    const refitting = pills.length > 0;

    let measured = [], source = null;
    if (refitting) {
        measured = measurePills(doc, pills);
        if (measured.length == 0) {
            alert("The selected pills have no letters to measure.");
            return;
        }
    }
    else
        source = newPillSource(doc, nodes);

    const dlg = Dialog.create(`${refitting ? "Make Pill: Refit" : "Make Pill"} v${VERSION}`);
    const col = dlg.addColumn();
    let textBox = null;
    if (!refitting)
        textBox = col.addGroup("Pill").addTextBox("Text", source.text);
    const group = col.addGroup("Padding");
    const editor = (label, value) =>
        group.addUnitValueEditor(label, UnitType.Pixel, doc.units, value, 0).setNoMaxValue();
    const left = editor("Left", 30), right = editor("Right", 30);
    const top = editor("Top", 10), bottom = editor("Bottom", 10);
    dlg.initialWidth = 300;

    const padding = () =>
        ({ left: left.value, right: right.value, top: top.value, bottom: bottom.value });

    // For a new pill, the probes are measured again only when the text changes.
    let probedText = null, probe = null;
    const command = () => {
        const pad = padding();
        if (refitting)
            return refitCommand(doc, measured, pad);
        const text = textBox.text.trim();
        if (text == "")
            return null;
        if (text != probedText) {
            probe = measureProbes(doc, [{ atts: source.atts, text }])[0];
            probedText = text;
        }
        if (!probe)
            return null;
        const origin = source.place(probe, pad);
        const metrics = newTextMetrics(probe, origin.x, origin.y);
        return makeCommand(source.atts, text, origin, metrics, pad);
    };
    const preview = () => {
        doc.clearPreviews();
        const cmd = command();
        if (cmd)
            doc.executeCommand(cmd, true);
    };
    dlg.onControlValueChangedHandler = preview;
    preview();
    const result = dlg.runModal();
    doc.clearPreviews();
    if ((result?.value ?? result) != DialogResult.Ok.value)
        return;
    const cmd = command();
    if (!cmd) {
        alert(refitting ? "Nothing to refit." : "Type some text for the pill.");
        return;
    }
    doc.executeCommand(cmd, false);
    if (refitting && skipped.length)
        alert(refitMessage(measured.length, skipped));
}

main();
