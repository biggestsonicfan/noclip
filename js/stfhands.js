/*
 * stfhands.js — Sonic the Fighters' hands, from the move script.
 *
 * Op 0x10 is `[slot][entry]`, and `load_action_from_list` (`0x330D0`) calls
 * the handler `0x33338[slot]` names; slots 5 and 8 both go to `0x33254`:
 *
 *     ldob  0x1B0(g7), r3 ; ld 0xC6570[r3*4], g0    the character's hand table
 *     ldob  0x3(g4), r3                             the slot
 *     bbc   6, 0x0(g7), keep                        mirrored: 5 <-> 8
 *     r5 = slot == 8 ? 16 : 0
 *     ldob  0x4(g4), r4 ; addo r5, r4, r4           the entry
 *     ldos  (g0)[r4*2]: 0 leaves the slot be, else st 0x40(g7)[slot*4]
 *
 * So each character has 32 models, sixteen for slot 5 and sixteen for slot
 * 8, and the op writes one over the part list's slot as Fighting Vipers' op
 * 18 does, skipping a 0. A mirrored fighter has the slot turned first and
 * takes the other half, so the mirror moves the shape, not the model, as in
 * the other games (TECHNICAL.md, "The hands").
 *
 * Unlike Virtua Fighter 2 and Fighting Vipers, the hands do not carry from
 * one motion into the next: `set_mot_dat` (`0x1B508`-`0x1B544`) puts entry
 * 0 of both halves back in slots 5 and 8 whenever a motion starts, unless
 * its skeleton type (record byte 12, `+0x84C`) is 3. Entry 0 is the part
 * list's own hand for every character but Tails' second look and Super
 * Sonic's (character 42 has Sonic's second look's table). A type 3 motion
 * keeps what the last one left, which the explorer cannot know, so it starts
 * from the part list's hands.
 */
import { progAddr } from './romset.js';
import { commandsBy, motionSkeletonType } from './motion.js';

const HAND_TABLES = 0x000c6570;
const CHARS = 52;
export const HAND_SLOTS = [5, 8];
const SHAPES = 16;
const OP_PART_CHANGE = 0x10;
const KEEPS_HANDS = 3;

/**
 * The character's hand models, or null if it has no table.
 * @returns {?{5:number[], 8:number[]}} sixteen s16 models a slot
 */
export function readStfHands(rom, charIndex) {
    if (!(charIndex >= 0 && charIndex < CHARS)) return null;
    const dv = rom.mainCpuView;
    const at = dv.getUint32(progAddr(rom, HAND_TABLES) + charIndex * 4, true);
    if (!at || at + 4 * SHAPES > rom.maincpu.length) return null;
    const half = (h) => Array.from({ length: SHAPES }, (_, i) => dv.getInt16(at + 2 * (h * SHAPES + i), true));
    return { [HAND_SLOTS[0]]: half(0), [HAND_SLOTS[1]]: half(1) };
}

/**
 * The models slots 5 and 8 hold on `frame` of motion `id`.
 * @param {{5:number[], 8:number[]}} hands readStfHands
 * @param {Array} script readMotionScript
 * @returns {Object<number, number>} slot to model; a slot left out keeps
 *   the part list's
 */
export function stfHandsAt(rom, hands, id, script, frame, mirrored) {
    const out = {};
    if (motionSkeletonType(rom, id) !== KEEPS_HANDS) {
        for (const s of HAND_SLOTS) out[s] = hands[s][0];
    }
    for (const c of commandsBy(script, frame)) {
        if (c.op !== OP_PART_CHANGE) continue;
        let slot = rom.maincpu[c.at + 3];
        if (!HAND_SLOTS.includes(slot)) continue;
        if (mirrored) slot = slot === HAND_SLOTS[1] ? HAND_SLOTS[0] : HAND_SLOTS[1];
        const model = hands[slot][rom.maincpu[c.at + 4]];
        if (model) out[slot] = model;
    }
    return out;
}
