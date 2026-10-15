/*
 * doafighters.js — Dead or Alive's fighters on the animation tab.
 *
 * The board draws a fighter with no table of parts to read: the body routine
 * (0x457C0) walks the skeleton and sends model after model, each with its
 * matrix. So the explorer runs that code (js/doa.js runDoaMotion) and a part
 * here is a place in the order the routine draws in, its model and matrix
 * whatever the frame's draw in that place was.
 *
 * The roster. The character number is the player's +1; nine of the thirteen
 * slots are fighters, the other four (3, 7, 9, 10) fall back on Zack's moves.
 * Each slot's song (0x90C40), against the song names in the data ROM, names
 * it: 2 is BGM_LOO (Jann Lee), 8 BGM_GATBY (Bayman), 11 BGM_BOSS (Raidou).
 * The model bank is the s16 at `banks` + 6 * row (the loader at 0x71540
 * puts player 0's at 0x5A6ED0), the row the character's load id: the byte
 * at `loads` + 13 * costume + char (0x70F40), its low bits the row and bit 7
 * 13 rows on. Costume 0's Jann Lee, Genfu, Bayman and Leifang are in the
 * second half; the first-half rows of the three whose sizes differ land
 * the bank in the middle of another costume's models.
 *
 * The motions. A motion id below 0x552 indexes the table *(0x6000000), the
 * rest the table *(0x6C00004) from 0x552 (0x420C0). A record is fourteen
 * joint tracks (+0x00..+0x34) and the root's (+0x3C), which sits in front of
 * the first joint's: eight words, then three a frame, so the gap gives the
 * length, the frame the motion step (0x44840) stops on.
 *
 * Which motions are a fighter's: the action number (player +0x28) picks a
 * script, `ld 0xD8000[action >> 9]` then [action & 0x1FF] (0x44160), and the
 * action's high bits are the character number; actions from 0x2000 use table
 * 13, the moves everyone shares. A script that opens with 0 starts its
 * motion, the s16 after it.
 */
import { doaMachine, runDoaMotion } from './doa.js';

const PARTS = 48;
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

const buses = new WeakMap();
function busOf(rom) {
    if (!buses.has(rom)) buses.set(rom, doaMachine(rom).cpu.bus);
    return buses.get(rom);
}

const s16 = (b, a) => (b.read16(a) << 16) >> 16;

const bankRow = (id) => (id & 0x7f) + (id & 0x80 ? 13 : 0);

/** The roster, as bodies of `PARTS` places in the draw order. */
export function readDoaFighters(rom) {
    const R = rom.game.rig;
    const b = busOf(rom);
    return R.roster.map(([char, name]) => ({
        index: char,
        name,
        base: s16(b, R.banks + 6 * bankRow(b.read8(R.loads + char))),
        joints: 14,
        parts: Array.from({ length: PARTS }, (_, k) => ({ index: k, joint: k, parent: -1, model: null })),
    }));
}

/** Every motion in the two tables, indexed by id. */
export function readDoaMotions(rom) {
    const b = busOf(rom);
    const list = [];
    for (const [table, first, count] of rom.game.rig.motions) {
        const at = b.read32(table);
        for (let i = 0; i < count; i++) {
            const rec = b.read32(at + 4 * i);
            const root = b.read32(rec + 0x3c);
            const frames = Math.floor(((b.read32(rec) - root) / 4 - 8) / 3);
            const id = first + i;
            list[id] = frames > 0
                ? { index: id, name: `motion 0x${id.toString(16)}`, address: rec, frames, joints: 14 }
                : null;
        }
    }
    return list;
}

/* The motions a group of scripts starts. */
function groupMotions(rom, group) {
    const b = busOf(rom);
    const at = b.read32(rom.game.rig.scripts + 4 * group);
    const ids = new Set();
    for (let i = 0; i < 0x200; i++) {
        const s = b.read32(at + 4 * i);
        if (!s) break;
        if (s16(b, s) === 0 && s16(b, s + 2) >= 0) ids.add(s16(b, s + 2));
    }
    return ids;
}

/** The fighter's own moves first, then everyone's, then the rest. */
export function doaMotionList(rom, body, motions) {
    const own = groupMotions(rom, body.index);
    const shared = groupMotions(rom, rom.game.rig.common);
    const pick = (ids) => motions.filter((x) => x && ids.has(x.index));
    const lead = [...pick(own), ...pick(shared).filter((x) => !own.has(x.index))];
    return {
        fits: motions.filter(Boolean),
        lead,
        label: `${body.name}'s moves and the shared ones`,
        every: 'Every motion in the table',
    };
}

/* Board matrix (3x3 by columns, then the place) to three.js, Z negated. */
function toThree(m) {
    return [m[0], m[1], -m[2], 0, m[3], m[4], -m[5], 0, -m[6], -m[7], m[8], 0, m[9], m[10], -m[11], 1];
}

/* The shadow is the body again, its matrices squashed flat onto the floor
 * (the first fifteen draws, determinant near 0): the explorer leaves it out. */
const det3 = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[3] * (m[1] * m[8] - m[2] * m[7])
    + m[6] * (m[1] * m[5] - m[2] * m[4]);

const runs = new WeakMap();
function framesOf(rom, body, motion) {
    if (!runs.has(rom)) runs.set(rom, new Map());
    const cache = runs.get(rom);
    const key = `${body.index}:${motion.index}`;
    if (!cache.has(key)) {
        /* One run at a time is kept; a motion is a few hundred frames of
         * fifty draws. */
        cache.clear();
        const frames = runDoaMotion(rom, { char: body.index, base: body.base }, motion.index, motion.frames);
        cache.set(key, frames.map((draws) => draws.filter((d) => Math.abs(det3(d.m)) > 0.5)));
    }
    return cache.get(key);
}

/* A draw is its model, or `model/mesh` (hex) when it goes out over another
 * mesh (js/doa.js modelTracker; js/app.js getModel decodes it). */
const drawKey = (d) => (d.mesh === undefined ? d.model : `${d.model}/${d.mesh.toString(16)}`);

/** The draws of a frame of the motion, a place in the draw order a part. */
export function poseDoaFighter(rom, body, motion, frame) {
    const draws = motion ? framesOf(rom, body, motion)[Math.max(0, Math.min(frame, motion.frames) - 1)] : [];
    const matrices = body.parts.map((p) => toThree(draws[p.index]?.m ?? IDENTITY));
    const origins = matrices.map((e) => [e[12], e[13], e[14]]);
    return { matrices, origins, draws: body.parts.map((p) => (draws[p.index] ? [drawKey(draws[p.index])] : [])) };
}
