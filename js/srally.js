/*
 * srally.js — Sega Rally Championship's people by the course: three figures
 * whose limbs are separate models, each with one keyframed motion.
 *
 * One routine draws them all, 0x5CA290 (ROM 0x2B290; the program runs from RAM,
 * 0x59F000 above its ROM address). It is handed a figure, a frame and a step:
 *
 *   +0x00  frames (30 for all three)
 *   +0x04  parts
 *   +0x08  the frames' data, a data ROM address
 *   +0x0C  a model number for each part
 *
 * A frame is 20 bytes a part: the part's place in the figure (three floats),
 * then halfwords at +0x0C and +0x10, which the routine sends with the place to
 * the TGP as one command (function 0x5F, `lda 0x2F805F5F`). The halfwords at
 * +0x0E and +0x12 are not read. Every part is placed from the figure's own
 * origin: none hangs from another, so a frame is the whole pose, baked.
 *
 * What the TGP makes of the command was read off MAME: the matrix it writes to
 * the geometry buffer for each part, against the figure's (solved from where
 * its parts land), is T(place) · Rz(-h0C) · Rx(-h10) on the board's axes. The
 * viewer's Z is the board's negated, which leaves the Z turn as it is and
 * flips the X turn: Rz(-h0C) · Rx(h10).
 *
 * The routine returns the next frame, frame + step, and both callers ask it to
 * swing back at the end: 0 to 29, then -29 to -1, read by their size, so a
 * cycle is 59 frames. The explorer's motion is that cycle unrolled.
 *
 * Who draws them: the object handlers in the table at 0x5DDFC4. Class 6
 * (0x5CAAE0) is the first figure, turned each frame toward the player's car
 * (0x2140CC). Classes 5 and 7 (0x5CA6D0, 0x5CA710) turn theirs to the camera
 * and take the figure from the table at 0x5CA280 (ROM 0x2B280), four entries
 * (the first, second, third and second again) picked by the backup RAM count
 * 0x1D001B8 over 30. The self-check report prints that count as OPERATION
 * DAYS, so a cabinet's spectators change every thirty days it is switched on.
 */

import { MAIN_DATA_BASE } from './romset.js';

const PART_BYTES = 20;

/* The figures, in the order the table names them, each once. */
function figureRecords(rom) {
    const F = rom.game.rig.figures;
    const dv = rom.mainCpuView;
    const seen = [];
    for (let i = 0; i < F.count; i++) {
        const at = dv.getUint32(F.table + i * 4, true) - F.ramBase;
        if (!seen.includes(at)) seen.push(at);
    }
    return seen.map((at) => ({
        at,
        keys: dv.getUint32(at, true),
        parts: dv.getUint32(at + 4, true),
        data: dv.getUint32(at + 8, true),
        models: Array.from({ length: dv.getUint32(at + 4, true) }, (_, j) => dv.getUint32(at + 12 + j * 4, true)),
    }));
}

function readPart(rom, data, keys, parts, key, part) {
    const dv = rom.mainDataView;
    const at = data - MAIN_DATA_BASE + (Math.max(0, Math.min(key, keys - 1)) * parts + part) * PART_BYTES;
    return {
        place: [dv.getFloat32(at, true), dv.getFloat32(at + 4, true), -dv.getFloat32(at + 8, true)],
        z: dv.getInt16(at + 12, true),
        x: dv.getInt16(at + 16, true),
    };
}

/** The three figures, as bodies whose parts all hang from the figure. */
export function readRallyFigures(rom) {
    const names = rom.game.rig.names ?? [];
    return figureRecords(rom).map((r, i) => ({
        index: i,
        name: names[i] ?? `figure ${i}`,
        joints: r.parts,
        scale: 1,
        roles: [],
        skin: -1,
        hitMotions: [],
        start: i,
        root: r.at,
        parts: r.models.map((model, j) => ({
            index: j,
            parent: -1,
            depth: 0,
            model,
            /* Where the part stands on the first frame. */
            offset: readPart(rom, r.data, r.keys, r.parts, 0, j).place,
            flags: 0,
            joint: j,
            record: r.at,
        })),
    }));
}

/** One motion a figure, its key frames swung there and back. */
export function readRallyMotions(rom) {
    return figureRecords(rom).map((r, i) => ({
        index: i,
        name: `motion ${i}`,
        address: r.data,
        offset: r.data - MAIN_DATA_BASE,
        view: rom.mainDataView,
        keys: r.keys,
        frames: 2 * r.keys - 1,
        frameSize: r.parts * PART_BYTES,
        joints: r.parts,
        layout: 'srallyc',
    }));
}

export function rallyMotionList(rom, body, motions) {
    const fits = motions.filter((m) => m.joints === body.joints);
    return { fits, lead: fits.filter((m) => m.index === body.index), label: 'Played by its routine' };
}

/* The key frame a frame of the cycle shows: up from 0, then back down. */
function keyAt(motion, frame) {
    const f = Math.max(1, Math.min(frame, motion.frames));
    return f <= motion.keys ? f - 1 : 2 * motion.keys - f;
}

const turn = (a) => (a * 2 * Math.PI) / 0x10000;

/** Every part's matrix on one frame, Rz(-h0C) · Rx(h10) at its place. */
export function poseRallyFigure(rom, body, motion, frame) {
    const r = figureRecords(rom)[body.index];
    const key = motion && motion.joints === body.joints ? keyAt(motion, frame) : 0;
    const origins = [];
    const matrices = body.parts.map((p, j) => {
        const { place, z, x } = readPart(rom, r.data, r.keys, r.parts, key, j);
        const cz = Math.cos(turn(-z)), sz = Math.sin(turn(-z));
        const cx = Math.cos(turn(x)), sx = Math.sin(turn(x));
        origins.push(place);
        return [
            cz, sz, 0, 0,
            -sz * cx, cz * cx, sx, 0,
            sz * sx, -cz * sx, cx, 0,
            place[0], place[1], place[2], 1,
        ];
    });
    return { matrices, origins };
}
