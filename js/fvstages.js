/*
 * Fighting Vipers' stage-wide state that moves as a fight goes on: the light,
 * one material slot, and the Observation Deck's colours and corner lights.
 *
 * camera_control (0x1EEA0) builds the stage light every frame, at 0x1F348, as
 * Ry(VECTER_Y) Rx(VECTER_X) (0, 0, bright) — js/stages.js stageLight — and the
 * camera it starts from cancels out. Nothing in a fight writes bright again;
 * what moves is VECTER_Y (u16 0x501022), written before the build by one stage
 * or another:
 *
 *   0x1EF94  flags bit 16 (both Westerns)  += 10 a frame, as the town turns
 *   0x1F124  stage 7, Observation Deck     from the lit corner (hallState)
 *   0x1F1E0  stage 2, UFO Diner            sub_21884, the trucks' headlights
 *   0x1F1F0  stage 5, Bay Side             the camera's yaw (cam+0x26)
 *
 * fvStageHooks hangs the matching hook on the stage record: `lightAt(frame)`,
 * or `lightFromHeading(heading)` for the one that follows the camera; and
 * `materialsAt(frame)` and `cxlatAt` for the two stages that rewrite more.
 *
 * Two stages also draw what their record does not name: the Observation
 * Deck's lit corner picks its platform, poles and cage (`hall`), and the City
 * Hall Elevator has a shaft and four city panels (`elevator`). fvStageDraws
 * turns those into draws.
 */

import { stageLight } from './stages.js';
import { cabPose, passingPose, inside, SHAFT_PLANES, RISE } from './fvobjects.js';
import { xtraResolve } from './romset.js';

const TURNING = 1 << 0x10;
const UFO_DINER = 2, BAY_SIDE = 5, CITY_HALL = 6, OBSERVATION_DECK = 7;
/* The objects' clock, which the trucks run on: js/display.js FV_ROUND. */
const ROUND = 3600;
const CAB_ROUTINE = 0x0006d2fc;

const ANGLE = (2 * Math.PI) / 65536;
const toAngle = (rad) => Math.round(rad / ANGLE) & 0xffff;

export function fvStageHooks(rom, stage) {
    const [vx, vy] = stage.vecter;
    const light = (y) => stageLight(stage.bright, vx, y);
    if (stage.flags & TURNING) return { lightAt: (f) => light(vy + 10 * f) };
    if (stage.slot === BAY_SIDE) return { lightFromHeading: light };
    if (stage.slot === OBSERVATION_DECK) return observationDeck(rom, light);
    if (stage.slot === UFO_DINER) return ufoDiner(stage, light);
    if (stage.slot === CITY_HALL) return { elevator: readElevator(rom) };
    return {};
}

/* ---- the UFO Diner: sub_21884 ------------------------------------------- */

/*
 * The light swings to whichever truck's headlights face the arena. For each
 * of the two trucks (dword_543014, the parked cab; dword_543018, the one that
 * passes) sub_219A0 takes the bearing g1 from the truck to the arena centre,
 * how square on its heading is to that — cos(g1 - h) + 0.5, clamped to 0..1 —
 * and how near it is: full within 30, nothing past 80. The brighter one, the
 * cab on a tie, gives I = 64 + 191 · near · square.
 *
 * At I of 96 or more VECTER_Y snaps to that truck's bearing; below, it eases
 * back towards 0 by 1/256 of itself a frame, and I is held at 96. So the
 * light integrates, and is run forward from the stage's start. Material slot
 * 26 is uploaded every frame from 0x6CE33E4[26], 0xF0 diffuse and 0x80
 * ambient, both times I/256 — which replaces the stage's own slot 26 from the
 * first frame, headlights or none.
 */
const HEAD_VY0 = 0xf600;
const HEAD_NEAR = 30, HEAD_FADE = 50, HEAD_SNAP = 96;
const HEAD_SLOT = 26, HEAD_DIFFUSE = 0xf0, HEAD_AMBIENT = 0x80;

function beam({ x, z, h }) {
    const g1 = toAngle(Math.atan2(x, -z));
    const square = Math.min(Math.max(Math.cos((g1 - h) * ANGLE) + 0.5, 0), 1);
    const near = 1 - Math.min(Math.max(Math.hypot(x, z) - HEAD_NEAR, 0), HEAD_FADE) / HEAD_FADE;
    return { g1, I: Math.trunc(191 * near * square) + 64 };
}

function headlightStep(cab, { vy }, f) {
    const c = f % ROUND;
    let best = null;
    for (const p of [cab && cabPose(cab, c), passingPose(c)]) {
        if (!p) continue;
        const b = beam(p);
        if (!best || b.I > best.I) best = b;
    }
    if (best.I >= HEAD_SNAP) return { vy: best.g1, I: best.I };
    return { vy: (vy + ((-((vy << 16) >> 16)) >>> 8)) & 0xffff, I: HEAD_SNAP };
}

function ufoDiner(stage, light) {
    const cab = stage.objects.find((o) => o.routine === CAB_ROUTINE)?.path ?? null;
    let at = { f: -1, vy: HEAD_VY0, I: HEAD_SNAP };
    const run = (f) => {
        if (f < at.f) at = { f: -1, vy: HEAD_VY0, I: HEAD_SNAP };
        while (at.f < f) at = { f: at.f + 1, ...headlightStep(cab, at, at.f + 1) };
        return at;
    };
    return {
        lightAt: (f) => light(run(f).vy),
        materialsAt: (f) => {
            const { I } = run(f);
            return [{ slot: HEAD_SLOT, diffuse: (HEAD_DIFFUSE * I) >> 8, ambient: (HEAD_AMBIENT * I) >> 8 }];
        },
    };
}

/* ---- the Observation Deck: hall_stage_cont (0x6CC94) --------------------- */

/*
 * One corner of the deck is lit at a time. Every 128 frames of the camera's
 * clock (fa_camera+6) sub_23684 names the next corner, (c >> 7) & 3, and
 * hall_stage_cont fades: the lit corner goes dark over 12 frames — `dark` 0 to
 * 3, a step every three — then the new one is shown and comes up again over
 * nine. The counter hall_int seeds with 0xFFFF holds corner 0 lit for the
 * first 128.
 */
export function hallState(f) {
    if (f < 128) return { lit: 0, dark: 0 };
    const k = f >> 7, n = f & 127, g = (n / 3) | 0;
    return n < 12 ? { lit: (k - 1) & 3, dark: Math.min(g, 3) } : { lit: k & 3, dark: Math.max(6 - g, 0) };
}

/*
 * What the corner and the fade pick, read from the program ROM:
 *
 *   platform  sub_235BC     u16 0x2369C + lit·2 + dark·8
 *   poles     pole_disp     u16 0x23014 + lit·32 + dark·8 + k·2, pole k under
 *                           Ry(k·0x4000) (0x22ECC; pole_disp_f the rest)
 *   cage      boss_cage     eight panels at 0x22908 + lit·16 while lit, the
 *                           eight at 0x22948 once it fades
 *
 * The light (0x1F124) turns to the lit corner: VECTER_Y = ((4 - lit) & 3) ·
 * 0x4000 + 0x2000.
 */
const HALL_PLATFORM = 0x2369c, HALL_POLES = 0x23014, HALL_CAGE = 0x22908, HALL_CAGE_DARK = 0x22948;

export function readHall(rom) {
    const dv = rom.mainCpuView;
    const u16 = (a) => dv.getUint16(a, true);
    const corners = [0, 1, 2, 3];
    const list = (a, n) => Array.from({ length: n }, (_, i) => u16(a + i * 2));
    return {
        platform: corners.map((lit) => corners.map((dark) => u16(HALL_PLATFORM + lit * 2 + dark * 8))),
        poles: corners.map((lit) => corners.map((dark) => list(HALL_POLES + lit * 32 + dark * 8, 4))),
        cage: corners.map((lit) => list(HALL_CAGE + lit * 16, 8)),
        cageDark: list(HALL_CAGE_DARK, 8),
    };
}

/*
 * And the colours. sub_A80 has genelate_change_color_table (0xAC4) build
 * sixteen copies of the dark end of colorxlat, copy k at 256/(0x80 + 16k) of
 * it; change_color_table (0xD3C) then copies one channel a vsync back from the
 * copy the list for the lit corner names (0xF4C[lit]). Copy 8 is the table as
 * it was and copy 9 is 256/272 of it, and the lists hold those two: one or two
 * channels a shade down per corner. The copies cover luma 48..63 of rows 0..27
 * and the whole of rows 28..31, as far as luma 63.
 */
const HALL_DIM = [[1, 0, 0], [1, 0, 1], [0, 1, 1], [0, 0, 1]];   /* R, G, B per lit corner */
const CXLAT_CHANNEL = 0x4000, CXLAT_ROW = 0x200;

function dimCorner(cxlat, lit) {
    const view = new DataView(cxlat.buffer, cxlat.byteOffset, cxlat.byteLength);
    HALL_DIM[lit].forEach((dim, ch) => {
        if (!dim) return;
        for (let row = 0; row < 32; row++) {
            for (let luma = row < 28 ? 48 : 0; luma < 64; luma++) {
                const o = ch * CXLAT_CHANNEL + row * CXLAT_ROW + luma * 2;
                const v = Math.min(view.getUint16(o, true), 0xff);
                view.setUint16(o, Math.trunc((v * 256) / 272), true);
            }
        }
    });
}

function observationDeck(rom, light) {
    return {
        lightAt: (f) => light((((4 - hallState(f).lit) & 3) * 0x4000 + 0x2000) & 0xffff),
        hall: readHall(rom),
        cxlatAt: { key: (f) => hallState(f).lit, apply: dimCorner },
    };
}

/* ---- the City Hall Elevator: tou_disp_all (0x23B2C), tex_move_poly -------- */

/*
 * The shaft the car rises through, which ground_upper_disp hands to tou_disp
 * on stage 6. Two tables in the stage data, each entry a height and models to
 * stand there, drawn round the four sides with a quarter turn between:
 *
 *   0x6CE2654  u32 count, then 0x38 bytes each: +0x20 f32 y, +0x24 four u32
 *              models, side k drawn while tower_check has the camera inside
 *              plane k (0x22B24, 8.5 out) and the model is not 0
 *   0x6CE3214  u32 count, then 0x2C bytes each from 0x6CE3218: +0x20 u32
 *              model, +0x24 f32 y, all four sides by hashira_check2 (0x22B64,
 *              the diagonals at 6.72)
 *
 * Each entry's own clip-point test is a cull and is left out. And the city:
 * tex_move_poly draws the four panels unk_642065C names for stage 6, 0x24
 * bytes each from 0x64206A0 — +4 u16 model, +0x18/+0x20 f32 the point it faces
 * (x, z) — and set_tpd_data slides the texture of each with the camera.
 * Everything goes down by stage_ypos with the ground, which is the ride.
 */
const WALLS = 0x6ce2654, WALL_SIZE = 0x38, PILLARS = 0x6ce3214, PILLAR_SIZE = 0x2c;
const PANELS = 0x64206a0, PANEL_SIZE = 0x24, PANEL_COUNT = 4;
const MAX_ENTRIES = 64;

function readElevator(rom) {
    const at = (a) => {
        const r = xtraResolve(rom, a);
        return { u32: (o) => r.view.getUint32(r.off + o, true), u16: (o) => r.view.getUint16(r.off + o, true),
            f32: (o) => r.view.getFloat32(r.off + o, true) };
    };
    const count = (a) => Math.min(at(a).u32(0), MAX_ENTRIES);
    const walls = Array.from({ length: count(WALLS) }, (_, i) => {
        const e = at(WALLS + 4 + i * WALL_SIZE);
        return { y: e.f32(0x20), models: [0, 1, 2, 3].map((k) => e.u32(0x24 + k * 4)) };
    });
    const pillars = Array.from({ length: count(PILLARS) }, (_, i) => {
        const e = at(PILLARS + 4 + i * PILLAR_SIZE);
        return { model: e.u32(0x20), y: e.f32(0x24) };
    });
    const panels = Array.from({ length: PANEL_COUNT }, (_, i) => {
        const e = at(PANELS + i * PANEL_SIZE);
        return { model: e.u16(4), x: e.f32(8), z: e.f32(0x10), face: [e.f32(0x18), e.f32(0x20)] };
    });
    return { walls, pillars, panels };
}

const DIAGONAL_PLANES = [[-6.718, 6.718], [-6.718, -6.718], [6.718, -6.718], [6.718, 6.718]];

/*
 * set_tpd_data (0x332CC): the bearing from the camera to the panel less the
 * bearing the panel faces, its tangent times 647.5, in eighths of a texel
 * wrapped to the tile's 2048, added to v. A parallax: the city behind the
 * glass shifts as the camera goes round.
 */
const TPD_SCALE = 647.5 * 8, TPD_WRAP = 2048;
const bearing = (dx, dz) => Math.atan2(-dx, dz);

export function panelSlide(p, cam) {
    const d = bearing(p.x - cam.x, p.z - cam.z) - bearing(p.face[0] - p.x, p.face[1] - p.z);
    const t = Math.tan(d) * TPD_SCALE;
    if (!Number.isFinite(t)) return 0;
    return (((Math.trunc(t) % TPD_WRAP) + TPD_WRAP) % TPD_WRAP) / 8;
}

/* ---- the draws ----------------------------------------------------------- */

const ANGLE_DEG = 360 / 65536;
const down = (f) => ['t', [0, -RISE * (f % ROUND), 0]];
const side = (k) => ['r', k * 0x4000 * ANGLE_DEG];
const lift = (y) => ['t', [0, y, 0]];

/* A draw shown while the camera is inside plane k of a set. */
const sided = (model, layer, ops, planes, k) => ({
    model, layer, ops: ops(0),
    live: (f, cam) => ({ model, ops: ops(f), hidden: Boolean(cam) && !inside(planes, k, cam) }),
});

function elevatorDraws({ walls, pillars, panels }) {
    const out = [];
    for (const { y, models } of walls) {
        models.forEach((m, k) => {
            const turns = Array.from({ length: k }, () => side(1));
            if (m) out.push(sided(m, 'upper', (f) => [down(f), lift(y), ...turns], SHAFT_PLANES, k));
        });
    }
    for (const { model, y } of pillars) {
        for (let k = 0; k < 4; k++) {
            const turns = Array.from({ length: k }, () => side(1));
            out.push(sided(model, 'upper', (f) => [down(f), lift(y), ...turns], DIAGONAL_PLANES, k));
        }
    }
    for (const p of panels) {
        out.push({
            model: p.model, layer: 'ground', ops: [], slides: true,
            live: (f, cam) => ({ model: p.model, ops: [down(f)], uv: [0, cam ? panelSlide(p, cam) : 0] }),
        });
    }
    return out;
}

/*
 * The Observation Deck's arena, in place of the record's: sub_235BC's
 * platform, the four poles (pole_disp and pole_disp_f between them draw all
 * four, by the same mask, in two windows) and boss_cage's eight panels under
 * cage_clip_m's six-unit push.
 */
function hallDraws({ platform, poles, cage, cageDark }, cagePush) {
    const at = (f) => hallState(f);
    const out = [{
        model: platform[0][0], layer: 'platform', planeBias: 0,
        anim: { frames: platform.flat(), index: (f) => at(f).lit * 4 + at(f).dark },
        ops: [],
    }];
    for (let k = 0; k < 4; k++) {
        const frames = poles.flat().map((l) => l[k]);
        out.push({
            model: frames[0], layer: 'poles', ops: [side(k)],
            anim: { frames, index: (f) => at(f).lit * 4 + at(f).dark },
        });
    }
    for (let i = 0; i < 8; i++) {
        const frames = [...cage.map((l) => l[i]), cageDark[i]];
        out.push({
            model: frames[0], layer: 'cage', ops: cagePush,
            anim: { frames, index: (f) => (at(f).dark ? 4 : at(f).lit) },
        });
    }
    return out;
}

/* What fvStageHooks found to draw, as display-list entries. */
export function fvStageDraws(stage, cagePush) {
    if (stage.hall) return hallDraws(stage.hall, cagePush);
    if (stage.elevator) return elevatorDraws(stage.elevator);
    return [];
}
