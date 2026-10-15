/*
 * Fighting Vipers' stage objects: the trucks, the UFO and the signs that move
 * while a fight goes on.
 *
 * The stage record's +0xB4 names a list that object_init (0x6AC74) copies into
 * object RAM — an `int` and a `dsp` per object, the same 24-byte entries as
 * Sonic The Fighters' — and object_cont (0x6ACEC) runs every int once a frame,
 * then steps one clock: the u16 at mod_fa_obj0+6 (0x6AD5C). There is no
 * per-object counter. The clock is zeroed in change_scene and again in
 * ROUND_INT (0xC778), which reinstalls object_init as well, so everything here
 * starts over at every round. Frame 0 below is the first frame of a round.
 *
 * object_control (0x6AD6C) then calls every dsp inline, under the camera and a
 * stage yaw (word_50A022) that is 0 in a fight. There is no window list as in
 * the other game: what is drawn here is sorted with the arena.
 *
 * Each routine is a port of the dsp at the address it is keyed by, with what
 * its int works out folded in, as a pure function of the frame. The ops are the
 * board's, through display.js's helpers: a translation loses its Z, an ang_z its
 * sign, and ang_x and ang_y go in as they are.
 */

import { xtraResolve } from './romset.js';

const ANGLE_DEG = 360 / 65536;
const at = (x, y, z) => ['t', [x, y, -z]];
const angY = (a) => ['r', (a & 0xffff) * ANGLE_DEG];
const angX = (a) => ['rx', (a & 0xffff) * ANGLE_DEG];
const angZ = (a) => ['rz', -(a & 0xffff) * ANGLE_DEG];
const scale = (x, y, z) => ['s', [x, y, z]];

/* ---- object_move_int (0x6ADFC): a keyed path ---------------------------- */

/*
 * The key records an object_move_int path is made of, 0x1C bytes each:
 *
 *   +0x00  u16  type    0 hold, 1 linear, 2 Hermite, 3 coast, 4 stop
 *   +0x02  u16  frame   the clock the key is reached at
 *   +0x04  f32  pos[3]
 *   +0x10  f32  ang[3]  binary angles, as floats
 *
 * read to the first type 4 (or 3, which runs on for ever).
 */
const KEY_SIZE = 0x1c;
const MAX_KEYS = 64;

export function readObjectPath(rom, addr) {
    if (!addr || (addr >>> 24) !== 0x06) return null;
    const r = xtraResolve(rom, addr);
    const keys = [];
    for (let i = 0; i < MAX_KEYS; i++) {
        const o = r.off + i * KEY_SIZE;
        if (o + KEY_SIZE > r.data.length) return null;
        const type = r.view.getUint16(o, true);
        if (type > 4) return null;
        const f = (k) => r.view.getFloat32(o + 4 + k * 4, true);
        keys.push({
            type,
            frame: r.view.getUint16(o + 2, true),
            v: [f(0), f(1), f(2), f(3), f(4), f(5)],
        });
        if (type === 4 || type === 3) return keys;
    }
    return null;
}

const h00 = (u) => 2 * u * u * u - 3 * u * u + 1;
const h10 = (u) => u * u * u - 2 * u * u + u;
const h01 = (u) => -2 * u * u * u + 3 * u * u;
const h11 = (u) => u * u * u - u * u;

/* A tangent, as 0x6AF50 takes it: the difference over the frames between,
 * shifted down by 5 as an integer before the divide. */
const slope = (a, b, k) => {
    const d = (b.frame - a.frame) >> 5;
    return d ? (b.v[k] - a.v[k]) / d : 0;
};

/*
 * The type-2 step, 0x6AF50: a cubic Hermite from key i to key i+1 on both the
 * position and the angles, through op 0x19003232. The out-tangent is zero on
 * the first span (+0x40, the keys passed, is still 0) and the slope across the
 * neighbours after; the in-tangent is zero into a stop, the span's own slope
 * into a coast, and the slope from this key to the one after next otherwise.
 * The coprocessor scales the tangents by span/30.
 */
function hermiteAt(keys, i, c) {
    const cur = keys[i], next = keys[i + 1];
    const span = next.frame - cur.frame;
    const u = (c - cur.frame) / span, s = span / 30;
    const after = keys[i + 2];
    return cur.v.map((v0, k) => {
        const m0 = i === 0 ? 0 : slope(keys[i - 1], next, k);
        const m1 = next.type === 4 ? 0
            : next.type === 3 || !after ? slope(cur, next, k)
                : slope(cur, after, k);
        return h00(u) * v0 + h01(u) * next.v[k] + s * (h10(u) * m0 + h11(u) * m1);
    });
}

/* Where the path puts its object at clock c, or null once it has stopped.
 * 0x6AE18 rescans from the first key every frame. */
export function pathAt(keys, c) {
    let i = 0;
    while (i + 1 < keys.length && c >= keys[i + 1].frame) i++;
    const cur = keys[i], next = keys[i + 1];
    if (cur.type === 4) return null;
    if (cur.type === 3) return coastAt(keys, i, c);
    if (!next || cur.type === 0 || c === cur.frame) return cur.v;
    if (cur.type === 1) {
        const t = (c - cur.frame) / (next.frame - cur.frame);
        return cur.v.map((v, k) => (k < 3 ? v + (next.v[k] - v) * t : v));
    }
    if (cur.type === 2) return hermiteAt(keys, i, c);
    return cur.v;
}

/* Type 3, 0x6B230: on from the last frame before the key at that frame's
 * step (+0x2C, which only the position has), the angles left where they were. */
function coastAt(keys, i, c) {
    const f = keys[i].frame;
    const a = pathAt(keys, f - 1), b = pathAt(keys, f - 2);
    if (!a || !b) return keys[i].v;
    const n = c - f + 1;
    return a.map((v, k) => (k < 3 ? v + n * (v - b[k]) : v));
}

const pathPos = (v) => at(v[0], v[1], v[2]);
/* The angles land in s16s at +0x24..0x28 through cvtri. */
const pathYaw = (v) => Math.round(v[4]);

/* ---- kanban (0x6D0C4): UFO Diner's neon ---------------------------------- */

/*
 * Three models, set_obj'd with no transform at all: the first swaps on bit 5
 * of frame_counter, the second on a random byte re-rolled every fourth frame
 * (a hash of the frame stands in for rand, so a scrub shows the same flicker),
 * the third is still. The third and the trucks below have a second set of
 * models picked by a backup-RAM byte (+0x3350) that reads like a region; this
 * draws the set for 0.
 */
const KANBAN_BLINK = [0xa82, 0xa83];
const KANBAN_FLICKER = [0xbb2, 0xbb3];
const KANBAN_STILL = 0xe53;

const flicker = (f) => {
    let x = Math.imul((f >> 2) + 1, 0x9e3779b1);
    x ^= x >>> 15;
    return (Math.imul(x, 0x85ebca6b) >>> 31) & 1;
};

function kanbanDsp({ push, pushFrames }) {
    pushFrames(KANBAN_BLINK, (f) => (f >> 5) & 1, []);
    pushFrames(KANBAN_FLICKER, flicker, []);
    push(KANBAN_STILL, []);
}

/* ---- the parked truck: trailer_dsp (0x6D2FC) and trailer_dsp_b0 (0x6D6E4) */

const TRUCK_WHEEL = 0xae5;
const TRUCK_CAB = 0xae4;
const TRUCK_TRAILER = 0xae3;
const WHEEL_Y = 0.461, WHEEL_Z = 1.1, AXLE = 2.2;
/* trailer_int's hitch and rear points, 0xc0200000 and 0xc1066666. */
const HITCH = 2.5, REAR = 8.4;

/* The board's ang_y applied to (0, 0, d): its third column times d. */
const turnZ = (a, d) => {
    const r = (a * 2 * Math.PI) / 65536;
    return [-Math.sin(r) * d, Math.cos(r) * d];
};

/*
 * The angle the cab's front wheels steer by: 0x6D15C pulls a rear point along
 * behind a hitch 2.5 back of the cab, the way a trailer follows, and the wheels
 * take the difference from the cab's own yaw. It is a history, so it is run
 * forward from the round's start and kept.
 */
function articulation(keys) {
    const angles = [];
    let rear = null;
    return (c) => {
        for (let n = angles.length; n <= c; n++) {
            const v = pathAt(keys, n) ?? pathAt(keys, n - 1);
            const yaw = pathYaw(v);
            const [hx, hz] = turnZ(yaw, -HITCH);
            const ax = v[0] + hx, az = v[2] + hz;
            /* The dsp seeds the rear point straight behind on its first call,
             * after the int has already run once. */
            if (!rear) rear = [v[0] + HITCH + REAR, v[2]];
            const ang = Math.round((Math.atan2(rear[0] - ax, az - rear[1]) * 65536) / (2 * Math.PI));
            const [rx, rz] = turnZ(ang, -REAR);
            rear = [ax + rx, az + rz];
            angles.push(ang);
        }
        return angles[c];
    };
}

/*
 * The four wheels: the dsps step a translate before each one, so the n-th sits
 * at the sum of the first n steps. A turn the routine pushes round a wheel it
 * pops straight after, so it touches that wheel alone.
 */
const CAB_WHEELS = [[0, WHEEL_Y, WHEEL_Z], [0, 0, -AXLE], [2.9, 0, 0], [0, 0, AXLE]];
const TRAILER_WHEELS = [[7.3, WHEEL_Y, WHEEL_Z], [0, 0, -AXLE], [1.1, 0, 0], [0, 0, AXLE]];

function wheels(push, base, steps, turn = () => []) {
    const sum = [0, 0, 0];
    steps.forEach((step, i) => {
        for (let a = 0; a < 3; a++) sum[a] += step[a];
        const p = at(...sum);
        push(TRUCK_WHEEL, (f) => [...base(f), p, ...turn(f, i)]);
    });
}

/* The path's pose at f, held at the last key once the path has stopped. */
const keyed = (keys, f) => pathAt(keys, f) ?? keys[keys.length - 2]?.v ?? keys[0].v;

const truckBody = (keys) => (f) => {
    const v = keyed(keys, f);
    return [pathPos(v), angY(pathYaw(v)), angY(-0x4000)];
};

/* trailer_dsp: the cab, its front pair steered by -k. */
function cabDsp({ object, push }) {
    const keys = object.path;
    if (!keys) return;
    const steer = articulation(keys);
    const body = truckBody(keys);
    const k = (f) => (steer(f) - pathYaw(keyed(keys, f))) & 0xffff;
    push(TRUCK_CAB, body);
    wheels(push, body, CAB_WHEELS, (f, i) => (i < 2 ? [angY(-k(f))] : []));
}

/* trailer_dsp_b0: the trailer, on a path of its own. */
function trailerDsp({ object, push }) {
    const keys = object.path;
    if (!keys) return;
    const body = truckBody(keys);
    push(TRUCK_TRAILER, body);
    wheels(push, body, TRAILER_WHEELS);
}

/* ---- trailer_easy (0x6D9B0 / 0x6DAC0): the truck that passes ------------- */

/*
 * A second truck on a straight line along z = 21: in from x = 350 at 0.3 a
 * frame until clock 1600, then back out from x = -250 the other way, drawn
 * through a mirror in X (0x6DAFC) rather than turned. The yaw it stores is
 * never read by the draw. Its wheels roll on frame_counter << 12, a turn every
 * 16 frames, the cab's one way and the trailer's the other.
 */
const PASS_Z = 21, PASS_SPEED = 0.3, PASS_TURN = 1600;
const PASS_IN = 350, PASS_OUT = -250;
const PASS_MODELS = [[0xbb5, 0xbb4], [0xbb7, 0xbb6]];

function passingDsp({ push }) {
    const back = (f) => f >= PASS_TURN;
    const base = (f) => (back(f)
        ? [at(PASS_OUT + PASS_SPEED * (f - PASS_TURN), 0, PASS_Z), scale(-1, 1, 1)]
        : [at(PASS_IN - PASS_SPEED * f, 0, PASS_Z)]);
    const spin = (sign) => (f) => [angZ(sign * (f << 12))];
    /* The two phases draw different models, so each phase is its own pair of
     * draws, hidden while the other runs. */
    PASS_MODELS.forEach(([cab, trailer], phase) => {
        const on = (f) => back(f) === (phase === 1);
        const trailerAt = (f) => [...base(f), at(HITCH, 0, 0)];
        push(cab, base, on);
        wheels((m, ops) => push(m, ops, on), base, CAB_WHEELS, spin(-1));
        push(trailer, trailerAt, on);
        wheels((m, ops) => push(m, ops, on), trailerAt, TRAILER_WHEELS, spin(1));
    });
}

/* ---- ufo_dsp (0x6E3F8) ---------------------------------------------------- */

/*
 * The UFO over the diner, at (0, 4.5, -16.1), turning 64 binary units a frame
 * on a counter of its own that ufo_int zeroes at each round. 0x6E490 leaves it
 * out when the camera is on the far side of it — the sign of a dot product of
 * the camera's offset with the UFO's own position, 5 pulled towards the arena.
 */
const UFO = 0xae6;
const UFO_AT = [0, 4.5, -16.1];
const UFO_STEP = 64;
const UFO_CULL_PULL = 5;

function ufoDsp({ push }) {
    const [x, , z0] = UFO_AT;
    const z = z0 + UFO_CULL_PULL;
    push(UFO, (f) => [at(...UFO_AT), angY(f * UFO_STEP), angX(0)],
        (f, cam) => !cam || (x - cam.x) * x + (z - cam.z) * z >= 0);
}

/* ---- sub_6B7BC: the Airport's planes -------------------------------------- */

/*
 * Two planes on object_move_int paths, told apart by the entry's type: type 0
 * taxis across the apron with its gear down for a minute, type 1 takes off
 * down the runway from z = 800, folds its gear from clock 451 to 577 —
 * (c - 450) * 128, a Z roll on the two mains and an X roll on the nose — and is
 * a smaller model from clock 898 on, until its path ends at 1920.
 *
 * Each also lays a shadow on the ground under it, turned by its yaw, and an
 * arena-sized model scaled by the ring-out bound (dword_50A00C, 5.0) over 6.
 * The routine skips all of it while the plane is off screen (0x6B7BC-0x6BAE0),
 * which a viewer that goes anywhere has no use for.
 */
const PLANE_PARKED = 0xe51, PLANE_FLYING = 0x2a4, PLANE_FAR = 0xe52;
const PLANE_MAIN_GEAR = 0x1b7, PLANE_NOSE_GEAR = 0x1b6;
const PLANE_SHADOW = 0x70e, PLANE_GROUND = 0x569;
const MAIN_GEAR_AT = [7.2, 6.62, -1.8], NOSE_GEAR_AT = [0, 3.335, 31.14];
const GEAR_FROM = 450, GEAR_UP = 578, GEAR_STEP = 128, PLANE_FAR_FROM = 898;
const RING_OUT = 5.0;

function planeDsp({ object, push }) {
    const keys = object.path;
    if (!keys) return;
    const alive = (f) => pathAt(keys, f) !== null;
    const v = (f) => keyed(keys, f);
    const M = (f) => {
        const p = v(f);
        return [pathPos(p), angY(Math.round(p[4])), angX(Math.round(p[3])), angZ(Math.round(p[5]))];
    };
    const [gx, gy, gz] = MAIN_GEAR_AT;
    const mains = [[at(-gx, gy, gz)], [at(gx, gy, gz), scale(-1, 1, 1)]];
    const nose = at(...NOSE_GEAR_AT);
    if (object.type === 0) {
        push(PLANE_PARKED, M, alive);
        for (const m of mains) push(PLANE_MAIN_GEAR, (f) => [...M(f), ...m], alive);
        push(PLANE_NOSE_GEAR, (f) => [...M(f), nose], alive);
    } else {
        const g = (f) => (f > GEAR_FROM ? (f - GEAR_FROM) * GEAR_STEP : 0);
        const geared = (f) => alive(f) && f < GEAR_UP;
        push(PLANE_FLYING, M, (f) => alive(f) && f < PLANE_FAR_FROM);
        push(PLANE_FAR, M, (f) => alive(f) && f >= PLANE_FAR_FROM);
        for (const m of mains) push(PLANE_MAIN_GEAR, (f) => [...M(f), ...m, angZ(-g(f))], geared);
        push(PLANE_NOSE_GEAR, (f) => [...M(f), nose, angX(g(f))], geared);
    }
    push(PLANE_SHADOW, (f) => {
        const p = v(f);
        return [at(p[0], 0, p[2]), angY(Math.round(p[4]))];
    }, alive);
    push(PLANE_GROUND, [scale(RING_OUT / 6, 1, RING_OUT / 6)], alive);
}

/* sub_6C198: four of the Airport's models, at the identity. */
function airportStillDsp({ push }) {
    for (const m of [0x28a, 0x291, 0x292, 0x298]) push(m, []);
}

/* ---- the Factory: 0x6B260 and 0x6B4F4 ------------------------------------- */

/*
 * Two draw-only routines that watch the camera and nothing else. 0x6B260
 * draws 0xAE8 always, and 0x1B5 while the camera is on the arena's side of
 * x = 8 — 8·(8 - cam.x) not negative. Its third model, 0xAE9, only changes
 * window with the camera's height, which a depth buffer does not need.
 */
function factoryDsp({ push }) {
    push(0xae8, []);
    push(0x1b5, [], (f, cam) => !cam || cam.x <= 8);
    push(0xae9, []);
}

/*
 * 0x6B4F4, the four walls round the arena: model 0x1DC turned a quarter turn
 * further for each, at the ring-out bound. 0x22AC8 rebuilds a mask of them every
 * frame from the planes in 0x22B04, (0, 6), (-6, 0), (0, -6) and (6, 0) scaled by
 * the bound over 6, and a wall is drawn only while the camera stands beyond
 * its plane — outside looking in, it is the wall between.
 */
const FACTORY_WALL = 0x1dc;
const FACTORY_PLANES = [[0, 6], [-6, 0], [0, -6], [6, 0]];

function factoryWallsDsp({ push }) {
    const k = RING_OUT / 6;
    FACTORY_PLANES.forEach(([px, pz], i) => {
        push(FACTORY_WALL, [scale(k, 1, k), angY(i * 0x4000)],
            (f, cam) => !cam || (cam.x - k * px) * px + (cam.z - k * pz) * pz >= 0);
    });
}

/* ---- hashira_check (0x22B84) ---------------------------------------------- */

/*
 * Which of four planes round the arena the camera is inside: plane k is the
 * (x, z) pair k of a table, scaled by the ring-out bound over 6, and the camera
 * is inside it when (cam - s·p)·p is negative. Several routines show a wall
 * or a light by it.
 */
const ARENA_PLANES = [[0, 6], [-6, 0], [0, -6], [6, 0]];
const SHAFT_PLANES = [[0, 8.5], [-8.5, 0], [0, -8.5], [8.5, 0]];
const BOUND = RING_OUT / 6;

const inside = (planes, k, cam) => {
    const [px, pz] = planes[k];
    return (cam.x - BOUND * px) * px + (cam.z - BOUND * pz) * pz < 0;
};

/* The cull several dsps open with: a point the object stands near, seen
 * from the camera; drawn while (p - cam)·p is not negative, which is the camera
 * on the near side of it. */
const facing = (x, z) => (f, cam) => !cam || (x - cam.x) * x + (z - cam.z) * z >= 0;

/* ---- kuma_int / kuma_dsp (0x6C1CC / 0x6C49C): the Western bear ---------- */

/*
 * The bear on its stand swings back and forth about X, on a clock that is its
 * own integer pendulum (0x6C254): it accelerates by 0x2000 a frame until its
 * position reaches 0x10000000, bounces back elastically, and the angle is the
 * negated top half — 0 to about -22.5° and back, every 513 frames once the
 * first bounce has come at 256. Integer arithmetic, so it is run as the board
 * runs it. The hop it also has is the fight's: it fires only when a fighter is
 * knocked out through wall segment 20 (finish_coli_check), and is left out.
 */
const KUMA_STAND = 0x257, KUMA = 0x407, KUMA_W2 = 0x406;
const KUMA_AT = [-5.02, -0.2, -10.37];
const KUMA_ACCEL = 0x2000, KUMA_STOP = 0x10000000;

function kumaSwing() {
    const angles = [];
    let p = 0, v = 0;
    return (c) => {
        while (angles.length <= c) {
            let t = KUMA_ACCEL + v;
            p = (p + t) | 0;
            if (p >= KUMA_STOP) {
                t = KUMA_ACCEL + t;
                if (t > 0) t = -t;
            }
            v = t;
            angles.push(-(p >> 16));
        }
        return angles[c];
    };
}

function kumaDsp({ push }) {
    const swing = kumaSwing();
    const shown = facing(KUMA_AT[0], KUMA_AT[2]);
    push(KUMA_STAND, [], shown);
    push(KUMA, (f) => [at(...KUMA_AT), angX(swing(f)), angZ(0)], shown);
}

/* 0x6C400, Western 2: one model more, always drawn, then kuma_dsp. */
function kumaW2Dsp(ctx) {
    ctx.push(KUMA_W2, []);
    kumaDsp(ctx);
}

/* ---- 0x6C5B4 / 0x6C67C: City Hall Elevator -------------------------------- */

/*
 * The ride is the camera task's: on this stage (flags bit 3) 0x1EFBC adds
 * 0.017 a frame to stage_ypos, and what this object draws goes down by it —
 * the lights outside and the shaft's walls, so the car seems to rise. The
 * lights are a 128-frame flipbook of three groups of four (0x6C5E4 picks the
 * group, 0x6C664 holds them). The walls are pushed out to the arena's size by
 * a scale about a far pivot, (c - 2W) / (c - 12) along their normal, and each
 * is drawn only while the camera is inside it.
 */
const RISE = 0.017;
const ELEVATOR_LIGHTS = [[0x96f, 0x972, 0x974, 0x976], [0x971, 0x973, 0x975, 0x977], [0x978, 0x997, 0x998, 0x999]];
function elevatorGroup(c) {
    if (c < 2 || (c >= 64 && c < 66)) return 1;
    return c < 64 ? 2 : 0;
}
const ELEVATOR_WALLS = [[0x36c, 'z', 111.8], [0x36e, 'x', -61.8], [0x36d, 'z', -126.4], [0x36b, 'x', 71.62]];

function elevatorDsp({ push, pushFrames }) {
    const down = (f) => at(0, -RISE * f, 0);
    ELEVATOR_LIGHTS[0].forEach((_, i) => {
        pushFrames(ELEVATOR_LIGHTS.map((g) => g[i]), (f) => elevatorGroup(f & 0x7f), (f) => [down(f)]);
    });
    const W = RING_OUT;
    const k = (c) => (Math.abs(c) - 2 * W) / (Math.abs(c) - 12);
    ELEVATOR_WALLS.forEach(([model, axis, c], i) => {
        const T = axis === 'z' ? [0, 0, c] : [c, 0, 0];
        const S = axis === 'z' ? [BOUND, 1, k(c)] : [k(c), 1, BOUND];
        push(model, (f) => [down(f), at(...T), scale(...S), at(-T[0], -T[1], -T[2])],
            (f, cam) => !cam || inside(SHAFT_PLANES, i, cam));
    });
}

/* ---- hall_disp (0x6CCE0): the Observation Deck ---------------------------- */

/*
 * A still model and two spinners, ten units either side of the arena on Z,
 * the second turned half round; both turn 0x60 a frame on a counter the dsp
 * steps itself (a turn in 682.67 frames), each culled like the bear. The deck's
 * four-phase light cycle (hall_stage_cont) is lighting, not a draw.
 */
const HALL = 0x5d7, HALL_SPINNER = [0x1a6, 0x1a4];
const HALL_Z = 10, HALL_CULL_Z = 9, HALL_STEP = 0x60;

function hallDsp({ push }) {
    push(HALL, []);
    for (const [z, flip] of [[HALL_Z, 0], [-HALL_Z, 0x8000]]) {
        const ops = (f) => [at(0, 0, z), ...(flip ? [angY(flip)] : []), angY(f * HALL_STEP)];
        for (const m of HALL_SPINNER) push(m, ops, facing(0, Math.sign(z) * HALL_CULL_Z));
    }
}

/* ---- 0x6CAF8: Bay Side — sixteen models, at the identity ------------------ */

function baySideDsp({ push }) {
    for (let m = 0x9fd; m <= 0xa0c; m++) push(m, []);
}

/* ---- 0x6CF38: the Tower's lights ------------------------------------------ */

/*
 * A still model, then the lights on the four sides, a quarter turn apart and
 * at the ring-out bound: a fade up, a hold and a fade down on frame_counter
 * (0x6D034 into 0x6D0B4), shown on a side while the camera is inside that
 * side's plane or the next one round.
 */
const TOWER = 0x56f, TOWER_LAMP = 0x56e;
const TOWER_LIGHTS = [0x570, 0x571, 0x572, 0x573];
const TOWER_FADE = [[3, 1], [6, 2], [64, 3], [67, 2], [70, 1]];
function towerLight(c) {
    return TOWER_FADE.find(([end]) => c < end)?.[1] ?? 0;
}

function towerDsp({ push, pushFrames }) {
    push(TOWER, []);
    for (let k = 0; k < 4; k++) {
        const ops = [scale(BOUND, 1, BOUND), angY(k * 0x4000)];
        const on = (f, cam) => !cam || inside(ARENA_PLANES, k, cam) || inside(ARENA_PLANES, (k + 1) & 3, cam);
        pushFrames(TOWER_LIGHTS, (f) => towerLight(f & 0x7f), ops, on);
        push(TOWER_LAMP, ops, on);
    }
}

/* ---- 0x6E4F8 / 0x6E908: the Tower's helicopter ----------------------------- */

/*
 * A helicopter that keeps itself in the camera's view: 0x6E5BC picks the
 * heading on a circle of radius 15 round the arena that puts it in front of
 * the camera, and steers there with a bang-bang controller — the turn rate
 * steps by one a frame towards the target and brakes when the stopping
 * distance says so. It banks into the turn and leans with how far round it
 * faces, bobs on two sines, and its searchlight (0x6D2) aims at the midpoint
 * of the fighters, which with no fight is taken as the arena's centre. The
 * glass (0x1A1) has its UVs rewritten each frame for a fake reflection
 * (sub_6EC0C); that is left out.
 *
 * Everything is integer state carried from frame to frame and fed by the
 * camera, so it is run forward from the round's start with the camera as it
 * stands, and run again from the start if the clock goes back.
 */
const HELI_BODY = 0x6d1, HELI_GLASS = 0x1a1, HELI_ROTOR = 0x97d, HELI_LIGHT = 0x6d2;
const HELI_R = 15, HELI_Y = 3;
const HELI_ROTOR_AT = [0, 1.6688, 0.4193], HELI_LIGHT_AT = [0, -1.0892, 0.1284];
const BIN = 65536 / (2 * Math.PI);
const rad = (a) => (a * 2 * Math.PI) / 65536;
const s16 = (v) => (v << 16) >> 16;

function heliStart() {
    return { n: 0, h: 0, w: 0, bank: 0, face: 0x80, rotor: 0, bob1: 0, bob2: 0, pitch: 0, roll: 0, yaw: 0 };
}

/* The heading 0x6E5BC steers for: on the circle, in front of the camera. */
function heliTarget(cam) {
    const psi = rad(cam.heading);
    const q = -cam.x * Math.cos(psi) - cam.z * Math.sin(psi);
    const base = Math.atan2(Math.cos(psi), -Math.sin(psi));
    const a2 = Math.atan2(Math.sqrt(Math.max(0, HELI_R * HELI_R - q * q)), q);
    return Math.round((base - a2) * BIN) & 0xffff;
}

/* One frame of the turn-rate controller, which returns the way it pushed. */
function heliSteer(st, target) {
    const e = (st.h - target) >>> 0;
    const room = (d) => st.w * st.w < 2 * (d >>> 0);
    let push;
    if (e & 0x8000) push = st.w < 0 || room(target - st.h) ? 1 : -1;
    else push = st.w >= 0 || room(e) ? -1 : 1;
    st.w += push;
    st.h = (st.h + st.w) & 0xffff;
    return push;
}

function heliStep(st, cam) {
    let s = heliSteer(st, heliTarget(cam));
    const slow = Math.abs(st.w) <= 2;
    if (slow) s = st.bank < 0 ? 1 : -1;
    else if (st.bank >= 32) s -= 1;
    else if (st.bank <= -32) s += 1;
    st.bank += Math.max(-1, Math.min(1, s));
    const k = slow && Math.abs(st.bank) <= 1 ? 0 : st.bank;
    if (st.w < 0) st.face = Math.min(st.face + 1, 256);
    else if (st.w > 0) st.face = Math.max(st.face - 1, 0);
    st.pitch = Math.trunc((-48 * k * (st.face - 128)) / 128);
    st.roll = Math.trunc((-96 * k * (Math.abs(st.face - 128) - 128)) / 128);
    st.yaw = (0xc000 + 128 * st.face + st.h) & 0xffff;
    st.rotor = s16(st.rotor + 0x1000);
    st.bob1 = s16(st.bob1 + 0x80);
    st.bob2 = s16(st.bob2 + 16);
}

function heliDsp({ pushLive }) {
    let st = heliStart();
    const at_ = (f, cam) => {
        if (f < st.n) st = heliStart();
        const c = cam ?? { x: 0, z: 0, heading: 0 };
        for (; st.n < f; st.n++) heliStep(st, c);
        return st;
    };
    const body = (q) => {
        const r = rad(q.h);
        const y = HELI_Y + Math.sin(rad(q.bob1)) + Math.cos(rad(q.bob2));
        return { x: -Math.sin(r) * HELI_R, y, z: Math.cos(r) * HELI_R };
    };
    const frame = (q) => {
        const p = body(q);
        return [at(p.x, p.y, p.z), angY(q.yaw), angX(q.pitch), angZ(q.roll)];
    };
    pushLive(HELI_BODY, (f, cam) => frame(at_(f, cam)));
    pushLive(HELI_GLASS, (f, cam) => frame(at_(f, cam)));
    pushLive(HELI_ROTOR, (f, cam) => {
        const q = at_(f, cam);
        return [...frame(q), at(...HELI_ROTOR_AT), angY(q.rotor)];
    });
    pushLive(HELI_LIGHT, (f, cam) => {
        const q = at_(f, cam);
        const p = body(q);
        const yaw = Math.round(Math.atan2(p.x, -p.z) * BIN) - q.yaw;
        const pitch = Math.round(Math.atan2(-p.y, Math.hypot(p.x, p.z)) * BIN) - q.pitch;
        return [...frame(q), at(...HELI_LIGHT_AT), angY(yaw), angX(pitch)];
    });
}

/* ---- by address ----------------------------------------------------------- */

/* The dsp addresses fvipers' stage records name, and the port of each. */
export const FV_OBJECT_ROUTINES = new Map([
    [0x0006b260, factoryDsp],
    [0x0006b4f4, factoryWallsDsp],
    [0x0006b7bc, planeDsp],
    [0x0006c198, airportStillDsp],
    [0x0006c49c, kumaDsp],
    [0x0006c400, kumaW2Dsp],
    [0x0006c67c, elevatorDsp],
    [0x0006caf8, baySideDsp],
    [0x0006cce0, hallDsp],
    [0x0006cf38, towerDsp],
    [0x0006d0c4, kanbanDsp],
    [0x0006e908, heliDsp],
    [0x0006d2fc, cabDsp],
    [0x0006d6e4, trailerDsp],
    [0x0006dac0, passingDsp],
    [0x0006e3f8, ufoDsp],
]);
