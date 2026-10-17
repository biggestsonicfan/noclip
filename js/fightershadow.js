/*
 * fightershadow.js — the fighters' floor shadows (TECHNICAL.md, "The
 * fighters' shadows"): a flat model under each part, slid along the stage's
 * light onto the floor.
 *
 * Both games send the coprocessor the stage light every frame (VF2 0x61684,
 * FV 0x5FA7C, Fn_kage_mat): three projections into its inner matrices, from
 * the light's elevation a0 and azimuth a1:
 *   inner[0] = Ry(r) S(1, 0, 1) Rx(a0 - 0x4000) Ry(-r)       the flattening
 *   inner[1] = C Ry(r) S(1, 1, 1/sin a0) Ry(-r)               the ring's floor
 *   inner[2] = C Ry(r) T(0, f, -f cot a0) S(1, 1, 1/sin a0) Ry(-r)  below it
 * with r = a1 ^ 0x8000, C the camera and f the ground's height (0x50A010).
 * Fn_kage_flag sorts the parts by one ball each, slid along the light onto
 * y = 0 (VF2 0x61A14, FV 0x6027C), and the draw (VF2 0x61BA0, FV 0x60640)
 * takes each part of the fighter's table its mask names: current = inner[0] *
 * unit[slot], moved by the entry's offset (flag bit 2), one axis laid flat
 * along another, then inner[1] or inner[2] in front.
 *
 * Everything here is in the pose's board frame (y up), with no camera.
 */
import { resolveData } from './motion.js';
import { coproSin, coproCos, turnedInOrder } from './pose.js';

const ENTRY = 24;
const ENTRIES = 15;
const FLAG_OFFSET = 4;
/* The ball test's margins: a part is on the ring inside the ring less 0.3,
 * off it outside the ring plus 0.2, and neither between. FV's lamp-lit
 * stage widens both by 0.2 (0x601BC). */
const NEAR = -0.3;
const FAR = 0.2;
const LAMP_WIDER = 0.2;
/* The stage flags that stop FV's shadows (0x602F0): bit 8 draws the mirror
 * instead (0x5FAA4), and bit 31 waits on the fight's own event bits
 * (0x574004 & 15), which every round starts with clear. */
const NO_SHADOW = (1 << 8) | (1 << 31);
/* Fn_kage_flag's round test (stages whose 0x60B98 byte is set). */
const ROUND = 0.70710677;
const ANGLE = 32768 / Math.PI;

/* The tables are in the program ROM, the rest in the data ROMs. */
const at = (rom, a) => (a < 0x2000000 ? { view: rom.mainCpuView, off: a } : resolveData(rom, a));
const u8 = (rom, a) => { const r = at(rom, a); return r.view.getUint8(r.off); };
const u32 = (rom, a) => { const r = at(rom, a); return r.view.getUint32(r.off, true); };
const f32 = (rom, a) => { const r = at(rom, a); return r.view.getFloat32(r.off, true); };
const u16 = (rom, a) => { const r = at(rom, a); return r.view.getUint16(r.off, true); };

/* A fighter's table: 15 entries of slot, model, flags and an offset. */
function readTable(rom, at) {
    return Array.from({ length: ENTRIES }, (_, i) => {
        const e = at + i * ENTRY;
        return { slot: u32(rom, e), model: u32(rom, e + 4), flags: u32(rom, e + 8), offset: [0, 4, 8].map((o) => f32(rom, e + 12 + o)) };
    });
}

/* Slot s's list of balls: VF2 keeps a pointer per slot; FV's boot (0x1A84)
 * lays them `inline` bytes apart from slot 1, slot 0 having none. */
const listOf = (rom, B, s) => (B.inline ? B.lists + B.inline * (s - 1) : u32(rom, B.lists + 4 * s));

/* Each slot's test ball, a point in the slot's frame; none for a slot with no
 * list. VF2 tests the middle one of its list (0x61A14), FV the first (the
 * coprocessor's 0x306E0 reads each slot's first). */
function readBalls(rom, B) {
    return Array.from({ length: 16 }, (_, s) => {
        const count = u8(rom, B.counts + s);
        if (!count) return null;
        const b = u8(rom, listOf(rom, B, s) + (B.first ? 0 : (count - 1) >> 1));
        return [0, 4, 8].map((o) => f32(rom, B.points + 4 * b + o));
    });
}

/**
 * The shadow tables of a game whose rig has them (`rig.shadow`), read once:
 * the fighters' tables, by the character (VF2 player +0x1B1) or the record
 * (FV +0x1B0, player 2's look 13 on), and the test balls.
 */
export function readShadows(rom) {
    const S = rom.game.rig?.shadow;
    if (!S) return null;
    const tables = Array.from({ length: S.count }, (_, c) => readTable(rom, u32(rom, S.tables + 4 * c)));
    return { tables, balls: readBalls(rom, S.balls), spec: S };
}

/** Every model the shadows can draw, to build before they are needed. */
export function shadowModels(shadows) {
    return [...new Set(shadows.tables.flat().map((e) => e.model))];
}

/* FV's lamp-lit stage (0x60468): the light comes from whichever of four lamps
 * on the ring's sides is nearest slot 0 (+0x1F4; the last on a tie), from
 * azimuth 0x8000 less its bearing, and the lower the further in. */
function lampLight(rom, L, stage, ring, [px, , pz]) {
    let best = 10000, lamp = null;
    for (let i = 0; i < 4; i++) {
        const x = f32(rom, L.at + 8 * i) * ring, z = f32(rom, L.at + 8 * i + 4) * ring;
        const d = Math.hypot(px - x, pz - z);
        if (!(d > best)) { best = d; lamp = { x, z }; }
    }
    const word = (y, x) => Math.floor(Math.atan2(y, x) * ANGLE) & 0xffff;
    const a1 = (0x8000 - word(px - lamp.x, pz - lamp.z)) & 0xffff;
    return { a0: word(f32(rom, L.heights + 4 * stage), Math.max(ring + 1 - best, 0)), a1 };
}

/**
 * What the shadows are drawn with on stage `stage` (0x500064), for a fighter
 * whose slot 0 stands at `root`: the light { a0, a1 }, the ground, the ring's
 * margins and its test; null on a stage that draws none. Only the first lamp
 * stage's near shadows are drawn: its far ones wait on +0xA29, fight state.
 */
export function shadowSetting(rom, shadows, stage, root) {
    const S = shadows.spec;
    if (S.gates && u32(rom, S.gates + 12 * stage) & NO_SHADOW) return null;
    const lamp = S.lamps && u8(rom, S.lamps.stages + stage) !== 0;
    const rec = S.stages.at + stage * S.stages.stride + S.stages.light;
    const light = lamp ? lampLight(rom, S.lamps, stage, S.ring, root) : { a0: u16(rom, rec), a1: u16(rom, rec + 2) };
    const wider = lamp ? LAMP_WIDER : 0;
    return {
        light,
        ground: S.grounds ? f32(rom, S.grounds + 4 * stage) : S.ground,
        near: S.ring + NEAR + wider,
        far: lamp ? Infinity : S.ring + FAR + wider,
        round: Boolean(S.round && u8(rom, S.round + stage)),
    };
}

const turn = (turns) => turnedInOrder([1, 0, 0, 0, 1, 0, 0, 0, 1], turns);
const scaled = (r, k) => r.map((v, i) => v * k[Math.floor(i / 3)]);
const apply = (r, v) => [0, 1, 2].map((i) => r[i] * v[0] + r[3 + i] * v[1] + r[6 + i] * v[2]);
/* a·b, each { r, t }. */
const times = (a, b) => ({ r: [0, 3, 6].flatMap((c) => apply(a.r, b.r.slice(c, c + 3))), t: apply(a.r, b.t).map((v, i) => v + a.t[i]) });

/* Fn_kage_mat's three, with no camera. */
function projections({ a0, a1 }, ground) {
    const inv = 1 / coproSin(a0), cot = inv * coproCos(a0);
    const r = (a1 ^ 0x8000) & 0xffff, back = (0x10000 - r) & 0xffff;
    const Y = 1, X = 0;
    const lean = turn([[Y, r]]);
    /* The ground's move comes before the stretch and the turn back, so
     * neither touches it. */
    const along = turnedInOrder(scaled(lean, [1, 1, inv]), [[Y, back]]);
    return {
        flat: { r: turnedInOrder(scaled(lean, [1, 0, 1]), [[X, (a0 - 0x4000) & 0xffff], [Y, back]]), t: [0, 0, 0] },
        ring: { r: along, t: [0, 0, 0] },
        ground: { r: along, t: apply(lean, [0, ground, -ground * cot]) },
    };
}

/* Fn_kage_leave_x_axis or _z_axis: one column's level heading copied into
 * the y column's, and the other level column turned square to it. */
function laidFlat(r, alongX) {
    const m = r.slice();
    const [i, j] = alongX ? [0, 6] : [6, 0];
    const k = 1 / Math.hypot(m[i], m[i + 2]);
    const nx = m[i] * k, nz = m[i + 2] * k;
    m[3] = nx; m[5] = nz;
    if (alongX) { m[j] = -nz; m[j + 2] = nx; } else { m[j + 2] = -nx; m[j] = nz; }
    return m;
}

/* Which axis an entry's flags lay flat: VF2 bit 0 the x, else the z
 * (0x61BA0); FV bit 1 the z, else bit 0 the x, else neither (kage_poly). */
function laid(r, flags, leave) {
    if (leave.z == null) return laidFlat(r, flags & leave.x);
    if (flags & leave.z) return laidFlat(r, false);
    return flags & leave.x ? laidFlat(r, true) : r;
}

/*
 * Fn_kage_flag: each slot's ball slid along the light to y = 0, near while
 * it is above the floor and within the near margin of the middle (on both
 * axes, or round), far once it is past the far one. Slot 0 takes slot 9's.
 */
function masks(balls, pose, { light: { a0, a1 }, near: n, far: f, round }) {
    const cot = coproCos(a0) / coproSin(a0);
    const r = (a1 + 0x8000) & 0xffff;
    const kx = -coproSin(r) * cot, kz = coproCos(r) * cot;
    let near = 0, far = 0;
    balls.forEach((ball, s) => {
        if (!ball) return;
        const [x, y, z] = apply(pose[s].r, ball).map((v, i) => v + pose[s].t[i]);
        const fx = x + kx * y, fz = z + kz * y;
        const d = round ? ROUND * Math.hypot(fx, fz) : Math.max(Math.abs(fx), Math.abs(fz));
        /* The sign bit: -0 is below. */
        if ((y > 0 || Object.is(y, 0)) && !(d > n)) near |= 1 << s;
        else if (!(d < f)) far |= 1 << s;
    });
    const nine = (m) => (m & ~1) | ((m >> 9) & 1);
    return { near: nine(near), far: nine(far) };
}

/* FV's draw skips slot 9 while the move flags have both bits (0x60690). */
const skipped = (S, slot, flags) => S.skip && slot === S.skip.slot && (flags & S.skip.flags) === S.skip.flags;

/**
 * What the draw sends for one fighter: { model, r, t } in the board frame for
 * each entry of table `index` (the character, or the record: readShadows)
 * whose slot is on the ring (inner[1]) or off it (inner[2]), under `setting`
 * (shadowSetting). `pose` is the fighter's, in the frame the light is in;
 * `flags` the move flags on its frame.
 */
export function shadowDraws(shadows, index, pose, setting, flags = 0) {
    const S = shadows.spec;
    const table = shadows.tables[index % shadows.tables.length];
    const P = projections(setting.light, setting.ground);
    const m = masks(shadows.balls, pose, setting);
    const out = [];
    for (const [mask, front] of [[m.near, P.ring], [m.far, P.ground]]) {
        for (const e of table) {
            if (!((mask >> e.slot) & 1) || skipped(S, e.slot, flags)) continue;
            const part = e.flags & FLAG_OFFSET
                ? { r: pose[e.slot].r, t: apply(pose[e.slot].r, e.offset).map((v, i) => v + pose[e.slot].t[i]) }
                : pose[e.slot];
            const cur = times(P.flat, part);
            out.push({ model: e.model, ...times(front, { r: laid(cur.r, e.flags, S.leave), t: cur.t }) });
        }
    }
    return out;
}

/**
 * `pose` stood where `at` puts it: `at` a column-major 4x4 in the viewer's
 * frame (opponentMatrix's), taken back to the board's by negating what
 * crosses z once, as js/pose.js's toViewer does the other way.
 */
export function placedPose(at, pose) {
    const r = [0, 1, 2].flatMap((c) => [0, 1, 2].map((w) => ((c === 2) !== (w === 2) ? -1 : 1) * at[c * 4 + w]));
    const P = { r, t: [at[12], at[13], -at[14]] };
    return pose.map((p) => times(P, p));
}
