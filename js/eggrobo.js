/*
 * eggrobo.js — the two timed animations the Egg robots run off the frame
 * counter, outside their motion.
 *
 * Neither is in the keyframe data. Both are drawn by `rob_disp`, stepped by the
 * board's own `frame_counter` at `0x500020`, and gated on the character index —
 * so they keep running on a motion held at one frame, the way Tails' tails do.
 *
 * ---- the Final Eggman Boss's arms -----------------------------------------
 *
 * `efc_eggrob_mune_chg` at `0x33758`, called from `rob_disp` at `0x1A264`:
 *
 *     ldob  0x1B0(g7), r3        ; the character
 *     mov   0xB, r4              ; 11, the boss
 *     addo  0x1F, 6, r5          ; 37, its mirror
 *     cmpobe  r3, r4, +          ; nobody else reaches this
 *     cmpobne r3, r5, ret
 *     ld    0x1A4(g7), r3        ; p1_mot_kind
 *     bbs   14, r3, hold         ; that bit pins it to the middle of the swing
 *     ld    frame_counter, r4
 *     shro  1, r4, r4            ; a new model every second frame
 *     and   0xF, r4, r4          ; sixteen of them
 *     ldos  egg_mech_arms[r4*2], r4
 *     call  set_obj
 *
 * `egg_mech_arms` is nine models, 4126..4134, and then the same nine back down
 * without repeating either end — a sixteen-entry ping-pong, so the arms swing
 * out and back over 32 displayed frames and the cycle closes. "mune" is the
 * chest, which is the matrix `rob_disp` has current when it calls: this is an
 * extra object hung on the chest, not one of the sixteen slots.
 *
 * ---- the Egg Minion's head -------------------------------------------------
 *
 * `rob_disp` again, at `0x1A024`, on slot 2 — the head — and character 13:
 *
 *     cmpibne 2, r8, +           ; the head slot only
 *     ldob    0x1B1(g7), r14
 *     cmpobne 0xD, r14, +        ; the Egg Minion only
 *     ld      frame_counter, r4
 *     bbs     7, r4, +           ; both bits clear, so it runs for 64 frames
 *     bbs     6, r4, +           ; out of every 256 and is still the rest
 *     shro    4, r4, r5
 *     and     3, r5, r5          ; which quarter of those 64
 *     and     0xF, r4, r6        ; the step inside it
 *     ld      egg_robo_anims[r5*4], r5
 *     bx      (r5)
 *
 * The four quarters are `nobi` (stretch), `gururi` (spin), `tizimi` (shrink)
 * and `ex`, which draws nothing — so the head stretches, spins, shrinks and
 * then holds still: 48 frames of movement in every 256, the fourth quarter of
 * the window being as idle as the 192 frames outside it. Stretch walks `egg_robo_head_anim`
 * (models 2981..2991) forward, clamped at its last entry; shrink walks the same
 * table with the step reversed. Spin holds the last model and turns it instead:
 *
 * The op it writes the angle with is 0x5000A0A -- opcode 0x0A, ang_z -- so the
 * turn is about the head's own Z:
 *
 *     mov  0xA, r5                       ; the eleventh model
 *     bbs  8, r4, +                      ; bit 8 flips which way it goes round
 *     shlo 0xC, 1, r5   -> 0x1000
 *   + shlo 0xC, 0xF, r5 -> 0xF000        ; which is -0x1000 in binary radians
 *     mulo r6, r5, r6                    ; step x that, so sixteen steps close
 *
 * A full turn either way over the quarter's sixteen frames, and the direction
 * alternates every 256 frames because bit 8 is the next one up from the window.
 */

/* Where each table lives, and the two characters that reach them. */
const EGG_MECH_ARMS_ADDR = 0x00034e96;   /* u16 model ids, zero-terminated */
const EGG_ROBO_ANIMS_ADDR = 0x0001d2e4;  /* four routine pointers */
const EGG_ROBO_HEAD_ADDR = 0x0001d2f4;   /* u32 model ids */

export const BOSS_CHARS = [11, 37];
export const MINION_CHARS = [13, 39];

/* The chest is the matrix the arms are hung on, and slot 2 the head. */
export const CHEST_SLOT = 1;
export const HEAD_SLOT = 2;

/* `shro 1` then `and 0xF`: a model every second frame, sixteen of them. */
export const ARM_SHIFT = 1, ARM_COUNT = 16;
/* The head's window is `fc & 0xC0 == 0`, split four ways by `(fc >> 4) & 3`. */
export const HEAD_WINDOW = 0xc0, HEAD_PHASE_SHIFT = 4, HEAD_STEPS = 16;
/* `egg_robo_head_anim` is indexed 0..10 and the walk is clamped there. */
export const HEAD_LAST = 10;
/* One sixteenth of a turn per step, negated when frame_counter bit 8 is set. */
export const SPIN_STEP = 0x1000, SPIN_FLIP_BIT = 8;
/* `lda 4130, g0` — the pose the arms are pinned at, which is the middle of the
 * nine the table ramps through rather than the middle of the sixteen entries. */
export const ARM_HOLD_MODEL = 4130;

const PHASE_STRETCH = 0, PHASE_SPIN = 1, PHASE_SHRINK = 2;

/**
 * The boss's sixteen arm models, in the order the ping-pong plays them.
 * @param {object} rom
 * @returns {number[]|null} sixteen model ids, or null if the table is short
 */
export function readMechArms(rom) {
    const dv = rom.mainCpuView;
    const out = [];
    for (let i = 0; i < ARM_COUNT; i++) {
        const a = EGG_MECH_ARMS_ADDR + i * 2;
        if (a + 2 > rom.maincpu.length) return null;
        const id = dv.getUint16(a, true);
        if (!id) break;
        out.push(id);
    }
    return out.length === ARM_COUNT ? out : null;
}

/**
 * The minion's head models, `egg_robo_head_anim[0..10]`.
 * @param {object} rom
 * @returns {number[]|null}
 */
export function readRoboHead(rom) {
    const dv = rom.mainCpuView;
    const out = [];
    for (let i = 0; i <= HEAD_LAST; i++) {
        const a = EGG_ROBO_HEAD_ADDR + i * 4;
        if (a + 4 > rom.maincpu.length) return null;
        const id = dv.getUint32(a, true);
        if (!id || id > 5103) return null;
        out.push(id);
    }
    return out;
}

/**
 * Which of the four quarter-routines the ROM puts in each phase, so a table
 * edited in the ROM is followed rather than the order assumed here.
 * @param {object} rom
 * @returns {number[]} four routine addresses
 */
export function readRoboAnims(rom) {
    const dv = rom.mainCpuView;
    const out = [];
    for (let i = 0; i < 4; i++) out.push(dv.getUint32(EGG_ROBO_ANIMS_ADDR + i * 4, true));
    return out;
}

/* The routine each phase runs, by the address `egg_robo_anims` names. */
const NOBI = 0x0001a05c, GURURI = 0x0001a070, TIZIMI = 0x0001a058;

/**
 * The boss's arm model for a displayed frame.
 * @param {number[]} arms from readMechArms()
 * @param {number} frame the display counter
 * @param {boolean} [hold] motion-kind bit 14, which pins it mid-swing
 * @returns {number} a model id
 */
export function armModel(arms, frame, hold = false) {
    if (hold) return ARM_HOLD_MODEL;
    return arms[(frame >>> ARM_SHIFT) & (ARM_COUNT - 1)];
}

/**
 * The minion's head for a displayed frame: which model, and how far round.
 *
 * @param {number[]} heads from readRoboHead()
 * @param {number[]} anims from readRoboAnims()
 * @param {number} frame the display counter
 * @returns {{model:number, spin:number}|null} null while the head is at rest,
 *   `spin` in 16-bit binary radians
 */
export function headFrame(heads, anims, frame) {
    if (frame & HEAD_WINDOW) return null;      /* the 192 frames it holds still */
    const phase = (frame >>> HEAD_PHASE_SHIFT) & 3;
    const step = frame & (HEAD_STEPS - 1);
    const routine = anims[phase];
    if (routine === GURURI) {
        const dir = (frame >> SPIN_FLIP_BIT) & 1 ? -SPIN_STEP : SPIN_STEP;
        return { model: heads[HEAD_LAST], spin: (step * dir) & 0xffff };
    }
    if (routine === NOBI) return { model: heads[Math.min(step, HEAD_LAST)], spin: 0 };
    if (routine === TIZIMI) {
        /* `subo r6, 15, r6` — the same walk with the step read backwards. */
        return { model: heads[Math.min(HEAD_STEPS - 1 - step, HEAD_LAST)], spin: 0 };
    }
    return null;                                /* rd_kao_rob_ex draws nothing */
}
