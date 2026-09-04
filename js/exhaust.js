/*
 * exhaust.js — Metal Sonic's jet exhaust.
 *
 * `rob_disp` walks the sixteen slots and, after drawing each one's mesh,
 * dispatches on the slot through the table at `0x1A184`. Slot 1 — the chest,
 * `unit_efc_mune` — is where a fighter's chest effects hang, and it dispatches
 * again on the character byte at `0x1B1(g7)`:
 *
 *     cmpobne 4, r4, loc_1A274 ; call efc_fang_gun_disp        Fang
 *     cmpobne 3, r4, loc_1A27C ; call efc_metalsonic_disp      Metal Sonic
 *
 * so nothing else in the roster reaches `efc_metalsonic_disp` at `0x1AABC`.
 * That byte is the fighter's own index folded onto the base roster, which is
 * why the mirror half — character 29 — gets the flame too.
 *
 * The routine is short enough to quote whole:
 *
 *     ld    0x0(g7), r3
 *     bbs   29, r3, ret            not while the fighter is on display
 *     ldos  0x40(g7)[1*4], r3      the chest object currently installed
 *     cmpobe 0x18D, r3, ret        397  — the closed chest
 *     cmpobe 0x7E4, r3, ret        2020 — the closed chest, recoloured
 *     ld    frame_counter, r3
 *     shro  1, r3, r5 ; and 3, r5, r5
 *     bbs   0, r3, burst
 *     ldos  yellow_cone_exhaust[r5*2], r4  ; set_obj r4 ; ret
 *  burst:
 *     ldos  yellow_burst_exhaust[r5*2], r4 ; set_obj r4
 *
 * `set_obj` draws at the matrix that is current, and nothing moves it first:
 * the flame is drawn on the chest's own matrix, and it is the mesh that puts it
 * behind him. There is no bone and no interpolation — the plume *is* the model,
 * one of eight.
 *
 * Two tables of four `u16` sit at `0x1AB24` and `0x1AB2C`, immediately before
 * Tails' two entry points. The frame counter picks a table on its bottom bit
 * and an entry on the two above it, so the cycle is eight frames long and
 * alternates the two shapes: a cone that stretches, then a burst that widens.
 * `metal_and_lunar_fox_exhaust` at `0x97568` is the same eight ids in that
 * order as `u32`, which is a second statement of the sequence in data.
 *
 * **What the viewer cannot know is *when*.** The flame is gated on the chest
 * object, and the chest is swapped by an opcode in the per-motion script —
 * `player_body_change_action` at `0x33308`, which reads
 * `player_body_animation[char]` at `0xC6710` and stores the entry the command's
 * byte names into `0x40(g7)[slot*4]`. Metal Sonic is the only character in that
 * 52-entry table with a body table at all, and his is two ids long: 397, the
 * chest he stands in, and 2461, the same chest with its vent open — 0.06 taller
 * along the axis the flame runs down. The guard above rejects the two closed
 * chests by id, so the pair is one effect: the vent opens and the flame lights
 * together. Nothing in the keyframe block says which frames the script fires it
 * on, so the viewer, which plays a motion and not an action, makes it a switch.
 */

/* The slot the flame is drawn on, and so the frame it is drawn in. */
export const CHEST_SLOT = 1;

/* The character byte `unit_efc_mune` compares against, at `0x1A274`. */
const METAL_SONIC = 3;

/* Per character: the two plume tables. Keyed by roster index, so the mirror
 * half is named rather than derived — the ROM folds it onto 3 in a byte the
 * viewer does not keep. */
const EXHAUST_TABLES = {
    3: { cone: 0x0001ab24, burst: 0x0001ab2c },
    29: { cone: 0x0001ab24, burst: 0x0001ab2c },
};

/* Four entries a table, two tables, one frame each. */
export const PHASE_COUNT = 4;
export const CYCLE_LENGTH = PHASE_COUNT * 2;

/* `player_body_animation`, 52 pointers to a per-character list of chest ids. */
const BODY_ANIM_TABLE = 0x000c6710;

/* The chest ids `efc_metalsonic_disp` returns on, as immediates at `0x1AAD0`
 * and `0x1AAD8`: 397 is the chest in Metal Sonic's part table and 2020 is the
 * same mesh and the same texture points under a second set of face colours. */
export const CLOSED_CHESTS = [397, 2020];

/**
 * Read Metal Sonic's plume tables, or null for a character that has none.
 *
 * @param {object} rom
 * @param {number} charIndex index into CHAR_PARTS
 * @returns {?{coneAddr:number, burstAddr:number, cone:number[], burst:number[],
 *             cycle:number[], bodyAddr:number, bodies:number[]}}
 */
export function readExhaust(rom, charIndex) {
    const t = EXHAUST_TABLES[charIndex];
    if (!t) return null;
    const dv = rom.mainCpuView;
    if (t.burst + PHASE_COUNT * 2 > rom.maincpu.length) return null;
    const read = (addr) => {
        const out = [];
        for (let i = 0; i < PHASE_COUNT; i++) out.push(dv.getUint16(addr + i * 2, true));
        return out;
    };
    const cone = read(t.cone), burst = read(t.burst);

    /* The chest pair the script swaps between. Read rather than named: the
     * routine's own guard is by id, and this is where the id it wants comes
     * from. A character with no body table keeps the chest its part table has. */
    const bodyAddr = charIndex < 52
        ? dv.getUint32(BODY_ANIM_TABLE + charIndex * 4, true) : 0;
    const bodies = [];
    if (bodyAddr && bodyAddr + 4 <= rom.maincpu.length) {
        bodies.push(dv.getUint16(bodyAddr, true), dv.getUint16(bodyAddr + 2, true));
    }

    return {
        coneAddr: t.cone,
        burstAddr: t.burst,
        cone,
        burst,
        /* Flattened into the order the frame counter walks them, which is the
         * order `metal_and_lunar_fox_exhaust` states outright. */
        cycle: Array.from({ length: CYCLE_LENGTH },
            (_, i) => (i & 1 ? burst : cone)[(i >> 1) & (PHASE_COUNT - 1)]),
        bodyAddr,
        bodies,
    };
}

/**
 * The chest the fighter is drawn in, given whether the vent is open.
 *
 * `player_body_change_action`'s two entries: index 0 is the chest the part
 * table already holds, index 1 the one with the vent open. Falls back to the
 * part table's own for a character the body table does not reach.
 *
 * @param {?object} exhaust from readExhaust()
 * @param {boolean} open
 * @param {number} fallback the part table's chest for this slot
 */
export function chestModel(exhaust, open, fallback) {
    return exhaust?.bodies[open ? 1 : 0] ?? fallback;
}

/**
 * Whether the flame is drawn at all, by the routine's own test: the chest
 * object installed on slot 1 is neither of the two closed chests.
 *
 * @param {number} chest the model id on the chest slot
 */
export function exhaustDrawn(chest) {
    return !CLOSED_CHESTS.includes(chest);
}

/**
 * Which of the eight plumes is up on a frame.
 *
 * `frame` is the game's own free-running counter, not the motion frame: the
 * routine reads `frame_counter` at `0x500020` and the cycle is eight long, so
 * a motion shorter than that still shows the whole of it.
 *
 * @param {number} frame the display counter
 * @returns {number} 0..7
 */
export function exhaustPhase(frame) {
    return ((frame % CYCLE_LENGTH) + CYCLE_LENGTH) % CYCLE_LENGTH;
}

/**
 * Place the flame on a solved pose.
 *
 * @param {Array<{r:number[],t:number[]}>} pose from buildPose(), board frame
 * @param {object} exhaust from readExhaust()
 * @param {number} frame the display counter
 * @returns {?{model:number, r:number[], t:number[], phase:number}}
 */
export function exhaustPart(pose, exhaust, frame = 0) {
    if (!exhaust) return null;
    const b = pose[CHEST_SLOT];
    if (!b) return null;
    const phase = exhaustPhase(frame);
    /* No `set_pos` and no `ang_*`: the chest's matrix is handed to `set_obj`
     * exactly as `rob_disp` left it. */
    return { model: exhaust.cycle[phase], phase, r: b.r.slice(), t: b.t.slice() };
}
