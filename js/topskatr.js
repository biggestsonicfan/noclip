/*
 * Top Skater (MAME `topskatr`, Model 2C). Not Wave Runner's engine: its own
 * model table, sheets and colours. See README's Top Skater section and
 * TECHNICAL.md.
 */
import { MAIN_DATA_BASE, meshOffsetOf, readModelEntry } from './romset.js';
import { SHEET_BYTES } from './atlas.js';
import { runRoutines, CXLAT_AT, CXLAT_BYTES } from './skisuprg.js';

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
