/*
 * srally.js — Sega Rally Championship's people by the course: three figures
 * whose limbs are separate models, each with one keyframed motion.
 *
 * One routine draws them all, 0x5CA290 (ROM 0x2B290; the program runs from RAM,
 * 0x59F000 above its ROM address). It is handed a figure, a frame and a step:
 *
 *   +0x00  frames (30 for all three)
 *   +0x04  parts
 *   +0x08  the frames' data, a data ROM address
 *   +0x0C  a model number for each part
 *
 * A frame is 20 bytes a part: the part's place in the figure (three floats),
 * then halfwords at +0x0C and +0x10, which the routine sends with the place to
 * the TGP as one command (function 0x5F, `lda 0x2F805F5F`). The halfwords at
 * +0x0E and +0x12 are not read. Every part is placed from the figure's own
 * origin: none hangs from another, so a frame is the whole pose, baked.
 *
 * What the TGP makes of the command was read off MAME: the matrix it writes to
 * the geometry buffer for each part, against the figure's (solved from where
 * its parts land), is T(place) · Rz(-h0C) · Rx(-h10) on the board's axes. The
 * viewer's Z is the board's negated, which leaves the Z turn as it is and
 * flips the X turn: Rz(-h0C) · Rx(h10).
 *
 * The routine returns the next frame, frame + step, and both callers ask it to
 * swing back at the end: 0 to 29, then -29 to -1, read by their size, so a
 * cycle is 59 frames. The explorer's motion is that cycle unrolled.
 *
 * Who draws them: the object handlers in the table at 0x5DDFC4. Class 6
 * (0x5CAAE0) is the first figure, turned each frame toward the player's car
 * (0x2140CC). Classes 5 and 7 (0x5CA6D0, 0x5CA710) turn theirs to the camera
 * and take the figure from the table at 0x5CA280 (ROM 0x2B280), four entries
 * (the first, second, third and second again) picked by the backup RAM count
 * 0x1D001B8 over 30. The self-check report prints that count as OPERATION
 * DAYS, so a cabinet's spectators change every thirty days it is switched on.
 *
 * The cars follow them in the list. A car has no key frames: 0x5C2A80 (ROM
 * 0x23A80) draws its body and then four wheels, each placed and turned from
 * the car's state that frame (see carRecords and poseRallyCar). In a race the
 * game's physics writes that state; in the attract mode it is played back from
 * runs recorded in the data ROM (readRallyRuns), and those are the cars'
 * motions here.
 */

import { MAIN_DATA_BASE } from './romset.js';

const PART_BYTES = 20;

/* The figures, in the order the table names them, each once. */
function figureRecords(rom) {
    const F = rom.game.rig.figures;
    const dv = rom.mainCpuView;
    const seen = [];
    for (let i = 0; i < F.count; i++) {
        const at = dv.getUint32(F.table + i * 4, true) - F.ramBase;
        if (!seen.includes(at)) seen.push(at);
    }
    return seen.map((at) => ({
        at,
        keys: dv.getUint32(at, true),
        parts: dv.getUint32(at + 4, true),
        data: dv.getUint32(at + 8, true),
        models: Array.from({ length: dv.getUint32(at + 4, true) }, (_, j) => dv.getUint32(at + 12 + j * 4, true)),
    }));
}

function readPart(rom, data, keys, parts, key, part) {
    const dv = rom.mainDataView;
    const at = data - MAIN_DATA_BASE + (Math.max(0, Math.min(key, keys - 1)) * parts + part) * PART_BYTES;
    return {
        place: [dv.getFloat32(at, true), dv.getFloat32(at + 4, true), -dv.getFloat32(at + 8, true)],
        z: dv.getInt16(at + 12, true),
        x: dv.getInt16(at + 16, true),
    };
}

/** The three figures, as bodies whose parts all hang from the figure, then
 * the cars. */
export function readRallyFigures(rom) {
    const names = rom.game.rig.names ?? [];
    const figures = figureRecords(rom).map((r, i) => ({
        index: i,
        name: names[i] ?? `figure ${i}`,
        joints: r.parts,
        scale: 1,
        roles: [],
        skin: -1,
        hitMotions: [],
        start: i,
        root: r.at,
        parts: r.models.map((model, j) => ({
            index: j,
            parent: -1,
            depth: 0,
            model,
            /* Where the part stands on the first frame. */
            offset: readPart(rom, r.data, r.keys, r.parts, 0, j).place,
            flags: 0,
            joint: j,
            record: r.at,
        })),
    }));
    return [...figures, ...readRallyCars(rom, figures.length)];
}

/** One motion a figure, its key frames swung there and back, then the
 * attract mode's recorded runs, which the cars play. */
export function readRallyMotions(rom) {
    const figures = figureRecords(rom).map((r, i) => ({
        index: i,
        name: `motion ${i}`,
        address: r.data,
        offset: r.data - MAIN_DATA_BASE,
        view: rom.mainDataView,
        keys: r.keys,
        frames: 2 * r.keys - 1,
        frameSize: r.parts * PART_BYTES,
        joints: r.parts,
        layout: 'srallyc',
    }));
    return [...figures, ...readRallyRuns(rom, figures.length)];
}

export function rallyMotionList(rom, body, motions) {
    if (body.car) {
        const fits = motions.filter((m) => m.run);
        const lead = fits.filter((m) => [].concat(m.car).includes(body.car.slot));
        return { fits, lead, label: 'Driven by this car in the attract', other: 'Other recorded runs', every: 'Recorded runs' };
    }
    const fits = motions.filter((m) => !m.run && m.joints === body.joints);
    return { fits, lead: fits.filter((m) => m.index === body.index), label: 'Played by its routine' };
}

/* The key frame a frame of the cycle shows: up from 0, then back down. */
function keyAt(motion, frame) {
    const f = Math.max(1, Math.min(frame, motion.frames));
    return f <= motion.keys ? f - 1 : 2 * motion.keys - f;
}

const turn = (a) => (a * 2 * Math.PI) / 0x10000;

/** Every part's matrix on one frame, Rz(-h0C) · Rx(h10) at its place. */
export function poseRallyFigure(rom, body, motion, frame, opts = {}) {
    if (body.car) return poseRallyCar(rom, body, motion?.run ? motion : null, frame, opts);
    const r = figureRecords(rom)[body.index];
    const key = motion && motion.joints === body.joints ? keyAt(motion, frame) : 0;
    const origins = [];
    const matrices = body.parts.map((p, j) => {
        const { place, z, x } = readPart(rom, r.data, r.keys, r.parts, key, j);
        const cz = Math.cos(turn(-z)), sz = Math.sin(turn(-z));
        const cx = Math.cos(turn(x)), sx = Math.sin(turn(x));
        origins.push(place);
        return [
            cz, sz, 0, 0,
            -sz * cx, cz * cx, sx, 0,
            sz * sx, -cz * sx, cx, 0,
            place[0], place[1], place[2], 1,
        ];
    });
    return { matrices, origins };
}

/* ---- The cars ------------------------------------------------------------ */

/*
 * A car's record, in the table at ROM 0x23780 (RAM 0x5C2780): 0x30 bytes a
 * car, picked by the low four bits of the car's +0x50, a near record and a far
 * one of 0x18 bytes each. 0x24800 draws the near one with 0x5C2A80 and the far
 * one, past the distance at 0x213970, with 0x5C30C0 or 0x5C3560, which leave
 * the wheels out or turn none of them. The near record:
 *
 *   +0x00  the wheels' places, a RAM address: four of three floats, the front
 *          left, front right, rear left and rear right
 *   +0x04  the shadow, laid on the ground under the car
 *   +0x08  the wheel, one model for all four
 *   +0x0C  the body
 *   +0x10  the body drawn instead while +0x52 & 0x8888 is set
 *   +0x14  a model drawn over the body while +0x50 bit 4 is set; where there
 *          is one, the body's number goes up by +0x51 & 3
 */
const CAR_BYTES = 0x30;

function carRecords(rom) {
    const C = rom.game.rig.cars;
    const dv = rom.mainCpuView;
    const out = [];
    for (let slot = 0; slot < C.count; slot++) {
        const at = C.table + slot * CAR_BYTES;
        const word = (o) => dv.getUint32(at + o, true);
        const places = word(0) - C.ramBase;
        const car = {
            slot,
            at,
            shadow: word(4),
            wheel: word(8),
            body: word(0xc),
            altBody: word(0x10),
            overlay: word(0x14),
            places: Array.from({ length: 4 }, (_, i) => [0, 4, 8].map((o) => dv.getFloat32(places + i * 12 + o, true))),
        };
        /* The last slots repeat one car. */
        if (!out.some((c) => c.body === car.body && c.wheel === car.wheel)) out.push(car);
    }
    return out;
}

/* The wheels' order in the record, and so in the body's parts after the
 * car's own. */
const WHEELS = ['front left', 'front right', 'rear left', 'rear right'];
const PARTS = ['body', ...WHEELS.map((w) => `${w} wheel`), 'shadow'];
const PARENTS = [-1, 0, 0, 0, 0, -1];

function readRallyCars(rom, first) {
    const names = rom.game.rig.cars.names ?? [];
    return carRecords(rom).map((c, i) => ({
        index: first + i,
        name: names[c.slot] ?? `car ${c.slot}`,
        car: c,
        joints: PARTS.length,
        scale: 1,
        roles: [],
        skin: -1,
        hitMotions: [],
        start: first + i,
        root: c.at,
        parts: [c.body, ...WHEELS.map(() => c.wheel), c.shadow].map((model, j) => ({
            index: j,
            name: PARTS[j],
            parent: PARENTS[j],
            depth: PARENTS[j] < 0 ? 0 : 1,
            model,
            offset: j >= 1 && j <= 4 ? toView(c.places[j - 1]) : [0, 0, 0],
            flags: 0,
            joint: j,
            record: c.at,
        })),
    }));
}

/* The viewer's Z is the board's negated. */
const toView = ([x, y, z]) => [x, y, -z];

/*
 * The attract mode's recorded runs. A run is a car's state every fourth
 * frame, 0x58 bytes each, in the layout the car itself has in work RAM:
 *
 *   +0x00  place (three floats)       +0x24  the front wheels' steer
 *   +0x18  pitch, heading, roll       +0x2C  the wheels' spin
 *   +0x30  each wheel's suspension travel, in the order of the places
 *   +0x40  the ground under each wheel
 *   +0x50  flags; the low four bits pick the car's record
 *
 * 0x28990 (RAM 0x5C7990) reads a run for the attract scenes (0x10A9C on): it
 * is given the run, a clock that goes up one a frame, and an end. The clock's
 * top bits are the sample, its low two how far toward the next, and between
 * two samples every value is eased by that quarter: a + t (b - a), as
 * (1 - t) a + t b with a double and b times t a float. A clock on a sample
 * copies it (0x28DDC).
 */
const RUN_BYTES = 0x58;

function readRallyRuns(rom, first) {
    const R = rom.game.rig.runs;
    return R.list.map((r, i) => ({
        index: first + i,
        name: r.name,
        run: true,
        car: r.car,
        flags: r.flags ?? null,
        address: r.at,
        offset: r.at - MAIN_DATA_BASE,
        view: rom.mainDataView,
        frames: r.frames,
        frameSize: RUN_BYTES,
        joints: PARTS.length,
        layout: 'srallyc-run',
    }));
}

const f32 = Math.fround;

/* One float of a run on clock `clock`, eased as 0x28990 eases it. */
function runValue(motion, clock, field) {
    const dv = motion.view;
    const n = clock >> 2;
    const a = dv.getFloat32(motion.offset + n * RUN_BYTES + field, true);
    const q = clock & 3;
    if (!q) return a;
    const b = dv.getFloat32(motion.offset + (n + 1) * RUN_BYTES + field, true);
    const t = q / 4;
    return f32(a * (1 - t) + f32(b * t));
}

/* An angle of a run (+0x18 to +0x20) on clock `clock`: 0x28990 eases it by
 * the difference 0x27BD8 gives, b - a brought within half a turn (in
 * doubles), so a heading eases the short way round: a + t d. */
function runAngle(motion, clock, field) {
    const dv = motion.view;
    const n = clock >> 2;
    const a = dv.getFloat32(motion.offset + n * RUN_BYTES + field, true);
    const q = clock & 3;
    if (!q) return a;
    const b = dv.getFloat32(motion.offset + (n + 1) * RUN_BYTES + field, true);
    let d = f32(b - a);
    if (Math.abs(d) > Math.PI) d = f32(d > 0 ? d - 2 * Math.PI : d + 2 * Math.PI);
    return f32(a + f32(f32(q / 4) * d));
}

/** The wheels' state on one frame of a run: what 0x5C2A80 reads off the car. */
export function rallyWheelState(motion, frame) {
    if (!motion) return { steer: 0, spin: 0, travel: [0, 0, 0, 0] };
    const clock = Math.max(0, Math.min(frame - 1, motion.frames - 1));
    return {
        steer: runValue(motion, clock, 0x24),
        spin: runValue(motion, clock, 0x2c),
        travel: [0, 1, 2, 3].map((i) => runValue(motion, clock, 0x30 + i * 4)),
    };
}

/*
 * The spin goes up for the whole run, past 8000 turns' worth of radians; the
 * TGP takes the whole turns off in single floats before it turns the wheel,
 * which is what this does (measured on MAME: to 1e-5 of a radian up to 8192,
 * where a float's step reaches 0.001).
 */
function wrapTurn(a) {
    const turn = f32(2 * Math.PI);
    return f32(a - f32(Math.floor(f32(a / turn)) * turn));
}

/*
 * The car's flags on a clock, as 0x5C2A80 finds them. 0x28990 eases the floats
 * but takes +0x50 to +0x57 whole from the sample it eases toward. The first
 * and fourth scenes then move the low halfword up a bit (run.flags). 0x12968
 * sets +0x51's low bits to 1 on the car in slot 1, the Delta, and clears them
 * on the other; 0x247D0 clears +0x50 bits 5 and 6 before the near draw.
 */
function runFlags(motion, clock, slot) {
    const samples = Math.floor((motion.view.byteLength - motion.offset) / RUN_BYTES);
    const n = Math.min((clock >> 2) + ((clock & 3) ? 1 : 0), samples - 1);
    let w = motion.view.getUint32(motion.offset + n * RUN_BYTES + 0x50, true);
    const F = motion.flags;
    if (F?.shift) w = (((w << 1) & 0xfff0) | (w & 7) | (F.high << 16)) & ~F.clear;
    return { b50: w & 0x9f, b51: ((w >> 8) & 0xfc) | (slot === 1 ? 1 : 0), h52: w >>> 16 };
}

/** What 0x5C2A80 draws for the body on one clock: the body, or the second
 * one while +0x52 & 0x8888 is set, its number up by +0x51 & 3 where the record
 * has a model to lay over it; that model while +0x50 bit 4 is set. */
export function rallyCarModels(car, motion, clock) {
    const { b50, b51, h52 } = motion ? runFlags(motion, clock, car.slot) : { b50: 0, b51: car.slot === 1 ? 1 : 0, h52: 0 };
    let body = h52 & 0x8888 ? car.altBody : car.body;
    if (car.overlay) body += b51 & 3;
    return { body, overlay: car.overlay && b50 & 0x10 ? car.overlay : 0 };
}

/* Column-major 4x4s. */
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
function rx(a) {
    const c = Math.cos(a), s = Math.sin(a);
    return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
}
function ry(a) {
    const c = Math.cos(a), s = Math.sin(a);
    return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}
function rz(a) {
    const c = Math.cos(a), s = Math.sin(a);
    return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/* Where the car stands on a clock: its place, heading, the ground's mean
 * height under the four wheels, and the body's pitch and roll. */
function carStand(motion, clock) {
    if (!motion) return { place: [0, 0, 0], heading: 0, ground: [0, 0, 0, 0], pitch: 0, roll: 0 };
    const v = (o) => runValue(motion, clock, o);
    const turn = (o) => runAngle(motion, clock, o);
    return {
        place: [v(0), v(4), v(8)],
        pitch: turn(0x18),
        heading: turn(0x1c),
        roll: turn(0x20),
        ground: [0, 1, 2, 3].map((i) => v(0x40 + i * 4)),
    };
}

/*
 * 0x5C2A80 draws the shadow first: a translate to the car's X and Z at the
 * mean of the ground under the four wheels (+0x40 on, in the order of the
 * places) less 0.02; the heading, +0x1C, as TGP function 0x2A; the ground's
 * tilt front to back, (FL + FR - RL - RR) / 4.2, as function 0x29; and side
 * to side, (FL + RL - FR - RR) / 3, as function 0x2B. Then the body: a
 * translate to the car's place, the heading again, the pitch (+0x18) as
 * function 0x29 and the roll (+0x20) as 0x2B, and each wheel from there.
 * On the board's axes the three functions are Ry(-a), Rx(-a) and Rz(-a); the
 * viewer's Z is the board's negated, which makes them Ry(a), Rx(a) and Rz(-a).
 *
 * Each wheel: a translate to the wheel's place in the record plus its
 * suspension travel (+0x30 on) on Y; on the front two (g13 <= 1) the steer,
 * +0x24, as function 0x2A; then the spin, +0x2C negated (`notbit 31`), as
 * function 0x29; the wheel model. Measured against the matrices the TGP
 * writes for the body and each wheel on MAME, that is
 * T(place + travel) · Ry(-steer) · Rx(spin) on the board's axes, and
 * Ry(steer) · Rx(-spin) in the viewer.
 *
 * The view stands the car with its heading taken off, over the ground's
 * mean height; with travel on, it drives from where the run starts, turned
 * as the run starts, and the camera goes with it (`follow`).
 */
export function poseRallyCar(rom, body, motion, frame, { travel: moving = false } = {}) {
    const clock = motion ? Math.max(0, Math.min(frame - 1, motion.frames - 1)) : 0;
    const now = carStand(motion, clock);
    const mean = (g) => f32(f32(f32(f32(g[0] + g[1]) + g[2]) + g[3]) * 0.25);
    const start = moving ? carStand(motion, 0) : now;
    const g = now.ground;
    const root = moving
        ? mul(ry(-start.heading), mul(move(now.place[0] - start.place[0], mean(g) - mean(start.ground), -(now.place[2] - start.place[2])), ry(now.heading)))
        : move(0, 0, 0);
    const shadow = mul(root, mul(move(0, -0.02, 0),
        mul(rx(f32(f32(f32(g[0] + g[1]) - f32(g[2] + g[3])) * f32(0.2380952))),
            rz(-f32(f32(f32(g[0] + g[2]) - f32(g[1] + g[3])) * f32(1 / 3))))));
    const car = mul(root, mul(move(0, now.place[1] - mean(g), 0), mul(rx(now.pitch), rz(-now.roll))));

    const { steer, spin, travel } = rallyWheelState(motion, frame);
    const s = wrapTurn(spin);
    const matrices = [car];
    const origins = [car.slice(12, 15)];
    body.car.places.forEach((place, i) => {
        const [x, y, z] = toView(place);
        const wheel = mul(car, mul(move(x, y + travel[i], z), mul(ry(i <= 1 ? steer : 0), rx(-s))));
        matrices.push(wheel);
        origins.push(wheel.slice(12, 15));
    });
    matrices.push(shadow);
    origins.push(shadow.slice(12, 15));

    const { body: model, overlay } = rallyCarModels(body.car, motion, clock);
    const wheels = WHEELS.map(() => [body.car.wheel]);
    return {
        matrices,
        origins,
        parents: PARENTS,
        draws: [overlay ? [model, overlay] : [model], ...wheels, [body.car.shadow]],
        follow: moving ? root.slice(12, 15) : undefined,
    };
}
