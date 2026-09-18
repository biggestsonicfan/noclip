/*
 * stages.js — the STF stage table.
 *
 * change_scene() (rom_code1.s) indexes a 256-byte struct per stage from
 * `stage_data` in the program ROM and copies 64 words of it to 0x504800. Field
 * offsets below are taken from the labelled fields in the stfdecomp listing
 * (stage_bright, stage_vecter_x, stage_RED, stage_floor, stage_parts, ...).
 *
 * This module only reads the record. Turning it into a draw list — which parts
 * get scaled, rotated or offset — lives in display.js, because only the ground
 * chunks are drawn at the identity matrix; the cage, its posts, the ring ramp
 * and the platform each carry a transform from the function that draws them.
 */

export const STAGE_DATA_ADDR = 0x0008f3d0;
import { xtraResolve } from './romset.js';

export const STAGE_STRIDE = 256;
export const STAGE_COUNT = 16;

/* set_material (0x29154) uploads 32 material slots to the geometry engine, and
 * sub_29110 picks which table to upload with the stage slot. A slot is one
 * packed word: diffuse in bits 0-7, ambient in 8-15, then specular. The
 * geometry engine lights every polygon with the slot its attribute word names
 * — see model.js for that half, and viewer.js for the arithmetic. */
const MATERIAL_TABLE_PTRS = 0x000909e0;
export const MATERIAL_COUNT = 32;

/* Field offsets inside one 256-byte stage record. */
const F = {
    flags: 0x00,        /* the bit field every draw function branches on */
    bright: 0x04,
    vecterX: 0x08,
    vecterY: 0x0a,
    texA: 0x0c,          /* send_tex_stage g0 — see resolveTexSets */
    texB: 0x0e,          /* send_tex_stage g1 */
    red: 0x10,
    green: 0x11,
    blue: 0x12,
    num: 0x13,           /* stage_NUM — the identity the game keys music etc. off */
    music: 0x14,
    bgColor: 0x16,       /* BGR555 backdrop */
    floor: 0x18,
    platform: 0x1a,
    cagePole: 0x1c,
    extra: 0x1e,
    parts: 0x64,         /* 16 model ids */
    cage: 0x84,          /* 24 model ids, mostly zero padding */
    sky: 0xc0,           /* 4 model ids */
    soko: 0xc8,
    height: 0xcc,        /* cage_height = this * 1.6 */
    floorSize: 0xd0,     /* copied to floor_stage_size_0 (0x5048D0) */
    colorCycle: 0xb8,    /* sub_2435C's list of palette rows to rotate */
    setup: 0xb4,         /* the stage's object list — see readStageObjects */
};

/*
 * The stage's own objects.
 *
 * A stage animates more than its draw list: `change_scene` hands the pointer at
 * +0xB4 to `object_init`, which walks a table of objects and gives each one a
 * pair of routines — an `init` that runs on the frame the stage loads and is
 * free to replace itself with a per-frame continuation, and a `disp` that
 * `object_control` calls once a frame after the arena is drawn. That is where
 * Casino Night's blimp and slot machine live, where the Flying Carpet's flight
 * lives, and where Giant Wing's roll comes from.
 *
 * The table is a count followed by 24-byte entries; only two fields matter
 * here, since the viewer runs its own port of a routine rather than the code:
 *
 *   +0x00  type      always 1
 *   +0x04  size      object RAM to reserve — 0x80, or 0x100 on Mushroom Hill
 *   +0x08  init      may be 0, for an object that only draws
 *   +0x0C  disp      may be a bare `ret`, for an object that only moves
 *   +0x10  argument  a data pointer for the two routines that take one
 *
 * `object_cont` also advances a counter at +6 of every object's RAM once a
 * frame, whatever its routines do — which is why some of them read a clock they
 * never set, and why the two that step it themselves as well run at double
 * rate. display.js models each routine at the clock it actually sees.
 */
function readStageObjects(rom, base) {
    /* Both halves of this — the object list and the colour cycles below — are
     * program-ROM pointers followed into program ROM. A game whose records live
     * somewhere else has its own object list at the same field, but nothing
     * here knows how to walk it, so it is left empty rather than read against
     * the wrong ROM. */
    if (rom.game.stageTable.source !== 'maincpu') return [];
    const dv = rom.mainCpuView;
    const ptr = dv.getUint32(base + F.setup, true);
    if (ptr + 4 > rom.maincpu.length) return [];
    const count = dv.getUint32(ptr, true);
    const objects = [];
    for (let i = 0; i < count && i < 8; i++) {
        const b = ptr + 4 + i * 24;
        if (b + 24 > rom.maincpu.length) break;
        objects.push({
            init: dv.getUint32(b + 8, true),
            disp: dv.getUint32(b + 12, true),
            arg: dv.getUint32(b + 16, true),
        });
    }
    return objects;
}

/* sub_2435C, called once a frame out of the interrupt, walks the list at
 * +0xB8: pairs of (colorxlat row, frame-counter shift), terminated by a zero
 * row. For each pair it rewrites that row's sixteen palette slots from the
 * stage colour block rotated by (frame_counter >> shift) & 15 — which is the
 * scrolling water and the waterfall. See colors.js for the rewrite itself. */
function readColorCycles(rom, base) {
    if (rom.game.stageTable.source !== 'maincpu') return [];
    const dv = rom.mainCpuView;
    const ptr = dv.getUint32(base + F.colorCycle, true);
    const cycles = [];
    if (ptr + 4 > rom.maincpu.length) return cycles;
    for (let a = ptr; a + 4 <= rom.maincpu.length && cycles.length < 16; a += 4) {
        const row = dv.getUint16(a, true);
        if (row === 0) break;
        cycles.push({ row, shift: dv.getUint16(a + 2, true) });
    }
    return cycles;
}

/* Names taken from the decompilation's own branch comments, which key off the
 * stage SLOT (the `stage_num` byte the draw functions compare against), not off
 * stage_NUM. Slots the listing does not name are shown as their slot number —
 * add a line here once one is positively identified. */
const SFIGHT_STAGE_NAMES = {
    0: 'South Island',
    1: 'Flying Carpet',
    2: 'Aurora Icefield',
    /* Five more come from the object list at +0xB4 rather than from a branch:
     * the routines it names are labelled in the listing, and a record pointing
     * at mushroom_stage_setup is Mushroom Hill's whatever else it says. */
    3: 'Mushroom Hill',
    4: 'Canyon Cruise',
    5: 'Casino Night',
    6: 'Dynamite Plant',
    7: 'Giant Wing',
    9: "Death Egg's Eye",
    10: 'Final Eggman Boss',
    13: 'South Island (alt)',
    14: 'South Island (ADV_MOVIE)',
    15: 'ADV_MOV2',
};

/*
 * The light the geometry engine dots every polygon normal against.
 *
 * camera_init builds it out of the stage record: it hands the coprocessor the
 * vector (0, 0, stage_bright) after a Y rotation by stage_vecter_y and an X
 * rotation by stage_vecter_x, and keeps the result. Two things fall out of that
 * which make it usable here:
 *
 * - The camera rotation is pushed first, so what comes back is in camera space
 *   — but the engine also transforms every normal by the same camera matrix, so
 *   the camera cancels out of the dot product. The light is world-fixed, which
 *   is what lets a free camera fly around without the lighting swinging.
 * - The fighters' own Z rotation is applied last, and a Z rotation does not move
 *   a vector that lies along Z. It has no effect on the light at all.
 *
 * So the whole thing reduces to the stage record. Z is negated to match the
 * decoder's vertex and normal convention, which leaves N·L exactly as the board
 * computes it.
 */
export function stageLight(bright, vecterX, vecterY) {
    const ax = (vecterX * 2 * Math.PI) / 65536;
    const ay = (vecterY * 2 * Math.PI) / 65536;
    /* Rx applied to (0, 0, bright), then Ry. */
    const y = -Math.sin(ax) * bright;
    const z = Math.cos(ax) * bright;
    return [Math.sin(ay) * z, y, -Math.cos(ay) * z];
}

/*
 * The light and material slots of a game that keeps one set for the whole game
 * rather than one per stage record: the fixed light a profile's `lighting` names,
 * and the material table the boot sequence uploads. Slots past the uploaded
 * count stay at zero, which is what the geometry engine holds for a slot nothing
 * has written. Null for a game without such a block.
 *
 * @returns {null|{light: number[], materials: {diffuse:number, ambient:number}[]}}
 */
export function gameLighting(rom) {
    const L = rom.game.lighting;
    if (!L) return null;
    /* The table is in the program ROM for every game here but Daytona USA after
     * 1993, which moved it into the data ROM along with its luma bands. */
    const src = L.materials.source ?? 'maincpu';
    const cv = src === 'maincpu' ? rom.mainCpuView : rom.mainDataView;
    const len = src === 'maincpu' ? rom.maincpu.length : rom.mainData.length;
    const materials = [];
    /* One 8-byte record a slot where the parameter word and the distance
     * coefficient are interleaved, 4 where the upload reads them out of two
     * arrays side by side — which is what Daytona USA's does. */
    const stride = L.materials.stride ?? 8;
    for (let i = 0; i < MATERIAL_COUNT; i++) {
        const at = L.materials.at + i * stride;
        if (i >= L.materials.count || at + 4 > len) {
            materials.push({ diffuse: 0, ambient: 0 });
            continue;
        }
        const w = cv.getUint32(at, true);
        materials.push({ diffuse: w & 0xff, ambient: (w >> 8) & 0xff });
    }
    /* A game whose light is a vector in its own ROM rather than the two angles
     * a stage record carries gives it outright. */
    const light = L.light ?? stageLight(1, L.vecter[0], L.vecter[1]);
    return { light, materials };
}

/*
 * The texture sets a stage actually uploads.
 *
 * The record's g0/g1 pair is not two set numbers to load. Two captures of real
 * texture RAM settle what is:
 *
 *   South Island, record (2, 0) -> sets 1 and 2
 *   Flying Carpet, record (4, 0x4/2) -> sets 1 and 4
 *
 * — that is, set 1 and g0. Set 1 is on screen whichever stage is loaded, which
 * is what you would expect of the fighters' own sheets; g0 is the stage's. g1 is
 * g0 - 2 on every stage in the table, so it carries nothing of its own, and
 * reading the pair literally uploads it in place of set 1: 911818 of South
 * Island's 2097152 bytes differ that way, and 1783033 of the Flying Carpet's.
 *
 * A set with no pages behind it is skipped by buildTexram, so the degenerate
 * g0 = 0 on the unused slot 11 costs nothing.
 *
 * The South Island MAME capture also holds set 16, left resident by the
 * attract and character-select screens it was taken after; the Flying Carpet one
 * was taken in attract and holds no such residue. That is capture history, not
 * something a stage asks for, which is why it is not modelled here.
 */
const SHARED_TEX_SET = 1;

function resolveTexSets(rom, texA, texB) {
    /* The pair is only a puzzle in the game the note above is about, where g1
     * carries nothing of its own. Fighting Vipers hands change_scene's two
     * numbers straight to send_tex_stage and they are two different sets — 20
     * and 1 on its first stage — so there both are uploaded as they stand. */
    if (rom.game.stageTable.texPair === 'literal') {
        return [...new Set([texB, texA])].filter((n) => n > 0);
    }
    return texA === SHARED_TEX_SET ? [texA] : [SHARED_TEX_SET, texA];
}

/*
 * A stage record, wherever the game keeps it.
 *
 * One game holds the table in the program ROM at a fixed address; the other
 * holds it in a second data bank reached through the XTRA_DATA window, where a
 * pointer has to be resolved before it can be read. Both are one base plus a
 * stride, so a reader that takes a view and an offset covers the two.
 */
function recordAt(rom, addr) {
    if (rom.game.stageTable.source === 'xtra') {
        const r = xtraResolve(rom, addr);
        return { view: r.view, u8: r.data, base: r.off };
    }
    return { view: rom.mainCpuView, u8: rom.maincpu, base: addr };
}

/** Read every stage record the game has. */
export function readStageTable(rom) {
    const T = rom.game.stageTable;
    const stages = [];

    for (let s = 0; s < T.count; s++) {
        const rec = recordAt(rom, T.at + s * T.stride);
        const dv = rec.view, u8 = rec.u8, b = rec.base;
        if (b + T.stride > u8.length) break;

        /* The lists a record carries, and how long each is, are per-game — one
         * has a sky shell the other does not, and one has a second ground list
         * the other has no equivalent for. */
        const list = (key) => {
            const spec = T.lists[key];
            if (!spec) return [];
            const out = [];
            for (let i = 0; i < spec[1]; i++) out.push(dv.getUint16(b + spec[0] + i * 2, true));
            return out;
        };
        const parts = list('ground');
        const cage = list('cage');
        const sky = list('sky');
        const upper = list('upper');

        const num = u8[b + F.num];
        /* The names are one game's, keyed off its own slot numbers, so they
         * are only applied to it. Another game's stages are shown by the
         * stage_NUM in their record until someone identifies them. */
        const named = T.source === 'maincpu' ? SFIGHT_STAGE_NAMES[s] : undefined;

        const bright = dv.getFloat32(b + F.bright, true);
        /* Kept raw as well as built, because one stage rewrites VECTER_Y every
         * frame and the light has to be rebuilt from the record around it. */
        const vecter = [dv.getInt16(b + F.vecterX, true), dv.getInt16(b + F.vecterY, true)];
        const materials = readMaterials(rom, s);

        stages.push({
            slot: s,
            num,
            name: named ?? `Stage ${num}`,
            named: named !== undefined,
            flags: dv.getUint32(b + F.flags, true),
            height: dv.getFloat32(b + F.height, true),
            floorSize: dv.getFloat32(b + F.floorSize, true),
            cagePanels: cage.slice(0, 8),
            /* doom_cnt indexes this with (i & 3), so duplicates matter — it is
             * kept in order rather than de-duplicated like the layer lists. */
            sky: sky.filter((m) => m !== 0),
            cagePole: dv.getUint16(b + F.cagePole, true),
            /* cage_clip_m draws this one six units up when flags bit 20 is set;
             * nothing else reads 0x20. */
            cageTop: dv.getUint16(b + 0x20, true),
            rail: T.rail ?? null,
            bright,
            materials,
            vecter,
            light: stageLight(bright, vecter[0], vecter[1]),
            tint: [u8[b + F.red] / 128, u8[b + F.green] / 128, u8[b + F.blue] / 128],
            /* Raw BGR555; the viewer runs it through colorxlat like the game does. */
            bgColor555: dv.getUint16(b + F.bgColor, true),
            /* The record's own pair, kept for the panel; texSets is what to
             * upload. See resolveTexSets. */
            texSet: [dv.getUint16(b + F.texA, true), dv.getUint16(b + F.texB, true)],
            texSets: resolveTexSets(rom, dv.getUint16(b + F.texA, true),
                dv.getUint16(b + F.texB, true)),
            colorCycles: readColorCycles(rom, b),
            /* The routines object_control runs for this stage; display.js
             * dispatches on the disp address. */
            objects: readStageObjects(rom, b),
            /* Grouped so the viewer can toggle each layer independently. */
            layers: {
                upper: upper.filter((m) => m !== 0),
                ground: parts.filter((m) => m !== 0),
                floor: [dv.getUint16(b + F.floor, true)].filter((m) => m !== 0),
                platform: [dv.getUint16(b + F.platform, true)].filter((m) => m !== 0),
                cage: cage.slice(0, 8).filter((m) => m !== 0),
                extra: [dv.getUint16(b + F.extra, true)].filter((m) => m !== 0),
                sky: [...new Set(sky)].filter((m) => m !== 0),
            },
        });
    }

    return stages;
}

export const LAYER_ORDER = ['sky', 'upper', 'ground', 'floor', 'platform', 'extra', 'cage', 'poles'];

/*
 * The 32 material slots a stage uploads.
 *
 * One game keeps the pointer array in the program ROM beside the stage table,
 * the other in the second data bank, but a slot is packed the same either way:
 * diffuse in bits 0-7, ambient in 8-15, then specular and mirror. The debug
 * material editor in the second game names every field of one as it builds it,
 * which is where that reading is confirmed.
 */
function readMaterials(rom, slot) {
    const M = rom.game.stageTable.materials;
    const out = [];
    let table = null;
    if (M.source === 'xtra') {
        const p = xtraResolve(rom, M.ptrs);
        const ptr = p.view.getUint32(p.off + slot * 4, true);
        if (ptr >= 0x06000000 && ptr < 0x07000000) table = xtraResolve(rom, ptr);
    } else {
        const at = rom.mainCpuView.getUint32(M.ptrs + slot * 4, true);
        if (at + MATERIAL_COUNT * 4 <= rom.maincpu.length) {
            table = { view: rom.mainCpuView, off: at };
        }
    }
    for (let i = 0; i < MATERIAL_COUNT; i++) {
        if (!table) { out.push({ diffuse: 255, ambient: 0 }); continue; }
        const w = table.view.getUint32(table.off + i * 4, true);
        out.push({ diffuse: w & 0xff, ambient: (w >> 8) & 0xff });
    }
    return out;
}
