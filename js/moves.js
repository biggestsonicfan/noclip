/*
 * moves.js — a fighter's moves, as the game recognises and names them.
 *
 * The 52 action slots are how a fighter stands, walks, falls and gets up; the
 * attacks are not in them. The game reaches an attack through two tables in
 * the program ROM, and this reads both.
 *
 * The input matcher. `MOVESET_ARRAY` (`0x1EFAC`) holds one pointer per
 * character id into a byte-code program that `_uk_execute_move` (`0x1E458`)
 * runs over the fighter's input history every frame — one byte of opcode, a
 * jump through `COMMANDS_BEGIN` (`0x1F00C`), each handler stepping the program
 * counter on by its own `addo N, g4, g4`, which is where `OP_LENGTH` comes
 * from. A table is a run of 7-byte headers, opcode `0x0E`, each a u16 key (the
 * buttons in the low byte, P=1 K=2 G=4, and the fighter's context in the high
 * byte, 0 on the ground) and the address of the script that key runs. A script
 * walks the input ring backwards from now, a direction state at a time, tests
 * the fighter's state, and ends in a commit (`0x05`/`0x06`) that writes a word
 * to `p1_command` — whose low sixteen bits are the motion that plays.
 *
 * Just before a commit, `0x0D` parks the address of another table of the same
 * shape in `p1_pc_command`: the moves that may follow this one. That is what a
 * string is — punch, then the punch table's punch, then its punch — and the
 * commit in a follow-up table waits (`0x12`/`0x1F`) until the running motion's
 * frame reaches its cancel frame plus a few, which `readMotionTiming` in
 * `js/motion.js` reads.
 *
 * The names. `debug_cpu_movesets` (`0xDE278`) is the table the CPU opponent is
 * driven from: 0x2C-byte records, each a pointer to the move's name
 * ("SNC_hataki"), which hit of a string it is, its damage, and the input the
 * CPU types to perform it — the stick and button byte per step and how many
 * frames to hold it, `stick_control_normal` (`0x3E588`) writing them into the
 * fighter's input register one after another. Fed through the matcher above,
 * that input lands on an entry, and the entry takes the name.
 *
 * The two tables and their readings are from the stf-fly project's
 * `flystf/matcher.py`, `combos.py` and `moves.py`, which checked them against
 * the board: typed on a running machine, the decoded input plays the motion the
 * commit names.
 */

import { readMotionTiming, decodeMotion, sampleMotion } from './motion.js';

const MOVESET_ARRAY = 0x0001efac;
const DEBUG_CPU_MOVESETS = 0x000de278;
const CPU_RECORD = 0x2c;
const CPU_STEPS = 16, CPU_END = 0x7f;
/* The CPU table is eleven characters deep; ids 11-15 point at a second copy
 * of Sonic's records and 16 at nothing. Naming Honey's moves after Sonic's
 * would be a guess dressed as a reading, so past 10 there are no names. */
const CPU_NAMED = 11;
/* Where the name strings live, to tell a record from what follows the last. */
const NAME_POOL = [0x00090000, 0x000b0000];
const MIRROR_BASE = 26;

const HEADER = 0x0e, HEADER_LENGTH = 7;
const OP_LENGTH = [
    3, 3, 2, 4, 2, 9, 5, 2, 2, 2, 2, 2, 2, 5, 7, 5,
    1, 5, 4, 5, 5, 9, 3, 1, 1, 1, 5, 5, 2, 4, 2, 4,
    2, 5, 2, 2, 3, 2, 1, 5, 13, 2, 2, 3, 2, 1, 1, 2,
    2, 2, 3, 2, 2, 2, 5, 2, 2, 2, 5, 2, 2, 2, 2, 2,
];
const OP_EXACT_NEW = 0x00, OP_EXACT = 0x01, OP_BIT = 0x02, OP_SUBSET = 0x03;
const OP_COMMIT = 0x05, OP_COMMIT_SHORT = 0x06;
const OP_SETPC = 0x0d, OP_ALT = 0x0f, OP_END = 0x10, OP_JUMP = 0x11;
const OP_WAIT = 0x12, OP_NATIVE_JUMP = 0x13, OP_CLRPC = 0x18;
const OP_NEAR = 0x1a, OP_FAR = 0x1b, OP_BIT_NEW = 0x1e, OP_WAIT2 = 0x1f;
const OP_VS = 0x21, OP_ALT2 = 0x27, OP_BRANCH = 0x28, OP_VS_KIND = 0x2a, OP_END_SETPC = 0x36;
const OP_FLAG = { 0x07: 'en_set', 0x08: 'state_set', 0x09: 'kind_set',
    0x0a: 'en_clear', 0x0b: 'state_clear', 0x0c: 'kind_clear' };
/* `p1_action` bit 18, the one `original_combo_control` raises for hyper. */
const HYPER_BIT = 18;

export const P = 0x01, K = 0x02, G = 0x04;
export const DOWN = 0x10, UP = 0x20, FWD = 0x40, BACK = 0x80;
/* `dir_adjust`'s symbolic bit numbers for forward and back. */
const SYM_FWD = 8, SYM_BACK = 9;

const GLYPHS = [[BACK, 'back'], [FWD, 'fwd'], [UP, 'up'], [DOWN, 'down'],
    [G, 'G'], [K, 'K'], [P, 'P']];
/** An input byte as a move list writes it. */
export function spellInput(byte) {
    const parts = GLYPHS.filter(([m]) => byte & m).map(([, n]) => n);
    return parts.length ? parts.join('+') : 'neutral';
}

/** Which context a key's high byte is. */
export const CONTEXTS = ['ground', 'air', 'air (hyper)', 'air, step 2',
    'air, step 2 (hyper)', 'rising', 'rising'];

const baseIndex = (charIndex) => (charIndex >= MIRROR_BASE ? charIndex - MIRROR_BASE : charIndex);

/*
 * One table: every commit reachable from each of its headers, in the order the
 * engine would try them.
 *
 * A script is a run of blocks, each opened by a fallback (`0x0F`, `0x27`) that
 * says where to go if anything in the block fails, and closed by a commit — so
 * the first block whose tests all pass is the move. Walking it depth first with
 * a stack of fallbacks visits the commits in exactly that order: the main path
 * first, then the innermost fallback, then the one outside it. The three-way
 * branch (`0x28`, handler `0x1EB5C`) picks its way by whether the input sample
 * under the cursor holds forward, back or neither, which is recorded as a test
 * of that one sample.
 */
function readTable(m, dv, start) {
    const out = [];
    const u8 = (a) => m[a], u16 = (a) => dv.getUint16(a, true), u32 = (a) => dv.getUint32(a, true);
    const inRom = (a) => a > 0 && a + 16 < m.length;
    for (let h = start; inRom(h) && m[h] === HEADER; h += HEADER_LENGTH) {
        const key = u16(h + 1);
        const stack = [{ a: u32(h + 3), dirs: [], guards: [], follow: 0, wait: null, depth: 0 }];
        const seen = new Set();
        while (stack.length && out.length < 4000) {
            let { a, dirs, guards, follow, wait, depth } = stack.pop();
            if (depth > 60) continue;
            while (inRom(a)) {
                const here = `${a}:${follow}:${dirs.map((d) => d.mask).join(',')}:${guards.join(';')}`;
                if (seen.has(here)) break;
                seen.add(here);
                const op = u8(a);
                if (op >= OP_LENGTH.length) break;
                if (op === OP_EXACT_NEW || op === OP_EXACT || op === OP_SUBSET) {
                    let mask = u8(a + 1);
                    if (u8(a + 2) & 1) mask |= FWD;
                    if (u8(a + 2) & 2) mask |= BACK;
                    dirs = [...dirs, { op, mask }];
                } else if (op === OP_BIT || op === OP_BIT_NEW) {
                    const b = u8(a + 1);
                    const mask = b === SYM_FWD ? FWD : b === SYM_BACK ? BACK : b < 8 ? 1 << b : 0;
                    dirs = [...dirs, { op, mask }];
                } else if (OP_FLAG[op]) {
                    guards = [...guards, [OP_FLAG[op], u8(a + 1)]];
                } else if (op === OP_NEAR) {
                    guards = [...guards, ['nearer_than', dv.getFloat32(a + 1, true)]];
                } else if (op === OP_FAR) {
                    guards = [...guards, ['further_than', dv.getFloat32(a + 1, true)]];
                } else if (op === OP_VS) {
                    guards = [...guards, ['vs', u32(a + 1)]];
                } else if (op === OP_VS_KIND) {
                    /* `ld 0x1A4(g8)`: a bit of the opponent's motion kind. */
                    guards = [...guards, ['vs_kind_set', u8(a + 1)]];
                } else if (op === OP_SETPC) {
                    follow = u32(a + 1);
                } else if (op === OP_CLRPC) {
                    follow = 0;
                } else if (op === OP_WAIT || op === OP_WAIT2) {
                    wait = (u8(a + 3) << 24) >> 24;
                } else if (op === OP_ALT || op === OP_ALT2) {
                    stack.push({ a: u32(a + 1), dirs, guards, follow, wait, depth: depth + 1 });
                } else if (op === OP_JUMP || op === OP_NATIVE_JUMP) {
                    a = u32(a + 1);
                    continue;
                } else if (op === OP_BRANCH) {
                    const ways = [[1, { op, mask: FWD, here: true }],
                        [5, { op, mask: BACK, here: true }], [9, { op, mask: 0, here: true }]];
                    for (const [off, d] of ways.reverse()) {
                        stack.push({ a: u32(a + off), dirs: [...dirs, d], guards, follow, wait, depth: depth + 1 });
                    }
                    break;
                } else if (op === OP_COMMIT || op === OP_COMMIT_SHORT) {
                    const cmd = u32(a + 1);
                    out.push({ key, cmd, motion: cmd & 0xffff, dirs, guards, follow, wait });
                    break;
                } else if (op === OP_END || op === OP_END_SETPC) {
                    break;
                }
                a += OP_LENGTH[op];
            }
        }
    }
    return out;
}

/* The direction states an entry wants, oldest first, repeats run together. */
function entryDirections(e) {
    const seq = [];
    for (let i = e.dirs.length - 1; i >= 0; i--) {
        if (e.dirs[i].op === OP_BRANCH && !e.dirs[i].mask) continue;
        const d = e.dirs[i].mask & 0xf0;
        if (seq[seq.length - 1] !== d) seq.push(d);
    }
    return seq;
}

/** An entry's input as a move list writes it. */
export function spellEntry(e) {
    const seq = entryDirections(e);
    const buttons = e.key & 0x07;
    if (!seq.length) return spellInput(buttons);
    seq[seq.length - 1] |= buttons;
    return seq.map(spellInput).join(' . ');
}

/* Would the entry's direction tests pass on this history, oldest first? Each
 * test, most recent first, is tried on the sample under the cursor and then one
 * further back until it passes, as `loc_1EE74` does. */
function satisfies(e, hist) {
    let i = hist.length - 1;
    for (const { op, mask, here } of e.dirs) {
        const ok = (s) => (op === OP_EXACT_NEW || op === OP_EXACT) ? s === (mask & 0xf0)
            : op === OP_SUBSET ? (s & ~mask & 0xf0) === 0
            : op === OP_BRANCH && !mask ? (s & (FWD | BACK)) === 0
            : (s & mask) !== 0;
        /* The branch reads the sample where the cursor is and moves nothing. */
        if (here) {
            if (i < 0 || !ok(hist[i])) return false;
            continue;
        }
        while (i >= 0 && !ok(hist[i])) i--;
        if (i < 0) return false;
        i--;
    }
    return true;
}

/*
 * A CPU script cut at its presses: the buttons, and the direction states since
 * the press before, oldest first — what the matcher sees looking back.
 */
function presses(steps) {
    const out = [];
    let hist = [], prev = 0;
    for (const [byte] of steps) {
        const btn = byte & 0x07;
        hist.push(byte & 0xf0);
        if (btn && btn !== prev) { out.push({ btn, hist }); hist = []; }
        prev = btn;
    }
    return out;
}

function collapse(hist) {
    const seq = [];
    for (const d of hist) if (seq[seq.length - 1] !== d) seq.push(d);
    while (seq.length > 1 && seq[0] === 0) seq.shift();
    return seq.length ? seq : [0];
}

/*
 * The situation the viewer shows a move in: a fighter standing on the ground,
 * facing an opponent who is standing too, at an ordinary distance, out of
 * hyper. Every flag the matcher tests — `p1_state` (`P1+0x000`), `p1_en_flag`
 * (`+0x5B8`), `p1_mot_kind` (`+0x1A4`) and the opponent's — reads clear, which
 * is what sends a plain punch to the jab that opens the punch string rather
 * than a turn-round or a throw.
 */
const STANDING_DISTANCE = 2.0;
export function standing(e) {
    return e.guards.every(([g, v]) => {
        if (g.endsWith('_clear')) return true;
        if (g === 'nearer_than') return STANDING_DISTANCE < v;
        if (g === 'further_than') return STANDING_DISTANCE > v;
        return g === 'vs';
    });
}

/* Of a table's entries for one press, the one the input lands on: the first,
 * in the engine's order, whose tests pass. */
function pick(entries, press) {
    return entries.find((e) => (e.key & 0xff) === press.btn && (e.key >> 8) === 0
        && standing(e) && satisfies(e, press.hist)) ?? null;
}

/* The CPU opponent's records for one character: name, hit, damage, input. */
function readCpuMoves(rom, base) {
    const m = rom.maincpu, dv = rom.mainCpuView;
    if (base >= CPU_NAMED) return [];
    const bases = [];
    for (let i = 0; i < 17; i++) bases.push(dv.getUint32(DEBUG_CPU_MOVESETS + i * 4, true));
    const start = bases[base];
    if (!start) return [];
    const stop = Math.min(...bases.filter((b) => b > start), start + 512 * CPU_RECORD);
    const out = [];
    for (let a = start; a + CPU_RECORD <= stop && a + CPU_RECORD <= m.length; a += CPU_RECORD) {
        const ptr = dv.getUint32(a, true);
        if (ptr < NAME_POOL[0] || ptr >= NAME_POOL[1]) break;
        let name = '';
        for (let p = ptr; m[p] && name.length < 48; p++) name += String.fromCharCode(m[p]);
        const steps = [];
        for (let s = 0; s < CPU_STEPS && m[a + 0x0c + s] !== CPU_END; s++) {
            steps.push([m[a + 0x0c + s], m[a + 0x1c + s]]);
        }
        out.push({ name: name.trim(), hit: m[a + 4], damage: m[a + 6], kind: m[a + 7], steps });
    }
    return out;
}

/*
 * The name the game gives a move: the CPU table's, with the character prefix
 * taken off and the romanisation left as it is ("hataki" is a slap).
 */
function shortName(name) {
    const i = name.indexOf('_');
    return i > 0 && i <= 4 ? name.slice(i + 1) : name;
}

/**
 * One fighter's moves.
 *
 * @returns {null | {root:number, tables:Map<number, object[]>, moves:object[]}}
 *   `tables` maps a table's address to its entries — `{key, cmd, motion, dirs,
 *   guards, follow, wait, name?, damage?}` — and the root is the one a fighter
 *   standing free reads. `moves` is the flat list to pick from: every distinct
 *   ground-context motion in the tree, in the order the tree reaches it, each
 *   with the input that reaches it (the strings as their presses, joined by
 *   " , ") and the CPU table's name where one lands on it.
 */
export function readMoves(rom, charIndex) {
    const m = rom.maincpu, dv = rom.mainCpuView;
    const base = baseIndex(charIndex);
    if (base >= 24) return null;
    const root = dv.getUint32(MOVESET_ARRAY + base * 4, true);
    if (!root || root >= m.length || m[root] !== HEADER) return null;

    const tables = new Map();
    const todo = [root];
    while (todo.length) {
        const a = todo.pop();
        if (tables.has(a) || !a || a >= m.length) continue;
        const es = readTable(m, dv, a);
        tables.set(a, es);
        for (const e of es) if (e.follow && !tables.has(e.follow)) todo.push(e.follow);
    }

    /* Name the entries by typing the CPU's scripts into the tree. A script
     * that jumps before its first press is an air attack, which this ground
     * reading has no business naming. */
    for (const cpu of readCpuMoves(rom, base)) {
        const ps = presses(cpu.steps);
        if (!ps.length || ps[0].hist.some((d) => d & UP)) continue;
        let table = root, e = null;
        for (const press of ps) {
            e = pick(tables.get(table) ?? [], press);
            if (!e) break;
            table = e.follow;
        }
        if (e && !e.name) Object.assign(e, { name: shortName(cpu.name), damage: cpu.damage });
    }

    /* Which entries a standing fighter actually gets for their own input: type
     * the input an entry spells and see whether the table lands on it, or on
     * something ahead of it in the engine's order. */
    for (const es of tables.values()) {
        for (const e of es) {
            const hist = entryDirections(e);
            e.reachable = !(e.key >> 8) && standing(e)
                && pick(es, { btn: e.key & 0x07, hist: hist.length ? hist : [0] }) === e;
        }
    }

    /* The flat list, one row per motion, under the plainest input a standing
     * fighter reaches it by: fewest presses, then fewest stick states. A
     * motion only some other situation reaches keeps the first path to it,
     * with the conditions that path needs. */
    const cost = (steps) => steps.length * 100
        + steps.reduce((n, e) => n + entryDirections(e).filter(Boolean).length, 0);
    const best = new Map();
    const order = [];
    /* Cheapest first, so a follow-up table is entered by the plainest way in. */
    const queue = [{ table: root, path: [], ok: true, cost: 0 }];
    const visited = new Set();
    while (queue.length) {
        queue.sort((x, y) => (y.ok - x.ok) || (x.cost - y.cost));
        const { table, path, ok } = queue.shift();
        const seen = `${table}:${ok}`;
        if (visited.has(seen)) continue;
        visited.add(seen);
        for (const e of tables.get(table) ?? []) {
            if (e.key >> 8) continue;
            const steps = [...path, e];
            const reachable = ok && e.reachable;
            const have = best.get(e.motion);
            if (!have) order.push(e.motion);
            if (!have || (reachable && (!have.reachable || cost(steps) < cost(have.steps)))) {
                best.set(e.motion, { motion: e.motion, steps, entry: e, reachable });
            }
            if (e.follow) queue.push({ table: e.follow, path: steps, ok: reachable, cost: cost(steps) });
        }
    }
    const moves = order.map((id) => best.get(id));
    /* The name is the one the CPU's input landed on this very entry, or else
     * the one whose input is plainest among the entries that play the motion. */
    const names = new Map();
    for (const es of tables.values()) {
        for (const e of es) {
            if (!e.name) continue;
            const c = entryDirections(e).filter(Boolean).length;
            const have = names.get(e.motion);
            if (!have || c < have.c) names.set(e.motion, { name: e.name, c });
        }
    }
    for (const mv of moves) mv.name = mv.entry.name ?? names.get(mv.motion)?.name ?? null;
    /* And every entry that plays a named motion answers to that name. */
    for (const es of tables.values()) {
        for (const e of es) e.name ??= names.get(e.motion)?.name;
    }
    return { root, tables, moves };
}

/** A move's input, a press at a time. */
export function spellMove(mv) {
    return mv.steps.map(spellEntry).join(' , ');
}

/* The conditions an entry needs beyond the stick, as the matcher tests them.
 * The bits are the game's; what most of them mean is not read yet. */
export function spellGuards(e) {
    return e.guards.filter(([g]) => !g.endsWith('_clear')).map(([g, v]) => {
        if (g === 'state_set' && v === HYPER_BIT) return 'hyper';
        if (g === 'nearer_than') return `nearer than ${v.toFixed(1)}`;
        if (g === 'further_than') return `further than ${v.toFixed(1)}`;
        if (g === 'vs') return 'against some fighters';
        const who = { state_set: 'state', en_set: 'en', kind_set: 'kind', vs_kind_set: "foe's kind" }[g] ?? g;
        return `${who} bit ${v}`;
    }).join(', ');
}

/** Whether an entry only commits in hyper mode. */
export function needsHyper(e) {
    return e.guards.some(([g, b]) => g === 'state_set' && b === HYPER_BIT);
}

/**
 * The entries of a table that a follow-up could be, in the ground context.
 * @returns {object[]}
 */
export function followUps(moves, e) {
    if (!e || !e.follow) return [];
    return (moves.tables.get(e.follow) ?? []).filter((x) => !(x.key >> 8));
}

/*
 * When the next move of a chain takes over, as the last frame of the one
 * playing that is shown.
 *
 * A follow-up's commit waits in the matcher (op `0x12`, `0x1E7D4`) for
 * `p1_motion_coma + 1 >= p1_follow1 + wait` — the running motion's cancel frame
 * plus the entry's own wait — so the frame before that is the last one of the
 * old motion on screen, and the new one opens on the next. The animators knew
 * it: Sonic's second punch opens on exactly the joint angles his jab holds at
 * frame 15, one short of its cancel frame of 16. Anything else waits for the fighter to be
 * free, which is the motion's end frame, `p1_follow2`, where the action
 * routines hand control back. Never past the motion's last frame.
 */
export function handoverFrame(rom, motionId, frames, next, isFollowUp) {
    const t = readMotionTiming(rom, motionId);
    let f = frames;
    if (t) f = isFollowUp ? t.cancel + (next?.wait ?? 0) - 1 : t.end;
    return Math.max(1, Math.min(frames, f));
}

/*
 * The ease into a new motion.
 *
 * The game does not cut from one motion to the next. `smooth_int` (`0x2F2B0`),
 * run as a motion starts, keeps the pose the fighter was in, and for the first
 * few frames of the new motion `calc_rob_angle_cont` adds back a share of the
 * difference that shrinks by one step a frame (`0x305B0`): the difference over
 * N a frame, times N minus the motion frame, until the frame reaches N. N
 * follows the new motion's length — none for two frames or fewer, then 1, 2
 * and 4 up to 4, 8 and 16 frames, and 8 for anything longer. The angle share
 * is an arithmetic shift of the difference, the float share a multiply by 1/N.
 *
 * The board takes the angle difference as a rotation — the coprocessor
 * composes the old joint rotation with the inverse of the new and reads the
 * three angles back — and this takes it channel by channel, which agrees with
 * that for the small turns an ease spans and not exactly for large ones.
 */
export function easeLength(frames) {
    if (frames <= 2) return 0;
    if (frames <= 4) return 1;
    if (frames <= 8) return 2;
    if (frames <= 16) return 4;
    return 8;
}
const EASE_SHIFT = { 8: 3, 4: 2 };

/**
 * A chain of moves to play one after another, as the game would hand over.
 *
 * @param {object} rom
 * @param {object} moves `readMoves`' result
 * @param {object[]} entries the entries, in order; an entry sitting in the
 *   follow-up table the one before it parked is a string link and takes over
 *   at the cancel frame, anything else once the one before comes free.
 * @returns {null | {links:object[], total:number}} each link `{entry, motion,
 *   decoded, follows, start, length}` — the tick it starts on and how many it
 *   plays before the next takes over.
 */
export function buildChain(rom, moves, entries) {
    const links = [];
    for (const e of entries) {
        const decoded = decodeMotion(rom, e.motion);
        if (!decoded) continue;
        const prev = links[links.length - 1]?.entry;
        const follows = Boolean(prev?.follow && moves.tables.get(prev.follow)?.includes(e));
        links.push({ entry: e, motion: e.motion, decoded, follows, start: 0, length: decoded.frames });
    }
    if (!links.length) return null;
    let t = 0;
    links.forEach((l, i) => {
        const next = links[i + 1];
        l.start = t;
        l.length = next ? handoverFrame(rom, l.motion, l.decoded.frames, next.entry, next.follows)
            : l.decoded.frames;
        t += l.length;
    });
    return { links, total: t };
}

/** Which link a chain tick falls in, and the motion frame there (from 1). */
export function chainAt(chain, tick) {
    const t = ((tick % chain.total) + chain.total) % chain.total;
    let i = 0;
    while (i + 1 < chain.links.length && chain.links[i + 1].start <= t) i++;
    return { index: i, frame: t - chain.links[i].start + 1 };
}

/**
 * Link `i`'s channels at motion frame `f`, eased out of the pose the link
 * before it left, as `sampleMotion` returns them.
 */
export function chainSample(rom, chain, i, f, ease = true) {
    const link = chain.links[i];
    const s = sampleMotion(rom, link.decoded, f);
    const n = easeLength(link.decoded.frames);
    if (!ease || i === 0 || f >= n) return s;
    const before = chain.links[i - 1];
    const old = chainSample(rom, chain, i - 1, before.length, ease);
    const first = sampleMotion(rom, link.decoded, 1);
    const shift = EASE_SHIFT[n] ?? 1;
    const left = n - f;
    for (let k = 0; k < s.angles.length; k++) {
        const d = ((old.angles[k] - first.angles[k]) << 16) >> 16;
        s.angles[k] = (s.angles[k] + (d >> shift) * left) & 0xffff;
    }
    for (let j = 0; j < s.targetUsed.length; j++) {
        if (!s.targetUsed[j] || !old.targetUsed[j]) continue;
        for (let a = 0; a < 3; a++) {
            const k = j * 3 + a;
            s.targets[k] += ((old.targets[k] - first.targets[k]) / n) * left;
        }
    }
    return s;
}

/*
 * The same chain typed on another fighter: each link's input put through the
 * new tree — a string link into the table the link before parked, anything
 * else into the root — and the entry it lands on kept. A press the new fighter
 * has nothing for ends the chain there.
 */
export function retypeChain(moves, entries, follows) {
    const out = [];
    entries.forEach((e, i) => {
        if (out.length !== i) return;
        const from = follows[i] && out.length ? out[out.length - 1].follow : moves.root;
        const hist = entryDirections(e);
        const got = from && pick(moves.tables.get(from) ?? [], { btn: e.key & 0x07, hist: hist.length ? hist : [0] });
        if (got) out.push(got);
    });
    return out;
}

/* A chain as text for a link: each entry as its table's address and its
 * position in that table, which is stable for a given program ROM. */
export function chainCode(moves, entries) {
    const where = new Map();
    for (const [a, es] of moves.tables) es.forEach((e, i) => where.set(e, `${a.toString(16)}.${i}`));
    return entries.map((e) => where.get(e)).join('-');
}

export function parseChainCode(moves, code) {
    const out = [];
    for (const part of String(code).split('-')) {
        const [a, i] = part.split('.');
        const e = moves.tables.get(parseInt(a, 16))?.[+i];
        if (!e) return null;
        out.push(e);
    }
    return out.length ? out : null;
}
