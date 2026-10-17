/*
 * What the opponent plays when a move lands: the motion the game picks for the
 * one it hits, guards or throws (TECHNICAL.md, "The opponent's reaction").
 * Virtua Fighter 2 and Fighting Vipers keep it the same way, at addresses of
 * their own (`rig.reactions` in js/games.js).
 *
 * set_mot_dat (VF2 0x1A1E4, FV 0x1B880) runs a motion's setup script,
 * `setups[id]` past a head of `head` bytes, through one handler per op; each
 * handler's length is the byte `lengths[op]` in the program ROM, op 0x10 is a
 * count and that many u16s, and 0 and 8 end it. Three ops say how the motion
 * hurts:
 *   - op 2's u16s at +1, +3 and +5 go to +0x808..+0x80C, the frames the attack
 *     opens, closes and winds down on (0x1C180 clears the open bit, move flag
 *     8, at the second);
 *   - op 4, the strike, puts its u16 at `strike` (+7 in FV, sub_1BB20; +0xA in
 *     VF2) at +0x828: the low byte is the kind of blow, bit 15 which side it
 *     comes from;
 *   - op 5, the throw, puts its u16 at +1 at +0x828 as well, and the throw code
 *     (VF2 0x14570, FV 0x13054) finds it again through calc_mht_adr (VF2
 *     0x1AB34, FV 0x1C0BC) and starts it on the one thrown, command 0x11.
 * coli_attack_chk (FV 0x25AA4) lets a strike land only from frame +0x808 on
 * and only while move flag 8 is set, so it lands on the first such frame.
 *
 * The one hit then takes its motion from the reaction picker (VF2 0x230D4, FV
 * 0x26978): `table[kind]` is forty u32s, five categories of eight, the index
 * category * 8 + 4 if it crouches (+0x1A4 bit 3) + 2 unless it faces the
 * attacker + the blow's side. The categories are attack_hit's callers' r8: 0
 * and 1 the guards, 2 the hit, 3 the counter hit (the "counter" string's
 * path) and 4 the knock-down (which writes the command 0xC000000). The game
 * keeps the low 13 bits as the motion; bit 15 turns the fighter round. Left
 * out as fight state: the side's other terms (both players' +0 words and the
 * defender's +0x1A4 bit 21), VF2's program-ROM table at 0x23D98 for a
 * defender with bit 25 set, and FV's 0x26A04 swap of 0x24D for 0x250 when
 * the defender's waist is low.
 */
import { resolveData } from './motion.js';

const MOTION_ID = 0x1fff;
const OP_END = 0, OP_LAST = 8, OP_TIMES = 2, OP_STRIKE = 4, OP_THROW = 5, OP_TABLE = 0x10;
const PER_KIND = 40, PER_CATEGORY = 8, CROUCH = 4, FACING_AWAY = 2;
const SIDE_BIT = 15, KIND_MASK = 0xff;

/** What the opponent can be made to play. `category` indexes the table. */
export const REACTIONS = [
    { key: 'same', label: 'the same motion' },
    { key: 'hit', label: 'hit', category: 2 },
    { key: 'counter', label: 'counter hit', category: 3 },
    { key: 'guard', label: 'guard', category: 0 },
    { key: 'down', label: 'knock-down', category: 4 },
];

function dataAt(rom, addr) {
    const r = resolveData(rom, addr);
    return r && r.off + 4 <= r.data.length ? r : null;
}

const u32At = (rom, addr) => { const r = dataAt(rom, addr); return r ? r.view.getUint32(r.off, true) : null; };

/* The setup script's ops, each as {op, at} in the record's view. */
function setupOps(rom, R, id) {
    const ptr = u32At(rom, R.setups + (id & MOTION_ID) * 4);
    const r = ptr && dataAt(rom, ptr);
    if (!r) return null;
    const dv = r.view, ops = [];
    let at = r.off + R.head;
    while (at < dv.byteLength) {
        const op = dv.getUint8(at);
        if (op === OP_END || op === OP_LAST || op >= R.ops) break;
        ops.push({ op, at });
        const len = op === OP_TABLE ? 2 + 2 * dv.getUint8(at + 1) : rom.mainCpuView.getUint8(R.lengths + op);
        if (!len) break;
        at += len;
    }
    return { dv, ops };
}

/**
 * How motion `id` hurts: a strike {kind, side, times}, a throw {victim}, or
 * null for a motion that does neither.
 */
export function attackOf(rom, id) {
    const R = rom.game.rig?.reactions;
    const s = R && setupOps(rom, R, id);
    if (!s) return null;
    const find = (want) => s.ops.find((o) => o.op === want);
    const strike = find(OP_STRIKE), throwOp = find(OP_THROW), times = find(OP_TIMES);
    if (strike) {
        const word = s.dv.getUint16(strike.at + R.strike, true);
        return {
            kind: word & KIND_MASK, side: word >> SIDE_BIT & 1,
            times: times ? [1, 3, 5].map((k) => s.dv.getInt16(times.at + k, true)) : null,
        };
    }
    if (throwOp) return { victim: s.dv.getUint16(throwOp.at + 1, true) & MOTION_ID };
    return null;
}

/**
 * The motion the one on the end of `attack` plays, for a REACTIONS entry, or
 * null. A throw's victim plays the throw's own, whatever is asked.
 */
export function reactionMotion(rom, attack, reaction, { behind = false, crouch = false } = {}) {
    if (!attack || reaction?.category == null) return null;
    if (attack.victim != null) return attack.victim;
    const R = rom.game.rig.reactions;
    if (attack.kind >= R.kinds) return null;
    const row = u32At(rom, R.table + attack.kind * 4);
    const index = reaction.category * PER_CATEGORY + (crouch ? CROUCH : 0) + (behind ? FACING_AWAY : 0) + attack.side;
    const entry = row && index < PER_KIND ? u32At(rom, row + index * 4) : null;
    return entry ? entry & MOTION_ID : null;
}

/**
 * The attacker's frame the reaction starts on: a throw's at once; a strike's
 * on the first frame from +0x808 on with move flag 8 set, where `flags` (the
 * motion's +0x1A4 by frame, js/vf2fighters.js moveFlags) is known, else on
 * +0x808 itself.
 */
export function landingFrame(attack, frames, flags = null) {
    if (!attack || attack.victim != null || !attack.times) return 1;
    const open = Math.max(1, attack.times[0]);
    if (flags) for (let f = open; f <= frames; f++) if (flags[f] & 0x100) return f;
    return Math.min(open, frames);
}
