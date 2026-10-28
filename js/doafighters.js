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
import { decodeModel } from './model.js';
import { meshOffsetOf, readModelEntry } from './romset.js';

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

/* The action script `action` names: group action >> 9, script action & 0x1FF
 * (0x44160). */
function scriptOf(rom, action) {
    const b = busOf(rom);
    const group = b.read32(rom.game.rig.scripts + 4 * (action >> 9));
    return group ? b.read32(group + 4 * (action & 0x1ff)) : 0;
}

/* The motion an action script opens by starting: op 0 [0, motion, n] or op
 * 0x1E [0x1E, 0, motion, n] (the interpreter at 0x441AC), else -1. */
function openingMotion(b, s) {
    const op = s16(b, s);
    return op === 0 ? s16(b, s + 2) : op === 0x1e ? s16(b, s + 4) : -1;
}

/**
 * The command that plays `motion` on character `char`, or null. A player's
 * command (+0x2C, a byte, what the attract's AI gives) indexes its
 * character's table (`fighters.commands`, 0x91C60): eight bytes an entry, the
 * action at +0, at +3 the state the fight code keeps at +0x2D (2 and 3 the
 * strikes, 4 and 6 the throws, 0x0A and 0x0B the one thrown) and at +4 the
 * attack's number. 0x25730 turns it into the action the player starts. The
 * command picked is the first whose action's script opens by starting the
 * motion; it comes back with that action and `rival`'s stance, the action of
 * entry 0 of its own table (Tina's is 0x800, the action the attract opens her
 * on).
 */
export function moveCommand(rom, char, motion, rival) {
    const table = rom.game.doa.fighters.commands;
    if (!table) return null;
    const b = busOf(rom);
    const entries = b.read32(table + 4 * char);
    for (let c = 0; c < 0x100; c++) {
        const action = b.read16(entries + 8 * c);
        const s = scriptOf(rom, action);
        if (s && openingMotion(b, s) === motion) return { command: c, action, stance: b.read16(b.read32(table + 4 * rival)) };
    }
    return null;
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

/* The shadow is the first fifteen draws (0x56180 from the body routine
 * 0x45B24): a piece for each bone, laid on the floor between its two ends
 * cast along the stage's light, and squashed to 0.01 high (determinant near
 * 0). It is kept apart from the parts, as `shadows`. */
const det3 = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[3] * (m[1] * m[8] - m[2] * m[7])
    + m[6] * (m[1] * m[5] - m[2] * m[4]);

/* A run's frames as parts: the shadow pieces apart, and the joints the
 * parts hang from. */
function keptFrames(rom, frames) {
    const kept = frames.map((draws) => draws.filter((d) => Math.abs(det3(d.m)) > 0.5));
    kept.joints = jointsOf(rom, kept);
    kept.shadows = frames.map((draws) => draws.filter((d) => Math.abs(det3(d.m)) <= 0.5));
    return kept;
}

const runs = new WeakMap();
function framesOf(rom, body, motion, rival = null, reacts = false) {
    if (!runs.has(rom)) runs.set(rom, new Map());
    const cache = runs.get(rom);
    const move = rival && reacts ? moveCommand(rom, body.index, motion.index, rival.index) : null;
    const key = `${body.index}:${motion.index}:${rival?.index ?? ''}:${move?.command ?? ''}`;
    if (!cache.has(key)) {
        /* One run at a time is kept; a motion is a few hundred frames of
         * fifty draws. */
        cache.clear();
        const frames = runDoaMotion(rom, { char: body.index, base: body.base }, motion.index, motion.frames,
            rival && { char: rival.index, base: rival.base, ...move });
        const kept = keptFrames(rom, frames);
        if (rival) kept.rival = keptFrames(rom, frames.rival);
        cache.set(key, kept);
    }
    return cache.get(key);
}

/* The point q in the frame of the board matrix m (its rotation is a turn). */
function localPoint(m, q) {
    const d = [q[0] - m[9], q[1] - m[10], q[2] - m[11]];
    return [0, 1, 2].map((c) => m[c * 3] * d[0] + m[c * 3 + 1] * d[1] + m[c * 3 + 2] * d[2]);
}

/* How far the place of draw c wanders in draw p's frame over the frames, and
 * where in that frame it sits on average. */
function hold(frames, p, c) {
    const pts = frames.filter((f) => f[c] && f[p]).map((f) => localPoint(f[p].m, f[c].m.slice(9)));
    if (!pts.length) return null;
    const mean = [0, 1, 2].map((k) => pts.reduce((a, q) => a + q[k], 0) / pts.length);
    const spread = Math.max(...pts.map((q) => Math.hypot(q[0] - mean[0], q[1] - mean[1], q[2] - mean[2])));
    return { spread, mean };
}

/* A draw's points, in its own frame with Z negated as decodeModel gives them. */
const pointCache = new WeakMap();
function pointsOf(rom, d) {
    if (!pointCache.has(rom)) pointCache.set(rom, new Map());
    const cache = pointCache.get(rom);
    const key = drawKey(d);
    if (!cache.has(key)) {
        let m = null;
        if (d.mesh === undefined) m = decodeModel(rom, d.model);
        else {
            const { uvPtr, matPtr } = readModelEntry(rom, d.model);
            const bytes = rom.polygons.subarray(meshOffsetOf(rom, { meshPtr: d.mesh }));
            m = decodeModel(rom, d.model, null, { bytes, uvPtr, matPtr });
        }
        cache.set(key, m?.positions ?? []);
    }
    return cache.get(key);
}

/* How near the point q (board, in the draw's frame) comes to the draw's model. */
function gapTo(rom, d, q) {
    const p = pointsOf(rom, d);
    let best = Infinity;
    for (let k = 0; k < p.length; k += 3) best = Math.min(best, Math.hypot(p[k] - q[0], p[k + 1] - q[1], p[k + 2] + q[2]));
    return best;
}

const sameMatrix = (a, b) => a.every((v, k) => Math.abs(v - b[k]) < 1e-4);

/*
 * The skeleton, which the body routine keeps to itself: it works out every
 * matrix whole, so the coprocessor's stack stays flat. A joint is fixed on
 * its parent's bone, so a part's parent is the earlier part in whose frame
 * its place holds still through the motion. A joint the motion never bends
 * holds still in more than one, so of those it is the one whose model comes
 * nearest the place: the bone the joint is the end of. A part drawn with its
 * parent's very matrix in every frame is laid on it (`joined`): the face on
 * the head, the bust on the chest.
 */
export function jointsOf(rom, frames) {
    const n = Math.max(0, ...frames.map((f) => f.length));
    const parents = new Array(n).fill(-1);
    const joined = new Array(n).fill(false);
    const first = (k) => frames.find((f) => f[k])?.[k];
    for (let c = 1; c < n; c++) {
        let best = null;
        for (let p = 0; p < c; p++) {
            const h = hold(frames, p, c);
            if (!h || h.spread >= 1e-3) continue;
            const gap = gapTo(rom, first(p), h.mean) + 1e-3 * Math.hypot(...h.mean);
            if (!best || gap < best.gap) best = { p, gap };
        }
        if (!best) continue;
        parents[c] = best.p;
        joined[c] = frames.every((f) => !f[c] || !f[best.p] || sameMatrix(f[c].m, f[best.p].m));
    }
    return { parents, joined };
}

/* A draw is its model, or `model/mesh` (hex) when it goes out over another
 * mesh (js/doa.js modelTracker; js/app.js getModel decodes it). */
const drawKey = (d) => (d.mesh === undefined ? d.model : `${d.model}/${d.mesh.toString(16)}`);

/** The draws of a frame of the motion, a place in the draw order a part;
 * `shadows` the frame's shadow pieces, each a model and its board matrix
 * (`r`, `t`). With `rival` (a body of the roster) the run has it as player
 * 2, and its draws of the same frame come back as `rival`, in the same
 * frame: the board's own place for it. With `reacts` the move is given as
 * the fighter's command (moveCommand) and the fight runs, so the opponent
 * plays the reaction the game picks (with no command for the motion it holds
 * its stance, as without). */
export function poseDoaFighter(rom, body, motion, frame, { rival = null, reacts = false } = {}) {
    const at = Math.max(0, Math.min(frame, motion?.frames ?? 0) - 1);
    const run = motion ? framesOf(rom, body, motion, rival, reacts) : null;
    const posed = posedFrame(body, run, at);
    if (rival) posed.rival = posedFrame(rival, run?.rival, at);
    return posed;
}

function posedFrame(body, run, at) {
    const draws = run?.[at] ?? [];
    const shadows = run?.shadows[at] ?? [];
    const matrices = body.parts.map((p) => toThree(draws[p.index]?.m ?? IDENTITY));
    const origins = matrices.map((e) => [e[12], e[13], e[14]]);
    const joints = run?.joints ?? { parents: [], joined: [] };
    return {
        matrices,
        origins,
        draws: body.parts.map((p) => (draws[p.index] ? [drawKey(draws[p.index])] : [])),
        parents: body.parts.map((p) => joints.parents[p.index] ?? -1),
        joined: body.parts.map((p) => joints.joined[p.index] ?? false),
        shadows: shadows.map((d) => ({ model: drawKey(d), r: d.m.slice(0, 9), t: d.m.slice(9, 12) })),
    };
}
