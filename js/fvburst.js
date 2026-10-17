/*
 * fvburst.js — Fighting Vipers' burst (TECHNICAL.md, "The burst"): a picture
 * the game draws on a fighter for the first fifteen frames of some motions.
 *
 * After both fighters, the draw (0x1FEEC) calls 0x21E40, which for each
 * player, while +0x720 has bit 10 or +0x1A4 has bit 26, pushes, translates to
 * +0x1F4 (slot 0's point, this frame's pose: the draw runs after it), and
 * while the motion frame +0x1AA is at most 15 turns by the camera's yaw
 * alone (0x4800909, g13 +0x26), scales by 0.5 and draws the model the u16
 * table 0x6CE35E4 gives for that frame. The tests are on the motion's own
 * words, so no fight state decides it.
 *
 * Everything here is in the pose's board frame (y up).
 */
import { resolveData } from './motion.js';
import { lightFlags, moveFlags } from './vf2fighters.js';

/** The table's models by frame, and the gate's bits, or null for a game
 * without it. */
export function readBurst(rom) {
    const B = rom.game.rig?.burst;
    if (!B) return null;
    const r = resolveData(rom, B.table);
    const models = Array.from({ length: B.last + 1 }, (_, i) => r.view.getUint16(r.off + 2 * i, true));
    return { ...B, models };
}

/** Every model the table can pick, to build before they are needed. */
export function burstModels(burst) {
    return [...new Set(burst.models.filter((m) => m > 0))];
}

/* Whether 0x21E40's test passes on `frame` of `motion`. */
function burstGate(rom, burst, motion, frame) {
    if (motion?.id == null || frame > motion.frames) return false;
    const light = lightFlags(rom, motion.id, motion.frames);
    if (((light?.[frame] ?? 0) >>> burst.lightBit) & 1) return true;
    return (((moveFlags(rom, motion)?.[frame] ?? 0) >>> burst.flag) & 1) === 1;
}

/*
 * What 0x21E40 draws on `frame` of a motion: the frame's model at slot 0's
 * point of `pose` (the board-frame pose of this frame), sized by the scale
 * and turned by `turn` (the camera's yaw, each axis's image in turn).
 */
export function burstDraws(rom, burst, motion, frame, { pose, turn }) {
    if (frame > burst.last || !burstGate(rom, burst, motion, frame)) return [];
    const model = burst.models[frame];
    if (!model) return [];
    return [{ model, r: turn.map((v) => v * burst.scale), t: pose[0].t.slice() }];
}
