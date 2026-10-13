/*
 * layers.js — which of two faces lying in one plane the board shows.
 *
 * The board has no depth buffer. The geometry engine gives every polygon one
 * depth — its nearest corner, or its farthest when the attribute asks (mode 2)
 * — sorts the polygons into buckets by it, and fills near buckets first,
 * writing a pixel only where nothing has yet. So two faces in the same plane
 * never fight: one wins the whole polygon. A depth buffer compares them a pixel
 * at a time, finds the same depth on both, and hands the pixel to whichever the
 * rasteriser's rounding favours, which changes as the camera moves.
 *
 * The House of the Dead is built on that. Its walls, floors and grounds are
 * large faces with smaller ones laid on them — stains, rugs, trim, window
 * glow, a pond's edge — some in exactly the same plane, some a few hundredths
 * or tenths of a unit off it. Nearly every one of them sorts by its far corner.
 * On a plane the far corner is where a linear depth peaks, and a face lying
 * inside another cannot peak further out than it, so from anywhere in front the
 * smaller face sorts nearer and is drawn. A depth buffer only tells apart what
 * its precision can: a tenth of a unit is under one step of it a couple of
 * hundred units out.
 *
 * So faces that overlap, face the same way to within a couple of degrees and
 * stand no more than half a unit apart across their overlap are put in the
 * order the board's sort gives them, and that order is not one answer: the sort
 * key is a corner, and which corner is furthest depends on where the camera
 * looks from. Seen square on, every point of a plane is at one depth, all its
 * faces share a bucket, and the one submitted last wins. At an angle a face
 * lying inside another sorts nearer by its far corner and wins, whether it
 * stands a few hundredths in front of the other or behind it, and a face that
 * asks for its near corner (mode 1) beats any far-corner face it overlaps. So
 * the pairs are found once, here, and ordered for every camera by rankLayers,
 * with the keys the board would give them from it.
 *
 * Faces tilted further than that against each other cross, and where they
 * cross the depth buffer is right.
 *
 * What comes out is a layer per face — 0 for a face nothing lies under, one
 * more than the highest face under it otherwise. Each face keeps its own
 * depth, and a layer lifts it a few steps of a 32-bit float depth buffer
 * (see FACE_LAYERS in js/viewer.js): enough to part two faces in one plane,
 * and no more. A face the sort puts on top that lies further behind than a
 * few steps -- a window pane a few thousandths behind its wall, seen close and
 * square on -- stays behind.
 */

/* Andrew's monotone chain, counter-clockwise. */
function hull(points) {
    const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const q of p) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 1e-12) lower.pop();
        lower.push(q);
    }
    const upper = [];
    for (let i = p.length - 1; i >= 0; i--) {
        const q = p[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 1e-12) upper.pop();
        upper.push(q);
    }
    upper.pop();
    lower.pop();
    return lower.concat(upper);
}

function polygonArea(poly) {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        a += p[0] * q[1] - q[0] * p[1];
    }
    return Math.abs(a) / 2;
}

/* The intersection of two convex counter-clockwise polygons (Sutherland-Hodgman,
 * clipping the first by each edge of the second). */
function intersect(subject, clipper) {
    let out = subject;
    for (let i = 0; i < clipper.length && out.length; i++) {
        const a = clipper[i], b = clipper[(i + 1) % clipper.length];
        const side = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
        const input = out;
        out = [];
        for (let j = 0; j < input.length; j++) {
            const p = input[j], q = input[(j + 1) % input.length];
            const sp = side(p), sq = side(q);
            if (sp >= 0) out.push(p);
            if ((sp >= 0) !== (sq >= 0)) {
                const t = sp / (sp - sq);
                out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
            }
        }
    }
    return out.length >= 3 ? out : [];
}

/* Whether two faces' boxes, each grown by `grow`, overlap. */
function boxesMeet(f, g, grow) {
    return [0, 1, 2].every((a) => f.lo[a] <= g.hi[a] + grow && g.lo[a] <= f.hi[a] + grow);
}

/* The axis a normal lies most along. */
function mainAxis(n) {
    const x = Math.abs(n[0]), y = Math.abs(n[1]), z = Math.abs(n[2]);
    return x >= y && x >= z ? 0 : y >= z ? 1 : 2;
}

/* The two axes left when `ax` is dropped. */
const OTHER = [[1, 2], [0, 2], [0, 1]];

/* The board's sort bucket for a view depth: the float with its mantissa rounded
 * to 12 bits (MAME's float_to_zval), which orders as the depth does. A depth
 * behind the eye is bucket 0, as the board clamps it. */
const zbits = new Float32Array(1);
const zword = new Int32Array(zbits.buffer);
function bucket(z) {
    if (!(z > 0)) return 0;
    zbits[0] = z;
    return (zword[0] + 0x400) >> 11;
}

/* Every face of every draw, in world space, with its box, normal, area,
 * zmode and the corners the board sorts it by. */
function facesOf(draws) {
    const faces = [];
    draws.forEach(({ decoded, matrix: M, zCorners = decoded?.zCorners, zones = null }, di) => {
        if (!decoded?.faces) return;
        const P = decoded.positions;
        const tris = P.length / 9;
        const world = (A, i) => [
            M[0] * A[i] + M[4] * A[i + 1] + M[8] * A[i + 2] + M[12],
            M[1] * A[i] + M[5] * A[i + 1] + M[9] * A[i + 2] + M[13],
            M[2] * A[i] + M[6] * A[i + 1] + M[10] * A[i + 2] + M[14],
        ];
        for (let t = 0; t < tris;) {
            let u = t;
            while (u + 1 < tris && decoded.faces[u + 1] === decoded.faces[t]) u++;
            const pts = [];
            let best = 0, n = null, area = 0;
            for (let k = t; k <= u; k++) {
                const a = world(P, k * 9), b = world(P, k * 9 + 3), c = world(P, k * 9 + 6);
                pts.push(a, b, c);
                const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
                const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
                const x = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
                const len = Math.hypot(x[0], x[1], x[2]);
                area += len / 2;
                if (len > best) { best = len; n = x.map((v) => v / len); }
            }
            if (n && area > 1e-4) {
                /* The normal the ROM gives points away from the side the face is
                 * drawn from; the plane's is turned to agree, so "further along
                 * the normal" is "further behind" for either face of a pair, and
                 * two faces back to back in one plane are never compared. */
                const r = t * 9;    /* the first vertex of the face's first triangle */
                const rn = decoded.normals;
                const wn = [
                    M[0] * rn[r] + M[4] * rn[r + 1] + M[8] * rn[r + 2],
                    M[1] * rn[r] + M[5] * rn[r + 1] + M[9] * rn[r + 2],
                    M[2] * rn[r] + M[6] * rn[r + 1] + M[10] * rn[r + 2],
                ];
                if (wn[0] * n[0] + wn[1] * n[1] + wn[2] * n[2] < 0) n = n.map((v) => -v);
                const lo = [0, 1, 2].map((a) => Math.min(...pts.map((p) => p[a])));
                const hi = [0, 1, 2].map((a) => Math.max(...pts.map((p) => p[a])));
                const zmode = (decoded.flags[r / 3] >> 5) & 3;
                /* The four corners the board sorts the face by. */
                const zc = zCorners ? zCorners.map((a) => world(a, r)) : [...pts.slice(0, 3), pts[2]];
                faces.push({ draw: di, t0: t, t1: u, pts, n, area, zmode, zc, lo, hi, hulls: [], zones });
            }
            t = u + 1;
        }
    });
    return faces;
}

/* Candidate pairs: faces whose boxes, grown by the gap, share a cell. */
const CELL = 32;
function cellsOf(faces, gap) {
    const cells = new Map();
    faces.forEach((f, i) => {
        const c0 = f.c0 = f.lo.map((v) => Math.floor((v - gap) / CELL));
        const c1 = f.c1 = f.hi.map((v) => Math.floor((v + gap) / CELL));
        for (let x = c0[0]; x <= c1[0]; x++) {
            for (let y = c0[1]; y <= c1[1]; y++) {
                for (let z = c0[2]; z <= c1[2]; z++) {
                    const k = `${x},${y},${z}`;
                    const list = cells.get(k);
                    if (list) list.push(i); else cells.set(k, [i]);
                }
            }
        }
    });
    return cells;
}

function flatHull(f, ax) {
    if (!f.hulls[ax]) {
        const [p, q] = OTHER[ax];
        f.hulls[ax] = hull(f.pts.map((v) => [v[p], v[q]]));
    }
    return f.hulls[ax];
}
/* The point of a face's plane over (u, v) in the plane of the other two axes. */
function lift(f, ax, uv) {
    const [p, q] = OTHER[ax];
    const o = f.pts[0];
    const w = o[ax] - (f.n[p] * (uv[0] - o[p]) + f.n[q] * (uv[1] - o[q])) / f.n[ax];
    const out = [0, 0, 0];
    out[p] = uv[0]; out[q] = uv[1]; out[ax] = w;
    return out;
}

/* One triangle drawn twice, the second a copy laid on the first — corners
 * that pair up, each within the gap, all but one of them within a quarter
 * of the first's shortest side. Daytona's flags draw their emblem that way,
 * a cut-out triangle over each triangle of the cloth, and every frame of
 * the wave but the first moves a corner of some copies a little differently
 * from the cloth's: up to a third of a unit, tilting a pair as much as 24
 * degrees apart. Left to the tests below, such a pair is not ordered,
 * crosses, and the depth buffer shows each over part of the other — the
 * emblem smeared across the cloth on six frames of the 32, which is the
 * flicker (issue 38). A copy is the same polygon, so it is taken as the tie
 * the first frame is, which the later polygon wins. The quarter is of the
 * triangle's own size, so the small parallel faces of a fighter's glove, a
 * tenth apart and a few tenths across, are not taken for copies.
 *
 * Ordered, the copy still does not cover its original where a corner of it
 * has moved inward: a sliver of cloth is left out, and it lies under the
 * next copy along, which is another pair and is not ordered against it.
 * At a fold that sliver comes out in front — a white streak down the flag.
 * So the copy is also drawn on its original's corners (`snap`), which
 * moves its picture by no more than the corner moved, a third of a unit.
 *
 * Returns, for each corner of g, the corner of f it pairs with, or null. */
function twins(f, g, gap) {
    if (f.pts.length !== 3 || g.pts.length !== 3) return null;
    const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    const near = 0.25 * Math.min(dist(f.pts[0], f.pts[1]), dist(f.pts[1], f.pts[2]), dist(f.pts[2], f.pts[0]));
    const free = [0, 1, 2];
    const pair = [];
    let close = 0;
    for (const p of g.pts) {
        let best = -1;
        for (const k of free) if (best < 0 || dist(p, f.pts[k]) < dist(p, f.pts[best])) best = k;
        const d = dist(p, f.pts[best]);
        if (d > gap) return null;
        if (d <= near) close++;
        pair.push(best);
        free.splice(free.indexOf(best), 1);
    }
    return close >= 2 ? pair : null;
}

/* A pair is taken in the first cell, in the order the cells were made, of
 * those its two faces share: once, without a set of every pair seen, which
 * a stage dense with small faces (Virtua Cop's high-rise) runs past the
 * 2^24 a Set can hold. */
function takenHere(f, g, cell, order) {
    const x0 = Math.max(f.c0[0], g.c0[0]), x1 = Math.min(f.c1[0], g.c1[0]);
    const y0 = Math.max(f.c0[1], g.c0[1]), y1 = Math.min(f.c1[1], g.c1[1]);
    const z0 = Math.max(f.c0[2], g.c0[2]), z1 = Math.min(f.c1[2], g.c1[2]);
    /* One cell shared: this one. */
    if (x0 === x1 && y0 === y1 && z0 === z1) return true;
    let first = Infinity;
    for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
            for (let z = z0; z <= z1; z++) first = Math.min(first, order.get(`${x},${y},${z}`));
        }
    }
    return first === cell;
}

/*
 * How far apart two faces of a pair must stand, everywhere across their
 * overlap, for the one in front to be on top from any camera, whatever the
 * board's sort says. The sort keys a whole polygon by one corner, so a large
 * face sorted by its near corner (mode 1) beats a small one sorted by its far
 * corner wherever the camera comes close to the large one's edge — even with
 * the small one well in front. The game's cameras never stand there; a free
 * camera does. Virtua Cop's third stage has it (issue 71): a bookcase 0.4 in
 * front of the office wall, the wall's triangles sorted by their near corner,
 * and the wall shown through the books in a triangle wherever its corner came
 * near. A face that far in front of another is in front of it in the picture
 * the game was made from, and a depth buffer would keep it there; the sort
 * is left to the faces closer than that, which only the sort can order.
 */
const APART = 0.25;
/*
 * A smaller face is put on top from nearer than that: a picture laid on a
 * larger one, in front of it, belongs over it however the larger is keyed.
 * Another bookcase in that office has its books 0.11 in front of the wall
 * (issue 73), and the wall, one quad sorted by its near corner, took them
 * over wherever the camera came near that corner. A smaller face behind a
 * larger one is still left to the sort: that is a decal or a pane the board
 * shows through the face it lies under, from the angles the game looks at it.
 */
const SMALL_APART = 0.05;
/* What the third number of a pair says: by the sort, a copy over its
 * original, or the face in front on top. */
const COPY = 1, J_FRONT = 2, I_FRONT = 3;

/* How far g stands behind f across their overlap, least and most. */
function behind(f, g, ax, common) {
    let lo = Infinity, hi = -Infinity;
    for (const uv of common) {
        const pf = lift(f, ax, uv), pg = lift(g, ax, uv);
        const s = f.n[0] * (pg[0] - pf[0]) + f.n[1] * (pg[1] - pf[1]) + f.n[2] * (pg[2] - pf[2]);
        lo = Math.min(lo, s); hi = Math.max(hi, s);
    }
    return [lo, hi];
}

/* Which of a pair, f before g, goes on top whatever the sort says, from how
 * far g stands behind f, least and most, and the faces' areas; 0 for neither. */
function inFront(lo, hi, fArea, gArea) {
    if (lo >= APART || (lo >= SMALL_APART && fArea < gArea)) return I_FRONT;
    if (hi <= -APART || (hi <= -SMALL_APART && gArea < fArea)) return J_FRONT;
    return 0;
}

/*
 * Which of a pair, f before g, goes on top when the game never draws the two
 * together: the one from the later segment (or room); 0 when they share one,
 * or either draws everywhere. Seen all at once, a stage overlays pieces the
 * game shows one segment at a time. Virtua Cop's third stage lays the road
 * of its first four segments on under the lobby floor of the later ones, in
 * its plane, where the lobby isn't drawn yet; with every segment at once the
 * sort put the road over the floor (issue 82). The later segment is where
 * the camera stands by then, so it is that one's picture.
 */
function laterZone(f, g) {
    if (!f.zones?.size || !g.zones?.size) return 0;
    for (const z of f.zones) if (g.zones.has(z)) return 0;
    return Math.min(...f.zones) > Math.min(...g.zones) ? I_FRONT : J_FRONT;
}

/*
 * Of two faces in one plane from pieces shown in different (if overlapping)
 * runs of segments, both sorted by the far corner, the smaller on top. A
 * face lying inside a larger one sorts nearer from any slant anyway; what
 * this changes is two faces that only partly overlap, where the far corners
 * order them one way from one side and the other way from another, and the
 * board cuts one into the other in triangles. Virtua Cop's third stage lays
 * its courtyard's gravel, quads of a few hundred square units, on the
 * road's of 900 and 1500, and from above the road came through it so (issue
 * 83). The game's camera passes low and far off; the smaller piece is the
 * one laid on the other. Pieces shown in the same segments keep the sort:
 * the game draws them together, and the sort is its picture (issue 71's
 * desks).
 */
const SMALLER = 0.9;
function sameZones(f, g) {
    if (!f.zones?.size || !g.zones?.size) return true;
    if (f.zones.size !== g.zones.size) return false;
    for (const z of f.zones) if (!g.zones.has(z)) return false;
    return true;
}
function smallerOnTop(f, g, lo, hi) {
    if (f.zmode !== 2 || g.zmode !== 2 || sameZones(f, g)) return 0;
    if (Math.max(hi, -lo) >= SMALL_APART) return 0;
    if (f.area < SMALLER * g.area) return I_FRONT;
    return g.area < SMALLER * f.area ? J_FRONT : 0;
}

/* The pairs, i before j in the game's order, three numbers each; a copy's is
 * marked, since its copy is put over it whatever the corners say, and so is
 * a pair standing apart (see inFront), its face in front put over the other. */
function pairsOf(faces, out, gap, cosine) {
    const cells = cellsOf(faces, gap);
    const order = new Map([...cells.keys()].map((k, n) => [k, n]));
    const pairs = [];
    const consider = (i, j) => {
        const f = faces[i], g = faces[j];
        const cos = f.n[0] * g.n[0] + f.n[1] * g.n[1] + f.n[2] * g.n[2];
        const copy = cos > 0 ? twins(f, g, gap) : null;
        if (cos < cosine && !copy) return;
        if (!boxesMeet(f, g, gap)) return;
        const ax = mainAxis(f.n);
        const common = intersect(flatHull(f, ax), flatHull(g, ax));
        if (!common.length || polygonArea(common) <= Math.max(1e-3, 0.01 * Math.min(f.area, g.area))) return;

        const [lo, hi] = behind(f, g, ax, common);
        if (Math.max(hi, -lo) > gap) return;
        if (copy && f.draw === g.draw) {
            for (let c = 0; c < 3; c++) out[g.draw].snap.push(g.t0 * 3 + c, f.t0 * 3 + copy[c]);
        }
        pairs.push(i, j, copy ? COPY : inFront(lo, hi, f.area, g.area) || laterZone(f, g) || smallerOnTop(f, g, lo, hi));
    };
    let cell = -1;
    for (const list of cells.values()) {
        cell++;
        for (let a = 0; a < list.length; a++) {
            for (let b = a + 1; b < list.length; b++) {
                const i = Math.min(list[a], list[b]), j = Math.max(list[a], list[b]);
                if (takenHere(faces[i], faces[j], cell, order)) consider(i, j);
            }
        }
    }
    return pairs;
}

/* Which faces any pair joins. */
function pairedOf(faces, pairs) {
    const paired = new Uint8Array(faces.length);
    for (let k = 0; k < pairs.length; k += 3) paired[pairs[k]] = paired[pairs[k + 1]] = 1;
    return paired;
}

/* What rankLayers needs: the paired faces alone, renumbered, with their
 * sort corners flattened. */
function rankingOf(faces, pairs, paired, out) {
    const index = new Int32Array(faces.length).fill(-1);
    const kept = [];
    faces.forEach((f, i) => { if (paired[i]) index[i] = kept.push(f) - 1; });
    const corners = new Float32Array(kept.length * 12);
    kept.forEach((f, k) => f.zc.forEach((c, m) => corners.set(c, k * 12 + m * 3)));
    const edges = new Int32Array(pairs.length);
    for (let k = 0; k < pairs.length; k += 3) {
        edges[k] = index[pairs[k]];
        edges[k + 1] = index[pairs[k + 1]];
        edges[k + 2] = pairs[k + 2];
    }
    return kept.length ? {
        out, edges, corners,
        zmode: Uint8Array.from(kept, (f) => f.zmode),
        draw: Int32Array.from(kept, (f) => f.draw),
        t0: Int32Array.from(kept, (f) => f.t0),
        t1: Int32Array.from(kept, (f) => f.t1),
        key: new Int32Array(kept.length),
        layer: new Int32Array(kept.length),
        below: new Int32Array(kept.length),
    } : null;
}

/**
 * The faces lying on each other, for every vertex of every draw; the layers
 * themselves come from `rankLayers` for each camera.
 *
 * @param {{decoded: object, matrix: ArrayLike<number>, zCorners?: Float32Array[], zones?: Set<number>}[]}
 *   draws in the order the game submits them; `matrix` is the draw's
 *   column-major 4x4, and `zCorners` stands in for the decode's own
 * @param {{gap?: number, cosine?: number}} [opts] how far apart two faces may
 *   stand and still be ordered, and the least cosine between their normals
 * @returns {{layer: Float32Array, snap: number[]}[]} per draw, one layer per
 *   vertex (0 until ranked), and pairs of vertex indices
 *   (copy, original) for a copy to be drawn on the corners of the triangle it
 *   copies. The array carries `ranking`, what rankLayers needs, or null when
 *   no two faces lie on each other.
 */
export function coplanarLayers(draws, { gap = 0.5, cosine = 0.999, stats = null } = {}) {
    const faces = facesOf(draws);
    const out = draws.map(({ decoded }) => {
        const count = decoded ? decoded.positions.length / 3 : 0;
        return { layer: new Float32Array(count), snap: [] };
    });
    const pairs = pairsOf(faces, out, gap, cosine);
    const paired = pairedOf(faces, pairs);
    out.ranking = rankingOf(faces, pairs, paired, out);
    if (stats) {
        stats.faces = faces.length;
        stats.paired = paired.reduce((s, v) => s + v, 0);
        stats.edges = pairs.length / 3;
    }
    return out;
}

/* The bucket the board sorts each face into from the camera `view`. */
function sortKeys({ corners, zmode, key }, view) {
    for (let k = 0; k < zmode.length; k++) {
        let near = Infinity, far = -Infinity;
        for (let c = 0; c < 4; c++) {
            const o = k * 12 + c * 3;
            const z = corners[o] * view[0] + corners[o + 1] * view[1] + corners[o + 2] * view[2] + view[3];
            if (z < near) near = z;
            if (z > far) far = z;
        }
        key[k] = zmode[k] === 3 ? 0x7fffffff : bucket(zmode[k] === 2 ? far : near);
    }
}

/**
 * Rank the faces of each group as the board's sort does from one camera: each
 * face is keyed by its nearest corner or its farthest (or "very far") along
 * the view, as its attribute asks; the nearer bucket fills first, and of two
 * in one bucket the later polygon, which the board puts at the head of the
 * bucket's list. Of each pair, then, one is on top, and a face's layer is one
 * more than the highest face under it. A copy (see `twins`) is put over its
 * original as the tie it is.
 *
 * The keys are whole-polygon and change with the camera, which is why the
 * layers are worked out here per view and not once: a decal lying inside a
 * wall sorts nearer by its far corner from an angle, and seen square on the
 * two share a bucket and the later wins.
 *
 * The keys are not handed to the shader as depth: a layer is an order, and
 * an order is all the shader needs.
 *
 * @param {object} r a `ranking` from coplanarLayers
 * @param {ArrayLike<number>} view the camera, as four numbers: the depth along
 *   the view of a point p in the draws' space is view[0..2] . p + view[3]
 * @returns {Set<number>} the draws whose layers changed
 */
export function rankLayers(r, view) {
    sortKeys(r, view);
    const next = layersFrom(r, upsOf(r));
    const changed = new Set();
    for (let k = 0; k < next.length; k++) {
        if (next[k] === r.layer[k]) continue;
        r.layer[k] = next[k];
        r.out[r.draw[k]].layer.fill(next[k], r.t0[k] * 3, (r.t1[k] + 1) * 3);
        changed.add(r.draw[k]);
    }
    return changed;
}

/* Each face's pairs, as edge offsets. */
function upsOf(r) {
    if (r.ups) return r.ups;
    const { edges } = r, n = r.zmode.length;
    const start = new Int32Array(n + 1);
    for (let e = 0; e < edges.length; e += 3) { start[edges[e] + 1]++; start[edges[e + 1] + 1]++; }
    for (let k = 0; k < n; k++) start[k + 1] += start[k];
    const list = new Int32Array(start[n]);
    const fill = start.slice(0, n);
    for (let e = 0; e < edges.length; e += 3) { list[fill[edges[e]]++] = e; list[fill[edges[e + 1]]++] = e; }
    return (r.ups = { start, list });
}

/* Each pair is i before j; j is on top unless i sorts into a nearer bucket,
 * or stands in front. */
function topOf({ edges, key }, e) {
    const how = edges[e + 2];
    if (how === I_FRONT) return edges[e];
    return how || key[edges[e + 1]] <= key[edges[e]] ? edges[e + 1] : edges[e];
}

/*
 * Longest path up from the faces nothing lies under. The sort alone orders
 * the faces one way, so only a pair laid against the key — a copy, or a face
 * standing in front — can close a circle, and every face on one, and every
 * face over it, would wait on the others for ever. A face is then let go once
 * nothing laid against the key waits under it, the sort's pairs under it
 * still waiting given up: of the two, it is the face in front that is on top
 * from any camera. Virtua Cop's third stage has such a circle (issue 82): the
 * lobby carpet, half a unit over the road that runs on under the lobby floor,
 * was left under it, and the road came through it.
 */
function layersFrom(r, ups) {
    const { edges } = r, n = r.zmode.length;
    const { below, forced } = countBelow(r);
    const next = new Int32Array(n);
    /* 0 waiting, 1 in the queue, 2 done. */
    const state = new Uint8Array(n);
    const { queue, free } = startOf(below, forced, state);
    for (let h = 0; h < n; h++) {
        if (h === queue.length && !letGo(free, state, queue)) break;
        const u = queue[h];
        state[u] = 2;
        for (let p = ups.start[u]; p < ups.start[u + 1]; p++) {
            const e = ups.list[p];
            const v = topOf(r, e);
            if (v === u || state[v] === 2) continue;
            if (next[u] + 1 > next[v]) next[v] = next[u] + 1;
            if (--below[v] === 0 && state[v] === 0) { queue.push(v); state[v] = 1; }
            else if (edges[e + 2] && --forced[v] === 0 && state[v] === 0) free.list.push(v);
        }
    }
    return next;
}

/* How many pairs have each face on top, and how many of those are laid
 * against the key. */
function countBelow(r) {
    const { edges } = r;
    const below = r.below.fill(0), forced = (r.forced ??= new Int32Array(below.length)).fill(0);
    for (let e = 0; e < edges.length; e += 3) {
        const v = topOf(r, e);
        below[v]++;
        if (edges[e + 2]) forced[v]++;
    }
    return { below, forced };
}

/* The faces nothing lies under, queued, and those waiting on the sort's
 * pairs alone, which a circle may let go. */
function startOf(below, forced, state) {
    const queue = [], free = { list: [], at: 0 };
    for (let k = 0; k < below.length; k++) {
        if (!below[k]) { queue.push(k); state[k] = 1; } else if (!forced[k]) free.list.push(k);
    }
    return { queue, free };
}

/* A face waiting on the sort's pairs alone, the first to come to that,
 * queued; false if there is none. */
function letGo(free, state, queue) {
    while (free.at < free.list.length) {
        const k = free.list[free.at++];
        if (state[k] !== 0) continue;
        queue.push(k);
        state[k] = 1;
        return true;
    }
    return false;
}
