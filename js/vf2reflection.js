/*
 * vf2reflection.js — Virtua Fighter 2's fighters in the Mirror stage's floor
 * (TECHNICAL.md, "Virtua Fighter 2's per-frame fighter draw").
 *
 * After the mirror floor (0x20400), the draw calls 0x20488. On a stage whose
 * flags (record +0x68, 0x6EEA0) have bit 5, it pushes, scales by (1, -1, 1)
 * on top of the camera, and calls 0x19C94 for each player that is drawn.
 * That routine, gated on player +0 bit 7 as rob_disp is, draws for each of
 * the sixteen slots the model the character record's +0x34 list gives,
 * on the matrix the slot's pose stored (0x1B803737, player +4, slot x 12).
 * The stored matrices are the world's, so the copy is the pose reflected
 * through the floor's plane, y = 0. The list is the slot's, whatever the
 * mirror bit: a mirrored fighter's copy is its mirrored pose, reflected.
 *
 * 0x2069C skips a part the fight camera cannot see; the Animation tab has
 * only its orbit view, so every part is drawn.
 *
 * Kage's and Pai's head piece has its own. After the piece (0x193C8),
 * rob_disp's slot 2 case, on the same stage flag, multiplies the piece's
 * matrix by 0x501960 (0x47, from the left), which 0x1E52C stored as
 * camera * S(1, -1, 1) * camera^-1, and draws +0x75C: the piece reflected
 * through y = 0, in a model of its own. It does so only while the head's
 * point (+0x20C, slot 2's) is at or above the floor and within the ring
 * (0x50A00C) less 1 in x and in z.
 *
 * Everything here is in the pose's board frame (y up).
 */
import { resolveData } from './motion.js';

const SLOTS = 16;

const u32 = (rom, at) => { const r = resolveData(rom, at); return r ? r.view.getUint32(r.off, true) : 0; };

/** The sixteen models record `body.root` keeps at +0x34 for the copy, or
 * null in a game without it. */
export function reflectionModels(rom, body) {
    const R = rom.game.rig?.reflection;
    const list = R && body?.root ? u32(rom, body.root + R.list) : 0;
    if (!list) return null;
    return Array.from({ length: SLOTS }, (_, s) => u32(rom, list + 4 * s));
}

/** Whether stage number `stage` has the mirror floor's flag (the stage
 * records are in the program ROM). */
export function stageReflects(rom, stage) {
    const R = rom.game.rig?.reflection;
    if (!R || stage == null) return false;
    const at = R.stages.at + R.stages.stride * stage + R.stages.flags;
    return ((rom.mainCpuView.getUint16(at, true) >> R.bit) & 1) === 1;
}

/** The head piece's reflection, `piece` ({ model, r, t } in the board
 * frame, vf2fighters.js headPieceReflection) reflected as 0x193CC draws it,
 * or null while the head (slot 2 of `pose`) is out of 0x193CC's bounds. */
export function pieceReflectionDraw(rom, piece, pose) {
    const P = rom.game.rig?.reflection?.piece;
    if (!P || !piece) return null;
    const [x, y, z] = pose[2].t, bound = P.ring - P.less;
    if (!(y >= 0) || Math.abs(x) > bound || Math.abs(z) > bound) return null;
    return reflectionDraws([piece.model], [piece])[0] ?? null;
}

/** What 0x19C94 sends under 0x20488's scale: { model, r, t } in the board
 * frame for each slot of `pose`. */
export function reflectionDraws(models, pose) {
    return models.map((model, s) => {
        const { r, t } = pose[s];
        return { model, r: r.map((v, i) => (i % 3 === 1 ? -v : v)), t: [t[0], -t[1], t[2]] };
    }).filter((d) => d.model > 0);
}
