/*
 * daytonacar.js — Daytona USA's car in the Animation tab: the body and its
 * four wheels as the attract mode draws them, playing the runs recorded in
 * the data ROM.
 *
 * Revision A's addresses throughout; a build that moved them gives its own in
 * `rig` (js/games.js).
 *
 * The runs. The data ROM's 0x2880000 opens "D.K." and a pointer to each run
 * follows from +4. A run is 20 bytes a frame: x, y and z (floats), then the
 * pitch, heading and roll (halfwords, a turn to 0x10000). The linked
 * cabinets' attract (set up at 0x5068 when the link is up) gives the player's
 * car handler 0xD104: it takes the car's models (below), zeroes the clock
 * 0x501AAC and moves on to 0xD1B8, which each frame
 *
 *   0xD3E4  reads the clock's frame of run 34 + n + 0x231B34[course] (0, 8, 4,
 *           0 by course), n the car's place in the link (+0x6D, 0x12860)
 *           held to 0..3: x and z to +0x1C and +0x24, the pitch, heading and
 *           roll to +0x4C, +0x4E and +0x50; +0x20 is the course's height
 *           0x231C44 (5.6 on the second course, else 0) and +0x5C the run's y
 *           plus 0x231C54 (-5.6 there), so the car stands at the run's y;
 *   0xD4C0  takes the next frame's x and z less this one's as its motion;
 *   0xD330  turns the wheels by it: |dx| + |dz| times 10000 (TGP function
 *           2), rounded and held to 0..0xAAA, off +0x5A, so they roll
 *           forward. Car 2 instead takes 0x200 a frame off from clock 0x8D to
 *           0x19A, the wheels spinning back;
 *   0xD2D4  steers: cars 0 and 1 take the front wheels' turn, +0x128, from
 *           runs 46 and 47 of their own, the heading of the clock's frame
 *           halved; the others keep theirs straight;
 *
 * and counts the clock up to the run's length (0x231B44 by n: 0x11D, 0x1BD,
 * 0x19D, 0x27C frames), where it stays. A lone cabinet's attract never plays
 * them: its car is driven along a lane (0xD4F0).
 *
 * The draw, 0x7598, with the clock running (0x78C8): a translate to the car,
 * the roll, heading and pitch, in that order; the body (0x7D38): +0x14, then
 * through 0x17CF8 the glass (model 2139, built in polygon RAM) and the second
 * model of 0x281E39C[0x501488], and with 0x501488 = 2 the car's number,
 * +0x258. Then 0x7DA4, the wheels: the tilt +0x52 and +0x56 taken off (both
 * 0 through every run measured), and for each wheel a push, a translate to
 * its place in 0x230D54, on the front two the steer, then the spin, and its
 * model from the list at 0x230496 (an unaligned word each; the left and
 * right wheels differ). The shadow, model 791, is drawn again from the car's
 * x and z at +0x20's height, squashed to 0.01 on Y before the same turns.
 *
 * 0x501488 is 2 on a linked cabinet (0xEBF0) and +0x258 its number plate,
 * 0x281E3B4 by the cabinet's number 0x5FE604; else it is 0x501464, which
 * 0x25C54 sets.
 *
 * Measured against the matrices the TGP sends the geometrizer for the body
 * and each wheel on MAME, every frame of three runs (the handler set to
 * 0xD104 by hand): on the board's axes the body is
 * T(x, y, z) · Rz(-roll) · Ry(-heading) · Rx(-pitch) and a wheel, against
 * the body, T(place) · Ry(-steer) · Rx(-spin), the TGP turning each axis the
 * other way. The viewer's Z is the board's negated (js/daytona.js).
 */

import { MAIN_DATA_BASE } from './romset.js';

const PROG_ALIAS = 0x00200000;
const RECORD = 20;

function view(rom, addr) {
    if (addr >= MAIN_DATA_BASE) return { dv: rom.mainDataView, off: addr - MAIN_DATA_BASE };
    return { dv: rom.mainCpuView, off: addr >= PROG_ALIAS ? addr - PROG_ALIAS : addr };
}
const u32 = (rom, a) => { const v = view(rom, a); return v.dv.getUint32(v.off, true); };
const f32at = (rom, a) => { const v = view(rom, a); return v.dv.getFloat32(v.off, true); };

/* A model record's address as a model-table index. */
function modelOf(rom, ptr) {
    const t = rom.game.modelTable;
    const i = (ptr - MAIN_DATA_BASE - t.offset) / t.stride;
    return Number.isInteger(i) && i >= 0 && i < t.count ? i : 0;
}

const WHEELS = ['front left', 'front right', 'rear left', 'rear right'];
const PARTS = ['body', ...WHEELS.map((w) => `${w} wheel`), 'shadow'];
const PARENTS = [-1, 0, 0, 0, 0, -1];

/* What 0x7D38 and 0x7DA4 draw, and where the wheels go. */
function carModels(rom, kind, plate) {
    const C = rom.game.rig.car;
    const body = [modelOf(rom, u32(rom, C.bodies + kind * 4)), modelOf(rom, C.glass), modelOf(rom, u32(rom, C.seconds + kind * 4))];
    if (kind === 2) body.push(modelOf(rom, u32(rom, C.plates + plate * 4)));
    return {
        body: body.filter(Boolean),
        wheels: WHEELS.map((_, i) => modelOf(rom, u32(rom, C.wheels + i * 4))),
        places: WHEELS.map((_, i) => [0, 4, 8].map((o) => f32at(rom, C.places + i * 12 + o))),
        shadow: modelOf(rom, C.shadow),
    };
}

/** The cars: 0x501488 = 0 and 1, then the linked car with each cabinet's
 * number. */
export function readDaytonaCars(rom) {
    const kinds = [{ kind: 0, plate: 0, name: 'car (0x501488 = 0)' }, { kind: 1, plate: 0, name: 'car (0x501488 = 1)' }];
    for (let p = 0; p < 8; p++) kinds.push({ kind: 2, plate: p, name: `linked car, cabinet ${p + 1}` });
    return kinds.map((k, index) => {
        const car = carModels(rom, k.kind, k.plate);
        const models = [car.body[0], ...car.wheels, car.shadow];
        return {
            index,
            name: k.name,
            car,
            joints: PARTS.length,
            scale: 1,
            roles: [],
            skin: -1,
            hitMotions: [],
            start: index,
            root: rom.game.rig.car.bodies + k.kind * 4,
            parts: models.map((model, j) => ({
                index: j,
                name: PARTS[j],
                parent: PARENTS[j],
                depth: PARENTS[j] < 0 ? 0 : 1,
                model,
                offset: j >= 1 && j <= 4 ? toView(car.places[j - 1]) : [0, 0, 0],
                flags: 0,
                joint: j,
                record: rom.game.rig.car.bodies + k.kind * 4,
            })),
        };
    });
}

const toView = ([x, y, z]) => [x, y, -z];

/* Run `i`'s first record, as a data ROM offset. */
const runAt = (rom, i) => u32(rom, rom.game.rig.runs.at + 4 + i * 4) - MAIN_DATA_BASE;

/** A run for each course and place in the link: what 0xD3E4 reads. */
export function readDaytonaRuns(rom) {
    const R = rom.game.rig.runs;
    const out = [];
    R.courses.forEach((course, c) => {
        for (let n = 0; n < 4; n++) {
            const run = R.first + n + u32(rom, R.course + c * 4);
            const steer = n < 2 ? R.steer[n] : null;
            out.push({
                index: out.length,
                name: `${course}, car ${n + 1} (run ${run})`,
                run,
                place: n,
                course: c,
                address: runAt(rom, run) + MAIN_DATA_BASE,
                offset: runAt(rom, run),
                steerOffset: steer == null ? null : runAt(rom, steer),
                view: rom.mainDataView,
                height: f32at(rom, R.height + c * 4),
                lift: f32at(rom, R.lift + c * 4),
                /* The clock stops on the length, which is shown too. */
                frames: u32(rom, R.lengths + n * 4) + 1,
                frameSize: RECORD,
                joints: PARTS.length,
                layout: 'daytona-run',
            });
        }
    });
    return out;
}

export function daytonaRunList(rom, body, motions) {
    return { fits: motions, lead: motions.filter((m) => m.course === 0), label: 'Played on the first course', other: 'The other courses', every: 'Recorded runs' };
}

const f32 = Math.fround;

/* One frame of a run, as 0xD3E4 leaves the car. */
function record(m, clock) {
    const dv = m.view, at = m.offset + clock * RECORD;
    return {
        x: dv.getFloat32(at, true),
        y: dv.getFloat32(at + 4, true),
        z: dv.getFloat32(at + 8, true),
        pitch: dv.getInt16(at + 12, true),
        heading: dv.getInt16(at + 14, true),
        roll: dv.getInt16(at + 16, true),
    };
}

/* The wheels' turn after `clock` frames: 0xD330 from +0x5A = 0, as a halfword. */
function spinAt(m, clock) {
    let spin = 0;
    for (let k = 0; k <= clock; k++) {
        const a = record(m, k), b = record(m, k + 1);
        let step;
        if (m.place === 2 && k > 0x8c && k <= 0x19a) step = -0x200;
        else {
            const d = f32(f32(Math.abs(f32(b.x - a.x))) + f32(Math.abs(f32(b.z - a.z))));
            step = Math.max(0, Math.min(0xaaa, Math.round(f32(d * 10000))));
        }
        spin = ((spin - step) << 16) >> 16;
    }
    return spin;
}

/* The front wheels' turn, 0xD2D4: the clock's heading in the car's steer run, halved. */
function steerAt(m, clock) {
    if (m.steerOffset == null) return 0;
    return m.view.getInt16(m.steerOffset + clock * RECORD + 14, true) >> 1;
}

/** The car's state on a frame of a run, as the draw reads it. */
export function daytonaCarState(m, frame) {
    if (!m) return { x: 0, y: 0, z: 0, pitch: 0, heading: 0, roll: 0, ground: 0, spin: 0, steer: 0, clock: 0 };
    const clock = Math.max(0, Math.min(frame - 1, m.frames - 1));
    const r = record(m, clock);
    return { ...r, y: f32(m.height + f32(r.y + m.lift)), ground: m.height, spin: spinAt(m, clock), steer: steerAt(m, clock), clock };
}

/* Column-major 4x4s, on the board's axes. */
function mul(a, b) {
    const o = new Array(16);
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
        }
    }
    return o;
}
const move = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const squash = (y) => [1, 0, 0, 0, 0, y, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const turn = (a) => (a * 2 * Math.PI) / 0x10000;
/* The TGP's turns, each the right-handed one the other way. */
function rx(a) {
    const c = Math.cos(turn(a)), s = Math.sin(turn(a));
    return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1];
}
function ry(a) {
    const c = Math.cos(turn(a)), s = Math.sin(turn(a));
    return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1];
}
function rz(a) {
    const c = Math.cos(turn(a)), s = Math.sin(turn(a));
    return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
/* Board to viewer: Z negated on both sides. */
const flip = (m) => m.map((v, i) => (((i & 3) === 2) !== ((i >> 2) === 2) ? -v : v));

/*
 * The car stands at the origin with the frame's heading taken off and the
 * shadow's ground at 0; with travel on it drives from where the run starts,
 * turned as it starts, and the camera goes with it (`follow`).
 */
export function poseDaytonaCar(rom, body, motion, frame, { travel: moving = false } = {}) {
    const m = motion?.layout === 'daytona-run' ? motion : null;
    const now = daytonaCarState(m, frame);
    return daytonaCarPose(body, now, moving ? daytonaCarState(m, 1) : null);
}

/** The pose for a car state (daytonaCarState's), driven from `from` if given. */
export function daytonaCarPose(body, now, from = null) {
    const moving = Boolean(from);
    from ??= now;
    const root = mul(ry(-from.heading), move(-from.x, -now.ground, -from.z));
    const turned = (x, y, z) => mul(move(x, y, z), mul(rz(now.roll), mul(ry(now.heading), rx(now.pitch))));
    const car = mul(root, turned(now.x, now.y, now.z));
    const shadow = mul(root, mul(move(now.x, now.ground, now.z), mul(squash(0.01), mul(rz(now.roll), mul(ry(now.heading), rx(now.pitch))))));
    const matrices = [car];
    body.car.places.forEach(([x, y, z], i) => {
        matrices.push(mul(car, mul(move(x, y, z), mul(ry(i <= 1 ? now.steer : 0), rx(now.spin)))));
    });
    matrices.push(shadow);
    const shown = matrices.map(flip);
    return {
        matrices: shown,
        origins: shown.map((x) => x.slice(12, 15)),
        parents: PARENTS,
        draws: [body.car.body, ...body.car.wheels.map((w) => [w]), [body.car.shadow]],
        follow: moving ? shown[0].slice(12, 15) : undefined,
    };
}
