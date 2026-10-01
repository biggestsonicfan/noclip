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
 * more than the highest face under it otherwise — and a plane for the faces
 * that lie on any other. An order is only as good as the depth buffer's
 * ability to keep it, and it cannot keep one by depth alone: a window pane a
 * few thousandths behind its wall is behind it to the buffer when seen close
 * and square on, and a few hundred units out the rounding of each vertex's
 * depth is as large as any offset small enough not to show. So the faces of a
 * group all take their depth from one plane, the largest face's, computed per
 * pixel where the view ray meets it, and are then parted by their layers alone
 * (see FACE_LAYERS in js/viewer.js). A face that strays further than the gap
 * from that plane, through a tilt, keeps the depth it has.
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

/**
 * The faces lying on each other, and a depth plane for every vertex of every
 * draw; the layers themselves come from `rankLayers` for each camera.
 *
 * @param {{decoded: object, matrix: ArrayLike<number>, zCorners?: Float32Array[]}[]}
 *   draws in the order the game submits them; `matrix` is the draw's
 *   column-major 4x4, and `zCorners` stands in for the decode's own
 * @param {{gap?: number, cosine?: number}} [opts] how far apart two faces may
 *   stand and still be ordered, and the least cosine between their normals
 * @returns {{layer: Float32Array, plane: Float32Array, snap: number[]}[]} per
 *   draw, one layer per vertex (0 until ranked) and four numbers per vertex:
 *   the plane its face takes its depth from, n.p = d in the draw's own space,
 *   or zeros for a face that keeps its own depth; and pairs of vertex indices
 *   (copy, original) for a copy to be drawn on the corners of the triangle it
 *   copies. The array carries `ranking`, what rankLayers needs, or null when
 *   no two faces lie on each other.
 */
export function coplanarLayers(draws, { gap = 0.5, cosine = 0.999, stats = null } = {}) {
    const faces = [];
    const out = draws.map(({ decoded }) => {
        const count = decoded ? decoded.positions.length / 3 : 0;
        return { layer: new Float32Array(count), plane: new Float32Array(count * 4), snap: [] };
    });

    draws.forEach(({ decoded, matrix: M, zCorners = decoded?.zCorners }, di) => {
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
                faces.push({ draw: di, t0: t, t1: u, pts, n, area, zmode, zc, lo, hi, hulls: [] });
            }
            t = u + 1;
        }
    });

    /* Candidate pairs: faces whose boxes, grown by the gap, share a cell. */
    const CELL = 32;
    const cells = new Map();
    faces.forEach((f, i) => {
        const c0 = f.lo.map((v) => Math.floor((v - gap) / CELL));
        const c1 = f.hi.map((v) => Math.floor((v + gap) / CELL));
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

    const flatHull = (f, ax) => {
        if (!f.hulls[ax]) {
            const [p, q] = OTHER[ax];
            f.hulls[ax] = hull(f.pts.map((v) => [v[p], v[q]]));
        }
        return f.hulls[ax];
    };
    /* The point of a face's plane over (u, v) in the plane of the other two axes. */
    const lift = (f, ax, uv) => {
        const [p, q] = OTHER[ax];
        const o = f.pts[0];
        const w = o[ax] - (f.n[p] * (uv[0] - o[p]) + f.n[q] * (uv[1] - o[q])) / f.n[ax];
        const out = [0, 0, 0];
        out[p] = uv[0]; out[q] = uv[1]; out[ax] = w;
        return out;
    };

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
    const twins = (f, g) => {
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
    };

    /* The pairs, i before j in the game's order; a copy's is marked, since
     * its copy is put over it whatever the corners say. */
    const pairs = [];
    const seen = new Set();
    for (const list of cells.values()) {
        for (let a = 0; a < list.length; a++) {
            for (let b = a + 1; b < list.length; b++) {
                const i = Math.min(list[a], list[b]), j = Math.max(list[a], list[b]);
                const key = i * faces.length + j;
                if (seen.has(key)) continue;
                seen.add(key);
                const f = faces[i], g = faces[j];
                const cos = f.n[0] * g.n[0] + f.n[1] * g.n[1] + f.n[2] * g.n[2];
                const copy = cos > 0 ? twins(f, g) : null;
                if (cos < cosine && !copy) continue;
                if (f.lo[0] > g.hi[0] + gap || g.lo[0] > f.hi[0] + gap
                    || f.lo[1] > g.hi[1] + gap || g.lo[1] > f.hi[1] + gap
                    || f.lo[2] > g.hi[2] + gap || g.lo[2] > f.hi[2] + gap) continue;
                const ax = Math.abs(f.n[0]) >= Math.abs(f.n[1]) && Math.abs(f.n[0]) >= Math.abs(f.n[2]) ? 0
                    : Math.abs(f.n[1]) >= Math.abs(f.n[2]) ? 1 : 2;
                const common = intersect(flatHull(f, ax), flatHull(g, ax));
                if (!common.length || polygonArea(common) <= Math.max(1e-3, 0.01 * Math.min(f.area, g.area))) continue;

                /* How far g stands from f across the overlap. */
                let most = 0;
                for (const uv of common) {
                    const pf = lift(f, ax, uv), pg = lift(g, ax, uv);
                    const s = f.n[0] * (pg[0] - pf[0]) + f.n[1] * (pg[1] - pf[1]) + f.n[2] * (pg[2] - pf[2]);
                    most = Math.max(most, Math.abs(s));
                }
                if (most > gap) continue;
                if (copy && f.draw === g.draw) {
                    for (let c = 0; c < 3; c++) out[g.draw].snap.push(g.t0 * 3 + c, f.t0 * 3 + copy[c]);
                }
                pairs.push(i, j, copy ? 1 : 0);
            }
        }
    }

    /* The groups: faces joined by any pair, each taking the plane of its
     * largest face. */
    const root = faces.map((_, i) => i);
    const find = (i) => {
        while (root[i] !== i) i = root[i] = root[root[i]];
        return i;
    };
    const paired = new Uint8Array(faces.length);
    for (let k = 0; k < pairs.length; k += 3) {
        paired[pairs[k]] = paired[pairs[k + 1]] = 1;
        root[find(pairs[k])] = find(pairs[k + 1]);
    }
    const largest = new Map();
    faces.forEach((f, i) => {
        if (!paired[i]) return;
        const r = find(i), best = largest.get(r);
        if (best === undefined || f.area > faces[best].area) largest.set(r, i);
    });

    let planes = 0;
    faces.forEach((f, i) => {
        if (!paired[i]) return;
        const ref = faces[largest.get(find(i))];
        const n = ref.n;
        const d = n[0] * ref.pts[0][0] + n[1] * ref.pts[0][1] + n[2] * ref.pts[0][2];
        if (f.pts.some((p) => Math.abs(n[0] * p[0] + n[1] * p[1] + n[2] * p[2] - d) > gap)) return;
        /* Into the draw's own space: for x = A p + t, n.x = d is (A^T n).p = d - n.t. */
        const M = draws[f.draw].matrix;
        const plane = [
            M[0] * n[0] + M[1] * n[1] + M[2] * n[2],
            M[4] * n[0] + M[5] * n[1] + M[6] * n[2],
            M[8] * n[0] + M[9] * n[1] + M[10] * n[2],
            d - (n[0] * M[12] + n[1] * M[13] + n[2] * M[14]),
        ];
        const o = out[f.draw];
        for (let k = f.t0 * 3; k < (f.t1 + 1) * 3; k++) o.plane.set(plane, k * 4);
        planes++;
    });

    /* What rankLayers needs: the paired faces alone, renumbered, with their
     * sort corners flattened. */
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
    out.ranking = kept.length ? {
        out, edges, corners,
        zmode: Uint8Array.from(kept, (f) => f.zmode),
        draw: Int32Array.from(kept, (f) => f.draw),
        t0: Int32Array.from(kept, (f) => f.t0),
        t1: Int32Array.from(kept, (f) => f.t1),
        key: new Int32Array(kept.length),
        layer: new Int32Array(kept.length),
        below: new Int32Array(kept.length),
    } : null;
    if (stats) {
        stats.faces = faces.length;
        stats.paired = kept.length;
        stats.edges = pairs.length / 3;
        stats.planes = planes;
    }
    return out;
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
 * The keys are not handed to the shader as depth: a 24-bit buffer's step is
 * about 3e-6 z² view units with the near plane at 0.02, a quarter of a unit
 * 300 out, so no offset small enough to hide in the depth would survive
 * there. A layer is an order, and an order is all the shader needs.
 *
 * @param {object} r a `ranking` from coplanarLayers
 * @param {ArrayLike<number>} view the camera, as four numbers: the depth along
 *   the view of a point p in the draws' space is view[0..2] . p + view[3]
 * @returns {Set<number>} the draws whose layers changed
 */
export function rankLayers(r, view) {
    const { corners, zmode, key, layer, below, edges } = r;
    const n = zmode.length;
    for (let k = 0; k < n; k++) {
        let near = Infinity, far = -Infinity;
        for (let c = 0; c < 4; c++) {
            const o = k * 12 + c * 3;
            const z = corners[o] * view[0] + corners[o + 1] * view[1] + corners[o + 2] * view[2] + view[3];
            if (z < near) near = z;
            if (z > far) far = z;
        }
        key[k] = zmode[k] === 3 ? 0x7fffffff : bucket(zmode[k] === 2 ? far : near);
    }
    /* Each pair is i before j; j is on top unless i sorts into a nearer bucket. */
    const top = (e) => (edges[e + 2] || key[edges[e + 1]] <= key[edges[e]] ? edges[e + 1] : edges[e]);
    below.fill(0);
    for (let e = 0; e < edges.length; e += 3) below[top(e)]++;
    /* Longest path up from the faces nothing lies under. Only a copy laid
     * against the key can close a circle; what is left in one keeps the layer
     * it has reached. */
    const next = new Int32Array(n);
    const queue = [];
    for (let k = 0; k < n; k++) {
        next[k] = 0;
        if (!below[k]) queue.push(k);
    }
    const ups = r.ups ??= (() => {
        /* Each face's pairs, as edge offsets. */
        const start = new Int32Array(n + 1);
        for (let e = 0; e < edges.length; e += 3) { start[edges[e] + 1]++; start[edges[e + 1] + 1]++; }
        for (let k = 0; k < n; k++) start[k + 1] += start[k];
        const list = new Int32Array(start[n]);
        const fill = start.slice(0, n);
        for (let e = 0; e < edges.length; e += 3) { list[fill[edges[e]]++] = e; list[fill[edges[e + 1]]++] = e; }
        return { start, list };
    })();
    for (let h = 0; h < queue.length; h++) {
        const u = queue[h];
        for (let p = ups.start[u]; p < ups.start[u + 1]; p++) {
            const e = ups.list[p];
            const v = top(e);
            if (v === u) continue;
            if (next[u] + 1 > next[v]) next[v] = next[u] + 1;
            if (--below[v] === 0) queue.push(v);
        }
    }
    const changed = new Set();
    for (let k = 0; k < n; k++) {
        if (next[k] === layer[k]) continue;
        layer[k] = next[k];
        r.out[r.draw[k]].layer.fill(next[k], r.t0[k] * 3, (r.t1[k] + 1) * 3);
        changed.add(r.draw[k]);
    }
    return changed;
}

/*
 * The corners a face is sorted by, taken from the whole flat surface it is a
 * piece of, for a draw that asks (see LAB_ROOM in js/display.js).
 *
 * The vertex shader steps a shallow face back to its far corner and leaves a
 * deep one at its own depth (ZSORT_RECEDE). A wall cut into pieces round a
 * doorway is judged piece by piece, so the strip over the door is shallow and
 * steps back while the wall it is cut from is deep and does not, and a door
 * standing a unit or two behind the wall comes through the strip. Faces of one
 * model that share an edge and lie in one plane are put together here, and
 * each takes the four corners of the rectangle round their surface in its
 * plane: the strip is then as deep as its wall, and as true.
 *
 * Returns the replacement for decoded.zCorners, or null when no two faces
 * join.
 */
export function surfaceCorners(decoded, { tolerance = 1e-3 } = {}) {
    const P = decoded.positions;
    const nt = P.length / 9;
    const faces = new Map();
    for (let t = 0; t < nt; t++) {
        const id = decoded.faces[t];
        let f = faces.get(id);
        if (!f) faces.set(id, f = { tris: [], n: null, d: 0 });
        f.tris.push(t);
        if (f.n) continue;
        const a = [P[t * 9], P[t * 9 + 1], P[t * 9 + 2]];
        const e1 = [P[t * 9 + 3] - a[0], P[t * 9 + 4] - a[1], P[t * 9 + 5] - a[2]];
        const e2 = [P[t * 9 + 6] - a[0], P[t * 9 + 7] - a[1], P[t * 9 + 8] - a[2]];
        const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const len = Math.hypot(...n);
        if (len < 1e-9) continue;
        f.n = n.map((v) => v / len);
        f.d = f.n[0] * a[0] + f.n[1] * a[1] + f.n[2] * a[2];
    }
    const ids = [...faces.keys()];
    const parent = new Map(ids.map((id) => [id, id]));
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const q = (v) => Math.round(v / tolerance);
    const key = (t, k) => `${q(P[t * 9 + k * 3])},${q(P[t * 9 + k * 3 + 1])},${q(P[t * 9 + k * 3 + 2])}`;
    const edges = new Map();
    for (const [id, f] of faces) {
        if (!f.n) continue;
        for (const t of f.tris) {
            for (let k = 0; k < 3; k++) {
                const a = key(t, k), b = key(t, (k + 1) % 3);
                if (a === b) continue;
                const e = a < b ? `${a}|${b}` : `${b}|${a}`;
                const other = edges.get(e);
                if (other === undefined) { edges.set(e, id); continue; }
                if (other === id) continue;
                const g = faces.get(other);
                if (g.n[0] * f.n[0] + g.n[1] * f.n[1] + g.n[2] * f.n[2] < 0.999) continue;
                if (Math.abs(g.d - f.d) > 0.01) continue;
                parent.set(find(id), find(other));
            }
        }
    }
    const groups = new Map();
    for (const id of ids) {
        if (!faces.get(id).n) continue;
        const r = find(id);
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r).push(id);
    }
    if (![...groups.values()].some((g) => g.length > 1)) return null;
    const zc = decoded.zCorners.map((a) => Float32Array.from(a));
    for (const group of groups.values()) {
        if (group.length < 2) continue;
        const { n, d } = faces.get(group[0]);
        /* Two directions in the plane, and the rectangle the surface spans
         * along them. */
        const u = Math.abs(n[0]) < 0.9 ? [0, -n[2], n[1]] : [n[2], 0, -n[0]];
        const ul = Math.hypot(...u);
        for (let k = 0; k < 3; k++) u[k] /= ul;
        const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
        let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
        for (const id of group) {
            for (const t of faces.get(id).tris) {
                for (let k = 0; k < 3; k++) {
                    const p = [P[t * 9 + k * 3], P[t * 9 + k * 3 + 1], P[t * 9 + k * 3 + 2]];
                    const pu = p[0] * u[0] + p[1] * u[1] + p[2] * u[2];
                    const pv = p[0] * v[0] + p[1] * v[1] + p[2] * v[2];
                    u0 = Math.min(u0, pu); u1 = Math.max(u1, pu);
                    v0 = Math.min(v0, pv); v1 = Math.max(v1, pv);
                }
            }
        }
        const corner = (a, b) => [0, 1, 2].map((k) => n[k] * d + u[k] * a + v[k] * b);
        const corners = [corner(u0, v0), corner(u1, v0), corner(u1, v1), corner(u0, v1)];
        for (const id of group) {
            for (const t of faces.get(id).tris) {
                for (let c = 0; c < 4; c++) {
                    for (let k = 0; k < 3; k++) zc[c].set(corners[c], (t * 3 + k) * 3);
                }
            }
        }
    }
    return zc;
}
