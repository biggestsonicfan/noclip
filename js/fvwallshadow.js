/*
 * fvwallshadow.js — Fighting Vipers' shadows on Bay Side's walls
 * (TECHNICAL.md, "Fighting Vipers' wall shadows"): rob_kabe_kage_disp
 * (0x76944), which camera_control calls for each player just before
 * rob_disp.
 *
 * On a stage whose flags (0x6442BA8 + 12 x stage) have bit 31, and, with bit
 * 7, the fight's event bits (0x574004 & 15) clear, 0x76A98 builds two walls
 * from slot 0's point (+0x1F4) and the light's angle (the camera's yaw,
 * +0x26, or the record's +8 with bit 4): the ring's side the camera looks
 * toward along z, and the one along x. Each is a pair of the coprocessor's
 * inner matrices: the lower turns the world so the view runs along the axis
 * the wall drops and moves the fighter's own line to 0, the upper lays that
 * on the wall where the fighter's line meets it, stretched by 1.7 and by
 * 1 / cos (1 / sin for the x wall) of the angle, at most 3. No wall when the
 * fighter is outside the ring, or when the cosine (sine) is 0.
 *
 * 0x77AF8 draws each wall in turn, the z wall first: for each of the
 * fighter's 15 table entries, upper x lower x the slot's matrix, unless the
 * slot's point lands higher than the stage's top (0x6CE35A4) plus the slot's
 * own (0x6443EDC). The z wall takes only a point within the ring plus 0.1,
 * and the x wall only the slots the z wall did not. Neither draws while the
 * camera is beyond it. The model is the entry's +0x18 for slot 9 while its
 * point is 0.2 high or less, 0xBB8 / 0xBB9 for slots 15 / 12 unless move
 * flags bit 14 or 4 is up, else +0x10 for a broken slot (+0x1F48), +4, or
 * with the item in hand (+0 bit 27) +8, mirrored too (+0 bit 6) +0xC. The
 * carried item, while it is not in hand, is drawn on whichever wall first
 * takes its matrix (the ring entry rob_disp left the frame before), as entry
 * [+0x788]'s +0x14, if that wall drew its slot.
 *
 * 0x7860C then lays model 0xAB6 on the floor under each slot 1..15 lower
 * than 0.24 (the feet), turned by the floor bearing from the slot's point to
 * its wall point plus half a turn, 0.4 wide and 1.15 x that distance long.
 * The wall point is the last 0x77AF8 stored (0x50F600, by slot); a slot no
 * wall stored this pass, which the game would draw from an older pass, is
 * left out.
 *
 * Everything here is in the pose's board frame (y up), with no camera.
 */
import { resolveData } from './motion.js';
import { coproSin, coproCos, turnedInOrder } from './pose.js';

const ENTRY = 28;
const ENTRIES = 15;
const SCALE = 1.7;            /* 0x50A3D0 / D4 / D8, set at boot (0x7690) */
const STRETCH_MAX = 3;
const DROP = -0.08;
const MARGIN = 0.1;
const LOW_HIPS = 0.2;
const STREAK = { model: 0xab6, below: 0.24, width: 0.4, length: 1.15 };
const LIGHT_FIXED = 1 << 4, OWN_RING = 1 << 5, EVENTS = 1 << 7, WALLS = 1 << 31;
const ANGLE = 32768 / Math.PI;
const Y = 1;

const at = (rom, a) => (a < 0x2000000 ? { view: rom.mainCpuView, off: a } : resolveData(rom, a));
const u32 = (rom, a) => { const r = at(rom, a); return r.view.getUint32(r.off, true); };
const i16 = (rom, a) => { const r = at(rom, a); return r.view.getInt16(r.off, true); };
const f32 = (rom, a) => { const r = at(rom, a); return r.view.getFloat32(r.off, true); };

/**
 * The tables of a game whose rig has them (`rig.wallShadow`), read once: each
 * record's 15 entries of slot and six models, and each slot's height.
 */
export function readWallShadows(rom) {
    const W = rom.game.rig?.wallShadow;
    if (!W) return null;
    const tables = Array.from({ length: W.count }, (_, c) => {
        const t = u32(rom, W.tables + 4 * c);
        return Array.from({ length: ENTRIES }, (_, i) => ({
            slot: u32(rom, t + ENTRY * i),
            models: Array.from({ length: 6 }, (_, k) => u32(rom, t + ENTRY * i + 4 + 4 * k)),
        }));
    });
    const heights = Array.from({ length: 16 }, (_, s) => f32(rom, W.heights + 4 * s));
    return { tables, heights, spec: W };
}

/** Every model the walls can draw. */
export function wallShadowModels(walls) {
    return [...new Set([...walls.tables.flat().flatMap((e) => e.models), 0xbb8, 0xbb9, STREAK.model])];
}

/**
 * The stage's wall setting, or null on a stage that draws none: the ring
 * and, with flag bit 4, the stage's own angle. The event bits are the
 * fight's, clear at every round's start, so bit 7 lets the walls through.
 */
export function wallSetting(rom, walls, stage, ring) {
    const W = walls.spec;
    const rec = W.gates + 12 * stage;
    const flags = u32(rom, rec);
    if (!(flags & WALLS)) return null;
    return {
        ring: flags & OWN_RING ? f32(rom, rec + 4) : ring,
        yaw: flags & LIGHT_FIXED ? i16(rom, rec + 8) & 0xffff : null,
        top: f32(rom, W.tops + 4 * stage),
    };
}

const apply = (r, v) => [0, 1, 2].map((i) => r[i] * v[0] + r[3 + i] * v[1] + r[6 + i] * v[2]);
const times = (a, b) => ({ r: [0, 3, 6].flatMap((c) => apply(a.r, b.r.slice(c, c + 3))), t: apply(a.r, b.t).map((v, i) => v + a.t[i]) });
const scaled = (k) => [k[0], 0, 0, 0, k[1], 0, 0, 0, k[2]];
const turnY = (a) => turnedInOrder([1, 0, 0, 0, 1, 0, 0, 0, 1], [[Y, a & 0xffff]]);
const word = (y, x) => Math.floor(Math.atan2(y, x) * ANGLE) & 0xffff;

/* 0x76A98: the two walls, each { lo, hi, beyond }, or null. */
function buildWalls({ ring: D }, yaw, [x, , z], eye) {
    if (!(Math.abs(x) < D) || !(Math.abs(z) < D)) return null;
    if (yaw === 0x4000) yaw = 0x4001;
    else if (yaw === 0xc000) yaw = 0xc001;
    const sin = coproSin(yaw), cos = coproCos(yaw), tan = sin / cos;
    const zs = ((yaw ^ (yaw << 1)) & 0x8000) ? -1 : 1, xs = yaw & 0x8000 ? 1 : -1;
    const Zw = zs * D, Xw = xs * D;
    const stretch = (v) => (v === 0 ? null : Math.min(1 / v, STRETCH_MAX));
    const out = { z: null, x: null };
    const kz = stretch(cos);
    if (kz != null) {
        const X0 = zs * -tan * (D - zs * z) + x;
        const a = (0x10000 - yaw) & 0xffff;
        out.z = {
            lo: { r: turnY(a), t: [-x * coproCos(a) + z * coproSin(a), 0, 0] },
            hi: { r: scaled([SCALE * kz, SCALE, 0]), t: [X0, DROP, Zw] },
            beyond: zs < 0 ? !(eye[2] > Zw) : !(eye[2] < Zw),
        };
    }
    const kx = stretch(coproSin((yaw + 0x8000) & 0xffff));
    if (kx != null) {
        const Z0 = xs * (-1 / tan) * (D - xs * x) + z;
        const a = (0xc000 - yaw) & 0xffff;
        out.x = {
            lo: { r: turnY(a), t: [0, 0, -x * coproSin(a) - z * coproCos(a)] },
            hi: { r: scaled([0, SCALE, SCALE * kx]), t: [Xw, DROP, Z0] },
            beyond: xs < 0 ? !(eye[0] > Xw) : !(eye[0] < Xw),
        };
    }
    return out;
}

/* 0x77AF8's model for entry `e` whose point is `p`. */
function modelFor(e, p, { flags, broken, held, mirrored }) {
    if (e.slot === 9 && !(p[1] > LOW_HIPS)) return e.models[5];
    if (!(flags & ((1 << 14) | (1 << 4)))) {
        if (e.slot === 15) return 0xbb8;
        if (e.slot === 12) return 0xbb9;
    }
    if ((broken >> e.slot) & 1) return e.models[3];
    if (!held) return e.models[0];
    return mirrored ? e.models[2] : e.models[1];
}

/**
 * What rob_kabe_kage_disp sends for one fighter: { model, r, t } in the
 * board frame. `index` is the record (+0x1B0); `pose` the fighter's, in the
 * board frame the light is in; `view` { yaw, eye } the camera's yaw word and
 * place in that frame; `state` { flags, broken, held, mirrored } the move
 * flags, the broken slots' mask, the item in hand and the mirror; `item`
 * { slot, r, t } the carried item's matrix while it is not in hand, or null.
 */
export function wallShadowDraws(walls, index, pose, setting, view, state, item = null) {
    const yaw = setting.yaw ?? view.yaw;
    const W = buildWalls(setting, yaw & 0xffff, pose[0].t, view.eye);
    if (!W) return [];
    const table = walls.tables[index % walls.tables.length];
    const D = setting.ring;
    const out = [], stored = new Map();
    let taken = 0, itemTaken = false;
    for (const [wall, first] of [[W.z, true], [W.x, false]]) {
        if (!wall) continue;
        const project = (m) => times(wall.hi, times(wall.lo, m));
        let drawn = 0;
        for (const e of table) {
            if ((taken >> e.slot) & 1) continue;
            const m = project(pose[e.slot]);
            const p = m.t;
            if (p[1] > setting.top + walls.heights[e.slot]) continue;
            if (first) {
                if (Math.abs(p[0]) > D + MARGIN || Math.abs(p[2]) > D + MARGIN) continue;
                taken |= 1 << e.slot;
            }
            stored.set(e.slot, p);
            if (wall.beyond) continue;
            drawn |= 1 << e.slot;
            out.push({ model: modelFor(e, p, state), ...m });
        }
        if (item && !state.held && !itemTaken) {
            const m = project(item);
            if (!(Math.abs(m.t[0]) > D) && !(Math.abs(m.t[2]) > D)) {
                itemTaken = true;
                const e = table[item.slot];
                if (e && (drawn >> item.slot) & 1) out.push({ model: e.models[4], ...m });
            }
        }
    }
    for (let s = 1; s < 16; s++) {
        const [x, y, z] = pose[s].t, q = stored.get(s);
        if (!(y < STREAK.below) || !q) continue;
        const a = (word(x - q[0], q[2] - z) + 0x8000) & 0xffff;
        const len = Math.hypot(x - q[0], z - q[2]) * STREAK.length;
        out.push({ model: STREAK.model, r: turnedInOrder(scaled([1, 1, 1]), [[Y, a]]).map((v, i) => v * [STREAK.width, 0, len][Math.floor(i / 3)]), t: [x, 0, z] });
    }
    return out;
}
