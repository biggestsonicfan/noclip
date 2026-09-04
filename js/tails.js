/*
 * tails.js — Tails' two tails.
 *
 * Tails is not one of the five fighters whose loose parts are sway chains: his
 * `osage_per_character` entry is the shared empty table, and `js/osage.js`
 * finds nothing for him. His tails are a display routine of their own,
 * `tails_tail_disp` at `0x1AB58`, reached through two entry points that differ
 * only in which tables they load:
 *
 *   0x1AB34   r11 = 0x1AE34   r10 = 0x1AF34    character 1,  Tails
 *   0x1AB48   r11 = 0x1AEB4   r10 = 0x1AF38    character 27, Tails (mirror)
 *
 * and dispatched on the character index at `0x1B0(g7)` — the same two indices
 * `CHARACTERS` names, so nothing else in the roster reaches this code.
 *
 * `r11` is 64 `u16` model ids and `r10` is two more. The 64 are a baked
 * animation: one tail modelled in 64 poses, the last a repeat of the first, so
 * it loops. Character 1's are models 108..171 in order; character 27's are
 * 1396..1459 *not* in order — the same animation authored in a different model
 * order, which the table puts back.
 *
 * The routine runs once per displayed frame and steps a counter at `0x2198(g7)`
 * that wraps at 64, then draws the cycle twice from it:
 *
 *     set_pos  0.1, -0.25, 0        the offset the pair hangs from
 *     ang_z    0xC000               the roll that lays a tail mesh along it
 *     ang_y    +0x1000 ; draw cycle[i]
 *     ang_y    -0x2000 ; draw cycle[(i + 8) % 64]
 *
 * The ops accumulate, so the second tail's own turn is -0x1000: the two splay
 * ±22.5° about the hang axis, and the second runs eight frames ahead of the
 * first in the same cycle. That eight-frame lead is what makes the pair read as
 * turning rather than as two tails waving in lockstep.
 *
 * Where it hangs from: `rob_disp` walks the sixteen slots and, after drawing
 * each one's mesh, dispatches on the slot through the table at `0x1A184`.
 * Slot 9 — the pelvis — is the entry that calls this routine, so the current
 * matrix is the pelvis's and the offset above is in its frame. The pair comes
 * out 0.1 below and 0.25 behind the waist, along the tails' own vertical.
 *
 * Two branches of the routine are not reproduced, and cannot be from a motion
 * alone:
 *
 * - The propeller. Bit 16 of `0x7F0(g7)` swaps the cycle for a spinning disc:
 *   two models alternating on the frame parity — 1221 and 1222 for Tails —
 *   turned by `0x500020 * 0xD80` about Y, which is 19° a frame. `0x7F4(g7)`
 *   picks between drawing it at the fighter's world root (`0x1AC58`) and on the
 *   hip like the cycle (`0x1AD84`). Both are turned on by an opcode at
 *   `0x1C970` in the per-motion script — `motion_flags[id]` at `0xCE380`, whose
 *   record carries thirteen bytes of flags and then a byte-code stream the
 *   game's action interpreter walks. Nothing in the keyframe block says the
 *   flag is set or when, so the viewer, which plays a motion and not an action,
 *   has no way to know.
 *
 * - The 0x8000 roll. `ang_z` is 0x8000 rather than 0xC000 when bit 16 of
 *   `0x1A4(g7)` is set. That word is initialised per motion — bit 16 comes from
 *   bits 8 and 15 of the motion record's own flag word at `0x1B4EC` — but no
 *   motion in the table has both, so it is only ever set later by game logic,
 *   which the viewer does not run. 0xC000 is the roll for every motion as it
 *   starts.
 *
 * The whole routine returns without drawing anything when the skeleton type at
 * `0x84C(g7)` is 3. Type 2, the hammer-squished form, still gets its tails.
 */

import { turnedBy } from './pose.js';

/* The slot the pair is drawn on, and so the frame the offset below is in. */
export const PELVIS_SLOT = 9;

/* Per character: the cycle table, and the two propeller models beside it. */
const TAIL_TABLES = {
    1: { cycle: 0x0001ae34, blur: 0x0001af34 },
    27: { cycle: 0x0001aeb4, blur: 0x0001af38 },
};

export const CYCLE_LENGTH = 64;

/* How far ahead of the first tail the second runs, in cycle entries. */
export const LEAD = 8;

/* `set_pos 0.1, -0.25, 0` — 0x3DCCCCCD, 0xBE800000, 0 at 0x1ABA0. */
export const HANG = [0.1, -0.25, 0];

/* `ang_z`, then the ±`ang_y` the pair splays by. */
export const ROLL = 0xc000;
export const SPLAY = 0x1000;

/**
 * Read Tails' tail tables, or null for a character that has none.
 *
 * @param {object} rom
 * @param {number} charIndex index into CHAR_PARTS
 * @returns {?{cycleAddr:number, blurAddr:number, cycle:number[], blur:number[]}}
 */
export function readTails(rom, charIndex) {
    const t = TAIL_TABLES[charIndex];
    if (!t) return null;
    const dv = rom.mainCpuView;
    if (t.cycle + CYCLE_LENGTH * 2 > rom.maincpu.length) return null;
    const cycle = [];
    for (let i = 0; i < CYCLE_LENGTH; i++) cycle.push(dv.getUint16(t.cycle + i * 2, true));
    return {
        cycleAddr: t.cycle,
        blurAddr: t.blur,
        cycle,
        /* The propeller pair. Read because the table is right there and it says
         * which models they are; nothing places them — see the header. */
        blur: [dv.getUint16(t.blur, true), dv.getUint16(t.blur + 2, true)],
    };
}

/**
 * Place both tails on a solved pose.
 *
 * `frame` is the game's own free-running counter, not the motion frame: the
 * routine steps `0x2198(g7)` once per displayed frame and the cycle is 64 long,
 * so a motion shorter than that still shows the whole of it.
 *
 * @param {Array<{r:number[],t:number[]}>} pose from buildPose(), board frame
 * @param {object} tails from readTails()
 * @param {number} frame the display counter
 * @returns {Array<{model:number, r:number[], t:number[], tail:number, phase:number}>}
 */
export function tailParts(pose, tails, frame = 0) {
    if (!tails) return [];
    const b = pose[PELVIS_SLOT];
    if (!b) return [];

    /* `set_pos` is additive — T += R · offset — so the pair hangs off the
     * pelvis's own position, stepped in the pelvis's own frame. Both tails are
     * drawn from the one point; only their turn differs. */
    const t = [0, 1, 2].map((k) =>
        b.t[k] + b.r[k] * HANG[0] + b.r[3 + k] * HANG[1] + b.r[6 + k] * HANG[2]);

    const i = ((frame % CYCLE_LENGTH) + CYCLE_LENGTH) % CYCLE_LENGTH;
    /* The ops accumulate: the second `ang_y` of -0x2000 lands on the first's
     * +0x1000, so the two tails sit at ±SPLAY about the rolled hang axis. */
    return [
        { phase: i, ay: SPLAY },
        { phase: (i + LEAD) % CYCLE_LENGTH, ay: (-SPLAY) & 0xffff },
    ].map((s, tail) => ({
        model: tails.cycle[s.phase],
        tail,
        phase: s.phase,
        r: turnedBy(b.r, 0, s.ay, ROLL),
        t: t.slice(),
    }));
}
