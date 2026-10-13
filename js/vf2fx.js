/*
 * vf2fx.js — Virtua Fighter 2's stage effects that the stage view leaves out
 * unless asked: each is a switch in the stage panel (`extras`).
 *
 * Two kinds of them. Some the board draws whatever the fight does, but by the
 * power-on frame counter at 0x500020 and the camera at the stage state's +0x18
 * (x), +0x20 (z) and +0x26 (yaw): Budou-jou's billboards, the Islands' animated
 * objects and Souseiji's corner objects. Here the counter is the explorer's
 * frame and the camera is the explorer's, so they are the board's draws seen
 * from a camera the board never has. The others the fight sets off — a burst
 * from a fighter's landing, bubbles from a fighter's part, the stone flying at
 * a fighter's head, a corner object a fighter steps on — and the stage view has
 * no fighters, so a stand-in sets them off and stands where the fighter would:
 * at a fixed time in the explorer's thirty-second round, at the ring's centre.
 *
 * The camera's yaw is the explorer's heading (cameraOnCourse in js/app.js): a
 * model turned by it faces (-sin h, cos h) across the ground. The board's
 * culling tables agree with that sense: Budou-jou's billboard at x = -12 is the
 * one kept while the camera faces -x (octants 1 and 2).
 */

const EMPTY = 0xffff;
const ANGLE_DEG = 360 / 0x10000;
/* The explorer's round, as js/vf2.js keeps it: everything starts again. */
const ROUND_FRAMES = 30 * 60;

const at = (x, y, z) => ['t', [x, y, -z]];
const angY = (a) => ['r', (a & 0xffff) * ANGLE_DEG];
const angX = (a) => ['rx', (a & 0xffff) * ANGLE_DEG];
const angZ = (a) => ['rz', -(a & 0xffff) * ANGLE_DEG];
const scale = (k) => ['s', [k, k, k]];
const boardSin = (a) => Math.sin(((a & 0xffff) * 2 * Math.PI) / 0x10000);
/* TGP function 0x27 (0x13802727): the angle of (a, b), b over a, as a board
 * angle. The camera code at 0x205DC asks it for the half field of view as
 * (focal length, 192), and 0x28E10 for an aim's elevation as (length, height). */
const tgpAtan = (a, b) => Math.round((Math.atan2(b, a) * 0x10000) / (2 * Math.PI)) & 0xffff;

const u8 = (rom, a) => rom.mainCpuView.getUint8(a);
const u16 = (rom, a) => rom.mainCpuView.getUint16(a, true);
const s16 = (rom, a) => rom.mainCpuView.getInt16(a, true);
const u32 = (rom, a) => rom.mainCpuView.getUint32(a, true);
const f32 = (rom, a) => rom.mainCpuView.getFloat32(a, true);
const u16s = (rom, a, n) => Array.from({ length: n }, (_, i) => u16(rom, a + i * 2));

/* The camera's octant, as `ldos 0x26(g13); shro 13` takes it. */
const octant = (cam) => (cam.heading >> 13) & 7;
/* Its 3x3 cell: x and z split at -10 and 10, x the column, z the row of four. */
function cell(cam, round) {
    const n = (v) => (round ? Math.round(v) : Math.trunc(v)) + 10;
    const col = (v) => (n(v) > 0 ? 1 : 0) + (n(v) > 20 ? 1 : 0);
    return col(cam.x) + 4 * col(cam.z);
}

/*
 * A draw the camera picks: `pick(frame, cam)` gives { model, ops } or null for
 * nothing drawn. A model the table leaves empty is nothing drawn too; the draw
 * keeps the last real model so there is always geometry to hide.
 */
function liveDraw(ok, first, ops, pick) {
    let last = first;
    return {
        model: first, ops,
        live: (f, cam) => {
            const r = pick(f, cam);
            if (!r || !ok(r.model)) return { model: last, hidden: true, ops: r?.ops ?? ops };
            last = r.model;
            return { model: r.model, ops: r.ops };
        },
    };
}

/* A draw whose model is a frame's, 0 for none: `index(frame)` into `frames`. */
function frameDraw(ok, frames, index, ops) {
    const fs = frames.map((m) => (ok(m) ? m : 0));
    const first = fs.find((m) => m);
    return first ? { model: first, ops, anim: { frames: fs, index } } : null;
}

/*
 * Budou-jou's billboards (0x2EC24, stage kind 11). Each is one frame of a
 * 16-model animation, 0x2EE90[c & 15] and [(c + 8) & 15], at (12, 1.19, 12)
 * and (-12, 1.19, 12), turned to the camera's yaw flipped by 0x8000. Which are
 * drawn is 0x2EE40[cell] & 0x2EE70[octant]: bit 1 the first, bit 0 the second.
 */
const BILLBOARDS = { cells: 0x2ee40, octants: 0x2ee70, frames: 0x2ee90, y: 1.19, z: 12 };
const BILLBOARD_AT = [[12, 0, 2], [-12, 8, 1]];

function billboards(rom, ok) {
    const B = BILLBOARDS;
    const frames = u16s(rom, B.frames, 16);
    return BILLBOARD_AT.map(([x, phase, bit]) => {
        const ops = (h) => [at(x, B.y, B.z), angY(h ^ 0x8000)];
        return liveDraw(ok, frames[phase], ops(0), (f, cam) => {
            const on = u32(rom, B.cells + cell(cam, false) * 4) & u32(rom, B.octants + octant(cam) * 4);
            return on & bit ? { model: frames[(f + phase) & 15], ops: ops(cam.heading) } : null;
        });
    });
}

/*
 * The Islands' animated objects (0x2EEE8, kind 1). Three models by c >> 2:
 * 0x2F788 at (12.5, 0, 17.6) turned 0xE000, gone in the octants 0x2F778 marks;
 * and while the yaw's bit 15 is set, 0x2F808 at the origin and 0x2F788 (16 on)
 * at (22.4, 0, -5.8) turned 0xC000. Then 23 records of 44 bytes at 0x2F364:
 * +0x00 the model list, +0x04 the place, +0x10 the scale, +0x1C the x, y and z
 * turns, +0x22 a mask, +0x23 an offset, +0x24 a byte list into the models,
 * +0x28 a shift, +0x29 the octants (bits, 0x2F35C) and +0x2A the cells (bits)
 * it is drawn from: model list[bytes[((c >> shift) + offset) & mask]], drawn
 * turned y, then z, then x, and scaled.
 */
const ISLANDS = {
    frames: 0x2f788, back: 0x2f808, gone: 0x2f778,
    records: 0x2f364, count: 23, bytes: 44, octantBits: 0x2f35c,
};

function islandRecord(rom, ok, a) {
    const list = u32(rom, a);
    const [x, y, z, sx, sy, sz] = [0, 1, 2, 3, 4, 5].map((i) => f32(rom, a + 4 + i * 4));
    const [ax, ay, az] = [0, 1, 2].map((i) => s16(rom, a + 0x1c + i * 2));
    const mask = u8(rom, a + 0x22), offset = u8(rom, a + 0x23), bytes = u32(rom, a + 0x24);
    const shift = u8(rom, a + 0x28), octants = u8(rom, a + 0x29), cells = u16(rom, a + 0x2a);
    const model = (f) => u16(rom, list + u8(rom, bytes + (((f >> shift) + offset) & mask)) * 2);
    const ops = [at(x, y, z), angY(ay), angZ(az), angX(ax), ['s', [sx, sy, sz]]];
    return liveDraw(ok, model(0), ops, (f, cam) => {
        if (!(octants & u8(rom, ISLANDS.octantBits + octant(cam)))) return null;
        if (!((cells >> cell(cam, true)) & 1)) return null;
        return { model: model(f), ops };
    });
}

function islands(rom, ok) {
    const I = ISLANDS;
    const n = (f, k) => ((f >> 2) + k) & 63;
    const front = [at(12.5, 0, 17.6), angY(0xe000)];
    const side = [at(22.4, 0, -5.8), angY(0xc000)];
    const draws = [
        liveDraw(ok, u16(rom, I.frames), front, (f, cam) => (u16(rom, I.gone + (cam.heading >> 13) * 2)
            ? null : { model: u16(rom, I.frames + n(f, 0) * 2), ops: front })),
        liveDraw(ok, u16(rom, I.back), [], (f, cam) => (cam.heading & 0x8000
            ? { model: u16(rom, I.back + n(f, 8) * 2), ops: [] } : null)),
        liveDraw(ok, u16(rom, I.frames), side, (f, cam) => (cam.heading & 0x8000
            ? { model: u16(rom, I.frames + n(f, 16) * 2), ops: side } : null)),
    ];
    for (let i = 0; i < I.count; i++) draws.push(islandRecord(rom, ok, I.records + i * I.bytes));
    return draws;
}

/*
 * Souseiji's corner objects (0x2FCBC, kind 7), each called while its octant
 * table (0x2FD08, 0x2FD10) has the camera's. An upper model, 0x7125C[(c/3) &
 * 15] (8 on for the second), turned to the camera's yaw flipped, at height 1.86
 * and scaled by 0x2FD18[k]; and under it 0x7121C (0x7123C) at -0.5, turned x,
 * z, y by the corner's angles. They stand at (9.19, -9.19) and (-9.19, -9.19).
 *
 * k is the corner's count, +0x27E / +0x27F: 0 until a fighter stands in that
 * back corner (0x30168 / 0x3018C), then one more a frame to 31 (0x30240). It
 * tips the lower model over by x = k << 9 (negated on the second) and z =
 * atan(sin x), sinks both 0.125 k out along the diagonal, shrinks the upper
 * one down the table and drops it from 16, and swaps the lower one for 0xE43
 * from 16 on. The stand-in steps into the first corner ten seconds into the
 * round and the second at twenty.
 */
const CORNERS = {
    octants: [0x2fd08, 0x2fd10], upper: 0x7125c, lower: [0x7121c, 0x7123c], scales: 0x2fd18,
    at: 9.1922, top: 1.86, foot: -0.5, sink: -0.125, fallen: 0xe43, steps: 31, gone: 16,
    falls: [600, 1200],
};

function cornerCount(f, i, fall) {
    if (!fall) return 0;
    const t = (f % ROUND_FRAMES) - CORNERS.falls[i] + 1;
    return Math.max(0, Math.min(t, CORNERS.steps));
}

function cornerPlace(i, k) {
    const C = CORNERS;
    const r = -C.at + C.sink * k;
    return i === 0 ? [-r, r] : [r, r];
}

function cornerUpper(rom, ok, i, fall) {
    const C = CORNERS;
    const model = (f) => u16(rom, C.upper + ((Math.trunc(f / 3) + 8 * i) & 15) * 2);
    const ops = (k, h) => {
        const [x, z] = cornerPlace(i, k);
        return [at(x, C.top, z), scale(f32(rom, C.scales + Math.min(k, C.gone - 1) * 4)), angY(h ^ 0x8000)];
    };
    return liveDraw(ok, model(0), ops(0, 0), (f, cam) => {
        const k = cornerCount(f, i, fall);
        if (!u8(rom, C.octants[i] + octant(cam)) || k >= C.gone) return null;
        return { model: model(f), ops: ops(k, cam.heading) };
    });
}

function cornerLower(rom, ok, i, fall) {
    const C = CORNERS;
    const ops = (k) => {
        const [x, z] = cornerPlace(i, k);
        const tip = ((i === 0 ? 1 : -1) * (k << 9)) & 0xffff;
        return [at(x, C.foot, z), angX(tip), angZ(k ? tgpAtan(1, boardSin(tip)) : 0)];
    };
    const model = (f, k) => (k >= C.gone ? C.fallen : u16(rom, C.lower[i] + (Math.trunc(f / 3) & 15) * 2));
    return liveDraw(ok, model(0, 0), ops(0), (f, cam) => {
        if (!u8(rom, C.octants[i] + octant(cam))) return null;
        const k = cornerCount(f, i, fall);
        return { model: model(f, k), ops: ops(k) };
    });
}

function corners(rom, ok, fall) {
    return [0, 1].flatMap((i) => [cornerUpper(rom, ok, i, fall), cornerLower(rom, ok, i, fall)]);
}

/*
 * The burst (0x30EAC, kinds 12 and 7). When a fighter's +0x1A8 is 0x40A with
 * +0x1AA at 1, it runs 177 frames: frame n draws 0x70CFC[n] and 0x70E3C[n] (the
 * same list 32 frames behind) at the fighter's waist (+0x1F4), 1.5 lower. The
 * stand-in sets it off every ten seconds, a second in, with the waist 1.5 up at
 * the ring's centre.
 */
const BURST = { lists: [0x70cfc, 0x70e3c], frames: 177, every: 600, from: 60 };

function burst(rom, ok) {
    const B = BURST;
    const index = (f) => {
        const t = ((f % ROUND_FRAMES) % B.every) - B.from;
        return t >= 0 && t < B.frames ? t + 1 : 0;
    };
    return B.lists.map((list) => frameDraw(ok, [0, ...u16s(rom, list, B.frames)], index, [])).filter(Boolean);
}

/*
 * The mirror stage's bubbles (0x30CA4, kind 4): 0x711BC[(c >> 2) & 15], turned
 * to the camera's yaw (and tilted by its pitch over 16, left out here), at a
 * point taken every 64 frames from a fighter's part: (0.15, 0, -0.03) in that
 * part's frame (+0x2C4, set at 0x2EBE8). The stand-in's part is a unit up at
 * the ring's centre.
 */
const BUBBLES = { frames: 0x711bc, place: [0.15, 1, -0.03] };

function bubbles(rom, ok) {
    const frames = u16s(rom, BUBBLES.frames, 16);
    const ops = (h) => [at(...BUBBLES.place), angY(h)];
    return [liveDraw(ok, frames.find(ok) ?? EMPTY, ops(0), (f, cam) => (
        { model: frames[(f >> 2) & 15], ops: ops(cam.heading) }))];
}

/*
 * The stones' stone once the fight lets it go (kind 5, 0x311B8). From rest at
 * (6, 4.7, 18.5) it makes for a fighter's head (+0x20C) 0.25 up: each frame a
 * fiftieth of the way, each axis held to a limit that grows 0.0005 a frame from
 * 0 (+0x60); it turns its yaw (+0x70) towards the way it goes by up to 0x400 a
 * frame and its roll (+0x72) to the climb by up to 0x200, within ±0x2000; and
 * it is drawn as 0x70CBC[c & 31] (0x31188). The stand-in lets it go five
 * seconds into the round at a head 1.6 up at the ring's centre.
 */
const STONE = {
    frames: 0x70cbc, rest: [6, 4.7, 18.5], head: [0, 1.6 + 0.25, 0], from: 300,
    pull: 0.02, accel: 0.0005, turn: 0x400, climb: 0x200, tilt: 0x2000,
};

const toward = (a, b, step) => {
    const d = (((b - a) << 16) >> 16);
    return a + Math.max(-step, Math.min(step, d));
};

/* The stone's place and angles, frame by frame through one round. */
function stoneFlight() {
    const S = STONE;
    const out = [];
    let p = [...S.rest], lim = 0, yaw = 0, roll = 0;
    for (let f = 0; f < ROUND_FRAMES; f++) {
        if (f >= S.from) {
            const d = S.head.map((h, i) => h - p[i]);
            lim += S.accel;
            p = p.map((v, i) => v + Math.max(-lim, Math.min(lim, d[i] * S.pull)));
            yaw = toward(yaw, tgpAtan(d[0], d[2]), S.turn) & 0xffff;
            const r = toward(roll, (tgpAtan(Math.hypot(d[0], d[2]), d[1]) << 16) >> 16, S.climb);
            roll = Math.max(-S.tilt, Math.min(S.tilt, r));
        }
        out.push({ p: [...p], yaw, roll, flying: f >= S.from });
    }
    return out;
}

function stone(rom, ok) {
    const flight = stoneFlight();
    const step = (f) => flight[f % ROUND_FRAMES];
    const frames = [0, ...u16s(rom, STONE.frames, 32)];
    return [frameDraw(ok, frames, (f) => (step(f).flying ? 1 + (f & 31) : 1), (f) => {
        const s = step(f);
        return [at(...s.p), angY(s.yaw), angZ(s.roll)];
    })].filter(Boolean);
}

/* The switches, by stage kind: [key, label, what it is, on to start with]. */
const KIND_EXTRAS = {
    11: [['billboards', 'billboards', 'Budou-jou\'s two billboards (0x2EC24), by the explorer\'s frame and camera']],
    1: [['islandLife', 'animated objects', 'The Islands\' animated objects (0x2EEE8), by the explorer\'s frame and camera']],
    7: [
        ['corners', 'corner objects', 'Souseiji\'s two corner objects at rest (0x2FCBC), by the explorer\'s frame and camera'],
        ['cornerFall', 'corner falls (stand-in)', 'A fighter stepping into each back corner, at 10 and 20 seconds into the round, tips that corner\'s object over (0x30240)'],
        ['burst', 'burst (stand-in)', 'The burst a fighter sets off (0x30EAC), every ten seconds at the ring\'s centre'],
    ],
    12: [['burst', 'burst (stand-in)', 'The burst a fighter sets off (0x30EAC), every ten seconds at the ring\'s centre']],
    4: [['bubbles', 'bubbles (stand-in)', 'The bubbles that rise from a fighter (0x30CA4), at the ring\'s centre']],
    5: [['stoneFlies', 'stone flies (stand-in)', 'The stone let go at the round\'s end (0x311B8), five seconds in, flying at a head at the ring\'s centre']],
};

/**
 * A stage kind's switched effects: the switches, and the draws, each tagged
 * with the switch that shows it (`extra`) or hides it (`unless`).
 *
 * @param {object} rom loaded ROM set
 * @param {number} kind the record's +0x76
 * @param {(m: number) => boolean} ok whether a model number can be drawn
 * @returns {{ extras: Array, draws: object[] }}
 */
export function vf2KindExtras(rom, kind, ok) {
    const extras = KIND_EXTRAS[kind] ?? [];
    const tag = (extra, list, more = {}) => list.map((d) => ({ layer: 'objects', ...d, extra, ...more }));
    const draws = [];
    for (const [key] of extras) {
        if (key === 'billboards') draws.push(...tag(key, billboards(rom, ok)));
        if (key === 'islandLife') draws.push(...tag(key, islands(rom, ok)));
        if (key === 'corners') {
            draws.push(...tag(key, corners(rom, ok, false), { unless: 'cornerFall' }));
            draws.push(...tag('cornerFall', corners(rom, ok, true)));
        }
        if (key === 'burst') draws.push(...tag(key, burst(rom, ok)));
        if (key === 'bubbles') draws.push(...tag(key, bubbles(rom, ok)));
        if (key === 'stoneFlies') draws.push(...tag(key, stone(rom, ok)));
    }
    return { extras: extras.map(([key, label, title, on = false]) => ({ key, label, title, on })), draws };
}
