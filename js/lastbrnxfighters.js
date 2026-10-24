/*
 * lastbrnxfighters.js — Last Bronx's fighters on the animation tab.
 *
 * As for Dead or Alive (js/doafighters.js), there is no table of parts to
 * read: the fighter's draw (0x4A940) works out each part's matrix on the
 * copro and sends model after model. Last Bronx's copro is a SHARC running a
 * program the i960 uploads (19698 halfwords at 0x99F8), and the fight code
 * leans on it as no stage piece does: a matrix stack, a pool of matrices it
 * hands out handles to (0x4B sets it up, 0x4C..0x4E take one, 0x59 gives it
 * back), lists of them per player, and command 0x46, which writes a whole
 * geometrizer packet (matrix, flags, the model entry's four words) into
 * buffer RAM itself. So the explorer runs that program too, on js/sharc.js,
 * beside the i960 and wired as the board wires them: the FIFO in, the FIFO
 * out, and buffer RAM at 0x900000 on the i960's side.
 *
 * The machine is the boot's (0x1380) set-up, routine by routine: the ones
 * the copro's lists and the fighters' tables need, in the boot's order. Three
 * of the boot's routines wait on hardware here and are left out or cut short
 * (0x3D700, 0x9DAC0; 0x72E0 once it has uploaded the program, 0x98D8, which
 * is answered by loading it). Then 0xB5E10 sets the two players up as the
 * round start (0x2F060) does, the fighter in player one's place at the
 * centre, and 0x49540 starts the motion. Each frame is the player step
 * (0x49820) and the draw, under an identity matrix: the parts come back in
 * the fighter's own frame.
 *
 * The motions are each character's three tables, indexed by the motion
 * number: 0x52CEA0 the names (`kon_kamae_new_5_0`), 0x511BA0 the data (a
 * bitstream in the data ROM, unpacked by 0x4B090), 0x52B4D0 a 16-byte head
 * whose halfwords at +8 and +10 are the data's length (in 1/30 s) and the
 * motion's in frames: 0x47D48 plays it at 57.5 * h8 / h10 a frame. A motion
 * id is the game's, the character above bit 10 (0x49540).
 */
import { I960 } from './i960.js';
import { Sharc } from './sharc.js';
import { jointsOf } from './doafighters.js';

const PARTS = 20;
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
const RAM_BASE = 0x500000, RAM_SIZE = 0x100000;
const DATA_BASE = 0x2000000;
const COPRO_PORT = 0x884000, COPRO_END = 0x888000;
const BUFFER = 0x900000, BUFFER_END = 0x920000;
/* The geometrizer's write pointer: 0x472A8 reads it and moves it on past
 * the packet the copro is to write. */
const GEO_PTR_W = 0x801008, GEO_PTR_R = 0x802008;
const PACKET = 0x48;

/* The SHARC's side of the board (MAME model2.cpp copro_sharc_map). */
const SH_FIFO_IN = 0x400000, SH_FIFO_OUT = 0xc00000, SH_BUFFER = 0x1400000, SH_END = 0x1c00000;

const f32 = new DataView(new ArrayBuffer(4));
const asFloat = (u) => { f32.setUint32(0, u >>> 0); return f32.getFloat32(0); };

/* The program ROM addresses the fight code is at in the Export build; the
 * Japan build's are `code` further on from `codeFrom`. */
function at(rom, a) {
    const R = rom.game.rig;
    return a >= R.codeFrom ? a + R.code : a;
}

/* The data section as the boot copies it, for the tables in it. */
function dataSection(rom) {
    const cv = rom.mainCpuView;
    const D = rom.game.texture.raw.data;
    return new DataView(cv.buffer, cv.byteOffset + D.rom, rom.game.stageTable.lastbrnx.dataSize);
}

/*
 * A machine booted as far as the fight needs, both players set up. `draw(p)`
 * is player p's draw for the frame, each part `{ model, m }`.
 */
export function lastbrnxFightMachine(rom, fighters) {
    const R = rom.game.rig;
    const cv = rom.mainCpuView, dv = rom.mainDataView;
    const T = rom.game.modelTable;
    const ram = new Uint8Array(RAM_SIZE), rv = new DataView(ram.buffer);
    const data = dataSection(rom);
    ram.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    const buf = new Uint32Array(0x8000);
    const fin = [], fout = [];
    let finAt = 0;

    const sharc = new Sharc({
        extRead(a) {
            if (a >= SH_FIFO_IN && a < SH_FIFO_OUT) {
                if (finAt >= fin.length) return null;
                const v = fin[finAt++];
                if (finAt === fin.length) { fin.length = 0; finAt = 0; }
                sharc.setFlagInput(0, fin.length === 0);
                return v;
            }
            if (a >= SH_BUFFER && a < SH_END) return buf[a & 0x7fff];
            return 0;
        },
        extWrite(a, v) {
            if (a >= SH_FIFO_OUT && a < SH_BUFFER) fout.push(v >>> 0);
            else if (a >= SH_BUFFER && a < SH_END) buf[a & 0x7fff] = v >>> 0;
            return true;
        },
    });
    /* The SHARC runs until it waits on the FIFO again. */
    const runSharc = () => {
        for (let k = 0; k < 50; k++) if (sharc.run(100_000) !== 'budget') return;
    };

    let lastModel = null, geoPtr = BUFFER, drawn = null;
    const recent = [];
    const push = (v) => {
        recent.push(v);
        if (recent.length > 8) recent.shift();
        fin.push(v >>> 0);
        sharc.setFlagInput(0, false);
        runSharc();
    };
    const pull = () => {
        if (!fout.length) runSharc();
        return fout.length ? fout.shift() : 0;
    };
    /* The model entry read last, by its `ldq` from the table. */
    const tableEnd = T.offset + T.count * T.stride;
    const inRam = (a) => a >= RAM_BASE && a < RAM_BASE + RAM_SIZE;
    const read32 = (a) => {
        if (a < cv.byteLength - 3) {
            if (a >= T.offset && a < tableEnd) lastModel = Math.floor((a - T.offset) / T.stride);
            return cv.getUint32(a, true);
        }
        if (inRam(a)) return rv.getUint32(a - RAM_BASE, true);
        if (a >= DATA_BASE && a - DATA_BASE < dv.byteLength - 3) return dv.getUint32(a - DATA_BASE, true);
        if (a >= COPRO_PORT && a < COPRO_END) return pull();
        if (a >= BUFFER && a < BUFFER_END) return buf[(a >> 2) & 0x7fff];
        if (a === GEO_PTR_R) return geoPtr;
        return 0;
    };
    const write32 = (a, v) => {
        if (inRam(a)) { rv.setUint32(a - RAM_BASE, v, true); return; }
        if (a >= COPRO_PORT && a < COPRO_END) {
            /* 0x47 closes a 0x46 draw: the packet is at the pointer the draw
             * moved on from. */
            if (v === 0x47 && recent.includes(0x46) && drawn) drawn.push({ model: lastModel, at: (geoPtr - PACKET) >>> 0 });
            if (v === 0x47) lastModel = null;
            push(v);
            return;
        }
        if (a >= BUFFER && a < BUFFER_END) buf[(a >> 2) & 0x7fff] = v >>> 0;
        else if (a === GEO_PTR_W) geoPtr = v >>> 0;
    };
    const lane = (a) => [a & ~3, (a & 3) * 8];
    const bus = {
        read32, write32,
        read8: (a) => { const [w, s] = lane(a); return (read32(w) >>> s) & 0xff; },
        read16: (a) => { const [w, s] = lane(a); return (read32(w) >>> s) & 0xffff; },
        write8: (a, v) => { if (inRam(a)) ram[a - RAM_BASE] = v; else { const [w, s] = lane(a); write32(w, (read32(w) & ~(0xff << s)) | ((v & 0xff) << s)); } },
        write16: (a, v) => { if (inRam(a)) rv.setUint16(a - RAM_BASE, v, true); else { const [w, s] = lane(a); write32(w, (read32(w) & ~(0xffff << s)) | ((v & 0xffff) << s)); } },
    };
    const cpu = new I960(bus);

    const program = new Uint16Array(R.sharc.halfwords);
    for (let n = 0; n < program.length; n++) program[n] = cv.getUint16(R.sharc.at + 2 * n, true);
    cpu.hooks.set(R.upload, () => { sharc.loadProgram(program); push(8); });
    for (const [a, args = [], steps = 3_000_000] of R.boot) {
        if (a === 'sync') push(8);
        else cpu.call(at(rom, a), args, { maxSteps: steps });
    }
    /* 0xB5E10(player, char, costume, 0, x, 0, angle, 0, 0), floats. */
    fighters.forEach(({ char, costume, x, angle }, p) => {
        f32.setFloat32(0, x); const xw = f32.getUint32(0);
        f32.setFloat32(0, angle); const aw = f32.getUint32(0);
        cpu.call(at(rom, R.setup), [p, char, costume, 0, xw, 0, aw, 0, 0], { maxSteps: 20_000_000 });
    });

    const byWords = modelsByWords(rom);
    return {
        cpu, sharc, ram,
        start(p, id) { cpu.call(at(rom, R.start), [p, id, 0, 0, 0], { maxSteps: 20_000_000 }); },
        step(p) { cpu.call(at(rom, R.step), [p], { maxSteps: 20_000_000 }); },
        draw(p) {
            drawn = [];
            geoPtr = BUFFER + 0x100;
            push(8);
            push(0x10);
            push(5);
            cpu.call(at(rom, R.draw), [p, 0], { maxSteps: 20_000_000 });
            push(6);
            const out = drawn.map(({ model, at: a }) => {
                const i = (a >> 2) & 0x7fff;
                const words = [buf[i + 14], buf[i + 15], buf[i + 16], buf[i + 17]];
                return {
                    model: model ?? byWords.get(words.join(':')) ?? null,
                    m: Array.from({ length: 12 }, (_, k) => asFloat(buf[(i + 1 + k) & 0x7fff])),
                };
            });
            drawn = null;
            return out;
        },
    };
}

/* A part whose entry was not read from the table is matched by its words. */
const wordMaps = new WeakMap();
function modelsByWords(rom) {
    if (!wordMaps.has(rom)) {
        const T = rom.game.modelTable;
        const cv = rom.mainCpuView;
        const map = new Map();
        for (let n = 0; n < T.count; n++) {
            const o = T.offset + n * T.stride;
            const key = [0, 4, 8, 12].map((k) => cv.getUint32(o + k, true)).join(':');
            if (!map.has(key)) map.set(key, n);
        }
        wordMaps.set(rom, map);
    }
    return wordMaps.get(rom);
}

const str = (dv, a) => {
    let s = '';
    for (let k = 0; k < 40 && a + k < dv.byteLength; k++) {
        const c = dv.getUint8(a + k);
        if (!c) break;
        s += String.fromCharCode(c);
    }
    return s;
};

/* The tables the data section holds, read as the program ROM and data
 * section lay them out. */
function tables(rom) {
    const data = dataSection(rom);
    const cv = rom.mainCpuView;
    const word = (a) => (inData(a) ? data.getUint32(a - RAM_BASE, true) : a + 4 <= cv.byteLength ? cv.getUint32(a, true) : 0);
    const inData = (a) => a >= RAM_BASE && a - RAM_BASE + 4 <= data.byteLength;
    const view = (a) => (inData(a) ? [data, a - RAM_BASE] : [cv, a]);
    return { data, word, view };
}

/** The roster, a body for each fighter and costume. */
export function readLastbrnxFighters(rom) {
    const R = rom.game.rig;
    const { view } = tables(rom);
    const cv = rom.mainCpuView;
    const out = [];
    for (let char = 0; char < R.fighters; char++) {
        const [dv, o] = view(R.names + 9 * char);
        const name = str(dv, o);
        const nice = name.charAt(0) + name.slice(1).toLowerCase();
        for (const costume of [0, 1]) {
            out.push({
                index: (char << 1) | costume,
                fighter: char,
                motionSet: cv.getUint32(R.chars + 128 * char + 4 * R.setWord, true),
                costume,
                name: `${nice}${costume ? ' (2P)' : ''}`,
                joints: 15,
                fighterSet: rom.game.texture.raw.stages + 2 * char + costume,
                parts: Array.from({ length: PARTS }, (_, k) => ({ index: k, joint: k, parent: -1, model: null })),
            });
        }
    }
    return out;
}

/** Every motion set's motions, by the game's id (set << 10 | number). */
export function readLastbrnxMotions(rom) {
    const R = rom.game.rig;
    const { word, view } = tables(rom);
    const list = [];
    for (let set = 1; set <= R.fighters; set++) {
        const names = word(R.motions.names + 4 * set);
        const datas = word(R.motions.data + 4 * set);
        const heads = word(R.motions.heads + 4 * set);
        for (let i = 1; i < 0x400; i++) {
            const n = word(names + 4 * i);
            if (!n) break;
            const head = word(heads + 4 * i);
            const [hv, ho] = view(head);
            const frames = head && ho + 12 <= hv.byteLength ? hv.getUint16(ho + 10, true) : 0;
            const [nv, no] = view(n);
            const id = (set << 10) | i;
            list[id] = frames > 0
                ? { index: id, set, name: str(nv, no), address: word(datas + 4 * i), frames, joints: 15 }
                : null;
        }
    }
    return list;
}

/** The fighter's own motions (its weapon's set) first, then every other set's. */
export function lastbrnxMotionList(rom, body, motions) {
    const all = motions.filter(Boolean);
    return {
        fits: all,
        lead: all.filter((x) => x.set === body.motionSet),
        label: `${body.name.replace(' (2P)', '')}'s moves`,
        every: 'Every motion in the table',
    };
}

/** A motion played by the game's code: the fighter's draws, frame by frame. */
export function runLastbrnxMotion(rom, body, motion) {
    const M = lastbrnxFightMachine(rom, [
        { char: body.fighter, costume: body.costume, x: 0, angle: 0 },
        { char: body.fighter, costume: body.costume ^ 1, x: 3, angle: Math.PI },
    ]);
    M.start(0, motion.index);
    return Array.from({ length: motion.frames }, () => {
        M.step(0);
        return M.draw(0);
    });
}

/* Board matrix (3x3 by columns, then the place) to three.js, Z negated. */
function toThree(m) {
    return [m[0], m[1], -m[2], 0, m[3], m[4], -m[5], 0, -m[6], -m[7], m[8], 0, m[9], m[10], -m[11], 1];
}

const runs = new WeakMap();
function framesOf(rom, body, motion) {
    if (!runs.has(rom)) runs.set(rom, new Map());
    const cache = runs.get(rom);
    const key = `${body.index}:${motion.index}`;
    if (!cache.has(key)) {
        cache.clear();
        const frames = runLastbrnxMotion(rom, body, motion);
        /* A part with no model in the table (polygon RAM's) gives no points
         * to place a joint by. */
        frames.joints = jointsOf(rom, frames.map((f) => f.map((d) => (d.model != null ? d : undefined))));
        cache.set(key, frames);
    }
    return cache.get(key);
}

/** The draws of a frame of the motion, a place in the draw order a part. */
export function poseLastbrnxFighter(rom, body, motion, frame) {
    const at = Math.max(0, Math.min(frame, motion?.frames ?? 0) - 1);
    const run = motion ? framesOf(rom, body, motion) : null;
    const draws = run ? run[at] ?? [] : [];
    const matrices = body.parts.map((p) => toThree(draws[p.index]?.m ?? IDENTITY));
    const joints = run ? run.joints : { parents: [], joined: [] };
    return {
        matrices,
        origins: matrices.map((e) => [e[12], e[13], e[14]]),
        draws: body.parts.map((p) => (draws[p.index]?.model != null ? [draws[p.index].model] : [])),
        parents: body.parts.map((p) => joints.parents[p.index] ?? -1),
        joined: body.parts.map((p) => joints.joined[p.index] ?? false),
    };
}
