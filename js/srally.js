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
export function poseRallyFigure(rom, body, motion, frame) {
    if (body.car) return poseRallyCar(rom, body, motion?.run ? motion : null, frame);
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

function readRallyCars(rom, first) {
    const names = rom.game.rig.cars.names ?? [];
    return carRecords(rom).map((c, i) => ({
        index: first + i,
        name: names[c.slot] ?? `car ${c.slot}`,
        car: c,
        joints: 5,
        scale: 1,
        roles: [],
        skin: -1,
        hitMotions: [],
        start: first + i,
        root: c.at,
        parts: [c.body, ...WHEELS.map(() => c.wheel)].map((model, j) => ({
            index: j,
            name: j ? `${WHEELS[j - 1]} wheel` : 'body',
            parent: j ? 0 : -1,
            depth: j ? 1 : 0,
            model,
            offset: j ? toView(c.places[j - 1]) : [0, 0, 0],
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
        address: r.at,
        offset: r.at - MAIN_DATA_BASE,
        view: rom.mainDataView,
        frames: r.frames,
        frameSize: RUN_BYTES,
        joints: 5,
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
 * 0x5C2A80 draws the body at the car's place and turn, and each wheel from
 * there: a translate to the wheel's place in the record plus its suspension
 * travel (+0x30 on) on Y; on the front two (g13 <= 1) the steer, +0x24, as
 * TGP function 0x2A; then the spin, +0x2C negated (`notbit 31`), as function
 * 0x29; the wheel model. On the board's axes, measured against the matrices
 * the TGP writes for the body and each wheel on MAME, that is
 * T(place + travel) · Ry(-steer) · Rx(spin). The viewer's Z is the board's
 * negated, which turns both the other way: Ry(steer) · Rx(-spin).
 */
export function poseRallyCar(rom, body, motion, frame) {
    const { steer, spin, travel } = rallyWheelState(motion, frame);
    const s = wrapTurn(spin);
    const cx = Math.cos(-s), sx = Math.sin(-s);
    const matrices = [[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]];
    const origins = [[0, 0, 0]];
    body.car.places.forEach((place, i) => {
        const [x, y, z] = toView(place);
        const at = [x, y + travel[i], z];
        const a = i <= 1 ? steer : 0;
        const cy = Math.cos(a), sy = Math.sin(a);
        /* Ry(a) · Rx(-s), by columns. */
        matrices.push([
            cy, 0, -sy, 0,
            sy * sx, cx, cy * sx, 0,
            sy * cx, -sx, cy * cx, 0,
            at[0], at[1], at[2], 1,
        ]);
        origins.push(at);
    });
    return { matrices, origins, parents: [-1, 0, 0, 0, 0] };
}
