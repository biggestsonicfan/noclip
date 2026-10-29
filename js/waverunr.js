/*
 * Wave Runner (MAME `waverunr`) and Sega Water Ski (`segawski`), Model 2C.
 * Both run one program, Water Ski's moved about 0x1A960 on; the addresses in
 * these comments are Wave Runner's, and the profiles (`rom.game.waverunr`)
 * carry each game's own. See README and TECHNICAL.md.
 *
 * A scene is three things the game names together: a texture bank onto sheet
 * 1 (0x34BF0 with g1 = 1), a {count, colours} block onto the face palette from
 * entry 500 (0x36360) and a colour table (0x35060, or 0x97500 a row a frame).
 * The boot sets up the first course's three (0x34DC8, 0xB5CC, 0x344E8). A
 * course takes its three from the tables at 0x973E0 (palette), 0x973F0
 * (bank) and 0x35040 (colours), indexed by the course in work RAM 0x511F60
 * (0x97410, 0x97460, 0x97470); two more scenes name theirs in the code
 * (0x4AF60 with 0x4AFF4, 0x2CBE0 with 0x2CD2C). A texture set here is one
 * scene, and the palette and colour tables follow it.
 */
import { MAIN_DATA_BASE } from './romset.js';
import { uploadRawBank } from './texture.js';
import { SHEET_BYTES } from './atlas.js';
import { runRoutines, CXLAT_AT, CXLAT_BYTES } from './skisuprg.js';

/* A data address as the program names it: the program ROM below its end, the
 * data ROM at 0x2000000 or through the XTRA window at 0x6000000. */
function bytesAt(rom, a) {
    if (a < rom.maincpu.length) return [rom.maincpu, a];
    const o = a >= 0x6000000 ? a - 0x6000000 : a - MAIN_DATA_BASE;
    return [rom.mainData, o];
}

/** The scenes, as {name, bank, palette, colors, patches}. */
export function waverunrScenes(rom) {
    if (rom.waverunrScenes) return rom.waverunrScenes;
    const W = rom.game.waverunr;
    const cv = rom.mainCpuView;
    const out = [];
    const C = W.courses;
    for (let c = 0; c < C.count; c++) {
        out.push({
            name: C.names?.[c] ?? `course ${c + 1}`,
            bank: cv.getUint32(C.banks + c * 4, true),
            palette: cv.getUint32(C.palettes + c * 4, true),
            colors: C.colorTable ? cv.getUint32(C.colorTable + C.colorIndex[c] * 4, true) : C.colors[c],
            patches: C.patches,
        });
    }
    for (const s of W.scenes ?? []) out.push({ ...s });
    return (rom.waverunrScenes = out);
}

function scene(rom, set) {
    const scenes = waverunrScenes(rom);
    return scenes[set] ?? scenes[rom.game.texture.defaultSet];
}

/*
 * The sheets. The boot (0x34DC8) puts bank 0x2000000 on sheet 0 and a scene
 * puts its bank on sheet 1, both with 0x34BF0: House of the Dead's upload, the
 * bank's first half straight onto its sheet and the mip levels of the second
 * half dealt between the sheets by the rectangle copy 0x345C0
 * (uploadRawBank). After a scene's bank, 0x3F570 fills the 16 x 8 halfwords at
 * (0x1F0, 0x1F8) of both sheets' mip half with 0xBBBB, and a course pastes
 * eight blocks of 64 halfwords square onto sheet 1 (0x4AAC0, each 0x2000
 * bytes from 0x2848B60 on, through 0x3EC50: the same places as House of the
 * Dead's, the source packed 64 rows of 128 bytes).
 */
const PATCH_AT = [[0, 0], [64, 0], [0, 64], [64, 64], [0, 128], [64, 128], [0, 192], [64, 192]];

export function buildWaverunrTexram(rom, texSets) {
    const W = rom.game.waverunr;
    const md = rom.mainData;
    const tex = new Uint8Array(SHEET_BYTES * 2);
    uploadRawBank(md, W.bootBank - MAIN_DATA_BASE, tex, false);
    const sets = [].concat(texSets).filter((s) => s >= 0 && s < rom.game.texture.sets);
    let pages = 1;
    if (sets.length) {
        const sc = scene(rom, sets[sets.length - 1]);
        const bank = sc.bank - MAIN_DATA_BASE;
        if (bank >= 0 && bank + SHEET_BYTES <= md.length) {
            uploadRawBank(md, bank, tex, true);
            pages++;
        }
        for (const sheet of [0, SHEET_BYTES]) {
            for (let y = 0x1f8; y <= 0x1ff; y++) {
                for (let x = 0x1f0; x <= 0x1ff; x++) {
                    const at = sheet + 0x80000 + ((y << 9) + x) * 2;
                    tex[at] = W.fill & 0xff;
                    tex[at + 1] = W.fill >> 8;
                }
            }
        }
        if (sc.patches) {
            const [src, o] = bytesAt(rom, sc.patches);
            PATCH_AT.forEach(([x, y], i) => {
                for (let r = 0; r < 64; r++) {
                    const s = o + i * 0x2000 + r * 128;
                    if (s + 128 <= src.length) tex.set(src.subarray(s, s + 128), SHEET_BYTES + (((y + r) << 9) + x) * 2);
                }
            });
        }
    }
    return { sheet0: tex.subarray(0, SHEET_BYTES), sheet1: tex.subarray(SHEET_BYTES), pages };
}

/*
 * The face palette: 0x351C0 writes the block at 0x10080 down from entry 1023
 * (once, at the boot), then every scene writes the {count, colours} blocks at
 * 0x2858B60 from entry 0 and 0x84350 from 300 and its own from 500
 * (0x36360, which stops at entry 1023).
 */
export function waverunrPalette(rom, set) {
    const W = rom.game.waverunr;
    const out = new Int32Array(1024).fill(-1);
    {
        const [b, o] = bytesAt(rom, W.palette.top);
        const n = b[o] | (b[o + 1] << 8);
        for (let i = 0; i < n && i < 1024; i++) out[1023 - i] = b[o + 2 + i * 2] | (b[o + 3 + i * 2] << 8);
    }
    const block = (at, first) => {
        const [b, o] = bytesAt(rom, at);
        if (o < 0 || o + 2 > b.length) return;
        const n = b[o] | (b[o + 1] << 8);
        for (let i = 0; i < n && first + i < 1024; i++) out[first + i] = b[o + 2 + i * 2] | (b[o + 3 + i * 2] << 8);
    };
    for (const [at, first] of W.palette.blocks) block(at, first);
    block(scene(rom, set).palette, W.palette.first);
    return out;
}

/*
 * Colorxlat: the ramps by running the program's 0x34EC0 with js/i960.js
 * (floating point, square roots; every entry of every row), then the scene's
 * table as 0x35060 lays it: a row count byte, then per row 64 {r, g, b} bytes,
 * the rows going to 1, 3, 5... of the three channels (0x1810200 on, 0x400
 * apart). The grey switch at 0x513334 is left off, as in MAME's attract.
 */
export function buildWaverunrColorxlat(rom, colorSet) {
    const W = rom.game.waverunr;
    const table = scene(rom, colorSet).colors;
    rom.waverunrColors ??= new Map();
    const have = rom.waverunrColors.get(table);
    if (have) return have.slice();
    rom.waverunrRamps ??= runRoutines(rom, [[W.ramps, []]], rom.game.name).pal.slice(CXLAT_AT, CXLAT_AT + CXLAT_BYTES);
    const out = rom.waverunrRamps.slice();
    const [b, o] = bytesAt(rom, table);
    const rows = b[o];
    let p = o + 1;
    for (let r = 0; r < rows && r < 16; r++) {
        for (let i = 0; i < 64; i++, p += 3) {
            for (let ch = 0; ch < 3; ch++) {
                const at = ch * 0x4000 + (1 + 2 * r) * 0x200 + i * 2;
                out[at] = b[p + ch];
                out[at + 1] = 0;
            }
        }
    }
    rom.waverunrColors.set(table, out);
    return out.slice();
}
