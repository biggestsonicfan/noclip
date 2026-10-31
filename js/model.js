/*
 * model.js — Model 2 index-array polygon decoder.
 *
 * A direct port of geo3d_decode_model() from m2-hle2 (src/board/geo3d.h), which
 * was validated at J=1.0 against 4405 reference meshes for Sonic The Fighters
 * and 2377 for Daytona USA. The algorithm is the board's polygon format, not a
 * per-game quirk, so the reverse-engineered rules are preserved verbatim here.
 *
 * Mesh layout: a run of 40-byte records, one per polygon link. It is the same
 * record the geometry engine reads (model2_v.cpp geo_parse_np_ns: attribute,
 * normal, then the points), rotated so the points come first:
 *   +0x00  float x, y, z   first vertex   (z is negated on read)
 *   +0x0C  float x, y, z   second vertex
 *   +0x18  u32   attr      low 18 bits go to the rasterizer; +0x18 is `f1`
 *                          (2 => triangle) and +0x19 carries iFlag in its low
 *                          two bits (strip connectivity)
 *   +0x1C  float x, y, z   the polygon's normal, unit length
 * A record whose attribute word is zero terminates the mesh.
 *
 * The normal is the one the board lights the polygon with — it is the artist's,
 * not the triangle's plane, and the two are not the same on anything curved.
 */

import { readModelEntry, meshOffsetOf, facePalette } from './romset.js';
import { topskatrMesh } from './topskatr.js';

const VERTEX_PAIR_SIZE = 40;
const MAX_VERTEX_PAIRS = 4096;

/** Model 2 BGR555 -> float RGB (bits 0-4 R, 5-9 G, 10-14 B). */
function bgr555(cw, out) {
    out[0] = (cw & 0x1f) / 31;
    out[1] = ((cw >> 5) & 0x1f) / 31;
    out[2] = ((cw >> 10) & 0x1f) / 31;
}

/*
 * The board's two RAMs a game fills with model data of its own.
 *
 * A texture pointer with bit 23 set is a word of texture RAM rather than of
 * the texture ROM (MAME model2_v.cpp, `& 0x800000`), and an object address
 * without it a word of polygon RAM. Both are copied straight out of the data
 * ROM, so `textureRam` lists the runs as {from, at}: the texture RAM word a run
 * starts at, and the data ROM byte it is copied from, a halfword a word; a
 * later run is copied over an earlier one. `polygonRam` is the data ROM byte
 * polygon RAM's word 0 is copied from, a word a word.
 *
 *   Virtua Cop: the second model table's materials (0x4D2 on), 0x800 words at
 *   texture RAM 0x4000 from data 0x81D3DE, at game start.
 *   Daytona USA: the cars' glass (Rev A models 2139-2141, three levels of
 *   detail) and the link cabinets' 1P to 8P markers (2142-2165, each with its
 *   arrow three ways), their meshes, materials and texture points. The boot
 *   sends texture RAM 0 on from data 0x8F0000 (0x1664 in Rev A), 0x5000 on
 *   from 0x8F5000 (0x16D0) and polygon RAM from 0x8E0000 (0x1730). The game later uploads the glass's points again every
 *   frame, slid by the camera, which is its reflection moving; read here they
 *   are the boot's.
 *
 *   Fighting Vipers: five blocks of one material header each, filled at
 *   boot (`textureRamFill`, textureRamImage).
 *   Last Bronx: 0x7E words from 0 on, in ten runs out of the program ROM
 *   (`source: 'maincpu'`), sent by the boot (0x9DAC0): the points and
 *   header of a skin at Red Eye's right knee.
 *
 * A pointer into texture RAM that no run covers has no points to read.
 */
function textureAt(rom, ptr) {
    const runs = rom.game.modelTable?.textureRam;
    if ((ptr & 0x800000) !== 0 && rom.game.modelTable?.textureRamFill) {
        return { src: textureRamImage(rom), base: (ptr & 0xffff) * 2 };
    }
    if (runs && (ptr & 0x800000) !== 0) {
        const w = ptr & 0xffff;
        const run = runs.findLast((r) => w >= r.from);
        if (run) return { src: run.source === 'maincpu' ? rom.maincpu : rom.mainData, base: run.at + (w - run.from) * 2 };
        return { src: rom.mainData, base: -1 };
    }
    return { src: rom.textures, base: ptr * 2 };
}

/* Texture RAM as a game's boot fills it block by block, each block one
 * four-halfword header repeated, the headers read from the program ROM. */
function textureRamImage(rom) {
    if (rom.textureRamImage) return rom.textureRamImage;
    const { headers, blocks, words } = rom.game.modelTable.textureRamFill;
    const ram = new Uint8Array(0x10000 * 2);
    const dv = new DataView(ram.buffer);
    for (let b = 0; b < blocks; b++) {
        const h = [0, 1, 2, 3].map((k) => rom.mainCpuView.getUint16(headers + b * 8 + k * 2, true));
        for (let w = 0; w < words; w++) dv.setUint16((b * words + w) * 2, h[w & 3], true);
    }
    return (rom.textureRamImage = ram);
}

/* A model's mesh in polygon RAM, as a data ROM offset; false where it is not. */
function polygonRamOffset(rom, meshPtr) {
    const at = rom.game.modelTable?.polygonRam;
    if (at === undefined || meshPtr === 0 || (meshPtr & 0x800000) !== 0) return false;
    return at + meshPtr * 4;
}

/**
 * Decode one model out of the polygon ROM into triangle-soup buffers plus the
 * quad-edge list the original wireframe path emits.
 *
 * @param {object} rom      loaded ROM set
 * @param {number} modelIdx index into the model table
 * @param {null|Uint16Array} points  texture points to use instead of the ROM's,
 *   as the (v, u) pairs the stream is in — what set_obj_tpd's second argument
 *   hands the geometry engine in place of the model's own. The block a game
 *   builds is not always a copy of what it replaces: Aurora Icefield's turns
 *   two of the curtain's nine panels the right way up.
 * @param {null|object} mesh  a mesh that is not in the polygon ROM, as
 *   {bytes, uvPtr, matPtr}: the same records in a buffer of their own, with the
 *   texture pointers a table entry would carry. The House of the Dead builds
 *   the polygons that join an enemy's chest to its hips this way, a template
 *   with some points moved every frame, and hands them to the geometry engine
 *   exactly as it does a model. `planeNormals` set lights it by its faces'
 *   planes, whatever the game's own mode.
 * @returns {null|object}   null when the table entry has no mesh
 */
export function decodeModel(rom, modelIdx, points = null, mesh = null) {
    if (!mesh && (modelIdx < 0 || modelIdx >= rom.game.modelTable.count)) return null;
    /* Top Skater packs its meshes without normals (js/topskatr.js). */
    if (!mesh && rom.game.modelTable.packed) {
        mesh = topskatrMesh(rom, modelIdx);
        if (!mesh) return null;
    }
    const entry = mesh ? { uvPtr: mesh.uvPtr, matPtr: mesh.matPtr, meshPtr: 1 } : readModelEntry(rom, modelIdx);
    if (entry.meshPtr === 0) return null;

    /* An object address without bit 23 is polygon RAM, which the game fills
     * itself (`polygonRam`): Daytona USA's cars' glass and player markers. */
    const ramMesh = !mesh && polygonRamOffset(rom, entry.meshPtr);
    const polygons = mesh ? mesh.bytes : ramMesh !== false ? rom.mainData : rom.polygons;
    const polyView = mesh ? new DataView(mesh.bytes.buffer, mesh.bytes.byteOffset, mesh.bytes.byteLength)
        : ramMesh !== false ? rom.mainDataView : rom.polygonsView;
    const palette = facePalette(rom);
    /* The highest colorbase any face names — which of a game's per-set palettes
     * can colour this model at all. */
    let paletteMax = -1;

    let meshOffset = mesh ? 0 : ramMesh !== false ? ramMesh : meshOffsetOf(rom, entry);
    if (meshOffset < 0 || meshOffset + VERTEX_PAIR_SIZE > polygons.length) return null;

    /* Material stream: one 8-byte record per EMITTED face at matPtr*2.
     * UV stream: nv (pv,pu) 16-bit pairs per face-loop ITERATION at uvPtr*2. */
    /* Either may point into texture RAM instead (textureAt). */
    const { src: matSrc, base: matBase } = textureAt(rom, entry.matPtr);
    const { src: uvSrc, base: uvBase } = textureAt(rom, entry.uvPtr);
    /* A table whose first records sit at 0 says so: Virtua Cop's model 0. */
    const haveMat = matBase >= 0
        && (entry.matPtr !== 0 || (!mesh && rom.game.modelTable?.matAtZero === true));
    let uvWord = entry.uvPtr;
    const haveUv = entry.uvPtr !== 0 || points !== null;

    /* ---- Pass 1: walk the vertex-pair stream, building the index array ---- */
    const sv = [];              /* strip vertices, xyz triples, 2 per pair */
    const qt = [];              /* per-pair f1 */
    const nrm = [];             /* per-pair polygon normal, xyz triples */
    const att = [];             /* per-pair attribute word */
    const idx = [0, 1, 2, 3];   /* placeholder group that becomes the first face */
    let vcount = 0;

    /* A game can raise the cap: Air Walkers' intro city, model 555, is 5440
     * polygons in one mesh. */
    const maxPairs = rom.game.modelTable?.maxVertexPairs ?? MAX_VERTEX_PAIRS;
    while (vcount < maxPairs) {
        if (meshOffset + VERTEX_PAIR_SIZE > polygons.length) break;

        const f1 = polygons[meshOffset + 24];
        const b25 = polygons[meshOffset + 25];
        const isEnd = f1 === 0 && b25 === 0 &&
            polygons[meshOffset + 26] === 0 && polygons[meshOffset + 27] === 0;

        sv.push(
            polyView.getFloat32(meshOffset + 0, true),
            polyView.getFloat32(meshOffset + 4, true),
            -polyView.getFloat32(meshOffset + 8, true),
            polyView.getFloat32(meshOffset + 12, true),
            polyView.getFloat32(meshOffset + 16, true),
            -polyView.getFloat32(meshOffset + 20, true),
        );
        qt.push(f1);
        att.push(polyView.getUint32(meshOffset + 24, true));
        /* Z is negated the same way the points are, so the normal stays with
         * the geometry it belongs to. */
        nrm.push(
            polyView.getFloat32(meshOffset + 28, true),
            polyView.getFloat32(meshOffset + 32, true),
            -polyView.getFloat32(meshOffset + 36, true),
        );

        const newA = 2 * (vcount + 2);   /* vertex index of this pair's first vertex */
        const n = idx.length;
        switch (b25 & 3) {
            case 0:   /* sentinel: previous group ended, start a fresh strip.
                       *
                       * The group standing here is wiped because the board
                       * never draws it: the rasterizer culls any polygon whose
                       * own link type is 0 before anything else is looked at
                       * (MAME check_culling, called from
                       * model2_3d_process_polygon ahead of the raster), and
                       * the geometry engine hands the ROM attribute through
                       * with these bits intact.
                       *
                       * That holds at the head of a mesh too. Every mesh that
                       * opens on this link type — in Sonic The Fighters,
                       * Fighting Vipers, the House of the Dead prototype and
                       * Daytona USA — is the same one-link card, a 2x2 quad at
                       * y = -2 whose only polygon is this one, so it draws
                       * nothing: 70 entries in Sonic The Fighters, 110 in
                       * Fighting Vipers and 813 in Daytona USA. Keeping that
                       * polygon stood a square on screen that the board culls. */
                idx[n - 4] = -1; idx[n - 3] = -1; idx[n - 2] = -1; idx[n - 1] = -1;
                idx.push(newA - 2, newA - 1, newA, newA + 1);
                break;
            case 1:   /* carry the far edge of the previous face */
                idx.push(idx[n - 4], idx[n - 2], newA, newA + 1);
                break;
            case 2:   /* plain new quad group */
                idx.push(newA - 2, newA - 1, newA, newA + 1);
                break;
            case 3: { /* anchor a new strip off the previous corner */
                const ancA = (f1 === 1) ? idx[n - 1] : idx[n - 2];
                const ancB = idx[n - 3];
                idx.push(ancA, ancB, newA, newA + 1);
                break;
            }
        }

        if (isEnd) break;
        meshOffset += VERTEX_PAIR_SIZE;
        vcount++;
    }

    /* A triangle reads one new point, and the slot for a second is not a
     * point: the geometry engine takes its place with the first (MAME
     * geo_parse_*, `p3 = p2`), which is what a following polygon linking off it
     * gets. The attribute describing a record's points is the one before it.
     * Sonic The Fighters and Fighting Vipers store the first point again in
     * that slot; The House of the Dead stores zeros, so taken literally a strip
     * after a triangle reached back to the part's origin. */
    for (let k = 0; k + 1 < qt.length; k++) {
        if (qt[k] !== 2) continue;
        const a = (k + 1) * 6;
        if (a + 6 > sv.length) break;
        sv[a + 3] = sv[a]; sv[a + 4] = sv[a + 1]; sv[a + 5] = sv[a + 2];
    }

    const nsv = sv.length / 3;

    /* ---- Pass 2: face loop, staying two groups behind the tail ---- */
    const positions = [];
    const normals = [];
    const colors = [];
    /* The palette entry each vertex's colour is, or -1: a stage that cycles
     * entries (Last Bronx's) recolours the vertices that name them. */
    const colorIndexes = [];
    const uvs = [];
    const tiles = [];
    const lumaBases = [];
    const flags = [];
    /* The four corners of the polygon each face takes its depth from —
     * see the note on the z source below emitTri. */
    const zc = [[], [], [], []];
    const mats = [];
    const edges = [];

    const rgb = [0.7, 0.7, 0.7];
    let colorIndex = -1;
    const uvu = new Float32Array(4);
    const uvv = new Float32Array(4);
    /* Stream order k -> decoder vertex slot.
     *
     * A face's corners come out of the index array as A,B,D,C for a quad and
     * A,B,C for a triangle, and the UV stream walks the same loop — but in the
     * opposite direction, because negating Z on read reverses the winding. So
     * the stream starts at B and runs backwards: B,A,C,D and B,A,C.
     *
     * The evidence is the strips themselves. A vertex shared by two faces of
     * one strip carries one UV in the ROM, so the right assignment is the one
     * that agrees with itself across the shared vertices: these two agree on
     * 94% of them, against 65% for reading the stream forwards. It is not a
     * cosmetic difference — read forwards, every quad whose texture axis runs
     * along the face is mirrored, which is what stood South Island's billboard
     * palms on their heads and put their coconuts in the sand. */
    const QUAD_SLOT = [1, 0, 2, 3];
    const TRI_SLOT = [1, 0, 2];

    /*
     * How a quad already emitted at this place was split.
     *
     * A decal on this hardware is not a face floating in front of a surface: it
     * is the surface's own faces emitted a second time with a cut-out texture,
     * so the holes let the first copy show. Sonic's open mouth is six such
     * quads standing on six of the muzzle's, corner for corner.
     *
     * The board never compares the two: both take their z from the same corners,
     * so they land in the same bucket, and a bucket is drawn newest first
     * (model2_v.cpp prepends to the list) with a fill that writes a pixel only
     * where nothing has — so the later polygon keeps the quad whole. A depth
     * test gets the same answer for free while the two are the same triangles,
     * because it resolves a tie in favour of whatever was drawn last.
     *
     * They are not always the same triangles. A quad is filled as two triangles
     * and which diagonal it is cut along comes from where its strip anchored,
     * which for the copy is not where the original anchored. Two of the mouth's
     * six quads are cut the other way, and across that diagonal the two surfaces
     * are no longer the same surface: a quad with any warp in it bulges one way
     * under one cut and the other way under the other, and the half that bulges
     * behind the muzzle is drawn behind it. That is the piece missing from the
     * right of the mouth.
     *
     * So a quad whose four corners have been emitted before is cut the way that
     * one was cut. Nothing else changes -- same corners, same winding, same UVs
     * on the same corners -- and with the triangles identical the depth test
     * lands the later face on top, which is the board's own answer.
     */
    const quadSplits = new Map();
    const cornerKey = (p) => {
        let h = 2166136261;
        for (let a = 0; a < 3; a++) {
            const q = Math.round(sv[p + a] * 4096) | 0;
            h = Math.imul(h ^ (q & 0xffff), 16777619);
            h = Math.imul(h ^ ((q >>> 16) & 0xffff), 16777619);
        }
        return h >>> 0;
    };

    /* Per-face material, refreshed each iteration and read by emitTri. */
    let tx = 0, ty = 0, tw = 0, th = 32;
    /* lumaram band for this face; the fill shader needs it for MAME's luma
     * ramp. -1 means "no ramp", which is what an untextured face gets. */
    let lumaBase = -1;
    /* Per-face render flags, bit 0 = the transparent renderer (texheader[0]
     * bit 13), where a texel of 15 is a hole rather than a colour; bit 1 = the
     * checker bit (bit 15), which draws the face on every other screen pixel;
     * bit 2 = the sheet the tile's full-size level is on; bits 3 and 4 = mirror
     * the tile in X and Y (bits 8 and 9), so a coordinate that runs past the
     * tile comes back reflected instead of repeating.
     * The first cuts out the palm fronds and the billboard trees; the second is
     * how the board does half-transparency, and South Island uses it on the
     * water planes and the waterfall. Bits 5 and 6 carry the face's z source,
     * which is not a texture property at all — see the note below emitTri —
     * and neither is bit 7, which says the board draws the face from behind as
     * well as in front; see the note on the facing point. Bits 8 and 9 let the
     * filter blend across the tile's edge in X and Y (bits 6 and 7); a face
     * without them is clamped there. Bit 10 turns on the microtexture, bits
     * 11-12 are its minimum LOD and bits 13-15 where its 128x128 square sits;
     * see the note where they are read. */
    let faceFlags = 0;
    /* Which of the 32 material slots the geometry engine lights this polygon
     * with — bits 18-22 of the attribute word. The slots themselves are per
     * stage; readStageTable reads them. */
    let material = 0;

    function pushEdge(p, q) {
        edges.push(sv[p], sv[p + 1], sv[p + 2], sv[q], sv[q + 1], sv[q + 2]);
    }

    /*
     * Where the polygon's one depth comes from.
     *
     * The board has no depth buffer. model2_3d_process_polygon gives a whole
     * polygon a single z -- bits 10 and 11 of the attribute word pick which of
     * its corners: 1 the nearest, 2 the farthest, 3 a fixed "very far", and 0
     * whatever the previous polygon got, out of a register the rasterizer keeps
     * across the frame. Polygons go into 65536 buckets on that z, are drawn
     * near bucket first, and the fill writes a pixel only if nothing has
     * written it yet (model2rd.ipp: `if (fill[x] == 0)`), so the nearest
     * polygon over a pixel wins whatever the geometry does between them.
     *
     * That is coarser than a per-pixel test, and the difference is visible:
     * Casino Night's platform carries its emerald 0.087 *under* the near-black
     * plate it is painted on, and only the board's rule draws it. So each
     * vertex carries the corners of the polygon its face takes its depth from,
     * and the shader takes the min or max there. It honours only the half of
     * the rule that pushes a polygon back -- see the note in the vertex shader
     * for why a free camera cannot afford the other half.
     *
     * A model whose first face asks for the previous polygon's z inherits from
     * whatever the board drew before it, which is not knowable from the ROM;
     * such a face takes its own nearest corner instead.
     */
    const zSrc = [0, 0, 0, 0];
    let zMode = 1;
    let zSet = false;

    /* The polygon's own normal, when the record carries one. A record that does
     * not (the terminator, and the degenerate links that only close a strip)
     * falls back to the triangle's plane. */
    let faceNx = 0, faceNy = 0, faceNz = 0, faceN = false;

    /*
     * Which side of the polygon the board draws.
     *
     * A polygon is drawn from in front only, unless bit 17 of its attribute word
     * says both sides. model2_v.cpp's check_culling throws a polygon out when
     * that bit is clear and geo_parse set the rear bit on it, and geo_parse
     * sets the rear bit when dot(normal, point) < 0 -- the normal out of ROM and
     * the first point the link itself brings, both through the same matrix,
     * before the perspective divide. So the test is per polygon, against one
     * point, and against the artist's normal rather than the winding. Which
     * point it is matters on anything curved, where the normal is not the
     * plane's.
     *
     * The ROM's normals point away from the side that is drawn: a polygon
     * facing the camera has dot(normal, point) >= 0 with the camera at the
     * origin. Four in five polygons in both games leave bit 17 clear.
     *
     * The link's first new point is the third corner the face loop reads -- C,
     * in the A-B-D-C of a quad and the A-B-C of a triangle -- because a record
     * carries its link's attribute and normal beside the *previous* link's
     * points. Each vertex of the face carries it, so the shader's test has the
     * same answer at all three.
     *
     * A face with no normal of its own has dot product zero, which the board
     * counts as the front, so it is marked as drawn from both sides.
     */
    let facePt = 0;
    const facePts = [];
    /* Which face each triangle was cut from, so a quad's two halves can be put
     * back together (see js/layers.js). */
    const triFaces = [];

    function emitTri(p0, p1, p2, s0, s1, s2) {
        triFaces.push(faceCount);
        const ax = sv[p0], ay = sv[p0 + 1], az = sv[p0 + 2];
        const bx = sv[p1], by = sv[p1 + 1], bz = sv[p1 + 2];
        const cx = sv[p2], cy = sv[p2 + 1], cz = sv[p2 + 2];
        let nx, ny, nz;
        if (faceN) {
            nx = faceNx; ny = faceNy; nz = faceNz;
        } else {
            const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
            const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
            nx = e1y * e2z - e1z * e2y;
            ny = e1z * e2x - e1x * e2z;
            nz = e1x * e2y - e1y * e2x;
        }
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
        normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
        for (let t = 0; t < 3; t++) colors.push(rgb[0], rgb[1], rgb[2]);
        for (let t = 0; t < 3; t++) colorIndexes.push(colorIndex);
        uvs.push(uvu[s0], uvv[s0], uvu[s1], uvv[s1], uvu[s2], uvv[s2]);
        for (let t = 0; t < 3; t++) tiles.push(tx, ty, tw, th);
        for (let t = 0; t < 3; t++) lumaBases.push(lumaBase);
        for (let t = 0; t < 3; t++) flags.push(faceFlags);
        for (let t = 0; t < 3; t++) mats.push(material);
        for (let t = 0; t < 3; t++) facePts.push(sv[facePt], sv[facePt + 1], sv[facePt + 2]);
        for (let c = 0; c < 4; c++) {
            const q = zSrc[c];
            for (let t = 0; t < 3; t++) zc[c].push(sv[q], sv[q + 1], sv[q + 2]);
        }
    }

    /*
     * The material stream is walked, not indexed.
     *
     * model2_3d_process_polygon reads a polygon's texture header at the current
     * address and then moves the address by a signed record count out of bits
     * 12-16 of that polygon's attribute word — for every polygon it is handed,
     * including the ones check_culling then throws out. Sonic The Fighters and
     * Fighting Vipers store 1 on every face that draws and 0 on the groups that
     * do not, which is one record per emitted face and is how this was first
     * read. The House of the Dead stores 0 on most faces and reuses a header
     * for a run of them, and steps back as well as forward: read as one record
     * per face, its rooms come out in the eight primary colours at the bottom
     * of its palette.
     */
    let hdr = matBase;
    const planeNormals = mesh?.planeNormals ?? rom.game.lighting?.planeNormals === true;
    let faceCount = 0;
    let texturedFaces = 0;

    for (let i = 0; i < idx.length - 8; i += 4) {
        const fi = i >> 2;
        const ai = idx[i], bi = idx[i + 1], ci = idx[i + 2], di = idx[i + 3];

        /* NumVerts drives both the UV-stream advance and the fill topology, so
         * it must be computed for skipped groups too or the stream desyncs. */
        const triCnt = fi < qt.length && qt[fi] === 2;
        material = (att[fi] >>> 18) & 0x1f;
        faceNx = nrm[fi * 3]; faceNy = nrm[fi * 3 + 1]; faceNz = nrm[fi * 3 + 2];
        faceN = Math.abs(faceNx) + Math.abs(faceNy) + Math.abs(faceNz) > 0.5;
        const nv = triCnt ? 3 : 4;

        tx = 0; ty = 0; tw = 0; th = 32;
        lumaBase = -1;
        faceFlags = 0;
        let textured = false, untexTrans = false;
        rgb[0] = 0.7; rgb[1] = 0.7; rgb[2] = 0.7;
        colorIndex = -1;

        if (haveMat) {
            const rec = hdr;
            let tho = (att[fi] >>> 12) & 0x1f;
            if (tho & 0x10) tho -= 0x20;
            hdr += tho * 8;
            if (rec >= 0 && rec + 8 <= matSrc.length) {
                const th0 = matSrc[rec] | (matSrc[rec + 1] << 8);
                const th1 = matSrc[rec + 2] | (matSrc[rec + 3] << 8);
                const th2 = matSrc[rec + 4] | (matSrc[rec + 5] << 8);
                const th3 = matSrc[rec + 6] | (matSrc[rec + 7] << 8);
                lumaBase = (th1 & 0xff) << 7;
                textured = (th0 & 0x4000) !== 0;
                /* Bits 14 and 13 select the renderer: textured, and
                 * transparent. The untextured transparent one draws nothing
                 * (model2rd.ipp: "if it's translucent, there's nothing to
                 * render"); its face still sets the z the next one may take. */
                if (textured && (th0 & 0x2000) !== 0) faceFlags |= 1;
                untexTrans = !textured && (th0 & 0x2000) !== 0;
                if (th0 & 0x8000) faceFlags |= 2;
                const texw = 32 << (th0 & 7);
                const texh = 32 << ((th0 >> 3) & 7);
                const sheet = (th2 >> 12) & 1;
                /* Bit 2 records which sheet the full-size level sits on. The
                 * mip chain alternates sheets at every level, so the fill path
                 * needs the starting one to find the smaller levels. */
                if (sheet) faceFlags |= 4;
                /* Bits 8 and 9 mirror the tile rather than repeat it. The board
                 * inverts the coordinate whenever it has run into an odd copy
                 * of the texture — model2rd.ipp fetch_bilinear_texel, `u = ~u`
                 * — which reflects that copy. A stage covers its ground with a
                 * handful of tiles laid out to alternate, so ignoring these
                 * does not lose a detail here or there: it repeats every other
                 * cell the wrong way round, which is what put the seams down
                 * the middle of the Flying Carpet's desert. */
                if ((th0 >> 8) & 1) faceFlags |= 8;
                if ((th0 >> 9) & 1) faceFlags |= 16;
                /* Bits 6 and 7 let the filter blend across the tile's edge into
                 * its far side. Without them the board clamps there instead
                 * (fetch_bilinear_texel, `!tex_wrap_x && u1 == 0`), which is
                 * what a picture cut across several tiles needs: South Island's
                 * sky ring is one panorama over four, and filtering each tile's
                 * last row into its own first put a thin seam at every join. */
                if ((th0 >> 6) & 1) faceFlags |= 256;
                if ((th0 >> 7) & 1) faceFlags |= 512;
                /* The microtexture: a 128x128 detail square the board blends
                 * in, up to almost half, where the face is magnified past its
                 * full-size level (model2rd.ipp, `object.utex && mml < 0`).
                 * Bit 12 turns it on and bits 10-11 are its minimum LOD; th2
                 * bit 13 picks its column of the other sheet and bits 14-15
                 * its row (model2_v.cpp). The House of the Dead puts it on its
                 * walls and floors, which up close read as flat smears of one
                 * texel without it. */
                if (textured && ((th0 >> 12) & 1)) {
                    faceFlags |= 1024 | (((th0 >> 10) & 3) << 11) | (((th2 >> 13) & 7) << 13);
                }
                tx = 32 * (th2 & 0x3f);
                ty = 32 * ((th2 >> 6) & 0x1f) + sheet * 1024;  /* sheets stack */
                tw = textured ? texw : 0;
                th = texh;
                const matidx = (th3 >> 6) & 0x3ff;   /* colorbase -> global palette */
                if (matidx > paletteMax) paletteMax = matidx;
                if (palette[matidx] >= 0) { bgr555(palette[matidx], rgb); colorIndex = matidx; }
            }
        }

        uvu[0] = uvu[1] = uvu[2] = uvu[3] = 0;
        uvv[0] = uvv[1] = uvv[2] = uvv[3] = 0;
        if (haveUv && textured) {
            const slot = triCnt ? TRI_SLOT : QUAD_SLOT;
            for (let k = 0; k < nv; k++) {
                /* An override block is the same stream from its own start, so
                 * it is indexed by how far into the model's the walk has got. */
                const pair = uvWord - entry.uvPtr + k * 2;
                let pv, pu;
                if (points) {
                    if (pair + 2 > points.length) break;
                    pv = points[pair];
                    pu = points[pair + 1];
                } else {
                    const b = uvBase + pair * 2;
                    if (uvBase < 0 || b + 4 > uvSrc.length) break;
                    pv = uvSrc[b] | (uvSrc[b + 1] << 8);
                    pu = uvSrc[b + 2] | (uvSrc[b + 3] << 8);
                }
                uvu[slot[k]] = pu / 8;    /* tile-relative texel; wrapped per-pixel */
                uvv[slot[k]] = pv / 8;
            }
        }
        uvWord += nv * 2;

        if (ai < 0 || ai >= nsv || bi < 0 || bi >= nsv) continue;

        const hasC = ci >= 0 && ci < nsv;
        const hasD = di >= 0 && di < nsv;
        const A = ai * 3, B = bi * 3, C = ci * 3, D = di * 3;

        /* The corners this face is sorted by, in the same two shapes the emit
         * below uses: A-B-C for a triangle and A-B-D-C for a quad. A face that
         * asks for the previous polygon's z keeps the corners already standing
         * here, which is what makes it land in that polygon's bucket. */
        const zm = (att[fi] >>> 10) & 3;
        if (zm !== 0 || !zSet) {
            if (zm !== 0) zMode = zm;
            zSet = true;
            if (triCnt || !hasC || !hasD) {
                zSrc[0] = A; zSrc[1] = B; zSrc[2] = hasC ? C : A; zSrc[3] = zSrc[2];
            } else {
                zSrc[0] = A; zSrc[1] = B; zSrc[2] = D; zSrc[3] = C;
            }
        }
        /* A game that runs the geometry engine in mode 2 (or a mesh drawn in
         * mode 3, `planeNormals` on the mesh) has it ignore the
         * normal in ROM and take the plane of the polygon's first three points
         * instead — P0(n-1), P1(n-1) and P0(n), which are A, B and C here on
         * every link type (MAME geo_parse_nn_ns, vector_cross3). Negated,
         * because the z flip on read reverses a cross product's handedness. */
        if (planeNormals && hasC) {
            const e1x = sv[B] - sv[A], e1y = sv[B + 1] - sv[A + 1], e1z = sv[B + 2] - sv[A + 2];
            const e2x = sv[C] - sv[A], e2y = sv[C + 1] - sv[A + 1], e2z = sv[C + 2] - sv[A + 2];
            const px = e1y * e2z - e1z * e2y;
            const py = e1z * e2x - e1x * e2z;
            const pz = e1x * e2y - e1y * e2x;
            const len = Math.hypot(px, py, pz);
            if (len > 0) {
                faceNx = -px / len; faceNy = -py / len; faceNz = -pz / len;
                faceN = true;
            }
        }
        faceFlags |= zMode << 5;
        if (((att[fi] >>> 17) & 1) || !faceN) faceFlags |= 128;
        facePt = hasC ? C : A;
        if (untexTrans) continue;

        if (triCnt || !hasC || !hasD) {
            if (hasC) {
                emitTri(A, B, C, 0, 1, 2);
                pushEdge(A, B); pushEdge(B, C); pushEdge(C, A);
            } else {
                pushEdge(A, B);   /* degenerate group: the original emits a lone edge */
            }
        } else {
            /* Quad winding A-B-D-C: cut along A-D as triangles ABD and ADC,
             * or along B-C as ABC and BDC when a quad here was cut that way. */
            const kA = cornerKey(A), kB = cornerKey(B), kC = cornerKey(C), kD = cornerKey(D);
            const quad = (kA ^ kB ^ kC ^ kD) >>> 0;
            const cut = (kA ^ kD) >>> 0;
            const seen = quadSplits.get(quad);
            if (seen === undefined) quadSplits.set(quad, cut);
            if (seen !== undefined && seen !== cut) {
                emitTri(A, B, C, 0, 1, 2);
                emitTri(B, D, C, 1, 3, 2);
            } else {
                emitTri(A, B, D, 0, 1, 3);
                emitTri(A, D, C, 0, 3, 2);
            }
            pushEdge(A, B); pushEdge(B, D); pushEdge(D, C); pushEdge(C, A);
        }
        if (textured) texturedFaces++;
        faceCount++;
    }

    if (positions.length === 0) return null;

    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
        for (let a = 0; a < 3; a++) {
            const v = positions[i + a];
            if (v < min[a]) min[a] = v;
            if (v > max[a]) max[a] = v;
        }
    }
    const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const radius = Math.hypot(max[0] - center[0], max[1] - center[1], max[2] - center[2]) || 1;

    return {
        index: modelIdx,
        positions: new Float32Array(positions),
        normals: new Float32Array(normals),
        colors: new Float32Array(colors),
        colorIndexes: new Int16Array(colorIndexes),
        uvs: new Float32Array(uvs),
        tiles: new Float32Array(tiles),
        lumaBases: new Float32Array(lumaBases),
        flags: new Float32Array(flags),
        zCorners: zc.map((a) => new Float32Array(a)),
        facePoints: new Float32Array(facePts),
        mats: new Float32Array(mats),
        edges: new Float32Array(edges),
        faces: new Uint32Array(triFaces),
        faceCount,
        texturedFaces,
        paletteMax,
        vertexPairs: vcount,
        bounds: { min, max, center, radius },
    };
}
