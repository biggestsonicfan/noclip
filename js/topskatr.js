/*
 * Top Skater (MAME `topskatr`, Model 2C). Not Wave Runner's engine: its own
 * model table, sheets and colours. See README's Top Skater section and
 * TECHNICAL.md.
 */
import { MAIN_DATA_BASE, meshOffsetOf, readModelEntry } from './romset.js';
import { SHEET_BYTES } from './atlas.js';
import { runRoutines, CXLAT_AT, CXLAT_BYTES } from './skisuprg.js';
import { boardToOps } from './doa.js';

/*
 * The meshes are packed tighter than the other games'. The program hands
 * the geometry engine {tpa, tha, object, 0} straight from the table (0x3330
 * to 0x334C: `ld` the entry's first three words, r11 = 0, `stq` to
 * 0x804000), so the count is the engine's to find: the stream stops at the
 * first attribute word whose link type (bits 0-1) is 0. The stream is the two
 * points of the first edge, then per polygon its attribute word and the
 * points it adds: two for a quad (link bit 0 set), one for a triangle, with
 * no normal and no padding point. That is MAME geo_parse_nn_ns's stream with
 * the gaps closed up (the engine lights by the polygon's plane; the normal
 * slots are not there to skip). Here it is laid back out as the 40-byte
 * records decodeModel walks: a record's two points, then the attribute word
 * of the polygon after it and a zero normal; a triangle's second point is
 * left as zeros, which decodeModel fills with its first.
 */
const MAX_LINKS = 8192;

export function topskatrMesh(rom, index) {
    rom.topskatrMeshes ??= new Map();
    const have = rom.topskatrMeshes.get(index);
    if (have !== undefined) return have;
    const entry = readModelEntry(rom, index);
    let at = meshOffsetOf(rom, entry);
    const p = rom.polygons;
    const pv = rom.polygonsView;
    if (entry.meshPtr === 0 || at < 0 || at + 28 > p.length) {
        rom.topskatrMeshes.set(index, null);
        return null;
    }
    const recs = [];
    let pts = p.subarray(at, at + 24);
    at += 24;
    for (let n = 0; n < MAX_LINKS && at + 4 <= p.length; n++) {
        const attr = pv.getUint32(at, true);
        recs.push([pts, attr]);
        at += 4;
        if ((attr & 3) === 0) break;
        const k = attr & 1 ? 24 : 12;
        if (at + k > p.length) break;
        pts = p.subarray(at, at + k);
        at += k;
    }
    const bytes = new Uint8Array(recs.length * 40);
    const dv = new DataView(bytes.buffer);
    recs.forEach(([q, attr], i) => {
        bytes.set(q, i * 40);
        dv.setUint32(i * 40 + 24, attr, true);
    });
    const mesh = { bytes, uvPtr: entry.uvPtr, matPtr: entry.matPtr, planeNormals: true };
    rom.topskatrMeshes.set(index, mesh);
    return mesh;
}

/*
 * The sheets: 0x3F9E0(bank, sheet) copies the megabyte at data 0x2000000 +
 * bank * 0x100000 onto sheet 0 (0x11000000) or 1 (0x11200000) as it stands,
 * 0x80000 halfwords eight at a time, a slice a frame (the run table at
 * 0x3F9C0/0x3F9C4 is one block of 0x80000). The boot puts bank 0 on sheet 0
 * (0x3F808). A scene puts bank 1 or 2 on sheet 1 (0x60C70 from the table at
 * 0x5EE10; a course record at 0x2A66C + 36 * n names its bank at +0, 2, 1
 * and 2). A texture set here is one of those two scenes (`sets`), with the
 * colours that go with it.
 */
function scene(rom, set) {
    const T = rom.game.topskatr;
    return T.sets[set] ?? T.sets[rom.game.texture.defaultSet];
}

export function buildTopskatrTexram(rom, texSets) {
    const T = rom.game.topskatr;
    const md = rom.mainData;
    const tex = new Uint8Array(SHEET_BYTES * 2);
    const put = (bank, sheet) => {
        const at = T.banks + bank * SHEET_BYTES - MAIN_DATA_BASE;
        if (at >= 0 && at + SHEET_BYTES <= md.length) tex.set(md.subarray(at, at + SHEET_BYTES), sheet * SHEET_BYTES);
    };
    put(T.bootBank, 0);
    const sets = [].concat(texSets).filter((s) => s >= 0 && s < rom.game.texture.sets);
    let pages = 1;
    if (sets.length) {
        put(scene(rom, sets[sets.length - 1]).bank, 1);
        pages++;
    }
    return { sheet0: tex.subarray(0, SHEET_BYTES), sheet1: tex.subarray(SHEET_BYTES), pages };
}

/*
 * Colorxlat, by running the program's routines with js/i960.js in the order
 * the game does: the boot's 0x20DA0 (sqrt ramps on the even rows and row 31,
 * a flat level per row in entries 64..255, then row 0 by 0x9B318/0x9BD70),
 * 0x213D0(7, -1) after it (0x3A2F0, rewriting the even rows), and a scene's
 * 0x9C1B0(scene), which interpolates eleven key-point lists (pointers at
 * 0x9B030 + scene * 60, by 0x9BE70) into work RAM 0x5D7190 and marks the
 * rows; the vblank's 0x9D3B0 then copies them to the odd rows 1..21 after a
 * three-frame wait (work RAM 0x5D52D8), so it is run four times here. The
 * scene comes with its bank (0x60C40: 0x5EE18 and 0x5EE10, scene 0 with bank
 * 1, scene 1 with bank 2). Rows 25, 27 and 29 move in the attract (0x9C220,
 * one row at a time) and are left as the scene sets them.
 */
export function buildTopskatrColorxlat(rom, colorSet) {
    const T = rom.game.topskatr;
    const n = scene(rom, colorSet).colors;
    rom.topskatrColors ??= new Map();
    const have = rom.topskatrColors.get(n);
    if (have) return have.slice();
    const copy = [T.copy, []];
    const { pal } = runRoutines(rom, [...T.ramps, [T.scene, [n]], copy, copy, copy, copy], 'Top Skater');
    const out = pal.slice(CXLAT_AT, CXLAT_AT + CXLAT_BYTES);
    rom.topskatrColors.set(n, out);
    return out.slice();
}

/* ---- the courses ------------------------------------------------------------ */

/*
 * The three courses, as stages: each is the run of section models its record
 * names, the props its object list spawns, and the sky dome round the camera.
 *
 * A start point (0x2A5A0 + 20 * n: x, y, z, heading, course) names its
 * course, and 0x39F60 keeps it at 0x5830A4 and takes the record at
 * 0x2A660 + 36 * course: +4 the last section (0x582730), +0xC the bank put on
 * sheet 1 (0x3D1C0 hands it to 0x3F9E0), +0x20 the run of model entries the
 * sections are (0x582734). The draw at 0x3C040 takes section k as entry
 * run + 16 * k under the camera's matrix alone, so the sections stand where
 * their own points put them; past the last one it goes on with a translation
 * of 4000 a lap down (copro 0x2A), which is the same course again. The
 * geometrizer list in MAME agrees: the sections and the props are sent under
 * the matrix the frame's camera sends first, unchanged.
 *
 * Course 0 is the long one (195 sections), 1 the short one (176), 2 the
 * hidden arena, one model. 0x16E90 adds a run to the bookkeeping by
 * 0x5830A4: course 0 to 0x1D00384, which the menu at 0x15290 shows as HARD
 * COURSE, course 1 to 0x1D002E8 (EASY COURSE, 0x14FE0), course 2 to
 * 0x1D00420 (HIDE COURSE, 0x15410). The start points' debug names at 0x2A760
 * say the same split: course_10_1..5 for course 0's five, M7course_1..3 for
 * course 1's three, course_??? for the arena.
 */
const COURSE_NAMES = ['Hard course', 'Easy course', 'Hidden course'];

/*
 * The props: 0x198F0(course) takes three lists from 0x198D0 + 12 * course
 * (none for the arena, which goes to 0x39098). The third is the props,
 * {handler, model entry, limit}, one task each (0x1B170). Every handler sends
 * the camera's matrix (copro 14, 0x1B2F0 and on) and the entry's object, and
 * kills the task once the section 0x5830AC passes the limit's low half (0x3E7
 * is never). What differs is which frame it shows:
 *   0x1B450, 0x1B590, 0x1BF80 the entry itself (0x1BF80 every other frame);
 *   0x1BC90 the entry and the one after it by turns, 30 frames each;
 *   0x1B2F0 a 120-frame flipbook from entry + 16 * phase, phase the limit's
 *     high half;
 *   0x1B1A0 a 60-frame flipbook on the frame counter 0x5830A8;
 *   0x1B6D0 the frame 0x57BFA4 says;
 *   0x1BB50 six entries, of which it draws the one 0x57BF80 names now;
 *   0x1BDE0 the same by turns, under a translation of 4000 down (copro 10,
 *     then 0x2A with 0, -4000, 0): the start of the next lap.
 * A stage shows each one's first frame; a flipbook's phase picks its frame.
 * MAME's list agrees on both courses (the attract runs course 0; course 1 with
 * start point 6 copied over the attract's): every section and prop is sent
 * under the camera's matrix, the sky under its turn alone.
 * Entry 401 on course 0 (0x90CA0) is not here: its points sit round its own
 * origin, and MAME draws that model from 0x1C348 under a matrix of its own,
 * not from this list's handler.
 */
const PROP_TRANSLATED = 0x1bde0;
const PROP_FLIPBOOK = 0x1b2f0;
const PROP_SKIPPED = new Set([0x90ca0]);

/*
 * The light: 0x3B68C loads (0.398, -0.882, 0.252) from 0x34890 when a course
 * starts, and 0x35880 turns it by the camera each frame for the geometrizer
 * (the 0x0A command). Taken back through the camera's matrix, MAME's list
 * gives the same vector on every course frame. The material slots are the
 * boot's 32 {word, float} at 0x3F6D0 (0x20F30, copied to 0x57C1D0 and sent
 * as the 0x06 command): diffuse in the low byte, ambient above it.
 */
const LIGHT_AT = 0x34890;
const MATERIALS_AT = 0x3f6d0;

function courseMaterials(rom) {
    const v = rom.mainCpuView;
    return Array.from({ length: 32 }, (_, i) => {
        const w = v.getUint32(MATERIALS_AT + i * 8, true);
        return { diffuse: w & 0xff, ambient: (w >> 8) & 0xff };
    });
}

export function readTopskatrStages(rom) {
    const S = rom.game.stageTable.topskatr;
    const T = rom.game.topskatr;
    const v = rom.mainCpuView;
    const table = rom.game.modelTable.offset;
    const entry = (address) => (address - table) / 16;
    /* Z negated, as the explorer reads the board's points (boardToOps). */
    const light = [0, 1, 2].map((k) => v.getFloat32(LIGHT_AT + k * 4, true) * (k === 2 ? -1 : 1));
    const materials = courseMaterials(rom);
    const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
    const stages = [];
    for (let c = 0; c < S.count; c++) {
        const rec = S.records + c * 36;
        const last = v.getUint32(rec + 4, true);
        const bank = v.getUint32(rec + 0xc, true);
        const run = v.getUint32(rec + 0x20, true);
        const set = T.sets.findIndex((s) => s.bank === bank);
        const draws = [];
        const put = (model, m, layer) => draws.push({
            model, pos: [m[9], m[10], m[11]], set, layer, ops: boardToOps(m),
        });
        /* The sky dome (0x3A034: entry 0x932E0 on course 1, 0x945F0 on the
         * others) goes round the camera unmoved (0x35D1C sends the camera's
         * turn with no translation). */
        draws.push({ model: entry(c === 1 ? S.skies[1] : S.skies[0]), pos: [0, 0, 0], set, layer: 'sky', layered: false, ops: [['ce']] });
        for (let k = 0; k <= last; k++) put(entry(run) + k, identity, 'scenery');
        let props = 0;
        const lists = S.objects + c * 12;
        const list = c < 2 ? v.getUint32(lists + 8, true) : 0;
        const seen = new Set();
        for (let at = list; list && at + 12 <= rom.maincpu.length; at += 12) {
            const handler = v.getUint32(at, true);
            if (!handler) break;
            let model = v.getUint32(at + 4, true);
            const limit = v.getUint32(at + 8, true);
            if (PROP_SKIPPED.has(model)) continue;
            if (handler === PROP_FLIPBOOK) model += 16 * (limit >>> 16);
            const key = `${model}:${handler === PROP_TRANSLATED}`;
            if (seen.has(key)) continue;
            seen.add(key);
            put(entry(model), handler === PROP_TRANSLATED ? [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, -4000, 0] : identity, 'objects');
            props++;
        }
        stages.push({
            slot: stages.length,
            placements: true,
            mixedSets: false,
            num: c,
            name: COURSE_NAMES[c] ?? `Course ${c}`,
            chapter: c,
            draws,
            objects: [],
            sky: null,
            zones: [],
            views: [['all', 'Everything']],
            view: 'all',
            union: 'all',
            /* The bank the record names is the set; its colours come with it
             * (0x60C40). */
            texSets: [set],
            texSet: [set, set],
            fighters: [],
            tint: [1, 1, 1],
            bright: 1,
            light,
            headlight: false,
            materials,
            colorCycles: [],
            floorSize: 0,
            meta: [['course', c], ['bank', bank], ['sections', last + 1], ['props', props]],
        });
    }
    return stages;
}
