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
 * What is left out. The cones are drawn where they stand, and not flying off
 * when hit; the horses gallop and do not bolt. Some things are only drawn in
 * a mode the explorer has no stand-in for — a third group of gulls and a
 * second flock (tori_syumi), the horses' curtain call, the Jeffry statue's
 * turn — and are drawn in the state a course opens in, which for the first
 * three is not at all. Two windows turn their picture to follow the camera;
 * they show their first.
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
    /* rou2: the record's own Y turn walked back 0x100 a frame. */
    spinY: (r, { rom }) => [{
        model: modelOf(rom, r.arg),
        ops: (f) => [at(r), RY(r.angle - (f + 1) * 0x100)],
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

    /* rank: the leader board, five models at five places out of a table. The
     * board fills it with the cars in the order they stand; before a race it
     * is the record's model at all five. */
    rank: (r, { rom, O }) => [0, 1, 2, 3, 4].map((i) => {
        const e = O.rankBoard + i * 12;
        return { model: modelOf(rom, r.arg), ops: [T(f32(rom, e), f32(rom, e + 4), f32(rom, e + 8))] };
    }),

    /* wing: the windmill — its sails walk 64 models and its two other parts
     * stand still, all three in world space. */
    windmill: (r, { rom, O }) => [
        { ...cycle(modelList(rom, O.windmill.sails, 64), (f) => f & 0x3f), ops: [] },
        ...O.windmill.still.map((p) => ({ model: modelOf(rom, p), ops: [] })),
    ],

    /* jeffly, reached by way of sub_216e4: the Jeffry statue, at the record's
     * place and not turned. */
    jeffry: (r, { rom, O }) => [{ model: modelOf(rom, O.jeffry), ops: [at(r)] }],

    /* The windows that follow the camera, at their first picture. */
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
     * more circle a point (5, 2) off it, on half the beat. A third group, a
     * further (-12, -1) on, is drawn only in attract mode.
     */
    birds: (r, ctx) => birdFlock(r, ctx),

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
     * on the ellipse each starts. They bolt when a car comes close, which a
     * viewer's camera does not do.
     */
    horse: (r, { rom, O }) => {
        const gallop = modelList(rom, O.horses, 32);
        return [{
            ...cycle(gallop, (f) => (f + 1) & 31),
            ops: (f) => {
                const a = r.angle + ((f + 1) << 6);
                const t = (a & 0xffff) * (2 * Math.PI / 65536);
                return [at(r), RZ(HORSE_LEAN),
                    T(Math.sin(t) * HORSE_RADII[0], 0, Math.cos(t) * HORSE_RADII[1]),
                    RY(0xc000 - a)];
            },
        }];
    },

    /*
     * ctykya: the crowds on Seaside Street Galaxy — groups of cut-out people,
     * each a place and three turns (Z, then Y, then X) out of a table, and a
     * four-model list walked every eighth frame, which is them waving. The
     * board draws a crowd only while the player is on the stretch of road it
     * lines. Revision A has one, twelve groups along the fence under the space
     * shuttle; the Special Edition added a second, nine in the plaza among the
     * shopfronts.
     */
    crowd: (r, { rom, O }) => {
        const out = [];
        for (const { list, count } of O.crowds) {
            for (let i = 0; i < count; i++) {
                const p = list + i * 24;
                const frames = modelList(rom, u32(rom, p), 4);
                out.push({
                    ...cycle(frames, (f) => ((f + 1) >> 3) & 3),
                    ops: [T(f32(rom, p + 4), f32(rom, p + 8), f32(rom, p + 12)),
                        RZ(s16(rom, p + 16)), RY(s16(rom, p + 18)), RX(s16(rom, p + 20))],
                });
            }
        }
        return out;
    },

    /* The ones that draw nothing in the state a course opens in. */
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
const HORSE_RADII = [25, 35];          /* 0x41C80000, 0x420C0000 */
const HORSE_LEAN = 0x222;

/* How far out along its heading each gull flies. */
const BIRD_RADIUS = 15;                /* 0x41700000 */
function birdFlock(r, { rom, O }) {
    const table = modelList(rom, O.birds, 32);
    const out = [];
    /* One bird: a heading of (t << 7) + the record's angle + its own offset,
     * stepped out 15, beating on `beat`. `base` is what the matrix holds
     * before the push: the record's place, and for the later groups a step
     * off it that is never popped. */
    const bird = (base, turn, beat) => {
        out.push({
            ...cycle(table, (f) => { const i = beat(f) & 0x7f; return (i > 0x5f ? 31 : i) & 31; }),
            ops: (f) => [...base, RY(((f + 1) << 7) + r.angle + turn), T(BIRD_RADIUS, 0, 0)],
        });
    };
    /* The helper adds its offset to the heading register and never puts it
     * back, so within a group each bird is the sum of the offsets so far:
     * 0 and 0x8000, then 0x500, 0x2800 and 0x3800. */
    const home = [at(r)];
    for (const turn of [0, 0x8000]) bird(home, turn, (f) => f + 1);
    const second = [...home, T(5, 2, 0)];
    for (const turn of [0x500, 0x2800, 0x3800]) bird(second, turn, (f) => ((f + 1) >> 1) + 14);
    return out;
}

/* ---- the course ------------------------------------------------------------- */

/**
 * The draws for one course's objects, in the explorer's shape.
 *
 * `ground(x, z)` answers where the road is under a point — a height and
 * the turns that tip a model to its slope — or null, and is only asked by the
 * pylons.
 */
export function courseObjectDraws(rom, course, ground) {
    const O = rom.game.objects;
    if (!O) return [];
    const ctx = { rom, O, course, ground };
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
