/*
 * scenes.js — the scene records of a game whose stages are not otherwise read.
 *
 * A Model 2 scene decides four things about how a model looks that are not in
 * the model: the light the geometry engine dots every normal against, the 32
 * material slots a polygon's attribute word picks between, which texture sets
 * are resident, and the per-channel trim the colour tables are built through.
 * Sonic The Fighters keeps all four in the stage record js/stages.js reads,
 * along with the draw list that makes the stage a stage. Fighting Vipers keeps
 * them in a table of its own, in the second data bank, and this reads that.
 *
 * It is deliberately not stage support. What a stage is made of — which models
 * are drawn where, and what animates — is a separate table and is not located.
 * What is here is everything needed to light and colour a lone model the way a
 * scene would, which is what the Models tab wants.
 *
 * The addresses are the ones change_scene, stage_disp and sub_24878 use; the
 * field offsets in js/games.js are read straight off those three routines.
 */

import { xtraResolve } from './romset.js';
import { stageLight } from './stages.js';

/*
 * The 32 material slots a scene uploads.
 *
 * sub_24878 is the whole of it: take the scene's pointer out of the array at
 * `off_6CE33A4`, then push 32 words at the geometry engine behind command
 * 0x606. A word is packed the way the board's material register is, and the
 * debug editor at sub_56694 names every field of it as it builds one — diffuse
 * in bits 0-7, ambient in 8-15, specular in 16-23, mirror in 24-31. Only the
 * first two reach the shader, which is the same pair js/stages.js hands it.
 */
function readMaterials(rom, index) {
    const m = rom.game.scenes.materials;
    const p = xtraResolve(rom, m.ptrs);
    const ptr = p.view.getUint32(p.off + index * 4, true);
    const out = [];
    if (ptr >= 0x06000000 && ptr < 0x07000000) {
        const t = xtraResolve(rom, ptr);
        for (let i = 0; i < m.count; i++) {
            const w = t.view.getUint32(t.off + i * 4, true);
            out.push({ diffuse: w & 0xff, ambient: (w >> 8) & 0xff });
        }
    }
    /* A scene whose pointer is not one leaves the slots at the board's reset
     * state rather than at whatever the array happened to hold. */
    while (out.length < m.count) out.push({ diffuse: 255, ambient: 0 });
    return out;
}

/**
 * Read every scene record the game has.
 *
 * @param {object} rom loaded ROM set
 * @returns {object[]} one entry per scene, empty when the game has no such table
 */
export function readScenes(rom) {
    const S = rom.game.scenes;
    if (!S) return [];
    const f = S.fields;
    const out = [];
    for (let i = 0; i < S.count; i++) {
        const r = xtraResolve(rom, S.base + i * S.stride);
        const v = r.view, o = r.off;
        const bright = v.getFloat32(o + f.bright, true);
        out.push({
            index: i,
            bright,
            /* The same two rotations of (0, 0, bright) the other game's record
             * describes, through the same helper — it is the board's formula,
             * not either game's. */
            light: stageLight(bright, v.getInt16(o + f.vecterX, true),
                v.getInt16(o + f.vecterY, true)),
            /* What change_scene hands send_tex_stage. */
            texSets: [v.getInt16(o + f.tex0, true), v.getInt16(o + f.tex1, true)],
            /* stage_disp copies these three to 0x5000E0 as RED/GREEN/BLUE, and
             * 128 is unity there. */
            tint: [f.red, f.green, f.blue].map((k) => r.data[o + k] / 128),
            materials: readMaterials(rom, i),
        });
    }
    return out;
}
