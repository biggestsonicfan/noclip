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
 * each pair is sorted as the board would sort it from a spread of directions
 * over the side they are drawn from, and where three in four of them agree
 * that is the order.
 *
 * Where they do not, the faces lie partly over each other and trade places as
 * the camera moves, and taking the majority there chains into circles — a
 * grille of equal cut-out tiles each a little over the next. Those are put in
 * an order that cannot circle: the one nearer the side they are drawn from
 * over the other, then the smaller over the larger, then the later over the
 * earlier, as a bucket's newest polygon goes.
 *
 * One pair is kept the other way, because the art makes no sense as the sort
 * has it: a solid face with a larger cut-out submitted after it, in one plane.
 * That is a window, a pane of lamplight and over it the frame with holes cut
 * for the glass, which buried under its own light would never be seen.
 *
 * Faces tilted further than that against each other cross, and where they
 * cross the depth buffer is right.
 *
 * What comes out is a layer per face — 0 for a face nothing lies under, one
 * more than the highest face under it otherwise — and a plane for the faces
 * that were ordered at all. An order is only as good as the depth buffer's
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

/* Directions to look from, as (u, v, w) with w the side a face is drawn from:
 * a golden-angle spiral over the cap within 80 degrees of it. Only direction
 * matters — the board sorts on view z, and where the camera stands shifts that
 * by the same amount for every corner. */
const VIEWS = Array.from({ length: 64 }, (_, k) => {
    const w = 1 - ((k + 0.5) / 64) * (1 - Math.cos((80 * Math.PI) / 180));
    const r = Math.sqrt(1 - w * w), a = k * 2.399963;
    return [r * Math.cos(a), r * Math.sin(a), w];
});

/* The share of VIEWS from which the board draws g over f: each is keyed by its
 * near or far corner along the view, the nearer key fills first, and a key
 * shared to within a bucket goes to g, the later polygon. */
function laterShare(f, g) {
    const w = f.n.map((x) => -x);
    const t = Math.abs(w[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = [w[1] * t[2] - w[2] * t[1], w[2] * t[0] - w[0] * t[2], w[0] * t[1] - w[1] * t[0]];
    const ul = Math.hypot(u[0], u[1], u[2]);
    u[0] /= ul; u[1] /= ul; u[2] /= ul;
    const v = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
    const key = (h, d) => {
        let near = Infinity, far = -Infinity;
        for (const p of h.pts) {
            const z = -(p[0] * d[0] + p[1] * d[1] + p[2] * d[2]);
            if (z < near) near = z;
            if (z > far) far = z;
        }
        return h.zmode === 1 ? near : far;
    };
    let wins = 0;
    for (const [a, b, c] of VIEWS) {
        const d = [a * u[0] + b * v[0] + c * w[0], a * u[1] + b * v[1] + c * w[1], a * u[2] + b * v[2] + c * w[2]];
        if (key(g, d) <= key(f, d) + 1e-3) wins++;
    }
    return wins / VIEWS.length;
}

/**
 * A layer and a depth plane for every vertex of every draw.
 *
 * @param {{decoded: object, matrix: ArrayLike<number>}[]} draws in the order the
 *   game submits them; `matrix` is the draw's column-major 4x4
 * @param {{gap?: number, tie?: number, cosine?: number, keepFar?: boolean,
 *   leaveApart?: boolean}} [opts] how far apart two faces may stand and still be
 *   ordered, how far apart counts as one plane, and the least cosine between
 *   their normals; and the two departures a game can ask for (see below):
 *   `keepFar` leaves a face sorted by its farthest corner with no layer and no
 *   plane, and `leaveApart` leaves a pair held apart by more than the tie and
 *   asking for the same corner to the depth buffer
 * @returns {{layer: Float32Array, plane: Float32Array}[]} per draw, one layer
 *   per vertex (0 almost everywhere) and four numbers per vertex: the plane its
 *   face takes its depth from, n.p = d in the draw's own space, or zeros for a
 *   face that keeps its own depth
 */
export function coplanarLayers(draws, {
    gap = 0.5, tie = 0.02, cosine = 0.999, keepFar = false, leaveApart = false, stats = null,
} = {}) {
    const faces = [];
    const out = draws.map(({ decoded }) => {
        const count = decoded ? decoded.positions.length / 3 : 0;
        return { layer: new Float32Array(count), plane: new Float32Array(count * 4) };
    });

    draws.forEach(({ decoded, matrix: M }, di) => {
        if (!decoded?.faces) return;
        const P = decoded.positions;
        const tris = P.length / 9;
        const world = (i) => [
            M[0] * P[i] + M[4] * P[i + 1] + M[8] * P[i + 2] + M[12],
            M[1] * P[i] + M[5] * P[i + 1] + M[9] * P[i + 2] + M[13],
            M[2] * P[i] + M[6] * P[i + 1] + M[10] * P[i + 2] + M[14],
        ];
        for (let t = 0; t < tris;) {
            let u = t;
            while (u + 1 < tris && decoded.faces[u + 1] === decoded.faces[t]) u++;
            const pts = [];
            let best = 0, n = null, area = 0;
            for (let k = t; k <= u; k++) {
                const a = world(k * 9), b = world(k * 9 + 3), c = world(k * 9 + 6);
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
                const cut = (decoded.flags[r / 3] & 1) !== 0;
                const zmode = (decoded.flags[r / 3] >> 5) & 3;
                faces.push({ draw: di, t0: t, t1: u, pts, n, area, cut, zmode, order: faces.length, lo, hi, hulls: [] });
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

    const above = faces.map(() => []);
    const below = new Int32Array(faces.length);
    const ordered = new Uint8Array(faces.length);
    const seen = new Set();
    for (const list of cells.values()) {
        for (let a = 0; a < list.length; a++) {
            for (let b = a + 1; b < list.length; b++) {
                const i = Math.min(list[a], list[b]), j = Math.max(list[a], list[b]);
                const key = i * faces.length + j;
                if (seen.has(key)) continue;
                seen.add(key);
                const f = faces[i], g = faces[j];
                if (f.n[0] * g.n[0] + f.n[1] * g.n[1] + f.n[2] * g.n[2] < cosine) continue;
                if (f.lo[0] > g.hi[0] + gap || g.lo[0] > f.hi[0] + gap
                    || f.lo[1] > g.hi[1] + gap || g.lo[1] > f.hi[1] + gap
                    || f.lo[2] > g.hi[2] + gap || g.lo[2] > f.hi[2] + gap) continue;
                const ax = Math.abs(f.n[0]) >= Math.abs(f.n[1]) && Math.abs(f.n[0]) >= Math.abs(f.n[2]) ? 0
                    : Math.abs(f.n[1]) >= Math.abs(f.n[2]) ? 1 : 2;
                const common = intersect(flatHull(f, ax), flatHull(g, ax));
                if (!common.length || polygonArea(common) <= Math.max(1e-3, 0.01 * Math.min(f.area, g.area))) continue;

                /* How far g stands behind f across the overlap. */
                let most = 0, sum = 0;
                for (const uv of common) {
                    const pf = lift(f, ax, uv), pg = lift(g, ax, uv);
                    const s = f.n[0] * (pg[0] - pf[0]) + f.n[1] * (pg[1] - pf[1]) + f.n[2] * (pg[2] - pf[2]);
                    most = Math.max(most, Math.abs(s));
                    sum += s;
                }
                if (most > gap) continue;

                /* g is the later of the two, so the window is g over a smaller f. */
                const behind = sum / common.length;
                const window = Math.abs(behind) <= tie
                    && !f.cut && g.cut && f.area < g.area * (1 - 1e-3);
                /* The sort only has the last word where the two are in one plane
                 * to within the tie, or where one of them asks for a different
                 * corner. Held apart by more than that and facing the same way
                 * about it, they are what they look like, and the nearer one is
                 * in front for the depth buffer as it is for the board. */
                const bySort = Math.abs(behind) <= tie || f.zmode !== g.zmode;
                /* `leaveApart` takes that at its word and does not order such a
                 * pair at all, so neither joins a group and neither is moved onto
                 * the other's plane. Sonic The Fighters needs it: a fighter's
                 * glove (1813, 1818) is a few tenths across with parallel faces
                 * 0.07 to 0.15 apart, and one plane for all of them lays the
                 * faces on each other. m2-hle2's grade against MAME
                 * (tools/grade-zsort.mjs, issue #75) is where that showed. */
                if (leaveApart && !bySort) continue;
                const share = bySort ? laterShare(f, g) : 0.5;
                let top;
                if (window || share >= 0.75) top = j;
                else if (share <= 0.25) top = i;
                else if (behind > tie) top = i;
                else if (behind < -tie) top = j;
                else if (Math.abs(f.area - g.area) > 1e-3 * Math.max(f.area, g.area)) top = f.area < g.area ? i : j;
                else top = j;
                const bottom = top === i ? j : i;
                above[bottom].push(top);
                below[top]++;
                ordered[i] = ordered[j] = 1;
            }
        }
    }

    /* Longest path from the faces nothing lies under. A cycle — three faces
     * each partly over the next — is broken where it is met: whatever is still
     * waiting when the queue runs dry keeps the layer it has reached. */
    const layer = new Int32Array(faces.length);
    const queue = [];
    for (let i = 0; i < faces.length; i++) if (!below[i]) queue.push(i);
    for (let h = 0; h < queue.length; h++) {
        const u = queue[h];
        for (const v of above[u]) {
            if (layer[u] + 1 > layer[v]) layer[v] = layer[u] + 1;
            if (--below[v] === 0) queue.push(v);
        }
    }

    /* The groups: faces joined by any ordering, each taking the plane of its
     * largest face. */
    const root = faces.map((_, i) => i);
    const find = (i) => {
        while (root[i] !== i) i = root[i] = root[root[i]];
        return i;
    };
    above.forEach((list, i) => {
        for (const k of list) root[find(i)] = find(k);
    });
    const largest = new Map();
    faces.forEach((f, i) => {
        const r = find(i), best = largest.get(r);
        if (best === undefined || f.area > faces[best].area) largest.set(r, i);
    });

    let planes = 0;
    faces.forEach((f, i) => {
        const o = out[f.draw];
        /* `keepFar`: a face sorted by its farthest corner (or the board's "very
         * far") keeps the recede and nothing else. Its orderings still count, so
         * a face laid on it is still raised over it; it just takes neither a
         * layer nor its group's plane, either of which would stop it stepping
         * back. In Sonic The Fighters that step back is what stands a backing
         * plane out of the way of other models: Casino Night's floor emblem,
         * model 194, is mode 2 over faces held a little below it, and layered it
         * covered the green MAME shows beside it (m2-hle2 issue #75). The
         * decals this is all for are mode 1 over mode-2 surfaces — Flying
         * Carpet's shadows on the sand, the slot machine's JACKPOT art — so they
         * keep their layers. */
        if (keepFar && f.zmode >= 2) return;
        if (layer[i]) o.layer.fill(layer[i], f.t0 * 3, (f.t1 + 1) * 3);
        if (!ordered[i]) return;
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
        for (let k = f.t0 * 3; k < (f.t1 + 1) * 3; k++) o.plane.set(plane, k * 4);
        planes++;
    });
    if (stats) {
        stats.faces = faces.length;
        stats.edges = above.reduce((n, list) => n + list.length, 0);
        stats.stuck = faces.length - queue.length;
        stats.planes = planes;
    }
    return out;
}
