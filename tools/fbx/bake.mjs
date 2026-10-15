/*
 * bake.mjs — a fighter's faces as plain RGBA, the way the board colours them.
 *
 * On the board a texel is not a colour. It is four bits, which the face's luma
 * band (lumaram) turns into a brightness, which the polygon's own luma scales,
 * which picks a column of the colour table (colorxlat) on the row the face's
 * palette colour names. js/viewer.js does that per pixel in its fragment
 * shader. An FBX has nowhere to put any of it, so this does the same arithmetic
 * once per texel and writes the answer into an ordinary texture atlas.
 *
 * The polygon luma is the one input that depends on the light. It is taken
 * with the face square on to it — luminance 1, so luma = diffuse + ambient of
 * the face's material slot — which is the colour the art shows at its
 * brightest, and leaves the shading to whatever renders the file. A material
 * with no diffuse term (slot 13's 0/112, slot 31's 0/255) is flat on the board
 * whatever the light does, and comes out the same here.
 */

import { ATLAS_W } from '../../js/atlas.js';

const KEY = 15;     /* a transparent face's hole */

/* colorxlat's three channel tables and MAME's output curve after them; see
 * cxlatColor in js/viewer.js. */
function cxlatColor(cxlat, [r5, g5, b5], li) {
    const ch = (base, row) => Math.max(cxlat[base + ((row << 8) + li) * 2] - 64, 0) * (255 / 191);
    return [ch(0, r5), ch(0x4000, g5), ch(0x8000, b5)].map((v) => Math.min(255, Math.round(v)));
}

/* A texel of a tile, wrapped or mirrored the way tileTexel in js/viewer.js
 * reads it, as 0..15. */
function tileTexel(atlas, face, x, y) {
    const [tx, ty, tw, th] = face.tile;
    const sx = x + tw * 64, sy = y + th * 64;
    let qx = sx % tw, qy = sy % th;
    if (face.flags & 8 && Math.floor(sx / tw) & 1) qx = tw - 1 - qx;
    if (face.flags & 16 && Math.floor(sy / th) & 1) qy = th - 1 - qy;
    return Math.round(atlas[((ty + qy) & 2047) * ATLAS_W + ((tx + qx) & 2047)] / 17);
}

/* The colour a face shows for texel t, as RGBA bytes. */
function texelColor(t, face, { luma, cxlat }) {
    const transparent = face.flags & 1;
    if (transparent && t === KEY) return [0, 0, 0, 0];
    const alpha = face.flags & 2 ? 128 : 255;   /* the checker: every other pixel */
    if (face.lumaBase < 0) {
        const v = Math.min(1, (t / 15) * 2);
        return [...face.rgb5.map((c) => Math.round(Math.min(1, (c / 31) * v) * 255)), alpha];
    }
    const lram = luma[2 * (face.lumaBase + t * 8)];
    const li = Math.min(Math.floor((lram * face.polyLuma) / 256), 63);
    return [...cxlatColor(cxlat, face.rgb5, li), alpha];
}

/* An untextured face's one colour; the viewer's flat branch, unlit. */
function solidColor(face) {
    return [...face.rgb5.map((c) => Math.round((c / 31) * 255)), 255];
}

/**
 * The faces of a set of decoded models, each with what its colour depends on.
 * @returns {object[]} one per triangle: {part, corners: [i,i,i] into the
 *   decoded soup, tile, flags, lumaBase, rgb5, polyLuma, texels: [[u,v] x3]}
 */
export function facesOf(decoded, part, materials) {
    const out = [];
    for (let v = 0; v < decoded.positions.length / 3; v += 3) {
        const mat = materials[decoded.mats[v]] ?? { diffuse: 0, ambient: 0 };
        out.push({
            part,
            decoded,
            first: v,
            tile: [0, 1, 2, 3].map((k) => decoded.tiles[v * 4 + k]),
            flags: decoded.flags[v],
            lumaBase: decoded.lumaBases[v],
            rgb5: [0, 1, 2].map((k) => Math.round(decoded.colors[v * 3 + k] * 31)),
            polyLuma: Math.min(255, Math.floor(mat.diffuse + mat.ambient)),
            texels: [0, 1, 2].map((c) => [decoded.uvs[(v + c) * 2], decoded.uvs[(v + c) * 2 + 1]]),
        });
    }
    return out;
}

/* Faces that read the same texels the same way share one block of the atlas. */
function blockKey(f) {
    if (f.tile[2] <= 0) return `solid:${f.rgb5}`;
    return `${f.tile}:${f.flags & 0x1b}:${f.lumaBase}:${f.rgb5}:${f.polyLuma}`;
}

/* Each block covers the texels its faces reach, which can run past the tile:
 * the board repeats or mirrors it there, so the block holds the copies. */
function blockOf(faces) {
    const f0 = faces[0];
    if (f0.tile[2] <= 0) return { faces, solid: true, x0: 0, y0: 0, w: 1, h: 1 };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const f of faces) for (const [u, v] of f.texels) {
        x0 = Math.min(x0, u); x1 = Math.max(x1, u);
        y0 = Math.min(y0, v); y1 = Math.max(y1, v);
    }
    x0 = Math.floor(x0); y0 = Math.floor(y0);
    return { faces, solid: false, x0, y0, w: Math.max(1, Math.ceil(x1) - x0), h: Math.max(1, Math.ceil(y1) - y0) };
}

const PAD = 2;      /* texels of border, so filtering stays inside a block */

/* Shelf packing, tallest first, into a square power of two wide enough. */
function pack(blocks) {
    const order = [...blocks].sort((a, b) => b.h - a.h);
    const area = blocks.reduce((s, b) => s + (b.w + 2 * PAD) * (b.h + 2 * PAD), 0);
    for (let size = 256; size <= 8192; size *= 2) {
        if (size * size < area) continue;
        let x = 0, y = 0, shelf = 0, fits = true;
        for (const b of order) {
            const w = b.w + 2 * PAD, h = b.h + 2 * PAD;
            if (w > size) { fits = false; break; }
            if (x + w > size) { x = 0; y += shelf; shelf = 0; }
            if (y + h > size) { fits = false; break; }
            b.ax = x + PAD; b.ay = y + PAD;
            x += w; shelf = Math.max(shelf, h);
        }
        if (fits) return size;
    }
    throw new Error('bake: the faces do not fit an 8192 atlas');
}

function paintBlock(img, size, b, tables) {
    const f = b.faces[0];
    for (let y = -PAD; y < b.h + PAD; y++) {
        for (let x = -PAD; x < b.w + PAD; x++) {
            /* The border repeats the block's own edge texels. */
            const cx = Math.max(0, Math.min(b.w - 1, x)), cy = Math.max(0, Math.min(b.h - 1, y));
            const rgba = b.solid ? solidColor(f)
                : texelColor(tileTexel(tables.atlas, f, b.x0 + cx, b.y0 + cy), f, tables);
            img.set(rgba, ((b.ay + y) * size + b.ax + x) * 4);
        }
    }
}

/**
 * Bake the faces into one atlas.
 *
 * @param {object[]} faces   facesOf's output, for every part
 * @param {{atlas, luma, cxlat}} tables  the texel atlas (js/atlas.js
 *   buildAtlas) and the two colour tables the board would have loaded
 * @returns {{size, rgba, uvOf(face, corner) -> [u, v]}} uv with v up, as FBX
 *   has it
 */
export function bakeFaces(faces, tables) {
    const groups = new Map();
    for (const f of faces) {
        const k = blockKey(f);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(f);
    }
    const blocks = [...groups.values()].map(blockOf);
    const size = pack(blocks);
    const rgba = new Uint8Array(size * size * 4);
    for (const b of blocks) {
        paintBlock(rgba, size, b, tables);
        for (const f of b.faces) f.block = b;
    }
    const uvOf = (f, c) => {
        const b = f.block;
        if (b.solid) return [(b.ax + 0.5) / size, 1 - (b.ay + 0.5) / size];
        const [u, v] = f.texels[c];
        return [(b.ax + u - b.x0) / size, 1 - (b.ay + v - b.y0) / size];
    };
    return { size, rgba, uvOf, blocks: blocks.length };
}
