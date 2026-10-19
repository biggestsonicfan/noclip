/*
 * fvstrobe.js — Fighting Vipers' light strobe (TECHNICAL.md, "The light
 * strobe"): the light a fighter is drawn by flickering through some of its
 * motions.
 *
 * Each frame 0x1F000 gives each player a light of its own: the light vector
 * (0x50108C) times a scale (P1 0x50109C, P2 0x5010A0), which the draw sends
 * to the geometrizer (command 0xA0A, 0x1FDD0 and 0x1FE44) before that
 * player's rob_disp. The scale is 0x50A0E0[fighter], which the scene's start
 * (0x21614) fills with 1.0 (0x2176C) and then, on stages 2 and 9 only, lowers
 * for some records (0x21794): stageFighterLight. Then (0x1F1FC, 0x1F258)
 * while the player's +0x720 has bit 5 or bit 10, or its +0x1A4 has bit 26,
 * the scale is instead a phase of its own
 * (P1 0x5010F0, P2 0x5010F4) stepped by 0.8 a frame, back to -2.0 once it
 * passes 2.0: 1.8, -2, -1.2, -0.4, 0.4, 1.2, 2, -2, ... The light swings
 * from twice as strong to the other side and back every six frames. The
 * phase is set to 1.0 when the fight's scene starts (0x1ED44) and nothing
 * else writes it, so it runs on from one motion into the next and only
 * steps on the frames the gate is open.
 *
 * A tick runs the script, then the light, then the draw, so the gate the
 * script leaves on frame N decides frame N: in MAME's attract, motion 551
 * steps from frame 1 (its setup's bit 5) through 32, and op 26 on frame 33
 * leaves frame 33 at 1.0.
 */
import { lightFlags, moveFlags } from './vf2fighters.js';

const STEP = Math.fround(0.8), TOP = 2, BOTTOM = -2;
const START = 1;

/* One frame's step of the phase, in the board's single precision. */
function stepPhase(v) {
    const next = Math.fround(v + STEP);
    return next > TOP ? BOTTOM : next;
}

/* Whether the strobe runs on each frame of `motion` (index = frame), or
 * null for a motion or game with none. */
function strobeGate(rom, motion) {
    const S = rom.game.rig?.strobe;
    if (!S || motion?.id == null) return null;
    const cache = (rom.strobeGates ??= new Map());
    if (cache.has(motion.id)) return cache.get(motion.id);
    const light = lightFlags(rom, motion.id, motion.frames);
    const flags = moveFlags(rom, motion);
    let gate = null;
    if (light) {
        gate = Array.from(light, (w, f) => f > 0 && ((w & S.bits) !== 0 || ((flags?.[f] ?? 0) >> S.flag & 1) === 1));
        if (!gate.includes(true)) gate = null;
    }
    cache.set(motion.id, gate);
    return gate;
}

/** Record `record`'s light scale on stage `stage` (0x500064), 1.0 but where
 * 0x21794 sets one. */
export function stageFighterLight(rom, stage, record) {
    const bits = rom.game.rig?.strobe?.stages?.[stage]?.[record];
    if (bits == null) return 1;
    const v = new DataView(new ArrayBuffer(4));
    v.setUint32(0, bits);
    return v.getFloat32(0);
}

/**
 * The light's scale on `frame` of `motion`, and the phase it leaves, with
 * the phase `from` as the motion starts (1.0, the fight's start, by default).
 * A frame with the gate shut is drawn at `base`, the stage's scale
 * (stageFighterLight), and leaves the phase alone.
 */
export function strobeAt(rom, motion, frame, from = START, base = 1) {
    const gate = strobeGate(rom, motion);
    let phase = from, scale = base;
    for (let f = 1; gate && f <= Math.min(frame, motion.frames); f++) {
        if (!gate[f]) { scale = base; continue; }
        phase = scale = stepPhase(phase);
    }
    return { scale, phase };
}

/** The phase a run of `links` ({ decoded, length }) leaves, each played for its length. */
export function strobeAfter(rom, links) {
    return links.reduce((phase, l) => strobeAt(rom, l.decoded, l.length, phase).phase, START);
}
