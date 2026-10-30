/*
 * belplayers.js — Behind Enemy Lines' soldiers, posed by the game's own draw.
 *
 * A soldier is an actor record of 0x1A0 bytes in the data ROM (136 of them,
 * data 0x2BDDF10 .. 0x2BEBC10, each its own compiled unit followed by its
 * SCCS strings): +0x04 + 8k the motion it plays in slot k (+0x08 + 8k a
 * word, -1 or 0), +0x60 sixteen parts of two words each, the near model
 * and the far one (model table records), +0x100 the part count (16).
 *
 * A motion is a 0x40-byte record: +0x00 the frames (16 parts x 12 bytes a
 * row), +0x04 a list of events (+0x0C their count), +0x08 the rows less
 * one, +0x10 the rate (0x20 or 0x40: rows a tick x 64), +0x14 the turn and
 * +0x18 the step (x y z) the actor is moved by when the motion ends. A row
 * part is {short rx, ry, rz, x, y, z}, the angles 0x10000 to the turn, the
 * place over 2048.
 *
 * 0x51C20 (actor, motion, frame) draws an actor: push, the actor's place
 * and turns, then for each part the copro commands translate (x y z),
 * turn Z by -rz, turn Y by ry, turn X by rx, the part's model (0x11EE0),
 * pop. Every part hangs from the actor itself; there is no chain. Between
 * rows it blends (rate below 0x40, near models only): half way from 0.4 to
 * 0.6 of a row, else by the fraction.
 *
 * The explorer runs 0x51C20 on js/i960.js (doaMachine) with the actor at
 * the origin and a camera beside it, and reads each part's matrix off the
 * draw it hands the geometrizer.
 */
import { doaMachine } from './doa.js';
import { floatToBits } from './i960.js';

const DATA = 0x2000000;
const DRAW = 0x51c20;
const ACTORS = 0x2bddf10, ACTOR_BYTES = 0x1a0, ACTOR_COUNT = 136;
const PARTS = 16;
const MOTION_SLOTS = 11;
const ROW_PART = 12;
/* Work RAM: the camera pointer the draw reads, and our own actor and camera. */
const CAMERA_PTR = 0x5a7e84;
const OBJ = 0x5d0000, CAMERA = 0x5d1000;

/* The parts by their models (records 493 + 10u .. for uniform u, then the
 * shared hands, heads and kit), in the actor's order. */
const PART_NAMES = ['hips', 'chest', 'head', 'upper arm R', 'forearm R', 'hand R', 'weapon',
    'thigh R', 'shin R', 'foot R', 'upper arm L', 'forearm L', 'hand L', 'thigh L', 'shin L', 'foot L'];

const word = (rom, a) => rom.mainDataView.getUint32(a - DATA, true);

function isRecord(rom, p) {
    const t = rom.game.modelTable;
    const off = p - DATA - t.offset;
    return off >= 0 && off % t.stride === 0 && off / t.stride < t.count;
}

function recordOf(rom, p) {
    const t = rom.game.modelTable;
    return (p - DATA - t.offset) / t.stride;
}

/* The actor records, checked: sixteen parts, every model a table record. */
function actors(rom) {
    if (rom.belActors) return rom.belActors;
    const out = [];
    for (let i = 0; i < ACTOR_COUNT; i++) {
        const a = ACTORS + i * ACTOR_BYTES;
        if (word(rom, a + 0x100) !== PARTS) continue;
        const near = [], far = [];
        let ok = true;
        for (let k = 0; k < PARTS && ok; k++) {
            const n = word(rom, a + 0x60 + k * 8), f = word(rom, a + 0x64 + k * 8);
            ok = isRecord(rom, n) && isRecord(rom, f);
            near.push(recordOf(rom, n));
            far.push(recordOf(rom, f));
        }
        if (!ok) continue;
        const slots = [];
        for (let k = 0; k < MOTION_SLOTS; k++) {
            const m = word(rom, a + 4 + k * 8);
            if (m) slots.push({ slot: k, address: m });
        }
        out.push({ address: a, near, far, slots });
    }
    rom.belActors = out;
    return out;
}

/**
 * The bodies: one for each set of models the actors are drawn with (23
 * uniforms, some with another head or held item), each with the actors
 * that use it.
 */
export function readBelBodies(rom) {
    const byModels = new Map();
    for (const a of actors(rom)) {
        const key = a.near.join(',');
        if (!byModels.has(key)) byModels.set(key, { actors: [], near: a.near, far: a.far });
        byModels.get(key).actors.push(a);
    }
    const out = [];
    for (const { actors: list, near, far } of byModels.values()) {
        const uniform = Math.floor((near[0] - 493) / 10) + 1;
        const index = out.length;
        out.push({
            index,
            name: `Soldier ${index + 1} (uniform ${uniform})`,
            address: list[0].address,
            actors: list.map((a) => a.address),
            joints: PARTS, scale: 1, roles: [], skin: -1, hitMotions: [], start: -1,
            /* Scene 2's sheets, where the attract plays the soldiers. */
            playerSet: rom.game.texture.defaultSet,
            root: list[0].address,
            parts: near.map((model, k) => ({
                index: k, name: PART_NAMES[k], parent: -1, depth: 0, joint: k, flags: 0,
                offset: [0, 0, 0], record: list[0].address + 0x60 + k * 8, model, far: far[k],
            })),
            motionAddresses: [...new Set(list.flatMap((a) => a.slots.map((s) => s.address)))],
        });
    }
    return out;
}

/** The motions every actor's slots name, in ROM order. */
export function readBelMotions(rom) {
    if (rom.belMotions) return rom.belMotions;
    const seen = new Map();
    for (const a of actors(rom)) for (const s of a.slots) {
        if (!seen.has(s.address)) seen.set(s.address, new Set());
        seen.get(s.address).add(s.slot);
    }
    const list = [...seen.keys()].sort((x, y) => x - y).map((address, index) => {
        const dv = rom.mainDataView, o = address - DATA;
        const rows = dv.getUint32(o + 8, true) + 1;
        return {
            index, name: `motion ${index + 1}`, address,
            offset: dv.getUint32(o, true) - DATA,
            frames: rows, keys: rows, joints: PARTS,
            rate: dv.getUint32(o + 0x10, true),
            events: dv.getUint32(o + 0x0c, true),
            turn: dv.getFloat32(o + 0x14, true),
            step: [0, 1, 2].map((k) => dv.getFloat32(o + 0x18 + k * 4, true)),
            slots: [...seen.get(address)].sort((x, y) => x - y),
            root: -1,
        };
    });
    rom.belMotions = list;
    return list;
}

/** One skeleton for every soldier: every motion fits every body; the lead
 * motions are the ones its own actors play. */
export function belMotionList(rom, body, motions) {
    const fits = motions.filter(Boolean);
    const own = new Set(body.motionAddresses);
    const lead = fits.filter((m) => own.has(m.address));
    return { fits, lead: lead.length ? lead : fits, label: 'Played by its actors' };
}

/* The actor at the origin, facing the way its models do, the camera on top
 * of it (so the near models) or 100 away, the shadow left out (flag bit 9). */
function setUp(M, body, far) {
    const o = OBJ - 0x500000;
    M.ram.fill(0, o, o + 0x200);
    M.ram.fill(0, CAMERA - 0x500000, CAMERA - 0x500000 + 0x100);
    M.rv.setUint32(o, 1 << 9, true);
    M.rv.setUint32(o + 0x38, body.address, true);
    M.rv.setUint32(CAMERA_PTR - 0x500000, CAMERA, true);
    /* 18 or more away (0x51EBC): the far models, and no blending. */
    if (far) M.rv.setFloat32(CAMERA - 0x500000 + 0x24, 100, true);
}

function run(rom, body, motion, frame, far) {
    const M = doaMachine(rom);
    setUp(M, body, far);
    M.copro.stack = [];
    M.geo.draws = [];
    const done = M.cpu.call(DRAW, [OBJ, motion.address, floatToBits(frame)], { maxSteps: 2_000_000 });
    if (!done) throw new Error('0x51C20 did not return');
    return M.geo.draws;
}

/* Board matrix to three.js, Z negated. */
function toThree(m) {
    return [m[0], m[1], -m[2], 0, m[3], m[4], -m[5], 0, -m[6], -m[7], m[8], 0, m[9], m[10], -m[11], 1];
}

/** A soldier at a row of a motion (1 the first; a fraction blends as the
 * game does), near, or far: the far models, the row without blending.
 * Without travel the hips stay over the origin. */
export function poseBel(rom, body, motion, frame, { far = false, travel = true } = {}) {
    motion ??= readBelMotions(rom)[0];
    const f = Math.max(1, Math.min(frame, motion.frames)) - 1;
    const draws = run(rom, body, motion, f, far);
    if (draws.length !== PARTS) throw new Error(`0x51C20 drew ${draws.length} parts, not ${PARTS}`);
    const three = draws.map((d) => toThree(d.m));
    /* On the spot: the hips' travel over the ground taken off every part. */
    if (!travel) {
        const [x, , z] = [three[0][12], three[0][13], three[0][14]];
        for (const e of three) { e[12] -= x; e[14] -= z; }
    }
    return {
        matrices: three,
        origins: three.map((e) => [e[12], e[13], e[14]]),
        draws: draws.map((d) => [d.model]),
        parents: body.parts.map((p) => p.parent),
    };
}
