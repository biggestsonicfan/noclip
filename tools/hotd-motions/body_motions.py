#!/usr/bin/env python3
"""
Which motions each body of The House of the Dead prototype (hotdp) plays, read
out of the program: the table `rig.bodyMotions` in js/games.js.

    python3 tools/hotd-motions/body_motions.py path/to/hotdp.zip > table.js
    python3 tools/hotd-motions/body_motions.py hotdp.zip hotd.zip > table.js

The second form writes the finished game's table: the prototype's, carried
over by body and motion name (see main).

It needs i960-elf-objdump (OBJDUMP, default /opt/i960/bin/i960-elf-objdump).

An enemy is a task. The stage script spawns it from a record whose first word
is its class, and the class picks its routine from 0x86C10. The routine sets a
body and then plays motions by number, through a handful of setters. So for
each (routine, body) pair the program sets up, the motions are every number
that reaches a setter in the code the routine can get to, plus what the
body-indexed tables hold. The bodies come from:

  - the spawn record: byte +0x24, which sub_28498 and sub_2877C store into the
    object's body (+0xC8); or, for the classes that read their own record at
    obj+0x344 instead (the monkeys, class 32's zombies), the field they load
    from it, which this finds by reading the class routine's first loads;
  - a constant stored to +0xC8, credited to the task just opened when it comes
    straight after TaskOpen (sub_10B30);
  - a constant body passed to sub_2DFD0 or sub_3C410.

The setters, with the register holding the motion (obj in g0):

  sub_2DFD0 g2   init: body in g1, the motion set on every channel
  sub_2E570 g1   change the motion, keeping the last one to blend from
  sub_2E5B0 g1   the second channel
  sub_2D870 g1   change with a frame and a blend
  sub_2DCA0 g1, sub_3AB80 g1, sub_3C410 g2 (draw a given body and motion)

A motion number is a constant, a global in ROM, or a ROM table the load
indexes; a table runs to the next address the code names. The code a routine
gets to is what it branches to, switches its task to (`lda X` stored as the
handler, not a child task's), dispatches through a table of code pointers, or
falls through into; and what it calls, unless the callee is called from more
than four places — the shared helpers would otherwise bring every enemy's
motions in. Routines that branch on the body (the researchers and the ladies
share theirs) give every body of the routine the union; the explorer drops the
motions written for another joint count.

The body-indexed tables, read for every body:

  0x22F70[body]   the motion sub_23060 starts a body on
  0x94940[body]   -> [variant] -> six (motion, param) pairs, one per state
                  at obj+0x60: stance, walk, dash, back...
  0x94C00[body]   -> [variant] -> 24-byte attack records, motion first,
                  picked by a byte of 0x94AA0[body][variant] (8 rows of 10)
  0x94D10[body]   -> nine hit motions, picked by 0x520394 % 9
  0x59FA0[body]   the death motion, or 1 for a pick from 0x5A0B0[0..4]
"""
import bisect, collections, os, re, struct, subprocess, sys, tempfile, zipfile

OBJDUMP = os.environ.get('OBJDUMP', '/opt/i960/bin/i960-elf-objdump')
CODE_END = 0x80000
BODIES, MOTIONS = 68, 508
CLASSES, GENERIC = 0x86c10, 0x2ecc0
TASKOPEN = 0x10b30
SETTERS = {0x2dfd0: 'g2', 0x2e570: 'g1', 0x2e5b0: 'g1', 0x2d870: 'g1',
           0x2dca0: 'g1', 0x3ab80: 'g1', 0x3c410: 'g2'}
MAXCALL = 4


def load_program(zip_path, files=('prg0.15', 'prg1.16')):
    """The two program chips, interleaved a halfword at a time."""
    with zipfile.ZipFile(zip_path) as z:
        lo, hi = (z.read(f) for f in files)
    out = bytearray(len(lo) * 2)
    for i in range(0, len(lo), 2):
        out[i * 2:i * 2 + 2] = lo[i:i + 2]
        out[i * 2 + 2:i * 2 + 4] = hi[i:i + 2]
    return bytes(out)


def disassemble(P):
    with tempfile.NamedTemporaryFile(suffix='.bin') as f:
        f.write(P[:CODE_END])
        f.flush()
        dis = subprocess.run([OBJDUMP, '-D', '-b', 'binary', '-m', 'i960:core', '--adjust-vma=0', f.name],
                             check=True, capture_output=True, text=True).stdout
    ins = []
    for line in dis.splitlines():
        m = re.match(r'^\s+([0-9a-f]+):\t[^\t]*\t[^\t]*\t(.*)$', line)
        if m: ins.append((int(m.group(1), 16), m.group(2).replace('\t', ' ').strip()))
    return ins


class Program:
    def __init__(self, P):
        self.P = P
        self.ins = disassemble(P)
        self.addrs = [a for a, _ in self.ins]
        self.text = dict(self.ins)
        # Every address the code names: a table ends where the next one starts.
        refs = set()
        for _, t in self.ins:
            for m in re.finditer(r'0x([0-9a-f]{4,})', t):
                v = int(m.group(1), 16)
                if 0x1000 <= v < len(P): refs.add(v)
        self.refs = sorted(refs)
        # Function starts: call targets, code addresses loaded with lda, and
        # code addresses held in ROM tables (task handlers).
        starts = set()
        for _, t in self.ins:
            m = re.match(r'(call|bal)\s+0x([0-9a-f]+)$', t)
            if m: starts.add(int(m.group(2), 16))
            m = re.match(r'lda\s+0x([0-9a-f]+),\w+$', t)
            if m and self.looks_code(int(m.group(1), 16)): starts.add(int(m.group(1), 16))
        for p in range(0, len(P), 4):
            v = self.u32(p)
            if self.looks_code(v): starts.add(v)
        self.starts = sorted(starts)
        self.startset = starts
        self.edges = {}
        self.callin = collections.Counter()
        for s in self.starts:
            for t in self.info(s)[0]: self.callin[t] += 1

    def u32(self, a): return struct.unpack_from('<I', self.P, a)[0]

    def looks_code(self, v):
        if not (0x1000 <= v < CODE_END and v % 16 == 0 and v in self.text): return False
        j = bisect.bisect_left(self.addrs, v)
        return not any(junk(t) or t.startswith('.word') for _, t in self.ins[j:j + 8])

    def table_end(self, a):
        i = bisect.bisect_right(self.refs, a)
        return self.refs[i] if i < len(self.refs) else a + 256

    def fstart(self, a):
        i = bisect.bisect_right(self.starts, a) - 1
        return self.starts[i] if i >= 0 else 0

    def fbody(self, s):
        """A function's instructions, to the next start or the first that is data."""
        i = bisect.bisect_right(self.starts, s)
        e = self.starts[i] if i < len(self.starts) else CODE_END
        out = []
        for a in self.addrs[bisect.bisect_left(self.addrs, s):bisect.bisect_left(self.addrs, e)]:
            if junk(self.text[a]): break
            out.append((a, self.text[a]))
        return out

    def code_table(self, a):
        return [v for p in range(a, min(self.table_end(a), a + 512), 4)
                for v in [self.u32(p)] if v in self.startset]

    def info(self, s):
        """(calls, switches, setter calls) of a function."""
        if s in self.edges: return self.edges[s]
        body = self.fbody(s)
        calls, sw, sets, regs = set(), set(), [], {}
        for i, (a, t) in enumerate(body):
            m = re.match(r'(call|bal)\s+0x([0-9a-f]+)$', t)
            if m:
                v = int(m.group(2), 16)
                if v in SETTERS: sets.append(regs.get(SETTERS[v]))
                elif v != TASKOPEN: calls.add(v)
            else:
                m = re.match(r'(b|b[a-z]+|cmp\w+)\s+(?:.*,)?0x([0-9a-f]+)$', t)
                if m:
                    v = int(m.group(2), 16)
                    if v < CODE_END and self.fstart(v) != s: sw.add(self.fstart(v))
                m = re.match(r'lda\s+0x([0-9a-f]+),(\w+)$', t)
                if m:
                    v = int(m.group(1), 16)
                    child = m.group(2) == 'g0' and any(re.match(r'call\s+0x10b30$', u) for _, u in body[i + 1:i + 4])
                    if v in self.startset and v != s and not child: sw.add(v)
                m = re.match(r'(?:ld|lda|ldis|ldos)\s+0x([0-9a-f]{5,})\[\w+\*\d\],\w+$', t)
                if m and int(m.group(1), 16) < len(self.P): sw.update(self.code_table(int(m.group(1), 16)))
            m = re.match(r'(\w+)\s+(.*),(g\d+)$', t)
            if m: regs[m.group(3)] = (m.group(1), m.group(2))
        if body and not re.match(r'(ret|b\s)', body[-1][1]):
            i = bisect.bisect_right(self.starts, s)
            if i < len(self.starts): sw.add(self.starts[i])
        self.edges[s] = (calls, sw, sets)
        return self.edges[s]

    def closure(self, root):
        seen, stack = set(), [root]
        while stack:
            s = stack.pop()
            if s in seen: continue
            seen.add(s)
            calls, sw, _ = self.info(s)
            stack.extend(sw)
            stack.extend(t for t in calls if self.callin[t] <= MAXCALL)
        return seen

    def resolve(self, r):
        """The motion numbers a register's last load can hold, and how."""
        k = const(r)
        if k is not None: return [k], 'const'
        if not r: return [], None
        op, arg = r
        if op not in ('ld', 'ldis', 'ldos'): return [], None
        m = re.match(r'^0x([0-9a-f]+)$', arg)
        if m:
            a = int(m.group(1), 16)
            return ([struct.unpack_from('<I' if op == 'ld' else '<h', self.P, a)[0]], 'global') \
                if a + 4 <= len(self.P) else ([], None)
        m = re.match(r'^0x([0-9a-f]+)(?:\[(\w+)\*(\d)\]|\((\w+)\))$', arg)
        if m:
            a = int(m.group(1), 16); w = 4 if op == 'ld' else 2
            if a >= len(self.P): return [], None
            out = []
            for p in range(a, min(self.table_end(a), a + 64 * w), w):
                v = struct.unpack_from('<I' if w == 4 else '<h', self.P, p)[0]
                if not 0 <= v < MOTIONS: break
                out.append(v)
            return out, 'table'
        return [], None

    def motions(self, root):
        out = set()
        for s in self.closure(root):
            for r in self.info(s)[2]:
                ks, how = self.resolve(r)
                # A zero read out of a table or RAM is an empty slot, not motion 0.
                out.update(k for k in ks if 0 <= k < MOTIONS and (k or how == 'const'))
        return out

    def rec_body_field(self, rt):
        """Where a class routine reads its body from the record at obj+0x344."""
        R, loads = None, {}
        for _, t in self.fbody(rt)[:24]:
            m = re.match(r'ld\s+0x344\(g0\),(\w+)$', t)
            if m: R = m.group(1); continue
            if not R: continue
            m = re.match(r'(ldob|ldib|ldos|ldis)\s+(?:(0x[0-9a-f]+))?\(' + R + r'\),(\w+)$', t)
            if m: loads[m.group(3)] = (int(m.group(2) or '0', 16), m.group(1)); continue
            m = re.match(r'mov\s+(\w+),(\w+)$', t)
            if m and m.group(1) in loads: loads[m.group(2)] = loads[m.group(1)]; continue
            m = re.match(r'(?:stos\s+(\w+),0xc8\(g0\)|st\s+(\w+),0x520390)$', t)
            if m and (m.group(1) or m.group(2)) in loads: return loads[m.group(1) or m.group(2)]
        return None


def junk(t):
    return (t.startswith('.word') and t != '.word 0x00000000') or '?' in t or re.search(r'\bsf\d', t) \
        or '.f ' in t or t.startswith(('fp', 'tanr'))


def const(r):
    if not r: return None
    op, arg = r
    if op in ('lda', 'mov') and re.match(r'^(0x[0-9a-f]+|\d+)$', arg): return int(arg, 0)
    m = re.match(r'(\d+),(\d+)$', arg)
    if m:
        a, b = int(m.group(1)), int(m.group(2))
        return {'addo': a + b, 'shlo': b << a, 'setbit': b | (1 << a)}.get(op)
    return None


# ---- the stage scripts' spawn records ---------------------------------------

END = 0xffffffff
ONE = {16, 34, 83}
TWO = {13, 14, 15, 20, 32, 33, 40, 69, 70, 71, 72, 73, 74, 75, 77, 78, 79, 80, 81, 82, 84, 85, 88, 89, 90, 91}
THREE = {26, 68, 76, 87}
LISTS = {9, 10, 11, 12, 50, 51}
SPAWN = {9, 10, 11, 12}
ENDS = {92, 93}


def spawn_records(prog):
    """Every record a stage script spawns (js/placements.js walks the same)."""
    P, u32 = prog.P, prog.u32
    inrom = lambda p, n=4: 0 < p != END and p + n <= len(P)

    def plist(p):
        out = []
        while inrom(p) and u32(p) != END: out.append(u32(p)); p += 4
        return out

    recs = set()
    for ch in range(5):
        for sec in plist(u32(0xe0000 + ch * 4)):
            for p in plist(sec):
                for _ in range(4096):
                    if not inrom(p): break
                    op = u32(p)
                    if op in SPAWN: recs.update(r for r in plist(p + 4) if inrom(r, 0x38))
                    if op in ENDS: break
                    if op == END or op in ONE: p += 4
                    elif op in TWO: p += 8
                    elif op in THREE: p += 12
                    elif op == 60: p += 8 + (u32(p + 4) >> 4) * 4
                    elif op in LISTS:
                        q = p + 4
                        while inrom(q) and u32(q) != END: q += 4
                        p = q + 4
                    else: break
    return recs


def routines(prog):
    """(routine, body) pairs the program sets up."""
    P, ins = prog.P, prog.ins
    out = set()
    fmt = {'ldob': '<B', 'ldib': '<b', 'ldos': '<H', 'ldis': '<h'}
    for r in spawn_records(prog):
        rt = prog.u32(CLASSES + prog.u32(r) * 4)
        if not rt or rt == GENERIC: continue
        f = prog.rec_body_field(rt)
        b = struct.unpack_from(fmt[f[1]], P, r + 0x24 + f[0])[0] if f else P[r + 0x24]
        if 0 <= b < BODIES: out.add((rt, b))
    for i, (a, t) in enumerate(ins):
        m = re.match(r'stos\s+(\w+),0xc8\((\w+)\)$', t)
        if m:
            val = None
            for _, u in reversed(ins[max(0, i - 12):i]):
                mm = re.match(r'(\w+)\s+(.*),' + m.group(1) + '$', u)
                if mm: val = const((mm.group(1), mm.group(2))); break
            if val is None or val >= BODIES: continue
            child = None
            for j in range(i - 1, max(0, i - 30), -1):
                if re.match(r'call\s+0x10b30$', ins[j][1]):
                    for _, w in ins[max(0, j - 4):j]:
                        mm = re.match(r'lda\s+0x([0-9a-f]+),g0$', w)
                        if mm: child = int(mm.group(1), 16)
                    break
            out.add((child or prog.fstart(a), val))
        if re.match(r'call\s+0x(2dfd0|3c410)$', t):
            regs = {}
            for _, u in ins[max(0, i - 14):i]:
                mm = re.match(r'(\w+)\s+(.*),(g\d+)$', u)
                if mm: regs[mm.group(3)] = (mm.group(1), mm.group(2))
            v = const(regs.get('g1'))
            if v is not None and v < BODIES: out.add((prog.fstart(a), v))
    return out


def table_motions(prog, b):
    """What the body-indexed tables hold for a body, read the way their
    consumers index them."""
    u32, end = prog.u32, prog.table_end
    out = set()

    def variants(top):
        """A body's list of per-variant pointers (the variant is obj+0x64),
        up to the next body's list."""
        p = u32(top + 4 * b)
        if not p: return []
        others = {u32(top + 4 * i) for i in range(BODIES)} - {p}
        vs, a = [], p
        while (a == p or (a < end(p) and a not in others)) and 0x50000 <= u32(a) < 0x96000:
            vs.append(u32(a)); a += 4
        return vs

    # One record of six (motion, param) pairs per variant, indexed by the
    # state at obj+0x60 (sub_5A980: `ld (r4)[r5*8]`).
    for vp in variants(0x94940): out.update(u32(vp + 8 * i) for i in range(6))
    # 24-byte records, motion first, indexed by obj+0x2DF: a byte of the
    # variant's attack patterns at 0x94AA0, eight rows of ten.
    pats = variants(0x94aa0)
    for i, vp in enumerate(variants(0x94c00)):
        used = [x for x in prog.P[pats[i]:pats[i] + 80] if x < 0x80] if i < len(pats) else []
        out.update(u32(vp + 24 * k) for k in range(max(used, default=0) + 1))
    if p := u32(0x94d10 + 4 * b):
        out.update(u32(p + 4 * i) for i in range(9))
    d = u32(0x59fa0 + 4 * b)
    out.update([u32(0x5a0b0 + 4 * i) for i in range(5)] if d == 1 else [d])
    out.add(u32(0x22f70 + 4 * b))
    return {k for k in out if 0 < k < MOTIONS}


def names(P, at, count):
    out = []
    for i in range(count):
        a = struct.unpack_from('<I', P, at + 4 * i)[0]
        out.append(P[a:P.index(0, a)].decode())
    return out


def print_table(per, body_names):
    print('bodyMotions: [')
    for b, name in enumerate(body_names):
        out, line = [f'    /* {b} {name} */'], '    ['
        for k in sorted(per.get(b, ())):
            item = f'{k}, '
            if len(line) + len(item) > 100: out.append(line.rstrip()); line = '     '
            line += item
        out.append(line.rstrip(', ') + '],')
        print('\n'.join(out))
    print('],')


def main():
    prog = Program(load_program(sys.argv[1]))
    per = collections.defaultdict(set)
    for rt, b in routines(prog): per[b] |= prog.motions(rt)
    for b in range(BODIES): per[b] |= table_motions(prog, b)
    body_names = names(prog.P, 0x96020, BODIES)
    if len(sys.argv) < 3:
        print_table(per, body_names)
        return
    # The finished game: its code was rewritten too far to read the same way,
    # but most bodies and motions kept their names, so carry the prototype's
    # table over by name. Body and motion numbers are the same in both of its
    # revisions; rev A's name tables are read.
    motion_names = names(prog.P, 0x96130, MOTIONS)
    F = load_program(sys.argv[2], ('epr-19696a.15', 'epr-19697a.16'))
    fb, fm = names(F, 0xc8a60, 94), names(F, 0xc8be0, 674)
    motion_at = {n: i for i, n in enumerate(fm)}
    proto = {n: b for b, n in enumerate(body_names)}
    print_table({b: {motion_at[motion_names[k]] for k in per[proto[n]] if motion_names[k] in motion_at}
                 for b, n in enumerate(fb) if n in proto}, fb)


if __name__ == '__main__':
    main()
