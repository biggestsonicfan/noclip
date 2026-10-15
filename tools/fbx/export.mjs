#!/usr/bin/env node
/*
 * export.mjs — a fighter out of the ROM set as an FBX file.
 *
 *   node tools/fbx/export.mjs fvipers.zip --fighter Grace --motion 73 --frame 1 \
 *       --out grace.fbx
 *
 * The fighter is the one the Animation tab shows: its sixteen parts placed by
 * the game's own pose (js/vf2fighters.js) on the motion and frame asked for,
 * textured and coloured from the ROM as the board colours them. In the file it
 * is one mesh skinned to a sixteen-bone skeleton, each part's points wholly on
 * its slot's bone, so it can be posed again in whatever opens it. The atlas is
 * embedded in the FBX and written beside it as a PNG.
 *
 * Only the solved rig (Virtua Fighter 2's, which Fighting Vipers uses) is read
 * here; see README.md beside this file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadRomSet } from '../../js/romset.js';
import { decodeModel } from '../../js/model.js';
import { readFighters, poseFighter } from '../../js/vf2fighters.js';
import { SLOT_NAMES, SLOT_PARENT } from '../../js/pose.js';
import { decodeMotion } from '../../js/motion.js';
import { buildTexram, programTextureSets } from '../../js/texture.js';
import { buildAtlas } from '../../js/atlas.js';
import { buildLumaram, buildColorxlat } from '../../js/colors.js';
import { readStageTable } from '../../js/stages.js';
import { facesOf, bakeFaces } from './bake.mjs';
import { skinnedMeshFbx, mul4 } from './fbx.mjs';
import { encodePng } from './png.mjs';

const USAGE = `usage: export.mjs <set.zip>... --fighter <name|index> [--motion <id>] [--frame <n>]
                 [--stage <index>] --out <file.fbx>`;

function parseArgs(argv) {
    const o = { zips: [], motion: null, frame: 1, stage: 0 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--fighter') o.fighter = argv[++i];
        else if (a === '--motion') o.motion = Number(argv[++i]);
        else if (a === '--frame') o.frame = Number(argv[++i]);
        else if (a === '--stage') o.stage = Number(argv[++i]);
        else if (a === '--out') o.out = argv[++i];
        else if (a.startsWith('--')) throw new Error(`unknown option ${a}\n${USAGE}`);
        else o.zips.push(a);
    }
    if (!o.zips.length || o.fighter == null || !o.out) throw new Error(USAGE);
    return o;
}

async function loadRom(zips) {
    const bufs = zips.map((z) => {
        const b = fs.readFileSync(z);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
    });
    const rom = await loadRomSet(bufs);
    if (rom.game.rig?.kind !== 'vf2') throw new Error(`${rom.game.name}: no solved fighter rig to export`);
    return rom;
}

function pickFighter(rom, which) {
    const all = readFighters(rom);
    const f = /^\d+$/.test(which) ? all[Number(which)]
        : all.find((x) => x.name.toLowerCase() === which.toLowerCase());
    if (!f) throw new Error(`no fighter ${which}; the roster is ${all.map((x) => x.name).join(', ')}`);
    return f;
}

/* The board's texture RAM and colour tables while this fighter is on screen:
 * the boot set and the fighter's pair, and its own rows of colorxlat over the
 * stage's. */
function sceneTables(rom, body, decoded, stage) {
    const sets = new Set();
    for (const [model, d] of decoded) {
        for (const s of programTextureSets(rom, model, d)?.sets ?? []) sets.add(s);
    }
    const { sheet0, sheet1 } = buildTexram(rom, [...sets]);
    return {
        atlas: buildAtlas(sheet0, sheet1),
        luma: buildLumaram(rom),
        cxlat: buildColorxlat(rom, { colorSet: stage.texSet[1], tint: [1, 1, 1], fighters: [body.index] }),
    };
}

/* The viewer's frame has the fighter looking down +x. The file has it facing
 * +z, FBX's front, with its lowest point on the floor. */
function placeInFile(matrices, decoded, body) {
    const turn = [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1];   /* +x to +z */
    let floor = Infinity;
    for (const p of body.parts) {
        const d = decoded.get(p.model);
        if (!d) continue;
        const m = mul4(turn, matrices[p.index]);
        for (let i = 0; i < d.positions.length; i += 3) {
            const [x, y, z] = [d.positions[i], d.positions[i + 1], d.positions[i + 2]];
            floor = Math.min(floor, m[1] * x + m[5] * y + m[9] * z + m[13]);
        }
    }
    /* The motion carries the body off along its step; the file stands it over
     * the origin, on the floor. */
    const root = mul4(turn, matrices[0]);
    const lift = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -root[12], Number.isFinite(floor) ? -floor : 0, -root[14], 1];
    return matrices.map((m) => mul4(lift, mul4(turn, m)));
}

const apply = (m, [x, y, z], w = 1) => [0, 1, 2].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r] * w);
const sub = (a, b) => a.map((v, k) => v - b[k]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };

/* A decal is the surface's own polygon drawn again, corner for corner, and on
 * the board the later one wins. A depth buffer cannot tell them apart, so each
 * repeat stands a hair further out along its face than the one under it. */
const DECAL_STEP = 0.0005;

/* The faces of every part in the file's frame, as triangles of points that
 * share an index where they are the same point of the same part and layer. */
function buildMesh(body, decoded, matrices, faces, baked) {
    const positions = [], polygons = [], normals = [], uvs = [];
    const bones = body.parts.map((p) => ({
        name: SLOT_NAMES[p.index] ?? `slot${p.index}`, parent: SLOT_PARENT[p.index],
        matrix: matrices[p.index], points: [],
    }));
    const pointIndex = new Map();
    const layers = new Map();
    const key = (v) => v.map((x) => Math.round(x * 1e5)).join(',');
    for (const f of faces) {
        const m = matrices[f.part];
        const corners = [0, 1, 2].map((c) => {
            const v = f.first + c;
            const d = f.decoded;
            return {
                p: apply(m, [d.positions[v * 3], d.positions[v * 3 + 1], d.positions[v * 3 + 2]]),
                n: unit(apply(m, [d.normals[v * 3], d.normals[v * 3 + 1], d.normals[v * 3 + 2]], 0)),
                uv: baked.uvOf(f, c),
            };
        });
        const tri = corners.map((c) => key(c.p)).sort().join('|');
        const layer = layers.get(tri) ?? 0;
        layers.set(tri, layer + 1);
        /* Wound so the face's own normal is its front. */
        const plane = cross(sub(corners[1].p, corners[0].p), sub(corners[2].p, corners[0].p));
        if (dot(plane, corners[0].n) < 0) corners.reverse();
        const lift = unit(plane).map((v) => v * DECAL_STEP * layer * Math.sign(dot(plane, corners[0].n) || 1));
        const poly = corners.map((c) => {
            const p = layer ? c.p.map((v, k) => v + lift[k]) : c.p;
            const k = `${f.part}:${layer}:${key(p)}`;
            if (!pointIndex.has(k)) {
                pointIndex.set(k, positions.length / 3);
                bones[f.part].points.push(positions.length / 3);
                positions.push(...p);
            }
            normals.push(...c.n);
            uvs.push(...c.uv);
            return pointIndex.get(k);
        });
        polygons.push(poly);
    }
    return { positions, polygons, normals, uvs, bones };
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const rom = await loadRom(opts.zips);
    const body = pickFighter(rom, opts.fighter);
    const stage = readStageTable(rom)[opts.stage];
    if (!stage) throw new Error(`no stage ${opts.stage}`);

    const motion = opts.motion == null ? null : decodeMotion(rom, opts.motion);
    if (opts.motion != null && !motion) throw new Error(`motion ${opts.motion} has no data`);
    /* Played up to the frame, so the head has turned as far as it would. */
    let pose;
    for (let f = 1; f <= Math.max(1, opts.frame); f++) pose = poseFighter(rom, body, motion, f);

    const decoded = new Map();
    for (const p of body.parts) {
        const d = p.model ? decodeModel(rom, p.model) : null;
        if (d?.positions.length) decoded.set(p.model, d);
    }
    const tables = sceneTables(rom, body, decoded, stage);
    const faces = body.parts.flatMap((p) => (decoded.has(p.model)
        ? facesOf(decoded.get(p.model), p.index, stage.materials) : []));
    const baked = bakeFaces(faces, tables);
    const matrices = placeInFile(pose.matrices, decoded, body);
    const mesh = buildMesh(body, decoded, matrices, faces, baked);

    const base = opts.out.replace(/\.fbx$/i, '');
    const pngName = `${path.basename(base)}.png`;
    const png = encodePng(baked.size, baked.size, baked.rgba);
    fs.writeFileSync(`${base}.png`, png);
    fs.writeFileSync(opts.out, skinnedMeshFbx({
        name: body.name.replace(/[^\w.-]+/g, '_'), unitScale: 100, ...mesh, texture: { file: pngName, png },
    }));
    console.log(`${body.name}: ${mesh.polygons.length} triangles, ${mesh.positions.length / 3} points, `
        + `${baked.blocks} texture blocks in a ${baked.size}x${baked.size} atlas -> ${opts.out}`);
}

main().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
