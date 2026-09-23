/*
 * daytona.js — Daytona USA's trackside objects: what stands along each course
 * besides the blocks of the course itself, and how each one moves.
 *
 * Where this was read. There is no decompilation of this game, but there is a
 * symbol table: Sega Racing Classic's d1a.exe, the 2009 Ringwide release,
 * carries the board's own names for 651 of its addresses, and its program ROM
 * is a later build of the same one. The object routines are in the second
 * 128KB of that ROM, which every build from Revision A on keeps at the same
 * addresses, so the names `ship`, `slot`, `jeffly`, `tori`, `uma` and the rest
 * are the board's own. Every constant below was read off those routines.
 *
 * How a course's objects are kept. `set_course_parms` stores
 * `<array>[sel_course*4]` at 0x501444, and the routine that runs once when a
 * race starts walks it: the array names one table per course, each table has
 * a pointer per grid block (the same 16x16 grid the course itself is cut
 * into), and each non-null pointer is a count and that many 24-byte records —
 *
 *   +0x00  float x, y, z      where it stands
 *   +0x0C  s16   angle        a Y turn, 0x10000 to the circle
 *   +0x0E  u16   id           which one of several a routine is handling
 *   +0x10  code  init         the routine the task starts in
 *   +0x14  u32   arg          a model record, or a table of them
 *
 * — and every record becomes a task. The init routine installs a display
 * routine, and the display routine draws, once a frame, if the grid block the
 * task stands in is in view. The block is `get_m_block`'s:
 * `((z + 1024) >> 7 & 15) << 4 | ((x + 1024) >> 7 & 15)`.
 *
 * Each display routine brackets its drawing in the TGP's push and pop and
 * builds its matrix out of a handful of TGP functions: 0x12 translate, 0x13
 * scale, and 0x14, 0x15 and 0x16 the turns about X, Y and Z. Several draw no
 * matrix at all, because their models are already in world space as the
 * course blocks are — the boat, the flags, the water, the lights — and move
 * only by drawing a different model each frame.
 *
 * What is drawn in which state. The routines test the game's mode and the
 * time-attack flag, so the explorer offers the three states that differ — a
 * race (which is also what attract mode draws), time attack and the ending —
 * see MODES. What is left out in all of them: the cones stand and are never
 * knocked flying; the Jeffry statue does not do its turn, which the board
 * saves for a player who stops beside it and presses the view button; and the
 * two windows — the grandstand's glass and the covered walkway's — show the
 * first of the 64 frames of sky the board picks between by where the car
 * stands, since the TGP functions that choose one are not ported.
 */

/* The board's 16-bit angle, and the conversion. */
const ANGLE_DEG = 360 / 65536;

/*
 * The TGP's frame against the viewer's.
 *
 * The decoder negates Z, so a position (x, y, z) is (x, y, -z) here. Mirroring
 * Z reverses every rotation, and the TGP's turns are the other hand from the
 * viewer's to begin with, so the two cancel and a board turn of +a about any
 * axis is a turn of +a here — the same as The House of the Dead's placements
 * come out. The slot machine settles it: its reels are turned 0x382D, and with
 * the sign the other way they face into the rock behind the housing.
 */
const T = (x, y, z) => ['t', [x, y, -z]];
const RX = (a) => ['rx', a * ANGLE_DEG];
const RY = (a) => ['r', a * ANGLE_DEG];
const RZ = (a) => ['rz', a * ANGLE_DEG];
const S = (x, y = x, z = x) => ['s', [x, y, z]];

/* globl_timer, which every one of these indexes its tables off, is the frame. */

/* ---- reading the ROM ------------------------------------------------------- */

const DATA_BASE = 0x02000000;
/* The program ROM's second half is mapped twice, at 0x20000 and again at
 * 0x00220000, and the program's own pointers use the alias. */
const PROG_ALIAS = 0x00200000;

function view(rom, addr) {
    if (addr >= DATA_BASE) return { dv: rom.mainDataView, off: addr - DATA_BASE, len: rom.mainData.length };
    const off = addr >= PROG_ALIAS ? addr - PROG_ALIAS : addr;
    return { dv: rom.mainCpuView, off, len: rom.maincpu.length };
}
const u32 = (rom, addr) => { const v = view(rom, addr); return v.dv.getUint32(v.off, true); };
const f32 = (rom, addr) => { const v = view(rom, addr); return v.dv.getFloat32(v.off, true); };
const s16 = (rom, addr) => { const v = view(rom, addr); return v.dv.getInt16(v.off, true); };

/* A model record's address as a model-table index, or -1. */
function modelOf(rom, ptr) {
    const t = rom.game.modelTable;
    const i = (ptr - DATA_BASE - t.offset) / t.stride;
    return Number.isInteger(i) && i >= 0 && i < t.count ? i : -1;
}
/* A run of `n` model-record pointers. */
function modelList(rom, addr, n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(modelOf(rom, u32(rom, addr + i * 4)));
    return out;
}

/** Every record of one course, in the order the start-of-race walk makes them. */
export function readObjectRecords(rom, course) {
    const O = rom.game.objects;
    const arr = u32(rom, O.at + course * 4);
    const out = [];
    for (let b = 0; b < 256; b++) {
        const g = u32(rom, arr + b * 4);
        if (!g) continue;
        const n = u32(rom, g);
        for (let i = 0; i < n; i++) {
            const r = g + 4 + i * 24;
            out.push({
                block: b,
                pos: [f32(rom, r), f32(rom, r + 4), f32(rom, r + 8)],
                angle: s16(rom, r + 12),
                id: u32(rom, r + 12) >>> 16,
                init: u32(rom, r + 16) & ~PROG_ALIAS,
                arg: u32(rom, r + 20),
            });
        }
    }
    return out;
}

/* ---- the routines ---------------------------------------------------------- */

/*
 * Each builds the draws for one record: `{model, ops, anim}` in the explorer's
 * own shape, `ops` a list or a function of the frame and `anim` a model per
 * frame. `ctx` has the ROM, the profile block, the course and the ground.
 */
const at = (r) => T(r.pos[0], r.pos[1], r.pos[2]);
const cycle = (frames, index) => ({ model: frames[0], anim: { frames, index } });

const KINDS = {
    /* sub_20118: translate, turn, the record's own model. The generic prop. */
    static: (r, { rom }) => [{ model: modelOf(rom, r.arg), ops: [at(r), RY(r.angle)] }],

    /*
     * sub_201bc: the same, but the model is one of a short list, from a
     * per-course table indexed by the record's id — {list, count, divisor}. The
     * counter runs 0..count and the list is indexed by counter / divisor, so
     * with count 24 and divisor 8 the fourth model shows for one frame of 25.
     */
    cycle: (r, { rom, O, course }) => {
        const e = u32(rom, O.cycles + course * 4) + r.id * 16;
        const count = u32(rom, e + 4), div = u32(rom, e + 8);
        const frames = modelList(rom, u32(rom, e), Math.floor(count / div) + 1);
        return [{ ...cycle(frames, (f) => Math.floor(((f + 1) % (count + 1)) / div)), ops: [at(r), RY(r.angle)] }];
    },
    /* The 1993 build's other prop routine: a four-model list of the routine's
     * own, a step every eighth frame, at the record's place and turn. */
    cycle4: (r, { rom, O }) => [{
        ...cycle(modelList(rom, O.lists[r.init], 4), (f) => ((f + 1) >> 3) & 3),
        ops: [at(r), RY(r.angle)],
    }],

    /* The ones already in world space, which move by walking a list. The
     * boat's list is 64 long at half speed, the lights' and the water's 64,
     * the flags' 32. */
    ship: (r, { rom }) => [{ ...cycle(modelList(rom, r.arg, 64), (f) => (f & 0x7f) >> 1), ops: [] }],
    light: (r, { rom }) => [{ ...cycle(modelList(rom, r.arg, 64), (f) => f & 0x3f), ops: [] }],
    flags: (r, { rom }) => [{ ...cycle(modelList(rom, r.arg, 32), (f) => f & 0x1f), ops: [] }],
    /* maku, the banner over the line, picks one of three by how the race
     * stands; the record names the one it opens on. wall is drawn only while
     * the player is between two points on the course. */
    world: (r, { rom }) => [{ model: modelOf(rom, r.arg), ops: [] }],

    /* z_kaitenn: turned by the record and then spun about Z, 0x100 a frame. */
    spinZ: (r, { rom }) => [{
        model: modelOf(rom, r.arg),
        ops: (f) => [at(r), RY(r.angle), RZ((f + 1) * 0x100)],
    }],
    /* rou2: the record's own Y turn walked on 0x100 a frame — back in every
     * build from Revision A, forward in the 1993 one. */
    spinY: (r, { rom, O }) => [{
        model: modelOf(rom, r.arg),
        ops: (f) => [at(r), RY(r.angle + (f + 1) * (O.spinY ?? -0x100))],
    }],

    /*
     * slot: the 777 machine's three reels, each at a place of its own, turned
     * 0x382D, and drawn as one of 64 models of the reel at a step of its turn.
     * With no one at the controls all three run — the left one a step every
     * other frame, the middle one a step a frame, the right one two.
     */
    slot: (r, { rom }) => {
        const reels = modelList(rom, r.arg, 64);
        return SLOT_REELS.map(([x, y, z, step]) => ({
            ...cycle(reels, (f) => Math.floor((f + 1) * step) & 63),
            ops: [T(x, y, z), RY(SLOT_TURN)],
        }));
    },

    /*
     * check_point: a table per checkpoint — {scale, x, y, z, list, list} —
     * rather than the record, for where it stands. Scaled in X and Z only,
     * turned by the record, and drawn from a 64-long list; the second list is
     * the one on the lap that finishes the race.
     */
    checkpoint: (r, { rom, O }) => {
        const e = O.checkpoints + r.id * 24;
        const s = f32(rom, e), p = [f32(rom, e + 4), f32(rom, e + 8), f32(rom, e + 12)];
        return [{
            ...cycle(modelList(rom, u32(rom, e + 16), 64), (f) => f & 0x3f),
            ops: [T(...p), S(s, 1, s), RY(r.angle)],
        }];
    },

    /*
     * 1993's check points, each a routine of its own with its numbers inline:
     * at the record's place, scaled in X and Z by the routine's own figure and
     * turned by the record, or drawn with no matrix at all; the list is the
     * record's, or one the routine names.
     */
    checkpointAt: (r, { rom, O }) => {
        const c = O.checkpointsAt[r.init];
        return [{
            ...cycle(modelList(rom, c.list ?? r.arg, 64), (f) => f & 0x3f),
            ops: c.world ? [] : [at(r), S(c.scale, 1, c.scale), RY(r.angle)],
        }];
    },

    /*
     * rank: the leader board, five models at five places out of a table. In a
     * race the board fills it with the numbers of the cars in the order they
     * stand, a model per car id out of a second table; the explorer has no
     * race, so it shows the order the field is entered in, ids 1 to 5 (0 is
     * the player). In time attack, with no field, it is the record's own model
     * — the player's number — at all five.
     */
    rank: (r, { rom, O, mode }) => {
        const cars = modelList(rom, O.rankCars, 6);
        return [0, 1, 2, 3, 4].map((i) => {
            const e = O.rankBoard + i * 12;
            return {
                model: mode === 'timeAttack' ? modelOf(rom, r.arg) : cars[i + 1],
                ops: [T(f32(rom, e), f32(rom, e + 4), f32(rom, e + 8))],
            };
        });
    },

    /* wing: the windmill — its sails walk 64 models and its two other parts
     * stand still, all three in world space. */
    windmill: (r, { rom, O }) => [
        { ...cycle(modelList(rom, O.windmill.sails, 64), (f) => f & 0x3f), ops: [] },
        ...O.windmill.still.map((p) => ({ model: modelOf(rom, p), ops: [] })),
    ],

    /* jeffly, reached by way of sub_216e4: the Jeffry statue, at the record's
     * place and not turned. */
    jeffry: (r, { rom, O }) => [{ model: modelOf(rom, O.jeffry), ops: [at(r)] }],

    /* stand_window and arcade_window: the grandstand's glass and the covered
     * walkway's, each a list of 64 frames of reflected sky that the board
     * picks between by where the car stands, so the reflection slides as it
     * drives past. Drawn at the first. */
    window: (r, { rom }) => [{ model: modelOf(rom, u32(rom, r.arg)), ops: [] }],

    /*
     * The pylons: four kinds, the same routine, differing in how high the
     * model's origin stands off the road. The record's y is not used — the
     * board puts it on the road under x, z with get_y_position and tips it to
     * that road's slope, turning X and then Z before the record's own Y. That
     * height is TGP function 0x36 over collision polygons in the coprocessor's
     * own ROM, which is not read here, so the road the course draws stands in.
     */
    pylon: (r, ctx) => {
        const { rom } = ctx;
        const lift = f32(rom, ctx.O.pylons[r.init] + 4);
        const g = ctx.ground?.(r.pos[0], r.pos[2]);
        const y = (g ? g.y : r.pos[1]) + lift;
        return [{ model: modelOf(rom, r.arg), ops: [T(r.pos[0], y, r.pos[2]), ...(g ? g.tilt : []), RY(r.angle)] }];
    },

    /*
     * tori: the gulls over the sea, drawn by one helper — push, turn Y by a
     * heading, step 15 out along it, a bird out of a 32-model table, pop — so
     * each circles a point, a turn every 512 frames. The wing table is indexed
     * so that three beats are followed by a glide: (t & 0x7F), and anything
     * past 0x5F held at the last frame. Two circle the record's place; three
     * more circle a point (5, 2) off it, on half the beat. Two more, a further
     * (-12, -1) on, are drawn only during the ending or in time attack.
     */
    birds: (r, ctx) => gullFlock(r, ctx, { third: ctx.mode !== 'race', grows: false }),

    /*
     * tori_syumi: six more flocks of the same gulls, which only time attack
     * draws — a race with no field in it has the polygons to spare. Each grows
     * as the race goes on: two birds, then three more after 960 frames, then
     * six more after 1920, the last on a quicker beat.
     */
    flock: (r, ctx) => (ctx.mode === 'timeAttack' ? gullFlock(r, ctx, { third: true, grows: true }) : []),

    /* bb: one of the birds, 26 times the size and turned by the record. */
    bigBird: (r, { rom, O }) => [{
        ...cycle(modelList(rom, O.birds, 32), (f) => f & 31),
        ops: [at(r), RY(r.angle), S(BIG_BIRD_SCALE)],
    }],

    /*
     * uma: a horse galloping round an ellipse, 25 across and 35 deep, a lap
     * every 1024 frames. Its place on it is TGP functions 0x1D and 0x1E at
     * the phase, which are the sine and the cosine times a radius; it leans
     * in by 0x222 about Z and is turned to run along the ellipse. Five of
     * them share one centre and differ by the record's angle, which is where
     * on the ellipse each starts. They bolt when the car comes close — see
     * horseRun, where the camera is the car.
     */
    horse: (r, ctx) => {
        const gallop = modelList(ctx.rom, ctx.O.horses, 32);
        return [{
            ...cycle(gallop, (f) => (f + 1) & 31),
            ops: (f) => horseRing(r, f + 1),
            live: horseRun(r, gallop, ctx),
        }];
    },

    /*
     * uma_end: the horses' curtain call, which only the ending draws. Two
     * horses turned about, galloping, and the pair walked back 0.2 a frame by
     * the routine writing the task's own z. The second is stepped out (z + 1,
     * 0, z + 1) in the first's frame — the z where a small offset would be
     * expected, so it stands hundreds of units off; that is the ROM's, and is
     * drawn as it stands.
     */
    curtainCall: (r, { rom, O, mode }) => {
        if (mode !== 'ending') return [];
        const gallop = modelList(rom, O.horses, 32);
        const zAt = (f) => r.pos[2] - 0.2 * f;
        const first = (f) => [T(r.pos[0], r.pos[1], zAt(f)), RY(0x8000)];
        return [
            { ...cycle(gallop, (f) => (f + 1) & 31), ops: first },
            { ...cycle(gallop, (f) => (f + 1) & 31), ops: (f) => [...first(f), T(zAt(f) + 1, 0, zAt(f) + 1)] },
        ];
    },

    /*
     * ctykya: the crowds on Seaside Street Galaxy — groups of cut-out people,
     * each a place and up to three turns, and a four-model list walked every
     * eighth frame, which is them waving. The board draws the shuttle's crowd
     * only while the player is on the stretch of road it lines, and the
     * plaza's while its block is in view. The 1993 build has both, written
     * out one instruction at a time; Revision A keeps only the shuttle's, in a
     * table of {list, x, y, z, turns}, and the Special Edition put the plaza's
     * back as a second table.
     */
    crowd: (r, { rom, O }) => {
        const out = [];
        const wave = (f) => ((f + 1) >> 3) & 3;
        const turn = { x: RX, y: RY, z: RZ };
        for (const c of O.crowds) {
            if (c.groups) {
                for (const g of c.groups) {
                    out.push({
                        ...cycle(modelList(rom, g.list, 4), wave),
                        ops: [T(...g.at), ...g.turns.map(([axis, a]) => turn[axis](a))],
                    });
                }
                continue;
            }
            for (let i = 0; i < c.count; i++) {
                const p = c.list + i * 24;
                out.push({
                    ...cycle(modelList(rom, u32(rom, p), 4), wave),
                    ops: [T(f32(rom, p + 4), f32(rom, p + 8), f32(rom, p + 12)),
                        RZ(s16(rom, p + 16)), RY(s16(rom, p + 18)), RX(s16(rom, p + 20))],
                });
            }
        }
        return out;
    },

    /* The ones that draw nothing in any state the explorer shows. */
    none: () => [],
};

/* slot's three reels: where each stands — lda'd floats — and its step a frame. */
const SLOT_REELS = [
    [-28.7869, 9.5, 140.705, 0.5],     /* 0xC1E65495 0x41180000 0x430CB474, stepped on odd frames */
    [-28.1053, 9.5, 144.391, 1],       /* 0xC1E0D7A8 0x41180000 0x43106439 */
    [-27.4193, 9.5, 148.078, 2],       /* 0xC1DB5ABA 0x41180000 0x43141405 */
];
const SLOT_TURN = 0x382d;
const BIG_BIRD_SCALE = 26;             /* 0x41D00000, bb_int's starting size */

/* ---- the gulls -------------------------------------------------------------- */

/* How far out along its heading each gull flies. */
const BIRD_RADIUS = 15;                /* 0x41700000 */

/*
 * tori_dsp and tori_syumi_dsp, which are the same flock drawn two ways. The
 * helper adds its offset to the heading register and never puts it back, so
 * within a group each bird's turn is the sum of the offsets so far. The later
 * groups stand off the first by translates that are never popped, so each is
 * off the one before: (5, 2), then (-12, -1) more.
 *
 * A bird not yet in the flock is drawn as model 0, which the viewer hides.
 */
function gullFlock(r, { rom, O }, { third, grows }) {
    const table = [...modelList(rom, O.birds, 32), 0];
    const hide = table.length - 1;
    const out = [];
    const bird = (base, turn, beat, from = 0, phase = 0) => {
        out.push({
            ...cycle(table, (f) => (f + 1 < from ? hide : beat(f + 1))),
            ops: (f) => [...base, RY(((f + 1 + phase) << 7) + r.angle + turn), T(BIRD_RADIUS, 0, 0)],
        });
    };
    /* Three beats and a glide: the 0x80-long cycle, held past 0x5F. */
    const beat = (t) => { const i = t & 0x7f; return (i > 0x5f ? 31 : i) & 31; };
    const home = [at(r)];
    for (const turn of [0, 0x8000]) bird(home, turn, beat);
    const second = [...home, T(5, 2, 0)];
    for (const turn of [0x500, 0x2800, 0x3800]) bird(second, turn, (t) => beat((t >> 1) + 14), grows ? 960 : 0);
    if (third) {
        const thirdBase = [...second, T(-12, -1, 0)];
        /* The quicker beat: a 0x40-long cycle, held past 31, and a heading
         * 31 frames on. */
        const quick = (t) => { const i = (t + 31) & 0x3f; return i > 31 ? 31 : i; };
        const turns = grows ? [0x6000, 0x6800, 0x8800, 0x9000, 0xc000, 0xc800] : [0x6000, 0x6800];
        for (const turn of turns) bird(thirdBase, turn, quick, grows ? 1920 : 0, 31);
    }
    return out;
}

/* ---- the horses ------------------------------------------------------------- */

const HORSE_RADII = [25, 35];          /* 0x41C80000, 0x420C0000 */
const HORSE_LEAN = 0x222;
/* uma_getaway_chk: the car has to come within 8 of a horse, across the ground. */
const HORSE_SHY = 8;                   /* 0x41000000 */
/* The horse runs at half again the car's speed. */
const HORSE_PACE = 1.5;                /* 0x3FC00000 */
/* uma_nashi_int: how long a horse that has run out of sight stays gone. */
const HORSE_AWAY = 5 << 9;
/* The camera is not a car. It may be standing still when it reaches a horse,
 * which would leave the horse galloping on the spot, or it may have jumped, and
 * a jump measured as a speed would throw the horse out of sight in a frame. So
 * the speed it lends a horse is kept between these two, which are the
 * explorer's numbers, not the board's. */
const HORSE_MIN_SPEED = 1.0;
const HORSE_MAX_SPEED = 6.0;
/* The frames a bolt is stepped through to catch up with the clock, as the
 * trails and the sway chains are; past that it is jumped. */
const HORSE_CATCH_UP = 120;

/* Where on its ellipse a horse is after `n` steps, as uma_dsp draws it. */
function horseRing(r, n) {
    const a = r.angle + (n << 6);
    return [at(r), RZ(HORSE_LEAN), T(...horseOffset(a)), RY(0xc000 - a)];
}
function horseOffset(a) {
    const t = (a & 0xffff) * (2 * Math.PI / 65536);
    return [Math.sin(t) * HORSE_RADII[0], 0, Math.cos(t) * HORSE_RADII[1]];
}

/*
 * The bolt: uma_getaway_chk, uma_getaway_int and uma_nashi_int, with the
 * camera standing in for the car.
 *
 * On its ellipse a horse checks, each frame, how far the car is from where it
 * stood the frame before; inside 8 it bolts. Bolting, it takes the car's
 * heading and half again its speed and runs straight along that heading on
 * the ground (get_y_position under it, which here is the drawn road's
 * height), and whenever the car comes within 8 again it takes them afresh.
 * TGP function 0x47 steps it: by speed along the heading, which is the
 * direction the model faces when turned by it. It runs until its block is out
 * of view — the 5x5 blocks round the car that set_area_block marks, less the
 * heading clip extra_clip takes off, which is not ported — and is then gone
 * for 2560 frames before uma_int puts it back on its ellipse.
 *
 * The board also stops a horse's ellipse while its block is out of view. The
 * explorer draws the whole course at once, so here the ellipse always runs.
 *
 * Stateful, unlike everything else here, so it is a `live` hook the app steps
 * with the camera: `live(frame, cam)` returns the ops, the model and whether
 * the draw is hidden.
 */
function horseRun(r, gallop, { ground }) {
    const s = { last: -1, mode: 'ring', n: 0, prev: [0, 0, 0], pos: null, heading: 0, speed: 0, away: 0 };
    const reset = () => Object.assign(s, { mode: 'ring', n: 0, prev: horseOffset(r.angle), pos: null, away: 0 });
    const near = (cam, x, z) => cam && Math.hypot(x - cam.x, z - cam.z) < HORSE_SHY;
    const block = (v) => ((Math.round(v) + 1024) >> 7) & 15;
    const inView = (cam, x, z) => !cam
        || (Math.abs(block(x) - block(cam.x)) <= 2 && Math.abs(block(z) - block(cam.z)) <= 2);
    const take = (cam) => {
        s.heading = cam.heading;
        s.speed = HORSE_PACE * Math.min(Math.max(cam.speed, HORSE_MIN_SPEED), HORSE_MAX_SPEED);
    };
    const step = (cam) => {
        if (s.mode === 'ring') {
            const bolt = near(cam, r.pos[0] + s.prev[0], r.pos[2] + s.prev[2]);
            s.n++;
            s.prev = horseOffset(r.angle + (s.n << 6));
            if (bolt) {
                s.mode = 'bolt';
                s.pos = [r.pos[0] + s.prev[0], r.pos[1], r.pos[2] + s.prev[2]];
                take(cam);
            }
            return;
        }
        if (s.mode === 'bolt') {
            if (near(cam, s.pos[0], s.pos[2])) take(cam);
            if (!inView(cam, s.pos[0], s.pos[2])) { s.n++; s.mode = 'away'; s.away = 0; return; }
            const g = ground?.(s.pos[0], s.pos[2]);
            if (g) s.pos[1] = g.y;
            const h = (s.heading & 0xffff) * (2 * Math.PI / 65536);
            s.pos[0] -= Math.sin(h) * s.speed;
            s.pos[2] += Math.cos(h) * s.speed;
            s.n++;
            return;
        }
        if (++s.away >= HORSE_AWAY) reset();
    };
    return (frame, cam) => {
        if (s.last < 0 || frame < s.last) { reset(); s.last = frame - 1; }
        const from = Math.max(s.last + 1, frame - HORSE_CATCH_UP + 1);
        for (let f = from; f <= frame; f++) step(cam);
        s.last = frame;
        const model = gallop[s.n & 31];
        if (s.mode === 'ring') return { model, ops: horseRing(r, s.n || 1) };
        if (s.mode === 'bolt') return { model, ops: [T(...s.pos), RY(s.heading)] };
        return { model, ops: [], hidden: true };
    };
}

/* ---- the game's states ------------------------------------------------------ */

/*
 * Which of the game's states a course is drawn in. The object routines test
 * two things besides the course: M_mode, which is 1 << B_mode and so a bit per
 * entry in mode_control's table — 0x400000 GAME_DSP, 0x10000000 STAFF_DSP, the
 * ending — and 0x501a80, which gear_select sets when switch bit 4 is held at
 * the transmission select and which entry_car_event_open reads to enter no
 * rival cars: time attack. Attract mode draws what a race does.
 */
export const MODES = [
    ['race', 'Race (and attract)'],
    ['timeAttack', 'Time attack'],
    ['ending', 'Ending'],
];

/* ---- the course ------------------------------------------------------------- */

/**
 * The draws for one course's objects, in the explorer's shape.
 *
 * `ground(x, z)` answers where the road is under a point — a height and
 * the turns that tip a model to its slope — or null; the cones stand on it and
 * a bolting horse runs on it. `mode` is which of the game's states to draw the
 * course in — see MODES.
 */
export function courseObjectDraws(rom, course, ground, mode = 'race') {
    const O = rom.game.objects;
    if (!O) return [];
    const ctx = { rom, O, course, ground, mode };
    const out = [];
    for (const r of readObjectRecords(rom, course)) {
        /* sub_216e4 calls whatever routine its argument names, once a frame,
         * and one of the three is the Jeffry statue's; the other two name none
         * and are the pylons' bookkeeping. */
        let kind = O.kinds[r.init];
        if (kind === 'runs') kind = O.kinds[r.arg & ~PROG_ALIAS] ?? 'none';
        const build = KINDS[kind];
        if (!build) continue;
        for (const d of build(r, ctx)) {
            if (d.model < 0) continue;
            out.push({ ...d, kind, block: r.block });
        }
    }
    return out;
}

/** The grid block a point stands in — get_m_block. */
export function gridBlock(x, z) {
    const c = (v) => ((Math.round(v) + 1024) >> 7) & 15;
    return (c(z) << 4) | c(x);
}

/*
 * The blocks of a course the board can ever draw.
 *
 * It never draws a course whole. set_area_block takes the camera's block and
 * marks the 5x5 round it, and where that runs off the grid it masks the
 * columns and rows that would — the grid does not wrap; extra_clip then takes
 * off more by where on the road the car is. So a block is drawn only if a car
 * can stand within two blocks of it, and the road is in the ROM: the row
 * change_course_bank reads per course (the sky's `table`) names, at +0x10, the
 * car lines — eight lanes, each a pointer and a count of 28-byte points with x
 * at +0 and z at +8, which set_course_parms hands to the cars at 0x50144c.
 *
 * Every block within two of a point on any lane. What this leaves out, in
 * every build, is four blocks in Seaside Street Galaxy's far corner: a copse of
 * trees with no ground under it, eight blocks from the nearest road.
 *
 * The fourth course, the striped test square, has no road — its row names no
 * lanes — so where the lanes do not read as points on the grid, all of it is
 * drawn (null).
 */
export function courseReach(rom, course) {
    const table = rom.game.sky?.table;
    if (table == null) return null;
    const inData = (a, len) => a >= DATA_BASE && a - DATA_BASE + len <= rom.mainData.length;
    const row = u32(rom, table + course * 4);
    if (!inData(row, 20)) return null;
    const lines = u32(rom, row + 16);
    if (!inData(lines, CAR_LANES * 8)) return null;
    const on = new Set();
    for (let l = 0; l < CAR_LANES; l++) {
        const p = u32(rom, lines + l * 8), n = u32(rom, lines + l * 8 + 4);
        if (!n || !inData(p, n * 28)) return null;
        for (let i = 0; i < n; i++) {
            const x = f32(rom, p + i * 28), z = f32(rom, p + i * 28 + 8);
            if (!(Math.abs(x) < 1024 && Math.abs(z) < 1024)) return null;
            on.add(boardBlock(x, z));
        }
    }
    const reach = new Set();
    for (const b of on) {
        for (let dz = -AREA_REACH; dz <= AREA_REACH; dz++) {
            for (let dx = -AREA_REACH; dx <= AREA_REACH; dx++) {
                const x = (b & 15) + dx, z = (b >> 4) + dz;
                if (x >= 0 && x < 16 && z >= 0 && z < 16) reach.add((z << 4) | x);
            }
        }
    }
    return reach;
}
const CAR_LANES = 8;
const AREA_REACH = 2;
/* get_m_block as the board computes it, cvtri truncating toward zero. */
const boardBlock = (x, z) => ((((Math.trunc(z) + 1024) >> 7) & 15) << 4) | (((Math.trunc(x) + 1024) >> 7) & 15);

/*
 * The road under a point, for the pylons: the course's own geometry standing
 * in for the collision polygons the board asks the TGP about.
 *
 * Only the block the point is in and the eight round it are looked at, which
 * is a few thousand triangles rather than the course's fifty thousand, and
 * each is decoded once. What is taken is the highest face under the point that
 * faces up: a pylon stands on the road, and nothing in the three courses runs
 * a road over one. Its normal gives the tip — the board turns X and then Z to
 * stand the model on the slope, and the two angles that carry +Y onto the
 * normal in that order are these.
 */
export function courseGround(blockModel) {
    const cache = new Map();
    const tris = (b) => {
        if (!cache.has(b)) cache.set(b, blockModel(b)?.positions ?? null);
        return cache.get(b);
    };
    return (x, z) => {
        /* The decoder has negated Z, so the point is (x, -z) in its frame. */
        const px = x, pz = -z;
        const bx = ((Math.round(x) + 1024) >> 7) & 15, bz = ((Math.round(z) + 1024) >> 7) & 15;
        let best = null;
        for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
                const cx = bx + dx, cz = bz + dz;
                if (cx < 0 || cx > 15 || cz < 0 || cz > 15) continue;
                const p = tris((cz << 4) | cx);
                if (!p) continue;
                for (let i = 0; i + 9 <= p.length; i += 9) {
                    const hit = underPoint(p, i, px, pz);
                    if (hit && (!best || hit.y > best.y)) best = hit;
                }
            }
        }
        if (!best) return null;
        const [nx, ny, nz] = best.n;
        const ax = Math.atan2(nz, ny), az = -Math.asin(Math.max(-1, Math.min(1, nx)));
        return { y: best.y, tilt: [['rx', (ax * 180) / Math.PI], ['rz', (az * 180) / Math.PI]] };
    };
}

/* Where a triangle is under (x, z) in the decoder's frame, if it is and it
 * faces up: the height there and its unit normal, turned up. */
function underPoint(p, i, x, z) {
    const ax = p[i], ay = p[i + 1], az = p[i + 2];
    const bx = p[i + 3], by = p[i + 4], bz = p[i + 5];
    const cx = p[i + 6], cy = p[i + 7], cz = p[i + 8];
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(d) < 1e-9) return null;
    const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
    const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
    if (u < 0 || v < 0 || u + v > 1) return null;
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const len = Math.hypot(nx, ny, nz);
    if (!len) return null;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    if (ny / len < 0.7) return null;
    return { y: u * ay + v * by + (1 - u - v) * cy, n: [nx / len, ny / len, nz / len] };
}
