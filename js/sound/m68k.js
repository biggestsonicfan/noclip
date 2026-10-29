/*
 * m68k.js — the sound board's MC68000, ported from m2-hle2's
 * src/board/m68k_exec.h, m68k_timing.h and m68k.h (commit 6a15509) as the
 * board's wasm build compiled them: NDEBUG, the LOG_* calls gone, the fast
 * forms (M68K_FAST) on.
 *
 * It is that core, quirks and all, not a 68000 in general: CHK, TRAP, TRAPV
 * and the privilege violations take no exception, ILLEGAL halts, leaving
 * supervisor mode never swaps the stack pointers, and so on. The board's
 * timing rests on its clock counts (the interrupt latency and the SCSP timer
 * periods), so those are the C's to the period: Motorola's table time per
 * opcode, the run-dependent parts (branches taken, DBcc, Scc, shift counts,
 * MOVEM registers, MULU/MULS bits, the divides' own counts) and the wait
 * states of every bus cycle, by 64 KB page (wmap). A C-vs-JS harness holds the
 * two to the same registers, clocks and bus traffic after every instruction.
 *
 * The one place the two cannot agree: DIVS of 0x80000000 by -1. The C divides
 * in int32 and the wasm build traps there (the whole board stops); this
 * reports the overflow (V and N set), as for every other quotient that does
 * not fit.
 *
 * State, all of it plain fields the board reads and writes:
 *   d, a       Int32Array(8): D0-D7, A0-A7 (A7 the active stack pointer);
 *              read them >>> 0 for the unsigned value
 *   pc, usp, ssp  unsigned 32-bit Numbers
 *   sr         the 16-bit status register
 *   halted, stopped  0 or 1
 *   cycles     clock periods run, a Number
 *   rmap       Array(256) of Uint8Array (at least 64 KB from its start) or
 *              null: pages of the 24-bit space read straight from memory,
 *              big-endian; an access crossing a page end goes to read()
 *   wmap       Uint8Array(256): wait states per bus cycle, by page
 *   read(addr24, sz)  the bus for reads not in rmap, sz 1, 2 or 4;
 *              returns the value (bits above sz are ignored)
 *   write(addr24, val, sz)  every write, val already cut to sz
 */

const SR_C = 0x0001, SR_V = 0x0002, SR_Z = 0x0004, SR_N = 0x0008, SR_X = 0x0010;
const SR_CCR = 0x001F, SR_IPL = 0x0700, SR_S = 0x2000, SR_T0 = 0x4000, SR_T1 = 0x8000;

/* ================================================================ timing (m68k_timing.h) */

const TIME = new Uint8Array(65536);

/* Table 8-1: effective address calculation time (0 = the mode does not exist) */
const EA_BW = [0, 0, 4, 4, 6, 8, 10, 8, 12, 8, 10, 4];
const EA_L  = [0, 0, 8, 8, 10, 12, 14, 12, 16, 12, 14, 8];
function eaTime(mode, reg, isLong) {
    const i = mode < 7 ? mode : (reg <= 4 ? 7 + reg : -1);
    if (i < 0) return 0;
    return isLong ? EA_L[i] : EA_BW[i];
}
function moveDstTime(mode, reg, isLong) {
    if (mode === 4) return isLong ? 8 : 4;
    return eaTime(mode, reg, isLong);
}
function ctlIndex(mode, reg) {
    switch (mode) {
    case 2: return 0;
    case 5: return 1;
    case 6: return 2;
    case 7: return reg <= 3 ? 3 + reg : -1;
    }
    return -1;
}
const T_LEA = [4, 8, 12, 8, 12, 8, 12];
const T_PEA = [12, 16, 20, 16, 20, 16, 20];
const T_JSR = [16, 18, 22, 18, 20, 18, 22];
const T_JMP = [8, 10, 14, 10, 12, 10, 14];

function timeOf(op) {
    const grp = op >> 12, mode = (op >> 3) & 7, reg = op & 7;
    const szb = (op >> 6) & 3;
    const L = szb === 2;
    const rnImm = mode === 0 || mode === 1 || (mode === 7 && reg === 4);

    switch (grp) {
    case 0x0:
        if (op & 0x0100) {
            if (mode === 1) return szb >= 2 ? 24 : 16;
            const type = szb;
            if (mode === 0) return type === 0 ? 6 : type === 2 ? 10 : 8;
            return (type === 0 ? 4 : 8) + eaTime(mode, reg, 0);
        }
        switch ((op >> 8) & 0xF) {
        case 0x8: {
            const type = szb;
            if (mode === 0) return type === 0 ? 10 : type === 2 ? 14 : 12;
            return (type === 0 ? 8 : 12) + eaTime(mode, reg, 0);
        }
        case 0x0: case 0x2: case 0x4: case 0x6: case 0xA:
            if (mode === 7 && reg === 4) return 20;
            if (mode === 0) return L ? 16 : 8;
            return (L ? 20 : 12) + eaTime(mode, reg, L);
        case 0xC:
            if (mode === 0) return L ? 14 : 8;
            return (L ? 12 : 8) + eaTime(mode, reg, L);
        }
        return 34;

    case 0x1: case 0x2: case 0x3: {
        const ml = grp === 2;
        const dmode = (op >> 6) & 7, dreg = (op >> 9) & 7;
        return 4 + eaTime(mode, reg, ml) + moveDstTime(dmode, dreg, ml);
    }

    case 0x4: {
        if ((op & 0xF1C0) === 0x41C0) { const i = ctlIndex(mode, reg); return i < 0 ? 34 : T_LEA[i]; }
        if ((op & 0xF1C0) === 0x4180) return 10 + eaTime(mode, reg, 0);
        switch (op & 0xFFC0) {
        case 0x40C0: return mode === 0 ? 6 : 8 + eaTime(mode, reg, 0);
        case 0x44C0: case 0x46C0: return 12 + eaTime(mode, reg, 0);
        case 0x4800: return mode === 0 ? 6 : 8 + eaTime(mode, reg, 0);
        case 0x4840: {
            if (mode === 0) return 4;
            const i = ctlIndex(mode, reg); return i < 0 ? 34 : T_PEA[i];
        }
        case 0x4880: case 0x48C0:
            if (mode === 0) return 4;
            switch (mode) {
            case 2: case 4: return 8;
            case 5: return 12;
            case 6: return 14;
            case 7: return reg === 0 ? 12 : 16;
            }
            return 34;
        case 0x4AC0:
            if (op === 0x4AFC) return 34;
            return mode === 0 ? 4 : 10 + eaTime(mode, reg, 0);
        case 0x4C80: case 0x4CC0:
            switch (mode) {
            case 2: case 3: return 12;
            case 5: return 16;
            case 6: return 18;
            case 7: return reg === 0 ? 16 : reg === 1 ? 20 : reg === 2 ? 16 : 18;
            }
            return 34;
        case 0x4E80: { const i = ctlIndex(mode, reg); return i < 0 ? 34 : T_JSR[i]; }
        case 0x4EC0: { const i = ctlIndex(mode, reg); return i < 0 ? 34 : T_JMP[i]; }
        }
        if ((op & 0xFFF0) === 0x4E40) return 34;
        if ((op & 0xFFF8) === 0x4E50) return 16;
        if ((op & 0xFFF8) === 0x4E58) return 12;
        if ((op & 0xFFF0) === 0x4E60) return 4;
        switch (op) {
        case 0x4E70: return 132;
        case 0x4E71: return 4;
        case 0x4E72: return 4;
        case 0x4E73: return 20;
        case 0x4E75: return 16;
        case 0x4E76: return 4;
        case 0x4E77: return 20;
        }
        if (szb !== 3) switch (op & 0xFF00) {
        case 0x4000: case 0x4200: case 0x4400: case 0x4600:
            if (mode === 0) return L ? 6 : 4;
            return (L ? 12 : 8) + eaTime(mode, reg, L);
        case 0x4A00:
            return 4 + eaTime(mode, reg, L);
        }
        return 34;
    }

    case 0x5:
        if (szb === 3) {
            if (mode === 1) return 12;
            return mode === 0 ? 4 : 8 + eaTime(mode, reg, 0);
        }
        if (mode === 0) return L ? 8 : 4;
        if (mode === 1) return 8;
        return (L ? 12 : 8) + eaTime(mode, reg, L);

    case 0x6: {
        const cc = (op >> 8) & 0xF, disp8 = op & 0xFF;
        if (cc === 1) return 18;
        if (cc === 0) return 10;
        return disp8 ? 8 : 12;
    }

    case 0x7:
        return 4;

    case 0x8: case 0xC: {
        if (szb === 3) {
            if (grp === 0x8) return ((op & 0x0100) ? 158 : 140) + eaTime(mode, reg, 0);
            return 38 + eaTime(mode, reg, 0);
        }
        if ((op & 0x01F0) === 0x0100) return mode === 0 ? 6 : 18;
        if (grp === 0xC && (op & 0x01F8) === 0x0140) return 6;
        if (grp === 0xC && (op & 0x01F8) === 0x0148) return 6;
        if (grp === 0xC && (op & 0x01F8) === 0x0188) return 6;
        if (op & 0x0100) return (L ? 12 : 8) + eaTime(mode, reg, L);
        return (L ? (rnImm ? 8 : 6) : 8) + eaTime(mode, reg, L);
    }

    case 0x9: case 0xD:
        if (szb === 3) {
            const al = (op & 0x0100) !== 0;
            return (al ? (rnImm ? 8 : 6) : 8) + eaTime(mode, reg, al);
        }
        if ((op & 0x0130) === 0x0100) return mode === 0 ? (L ? 12 : 8) : (L ? 30 : 18);
        if (op & 0x0100) return (L ? 12 : 8) + eaTime(mode, reg, L);
        return (L ? (rnImm ? 8 : 6) : 8) + eaTime(mode, reg, L);

    case 0xB:
        if (szb === 3) return 6 + eaTime(mode, reg, (op & 0x0100) !== 0);
        if (op & 0x0100) {
            if (mode === 1) return L ? 20 : 12;
            if (mode === 0) return L ? 12 : 8;
            return (L ? 12 : 8) + eaTime(mode, reg, L);
        }
        return 6 + eaTime(mode, reg, L);

    case 0xE:
        if (szb === 3) return 8 + eaTime(mode, reg, 0);
        return L ? 8 : 6;

    default:
        return 34;
    }
}

/* ================================================================ fast forms (m68k_exec.h) */

const F_NONE = 0, F_JMP_PCD16 = 1, F_BRA_W = 2, F_BRA_B = 3, F_BCC_W = 4, F_BCC_B = 5,
    F_MOVEB_AI_DN = 6, F_MOVEB_D16_D16 = 7, F_ADDAW_IMM = 8, F_RORL_IMM = 9;
const FAST = new Uint8Array(65536);

function fastKind(op) {
    if (op === 0x4EFA) return F_JMP_PCD16;
    if ((op & 0xF000) === 0x6000) {
        const disp = op & 0xFF, cc = (op >> 8) & 0xF;
        if (cc === 1 || disp === 0xFF) return F_NONE;
        if (cc === 0) return disp === 0 ? F_BRA_W : F_BRA_B;
        return disp === 0 ? F_BCC_W : F_BCC_B;
    }
    if ((op & 0xF1F8) === 0x1010) return F_MOVEB_AI_DN;
    if ((op & 0xF1F8) === 0x1168) return F_MOVEB_D16_D16;
    if ((op & 0xF1FF) === 0xD0FC) return F_ADDAW_IMM;
    if ((op & 0xF1F8) === 0xE098) return F_RORL_IMM;
    return F_NONE;
}

let tablesReady = false;
/* m68k_tables_init. The module calls it itself when it loads; calling it again
 * does nothing. */
export function m68kTablesInit() {
    if (tablesReady) return;
    for (let op = 0; op < 65536; op++) { TIME[op] = timeOf(op); FAST[op] = fastKind(op); }
    tablesReady = true;
}
m68kTablesInit();

/* ================================================================ helpers */

function szMask(sz) { return sz === 1 ? 0xFF : sz === 2 ? 0xFFFF : -1; }
function szMsb(sz) { return sz === 1 ? 0x80 : sz === 2 ? 0x8000 : 0x80000000; }
/* v cut to sz, unsigned */
function cut(v, sz) { return sz === 1 ? v & 0xFF : sz === 2 ? v & 0xFFFF : v >>> 0; }
/* (An)+ / -(An) step: a byte on A7 keeps it even */
function step(sz, reg) { return (sz === 1 && reg === 7) ? 2 : sz; }

function testCC(sr, cc) {
    switch (cc & 0xF) {
    case 0: return true;
    case 1: return false;
    case 2: return (sr & (SR_C | SR_Z)) === 0;
    case 3: return (sr & (SR_C | SR_Z)) !== 0;
    case 4: return (sr & SR_C) === 0;
    case 5: return (sr & SR_C) !== 0;
    case 6: return (sr & SR_Z) === 0;
    case 7: return (sr & SR_Z) !== 0;
    case 8: return (sr & SR_V) === 0;
    case 9: return (sr & SR_V) !== 0;
    case 10: return (sr & SR_N) === 0;
    case 11: return (sr & SR_N) !== 0;
    case 12: return ((sr >> 3) & 1) === ((sr >> 1) & 1);
    case 13: return ((sr >> 3) & 1) !== ((sr >> 1) & 1);
    case 14: return (sr & SR_Z) === 0 && ((sr >> 3) & 1) === ((sr >> 1) & 1);
    default: return (sr & SR_Z) !== 0 || ((sr >> 3) & 1) !== ((sr >> 1) & 1);
    }
}

/* the divides' clock counts: Musashi's getDivu68kCycles / getDivs68kCycles */
function divuCycles(dividend, divisor) {
    dividend >>>= 0;
    if ((dividend >>> 16) >= divisor) return 10;
    let m = 38;
    const hdiv = (divisor << 16) >>> 0;
    for (let i = 0; i < 15; i++) {
        const t = dividend;
        dividend = (dividend << 1) >>> 0;
        if (t & 0x80000000) dividend = (dividend - hdiv) >>> 0;
        else {
            m += 2;
            if (dividend >= hdiv) { dividend = (dividend - hdiv) >>> 0; m--; }
        }
    }
    return m * 2;
}
function divsCycles(dividend, divisor) {            /* int32, int16 */
    let m = 6;
    const adiv = dividend < 0 ? -dividend : dividend;
    const asor = divisor < 0 ? -divisor : divisor;
    if (dividend < 0) m++;
    if ((adiv >>> 16) >= asor) return (m + 2) * 2;
    let aquot = Math.floor(adiv / asor);
    m += 55;
    if (divisor >= 0) { if (dividend >= 0) m--; else m++; }
    for (let i = 0; i < 15; i++) { if ((aquot & 0x8000) === 0) m++; aquot = (aquot << 1) >>> 0; }
    return m * 2;
}

function defaultRead() { return 0; }
function defaultWrite() {}

/* ================================================================ the CPU */

export class M68K {
    constructor() {
        this.d = new Int32Array(8);
        this.a = new Int32Array(8);
        this.pc = 0;
        this.sr = SR_S | 0x0700;
        this.usp = 0;
        this.ssp = 0;
        this.halted = 0;
        this.stopped = 0;
        this.cycles = 0;
        this.rmap = new Array(256).fill(null);
        this.wmap = new Uint8Array(256);
        this.read = defaultRead;
        this.write = defaultWrite;
        this.ea = 0;            /* the address rmr decoded, for rmw */
    }

    /* m68k_reset: the CPU state zeroed, supervisor mode, all interrupts masked.
     * rmap, wmap, read and write stay as they are. */
    reset() {
        this.d.fill(0);
        this.a.fill(0);
        this.pc = 0;
        this.sr = SR_S | 0x0700;
        this.usp = 0;
        this.ssp = 0;
        this.halted = 0;
        this.stopped = 0;
        this.cycles = 0;
    }

    ipl() { return (this.sr >> 8) & 7; }

    /* m68k_startup: SSP and PC from the reset vectors, through the bus. */
    startup() {
        const ssp = this.rl(0);
        this.ssp = ssp;
        this.a[7] = ssp;
        this.pc = this.rl(4);
    }

    /* ---------------------------------------------------------------- bus */

    rb(a) {
        const pg = (a >>> 16) & 0xFF;
        this.cycles += this.wmap[pg];
        const p = this.rmap[pg];
        if (p) return p[a & 0xFFFF];
        return this.read(a & 0xFFFFFF, 1) & 0xFF;
    }
    rw(a) {
        const pg = (a >>> 16) & 0xFF;
        this.cycles += this.wmap[pg];
        const p = this.rmap[pg], o = a & 0xFFFF;
        if (p && o <= 0xFFFE) return (p[o] << 8) | p[o + 1];
        return this.read(a & 0xFFFFFF, 2) & 0xFFFF;
    }
    rl(a) {
        const pg = (a >>> 16) & 0xFF;
        this.cycles += this.wmap[pg] * 2;
        const p = this.rmap[pg], o = a & 0xFFFF;
        if (p && o <= 0xFFFC) return ((p[o] << 24) | (p[o + 1] << 16) | (p[o + 2] << 8) | p[o + 3]) >>> 0;
        return this.read(a & 0xFFFFFF, 4) >>> 0;
    }
    wb(a, v) {
        this.cycles += this.wmap[(a >>> 16) & 0xFF];
        this.write(a & 0xFFFFFF, v & 0xFF, 1);
    }
    ww(a, v) {
        this.cycles += this.wmap[(a >>> 16) & 0xFF];
        this.write(a & 0xFFFFFF, v & 0xFFFF, 2);
    }
    wl(a, v) {
        this.cycles += this.wmap[(a >>> 16) & 0xFF] * 2;
        this.write(a & 0xFFFFFF, v >>> 0, 4);
    }
    rd(a, sz) { return sz === 1 ? this.rb(a) : sz === 2 ? this.rw(a) : this.rl(a); }
    wr(a, sz, v) {
        if (sz === 1) this.wb(a, v);
        else if (sz === 2) this.ww(a, v);
        else this.wl(a, v);
    }

    fetch() {
        const pc = this.pc;
        const w = this.rw(pc);
        this.pc = (pc + 2) >>> 0;
        return w;
    }
    fetchL() {
        const pc = this.pc;
        const v = this.rl(pc);
        this.pc = (pc + 4) >>> 0;
        return v;
    }
    /* a sign-extended word from the stream */
    fetchS() { return (this.fetch() << 16) >> 16; }

    pushL(v) { const sp = this.a[7] - 4; this.a[7] = sp; this.wl(sp, v); }
    popL() { const sp = this.a[7]; const v = this.rl(sp); this.a[7] = sp + 4; return v; }
    popW() { const sp = this.a[7]; const v = this.rw(sp); this.a[7] = sp + 2; return v; }

    dnWrite(n, v, sz) {
        const d = this.d;
        if (sz === 1) d[n] = (d[n] & ~0xFF) | (v & 0xFF);
        else if (sz === 2) d[n] = (d[n] & ~0xFFFF) | (v & 0xFFFF);
        else d[n] = v;
    }

    /* (d8,base,Xn) */
    indexed(base, ext) {
        const xi = (ext >> 12) & 7;
        let xv = (ext & 0x8000) ? this.a[xi] : this.d[xi];
        if (!(ext & 0x0800)) xv = (xv << 16) >> 16;
        return (base + ((ext << 24) >> 24) + xv) | 0;
    }

    /* ---------------------------------------------------------------- flags */

    flagsLogic(r, sz) {
        let sr = this.sr & ~(SR_N | SR_Z | SR_V | SR_C);
        if ((r & szMask(sz)) === 0) sr |= SR_Z;
        if (r & szMsb(sz)) sr |= SR_N;
        this.sr = sr;
    }
    flagsAdd(dst, src, sz) {
        const mask = szMask(sz), msb = szMsb(sz);
        const u = ((dst & mask) >>> 0) + ((src & mask) >>> 0);
        const r = (u & mask) >>> 0;
        const carry = sz === 4 ? u > 0xFFFFFFFF : ((u >> (sz * 8)) & 1) !== 0;
        let sr = this.sr & ~(SR_N | SR_Z | SR_V | SR_C | SR_X);
        if (r === 0) sr |= SR_Z;
        if (r & msb) sr |= SR_N;
        if (~(dst ^ src) & (dst ^ r) & msb) sr |= SR_V;
        if (carry) sr |= SR_C | SR_X;
        this.sr = sr;
    }
    flagsAddx(dst, src, sz) {
        const mask = szMask(sz), msb = szMsb(sz);
        const u = ((dst & mask) >>> 0) + ((src & mask) >>> 0);
        const r = (u & mask) >>> 0;
        const carry = sz === 4 ? u > 0xFFFFFFFF : ((u >> (sz * 8)) & 1) !== 0;
        let sr = this.sr;
        if (r !== 0) sr &= ~SR_Z;
        sr &= ~(SR_N | SR_V | SR_C | SR_X);
        if (r & msb) sr |= SR_N;
        if (~(dst ^ src) & (dst ^ r) & msb) sr |= SR_V;
        if (carry) sr |= SR_C | SR_X;
        this.sr = sr;
    }
    flagsSub(dst, src, sz) {
        const mask = szMask(sz), msb = szMsb(sz);
        const md = (dst & mask) >>> 0, ms = (src & mask) >>> 0;
        const r = ((md - ms) & mask) >>> 0;
        let sr = this.sr & ~(SR_N | SR_Z | SR_V | SR_C | SR_X);
        if (r === 0) sr |= SR_Z;
        if (r & msb) sr |= SR_N;
        if ((dst ^ src) & (dst ^ r) & msb) sr |= SR_V;
        if (md < ms) sr |= SR_C | SR_X;
        this.sr = sr;
    }
    flagsSubx(dst, src, sz) {
        const mask = szMask(sz), msb = szMsb(sz);
        const md = (dst & mask) >>> 0, ms = (src & mask) >>> 0;
        const r = ((md - ms) & mask) >>> 0;
        let sr = this.sr;
        if (r !== 0) sr &= ~SR_Z;
        sr &= ~(SR_N | SR_V | SR_C | SR_X);
        if (r & msb) sr |= SR_N;
        if ((dst ^ src) & (dst ^ r) & msb) sr |= SR_V;
        if (md < ms) sr |= SR_C | SR_X;
        this.sr = sr;
    }
    flagsCmp(dst, src, sz) {
        const mask = szMask(sz), msb = szMsb(sz);
        const md = (dst & mask) >>> 0, ms = (src & mask) >>> 0;
        const r = ((md - ms) & mask) >>> 0;
        let sr = this.sr & ~(SR_N | SR_Z | SR_V | SR_C);
        if (r === 0) sr |= SR_Z;
        if (r & msb) sr |= SR_N;
        if ((dst ^ src) & (dst ^ r) & msb) sr |= SR_V;
        if (md < ms) sr |= SR_C;
        this.sr = sr;
    }
    doNegx(src, sz) {
        const x = (this.sr & SR_X) ? 1 : 0;
        const mask = szMask(sz), msb = szMsb(sz);
        const ms = (src & mask) >>> 0;
        const r = ((0 - ms - x) & mask) >>> 0;
        let sr = this.sr;
        if (r !== 0) sr &= ~SR_Z;
        sr &= ~(SR_N | SR_V | SR_C | SR_X);
        if (r & msb) sr |= SR_N;
        if ((src & msb) !== 0 && (r & msb) !== 0) sr |= SR_V;
        if (ms + x > 0) sr |= SR_C | SR_X;
        this.sr = sr;
        return r;
    }

    /* ---------------------------------------------------------------- shifts */

    /* N and Z from v, C and X from last when cnt > 0, V from ov */
    shiftFlags(v, sz, cnt, last, ov) {
        let sr = this.sr & ~(SR_N | SR_Z | SR_V | SR_C | SR_X);
        if (v === 0) sr |= SR_Z;
        if (v & szMsb(sz)) sr |= SR_N;
        if (ov) sr |= SR_V;
        if (cnt > 0 && last) sr |= SR_C | SR_X;
        this.sr = sr;
    }
    doLsl(v, cnt, sz) {
        const mask = szMask(sz), bits = sz * 8;
        v = (v & mask) >>> 0;
        let last = 0;
        if (cnt > 0) {
            last = cnt <= bits ? (v >>> (bits - cnt)) & 1 : 0;
            v = cnt >= bits ? 0 : ((v << cnt) & mask) >>> 0;
        }
        this.shiftFlags(v, sz, cnt, last, 0);
        return v;
    }
    doLsr(v, cnt, sz) {
        const mask = szMask(sz), bits = sz * 8;
        v = (v & mask) >>> 0;
        let last = 0;
        if (cnt > 0) {
            last = cnt <= bits ? (v >>> (cnt - 1)) & 1 : 0;
            v = cnt >= bits ? 0 : v >>> cnt;
        }
        this.shiftFlags(v, sz, cnt, last, 0);
        return v;
    }
    doAsl(v, cnt, sz) {
        const mask = szMask(sz), msb = szMsb(sz);
        v = (v & mask) >>> 0;
        let ov = 0, last = 0;
        for (let i = 0; i < cnt; i++) {
            last = (v & msb) !== 0 ? 1 : 0;
            v = ((v << 1) & mask) >>> 0;
            if (((v & msb) !== 0 ? 1 : 0) !== last) ov = 1;
        }
        this.shiftFlags(v, sz, cnt, last, ov);
        return v;
    }
    doAsr(v, cnt, sz) {
        const mask = szMask(sz), msb = szMsb(sz), bits = sz * 8;
        v = (v & mask) >>> 0;
        const sign = (v & msb) !== 0 ? 1 : 0;
        let last = 0;
        if (cnt > 0) {
            last = cnt <= bits ? (v >>> (cnt - 1)) & 1 : sign;
            if (cnt >= bits) v = sign ? mask >>> 0 : 0;
            else {
                v >>>= cnt;
                if (sign) v |= mask << (bits - cnt);
                v = (v & mask) >>> 0;
            }
        }
        this.shiftFlags(v, sz, cnt, last, 0);
        return v;
    }
    doRol(v, cnt, sz) {
        const mask = szMask(sz), msb = szMsb(sz), bits = sz * 8;
        v = (v & mask) >>> 0;
        cnt &= bits - 1;
        if (cnt) v = (((v << cnt) | (v >>> (bits - cnt))) & mask) >>> 0;
        let sr = this.sr & ~(SR_N | SR_Z | SR_V | SR_C);
        if (v === 0) sr |= SR_Z;
        if (v & msb) sr |= SR_N;
        if (v & 1) sr |= SR_C;
        this.sr = sr;
        return v;
    }
    doRor(v, cnt, sz) {
        const mask = szMask(sz), msb = szMsb(sz), bits = sz * 8;
        v = (v & mask) >>> 0;
        cnt &= bits - 1;
        if (cnt) v = (((v >>> cnt) | (v << (bits - cnt))) & mask) >>> 0;
        let sr = this.sr & ~(SR_N | SR_Z | SR_V | SR_C);
        if (v === 0) sr |= SR_Z;
        if (v & msb) sr |= SR_N | SR_C;
        this.sr = sr;
        return v;
    }
    doRoxl(v, cnt, sz) {
        const mask = szMask(sz), msb = szMsb(sz);
        v = (v & mask) >>> 0;
        let x = (this.sr & SR_X) ? 1 : 0, last = x;
        for (let i = 0; i < cnt; i++) {
            last = (v & msb) !== 0 ? 1 : 0;
            v = (((v << 1) | x) & mask) >>> 0;
            x = last;
        }
        this.shiftFlags(v, sz, cnt, last, 0);
        return v;
    }
    doRoxr(v, cnt, sz) {
        const mask = szMask(sz), bits = sz * 8;
        v = (v & mask) >>> 0;
        let x = (this.sr & SR_X) ? 1 : 0, last = x;
        for (let i = 0; i < cnt; i++) {
            last = v & 1;
            v = (((v >>> 1) | (x << (bits - 1))) & mask) >>> 0;
            x = last;
        }
        this.shiftFlags(v, sz, cnt, last, 0);
        return v;
    }

    /* ---------------------------------------------------------------- effective addresses */

    eaRead(mode, reg, sz) {
        let a;
        switch (mode) {
        case 0: return cut(this.d[reg], sz);
        case 1: return sz === 2 ? ((this.a[reg] << 16) >> 16) >>> 0 : this.a[reg] >>> 0;
        case 2: a = this.a[reg]; break;
        case 3: a = this.a[reg]; this.a[reg] = a + step(sz, reg); break;
        case 4: a = this.a[reg] - step(sz, reg); this.a[reg] = a; break;
        case 5: { const d16 = this.fetchS(); a = this.a[reg] + d16; break; }
        case 6: { const ext = this.fetch(); a = this.indexed(this.a[reg], ext); break; }
        default:
            switch (reg) {
            case 0: a = this.fetchS(); break;
            case 1: a = this.fetchL(); break;
            case 2: { const b = this.pc; a = b + this.fetchS(); break; }
            case 3: { const b = this.pc; const ext = this.fetch(); a = this.indexed(b, ext); break; }
            case 4:
                if (sz === 1) return this.fetch() & 0xFF;
                if (sz === 2) return this.fetch();
                return this.fetchL();
            default: return 0;
            }
        }
        return this.rd(a, sz);
    }

    eaWrite(mode, reg, sz, val) {
        let a;
        switch (mode) {
        case 0: this.dnWrite(reg, val, sz); return;
        case 1: this.a[reg] = sz === 2 ? (val << 16) >> 16 : val; return;
        case 2: a = this.a[reg]; break;
        case 3: a = this.a[reg]; this.a[reg] = a + step(sz, reg); break;
        case 4: a = this.a[reg] - step(sz, reg); this.a[reg] = a; break;
        case 5: { const d16 = this.fetchS(); a = this.a[reg] + d16; break; }
        case 6: { const ext = this.fetch(); a = this.indexed(this.a[reg], ext); break; }
        default:
            if (reg === 0) a = this.fetchS();
            else if (reg === 1) a = this.fetchL();
            else return;
        }
        this.wr(a, sz, val);
    }

    /* m68k_rmr: decode once, read, leave the address in this.ea */
    rmr(mode, reg, sz) {
        let a;
        switch (mode) {
        case 0: this.ea = 0; return cut(this.d[reg], sz);
        case 1: this.ea = 1; return sz === 2 ? ((this.a[reg] << 16) >> 16) >>> 0 : this.a[reg] >>> 0;
        case 2: a = this.a[reg]; break;
        case 3: a = this.a[reg]; this.a[reg] = a + step(sz, reg); break;
        case 4: a = this.a[reg] - step(sz, reg); this.a[reg] = a; break;
        case 5: { const d16 = this.fetchS(); a = this.a[reg] + d16; break; }
        case 6: { const ext = this.fetch(); a = this.indexed(this.a[reg], ext); break; }
        default:
            switch (reg) {
            case 0: a = this.fetchS(); break;
            case 1: a = this.fetchL(); break;
            case 2: { const b = this.pc; a = b + this.fetchS(); break; }
            case 3: { const b = this.pc; const ext = this.fetch(); a = this.indexed(b, ext); break; }
            default: this.ea = 0; return 0;
            }
        }
        this.ea = a;
        return this.rd(a, sz);
    }
    rmw(mode, reg, sz, a, val) {
        if (mode === 0) { this.dnWrite(reg, val, sz); return; }
        if (mode === 1) { this.a[reg] = sz === 2 ? (val << 16) >> 16 : val; return; }
        this.wr(a, sz, val);
    }
    rmwW(mode, reg, sz, val) {
        if (mode < 2) { this.eaWrite(mode, reg, sz, val); return; }
        this.rmr(mode, reg, sz);
        this.rmw(mode, reg, sz, this.ea, val);
    }

    eaAddr(mode, reg) {
        switch (mode) {
        case 2: case 3: case 4: return this.a[reg];
        case 5: { const d16 = this.fetchS(); return (this.a[reg] + d16) | 0; }
        case 6: { const ext = this.fetch(); return this.indexed(this.a[reg], ext); }
        case 7:
            switch (reg) {
            case 0: return this.fetchS();
            case 1: return this.fetchL() | 0;
            case 2: { const b = this.pc; return (b + this.fetchS()) | 0; }
            case 3: { const b = this.pc; const ext = this.fetch(); return this.indexed(b, ext); }
            }
        }
        return 0;
    }

    leaveSupervisor() {
        if (this.sr & SR_S) {
            this.ssp = this.a[7] >>> 0;
            this.a[7] = this.usp;
            this.sr &= ~SR_S;
        }
    }

    /* ---------------------------------------------------------------- BCD */

    bcdFlags(pre, res, carry) {
        res &= 0xFF;
        let sr = this.sr & ~(SR_N | SR_V | SR_C | SR_X);
        if (carry) sr |= SR_C | SR_X;
        if (~pre & res & 0x80) sr |= SR_V;
        if (res & 0x80) sr |= SR_N;
        if (res) sr &= ~SR_Z;
        this.sr = sr;
        return res;
    }
    abcd(src, dst) {
        let res = (src & 0x0F) + (dst & 0x0F) + ((this.sr & SR_X) ? 1 : 0);
        const pre = res;
        if (res > 9) res += 6;
        res += (src & 0xF0) + (dst & 0xF0);
        const carry = res > 0x99;
        if (carry) res -= 0xA0;
        return this.bcdFlags(pre, res, carry);
    }
    sbcd(src, dst) {
        /* uint32 arithmetic: a borrow wraps, and the compares are unsigned */
        let res = ((dst & 0x0F) - (src & 0x0F) - ((this.sr & SR_X) ? 1 : 0)) >>> 0;
        const pre = res;
        if (res > 9) res = (res - 6) >>> 0;
        res = (res + (dst & 0xF0) - (src & 0xF0)) >>> 0;
        const carry = res > 0x99;
        if (carry) res = (res + 0xA0) >>> 0;
        return this.bcdFlags(pre, res, carry);
    }
    opXbcd(op, add) {
        const rx = (op >> 9) & 7, ry = op & 7;
        if (!(op & 0x0008)) {
            const src = this.d[ry] & 0xFF, dst = this.d[rx] & 0xFF;
            this.dnWrite(rx, add ? this.abcd(src, dst) : this.sbcd(src, dst), 1);
            return;
        }
        this.a[ry] -= ry === 7 ? 2 : 1;
        const src = this.rb(this.a[ry]);
        this.a[rx] -= rx === 7 ? 2 : 1;
        const dst = this.rb(this.a[rx]);
        this.wb(this.a[rx], add ? this.abcd(src, dst) : this.sbcd(src, dst));
    }

    /* ---------------------------------------------------------------- interrupt */

    /* m68k_interrupt: level 1-7 (7 is never masked); true if taken. */
    interrupt(level) {
        const curIpl = (this.sr >> 8) & 7;
        if (level !== 7 && level <= curIpl) return false;
        const handler = this.rl((24 + level) * 4);
        if (!handler || handler === 0xFFFFFFFF) return false;
        const oldSr = this.sr, oldPc = this.pc;
        let sr = (oldSr | SR_S) & ~(SR_T1 | SR_T0);
        this.sr = ((sr & ~SR_IPL) | (level << 8)) & 0xFFFF;
        if (!(oldSr & SR_S)) {
            this.usp = this.a[7] >>> 0;
            this.a[7] = this.ssp;
        }
        let sp = this.a[7] - 4; this.a[7] = sp; this.wl(sp, oldPc);
        sp = this.a[7] - 2; this.a[7] = sp; this.ww(sp, oldSr);
        this.pc = handler;
        this.stopped = 0;
        this.halted = 0;
        this.cycles += 48;
        return true;
    }

    /* ---------------------------------------------------------------- one instruction */

    stepCore() {
        if (this.halted || this.stopped) return;
        const opPc = this.pc;
        const op = this.fetch();
        this.cycles += TIME[op];

        switch (FAST[op]) {
        case F_NONE: break;
        case F_JMP_PCD16: { const b = this.pc; this.pc = (b + this.fetchS()) >>> 0; return; }
        case F_BRA_W: { const d16 = this.fetchS(); this.pc = (opPc + 2 + d16) >>> 0; return; }
        case F_BRA_B: this.pc = (opPc + 2 + ((op << 24) >> 24)) >>> 0; return;
        case F_BCC_W: {
            const d16 = this.fetchS();
            if (testCC(this.sr, op >> 8)) { this.pc = (opPc + 2 + d16) >>> 0; this.cycles -= 2; }
            return;
        }
        case F_BCC_B:
            if (testCC(this.sr, op >> 8)) { this.pc = (opPc + 2 + ((op << 24) >> 24)) >>> 0; this.cycles += 2; }
            return;
        case F_MOVEB_AI_DN: {
            const v = this.rb(this.a[op & 7]);
            const n = (op >> 9) & 7;
            this.d[n] = (this.d[n] & ~0xFF) | v;
            this.flagsLogic(v, 1);
            return;
        }
        case F_MOVEB_D16_D16: {
            const ds = this.fetchS();
            const v = this.rb(this.a[op & 7] + ds);
            const dd = this.fetchS();
            this.wb(this.a[(op >> 9) & 7] + dd, v);
            this.flagsLogic(v, 1);
            return;
        }
        case F_ADDAW_IMM: { const n = (op >> 9) & 7; this.a[n] += this.fetchS(); return; }
        case F_RORL_IMM: {
            const cnt = ((op >> 9) & 7) || 8;
            this.cycles += 2 * cnt;
            this.d[op & 7] = this.doRor(this.d[op & 7], cnt, 4);
            return;
        }
        }

        switch (op >> 12) {
        case 0x0: this.grp0(op); break;
        case 0x1: this.move(op, 1); break;
        case 0x2: this.move(op, 4); break;
        case 0x3: this.move(op, 2); break;
        case 0x4: this.grp4(op); break;
        case 0x5: this.grp5(op, opPc); break;
        case 0x6: this.grp6(op, opPc); break;
        case 0x7:
            if (!(op & 0x0100)) {
                const v = (op << 24) >> 24;
                this.d[(op >> 9) & 7] = v;
                this.flagsLogic(v, 4);
            }
            break;
        case 0x8: this.grp8(op); break;
        case 0x9: this.grp9(op); break;
        case 0xB: this.grpB(op); break;
        case 0xC: this.grpC(op); break;
        case 0xD: this.grpD(op); break;
        case 0xE: this.grpE(op); break;
        default: break;                     /* line A, line F: their table time only */
        }
    }

    /* groups 1/2/3: MOVE.B / MOVE.L / MOVE.W, MOVEA */
    move(op, sz) {
        const v = this.eaRead((op >> 3) & 7, op & 7, sz);
        const dstR = (op >> 9) & 7, dstM = (op >> 6) & 7;
        if (dstM === 1) {
            this.a[dstR] = sz === 2 ? (v << 16) >> 16 : v;
        } else {
            this.eaWrite(dstM, dstR, sz, v);
            this.flagsLogic(v, sz);
        }
    }

    /* group 0: immediates and bit operations */
    grp0(op) {
        const sub = (op >> 8) & 0xF;
        const mode = (op >> 3) & 7, reg = op & 7;
        const szb = (op >> 6) & 3;
        const isz = szb === 0 ? 1 : szb === 1 ? 2 : 4;

        switch (sub) {
        case 0x0: {                                         /* ORI */
            if (szb === 3) {
                if (!(this.sr & SR_S)) return;
                this.sr |= this.fetch();
                return;
            }
            const imm = this.eaRead(7, 4, isz);
            if (szb === 0 && mode === 7 && reg === 4) { this.sr |= imm & SR_CCR; return; }
            const dst = this.rmr(mode, reg, isz);
            const r = (dst | imm) >>> 0;
            this.rmw(mode, reg, isz, this.ea, r);
            this.flagsLogic(r, isz);
            return;
        }
        case 0x2: {                                         /* ANDI */
            if (szb === 3) {
                if (!(this.sr & SR_S)) return;
                const imm = this.fetch();
                const old = this.sr;
                this.sr &= imm;
                if ((old & SR_S) && !(this.sr & SR_S)) this.leaveSupervisor();
                return;
            }
            const imm = this.eaRead(7, 4, isz);
            if (szb === 0 && mode === 7 && reg === 4) { this.sr &= ~(~imm & SR_CCR); return; }
            const dst = this.rmr(mode, reg, isz);
            const r = (dst & imm) >>> 0;
            this.rmw(mode, reg, isz, this.ea, r);
            this.flagsLogic(r, isz);
            return;
        }
        case 0x4: {                                         /* SUBI */
            if (szb === 3) return;
            const imm = this.eaRead(7, 4, isz);
            const dst = this.rmr(mode, reg, isz);
            const r = cut(dst - imm, isz);
            this.rmw(mode, reg, isz, this.ea, r);
            this.flagsSub(dst, imm, isz);
            return;
        }
        case 0x6: {                                         /* ADDI */
            if (szb === 3) return;
            const imm = this.eaRead(7, 4, isz);
            const dst = this.rmr(mode, reg, isz);
            const r = cut(dst + imm, isz);
            this.rmw(mode, reg, isz, this.ea, r);
            this.flagsAdd(dst, imm, isz);
            return;
        }
        case 0xA: {                                         /* EORI */
            if (szb === 3) {
                if (!(this.sr & SR_S)) return;
                this.sr ^= this.fetch();
                return;
            }
            const imm = this.eaRead(7, 4, isz);
            if (szb === 0 && mode === 7 && reg === 4) { this.sr ^= imm & SR_CCR; return; }
            const dst = this.rmr(mode, reg, isz);
            const r = (dst ^ imm) >>> 0;
            this.rmw(mode, reg, isz, this.ea, r);
            this.flagsLogic(r, isz);
            return;
        }
        case 0xC: {                                         /* CMPI */
            if (szb === 3) return;
            const imm = this.eaRead(7, 4, isz);
            const dst = this.eaRead(mode, reg, isz);
            this.flagsCmp(dst, imm, isz);
            return;
        }
        }
        /* BTST / BCHG / BCLR / BSET, register (0000 Dn 1 xx ea) or immediate (0000 1000 xx ea) */
        let bitNum;
        if (op & 0x0100) bitNum = this.d[(op >> 9) & 7] & (mode === 0 ? 31 : 7);
        else if ((op & 0x0F00) === 0x0800) bitNum = this.fetch() & (mode === 0 ? 31 : 7);
        else return;
        const bitOp = szb;
        if (mode === 0) {
            const mask2 = 1 << bitNum;
            const v = this.d[reg];
            this.sr = (v & mask2) ? (this.sr & ~SR_Z) : (this.sr | SR_Z);
            if (bitOp === 1) this.d[reg] ^= mask2;
            else if (bitOp === 2) this.d[reg] &= ~mask2;
            else if (bitOp === 3) this.d[reg] |= mask2;
        } else {
            const mask2 = 1 << (bitNum & 7);
            const a = this.eaAddr(mode, reg);
            const bv = this.rb(a);
            this.sr = (bv & mask2) ? (this.sr & ~SR_Z) : (this.sr | SR_Z);
            if (bitOp === 1) this.wb(a, bv ^ mask2);
            else if (bitOp === 2) this.wb(a, bv & ~mask2);
            else if (bitOp === 3) this.wb(a, bv | mask2);
        }
    }

    /* group 4: miscellaneous, in the C's order of tests */
    grp4(op) {
        const mode = (op >> 3) & 7, reg = op & 7;

        /* m68k_op_grp4_misc: NBCD, TAS, CHK */
        if ((op & 0xFFC0) === 0x4800 && mode !== 1) {       /* NBCD */
            const dst = this.rmr(mode, reg, 1);
            const a = this.ea;
            this.rmw(mode, reg, 1, a, this.sbcd(dst, 0));
            return;
        }
        if ((op & 0xFFC0) === 0x4AC0 && mode !== 1 && op !== 0x4AFC) {   /* TAS */
            const v = this.rmr(mode, reg, 1);
            const a = this.ea;
            this.flagsLogic(v, 1);
            this.rmw(mode, reg, 1, a, v | 0x80);
            return;
        }
        if ((op & 0xF1C0) === 0x4180 && mode !== 1) {       /* CHK.W, no trap */
            const bound = (this.eaRead(mode, reg, 2) << 16) >> 16;
            const v = (this.d[(op >> 9) & 7] << 16) >> 16;
            if (v < 0 || v > bound) {
                if (v < 0) this.sr |= SR_N; else this.sr &= ~SR_N;
            }
            return;
        }

        switch (op) {
        case 0x4E71: return;                                /* NOP */
        case 0x4E70: return;                                /* RESET */
        case 0x4E73:                                        /* RTE */
            if (!(this.sr & SR_S)) return;
            this.sr = this.popW();
            this.pc = this.popL();
            if (!(this.sr & SR_S)) this.leaveSupervisor();
            return;
        case 0x4E75: this.pc = this.popL(); return;         /* RTS */
        case 0x4E77: {                                      /* RTR */
            const w = this.popW();
            this.sr = (this.sr & ~SR_CCR) | (w & SR_CCR);
            this.pc = this.popL();
            return;
        }
        case 0x4E72:                                        /* STOP #imm */
            if (!(this.sr & SR_S)) return;
            this.sr = this.fetch();
            if (!(this.sr & SR_S)) this.leaveSupervisor();
            this.stopped = 1;
            return;
        case 0x4AFC: case 0x4E74:                           /* ILLEGAL, RTD */
            this.halted = 1;
            return;
        case 0x4E76: return;                                /* TRAPV, no trap */
        }
        if ((op & 0xFFF0) === 0x4E40) return;               /* TRAP #n, no trap */
        if ((op & 0xFFF8) === 0x4E50) {                     /* LINK */
            const d16 = this.fetchS();
            this.pushL(this.a[reg]);
            this.a[reg] = this.a[7];
            this.a[7] += d16;
            return;
        }
        if ((op & 0xFFF8) === 0x4E58) {                     /* UNLK */
            this.a[7] = this.a[reg];
            this.a[reg] = this.popL();
            return;
        }
        if ((op & 0xFFF0) === 0x4E60) {                     /* MOVE USP */
            if (!(this.sr & SR_S)) return;
            if (op & 8) this.a[reg] = this.usp;
            else this.usp = this.a[reg] >>> 0;
            return;
        }
        if ((op & 0xFFC0) === 0x4EC0) { this.pc = this.eaAddr(mode, reg) >>> 0; return; }   /* JMP */
        if ((op & 0xFFC0) === 0x4E80) {                     /* JSR */
            const dest = this.eaAddr(mode, reg);
            this.pushL(this.pc);
            this.pc = dest >>> 0;
            return;
        }
        if ((op & 0xFFC0) === 0x40C0) {                     /* MOVE from SR */
            if (!(this.sr & SR_S)) return;
            this.eaWrite(mode, reg, 2, this.sr);
            return;
        }
        if ((op & 0xFFC0) === 0x42C0) { this.eaWrite(mode, reg, 2, this.sr & SR_CCR); return; }   /* MOVE from CCR */
        if ((op & 0xFFC0) === 0x44C0) {                     /* MOVE to CCR */
            const v = this.eaRead(mode, reg, 2);
            this.sr = (this.sr & ~SR_CCR) | (v & SR_CCR);
            return;
        }
        if ((op & 0xFFC0) === 0x46C0) {                     /* MOVE to SR */
            if (!(this.sr & SR_S)) return;
            const v = this.eaRead(mode, reg, 2) & 0xFFFF;
            const old = this.sr;
            this.sr = v;
            if ((old & SR_S) && !(v & SR_S)) this.leaveSupervisor();
            return;
        }
        if ((op & 0xFFC0) === 0x4840 && mode >= 2) { this.pushL(this.eaAddr(mode, reg)); return; }   /* PEA */
        if ((op & 0xFEB8) === 0x4880) {                     /* EXT */
            if (!(op & 0x0040)) {
                const v = (this.d[reg] & ~0xFFFF) | (((this.d[reg] << 24) >> 24) & 0xFFFF);
                this.d[reg] = v;
                this.flagsLogic(v, 2);
            } else {
                const v = (this.d[reg] << 16) >> 16;
                this.d[reg] = v;
                this.flagsLogic(v, 4);
            }
            return;
        }
        if ((op & 0xFFF8) === 0x4840) {                     /* SWAP */
            const v = this.d[reg];
            const r = (v >>> 16) | (v << 16);
            this.d[reg] = r;
            this.flagsLogic(r, 4);
            return;
        }
        if ((op & 0xFB80) === 0x4880 && mode >= 2) { this.movem(op, mode, reg); return; }

        /* NEGX / CLR / NEG / NOT / TST */
        const szb = (op >> 6) & 3;
        if (szb !== 3) {
            const isz = szb === 0 ? 1 : szb === 1 ? 2 : 4;
            const hi2 = (op >> 10) & 3, lo2 = (op >> 8) & 3;
            if (hi2 === 0 && lo2 === 0) {                   /* NEGX */
                const src = this.rmr(mode, reg, isz);
                const a = this.ea;
                this.sr |= SR_Z;
                const r = this.doNegx(src, isz);
                this.rmw(mode, reg, isz, a, r);
                return;
            }
            if (hi2 === 0 && lo2 === 2) {                   /* CLR */
                this.rmwW(mode, reg, isz, 0);
                this.sr = (this.sr & ~(SR_N | SR_V | SR_C)) | SR_Z;
                return;
            }
            if (hi2 === 1 && lo2 === 0) {                   /* NEG */
                const src = this.rmr(mode, reg, isz);
                const a = this.ea;
                const r = cut(-src, isz);
                this.rmw(mode, reg, isz, a, r);
                this.flagsSub(0, src, isz);
                if (src & szMask(isz)) this.sr |= SR_C | SR_X;
                else this.sr &= ~(SR_C | SR_X);
                return;
            }
            if (hi2 === 1 && lo2 === 2) {                   /* NOT */
                const src = this.rmr(mode, reg, isz);
                const a = this.ea;
                const r = cut(~src, isz);
                this.rmw(mode, reg, isz, a, r);
                this.flagsLogic(r, isz);
                return;
            }
            if (hi2 === 2 && lo2 === 2) {                   /* TST */
                const src = this.eaRead(mode, reg, isz);
                this.flagsLogic(src, isz);
                return;
            }
        }
        if ((op & 0xF1C0) === 0x41C0) { this.a[(op >> 9) & 7] = this.eaAddr(mode, reg); return; }   /* LEA */
        if ((op & 0xFFC0) === 0x4840 && mode >= 2) { this.pushL(this.eaAddr(mode, reg)); return; }   /* PEA */
    }

    movem(op, mode, reg) {
        const toRegs = (op >> 10) & 1;
        const isLong = (op >> 6) & 1;
        const isz = isLong ? 4 : 2;
        const list = this.fetch();
        for (let b = list; b; b &= b - 1) this.cycles += isLong ? 8 : 4;
        const d = this.d, a = this.a;
        if (!toRegs) {
            if (mode === 4) {
                for (let i = 0; i < 16; i++) {
                    if (list & (1 << i)) {
                        const rv = i < 8 ? a[7 - i] : d[15 - i];
                        if (isz === 2) { a[reg] -= 2; this.ww(a[reg], rv); }
                        else { a[reg] -= 4; this.wl(a[reg], rv); }
                    }
                }
            } else {
                let p = this.eaAddr(mode, reg);
                for (let i = 0; i < 16; i++) {
                    if (list & (1 << i)) {
                        const rv = i < 8 ? d[i] : a[i - 8];
                        if (isz === 2) { this.ww(p, rv); p = (p + 2) | 0; }
                        else { this.wl(p, rv); p = (p + 4) | 0; }
                    }
                }
            }
        } else {
            let p = this.eaAddr(mode, reg);
            for (let i = 0; i < 16; i++) {
                if (list & (1 << i)) {
                    const v = isz === 2 ? (this.rw(p) << 16) >> 16 : this.rl(p);
                    if (i < 8) d[i] = v; else a[i - 8] = v;
                    p = (p + isz) | 0;
                }
            }
            if (mode === 3) a[reg] = p;
        }
    }

    /* group 5: ADDQ / SUBQ / Scc / DBcc */
    grp5(op, opPc) {
        const mode = (op >> 3) & 7, reg = op & 7;
        const szb = (op >> 6) & 3;
        const data8 = ((op >> 9) & 7) || 8;
        if (szb === 3) {
            const cc = (op >> 8) & 0xF;
            if (mode === 1) {                               /* DBcc */
                const d16 = this.fetchS();
                if (!testCC(this.sr, cc)) {
                    const cnt = (this.d[reg] - 1) & 0xFFFF;
                    this.d[reg] = (this.d[reg] & ~0xFFFF) | cnt;
                    if (cnt !== 0xFFFF) { this.pc = (opPc + 2 + d16) >>> 0; this.cycles -= 2; }
                    else this.cycles += 2;
                }
                return;
            }
            const val = testCC(this.sr, cc) ? 0xFF : 0;     /* Scc */
            if (val && mode === 0) this.cycles += 2;
            this.rmwW(mode, reg, 1, val);
            return;
        }
        const isz = szb === 0 ? 1 : szb === 1 ? 2 : 4;
        if (mode === 1) {
            if (op & 0x0100) this.a[reg] -= data8;
            else this.a[reg] += data8;
            return;
        }
        const dst = this.rmr(mode, reg, isz);
        const a = this.ea;
        let r;
        if (op & 0x0100) { r = cut(dst - data8, isz); this.flagsSub(dst, data8, isz); }
        else { r = cut(dst + data8, isz); this.flagsAdd(dst, data8, isz); }
        this.rmw(mode, reg, isz, a, r);
    }

    /* group 6: Bcc / BRA / BSR (the forms the fast table leaves) */
    grp6(op, opPc) {
        const cc = (op >> 8) & 0xF;
        const disp = (op << 24) >> 24;
        let target;
        if (disp === 0) target = opPc + 2 + this.fetchS();
        else if (disp === -1) target = opPc + 2 + (this.fetchL() | 0);
        else target = opPc + 2 + disp;
        target >>>= 0;
        if (cc === 1) {
            this.pushL(this.pc);
            this.pc = target;
        } else if (cc === 0 || testCC(this.sr, cc)) {
            this.pc = target;
            if (cc) this.cycles += disp === 0 ? -2 : 2;
        }
    }

    /* group 8: OR / DIVU / DIVS / SBCD */
    grp8(op) {
        const dn = (op >> 9) & 7, dir = (op >> 8) & 1;
        const mode = (op >> 3) & 7, reg = op & 7;
        const szb = (op >> 6) & 3;
        if (szb === 3) {
            if (!dir) {                                     /* DIVU.W */
                const divisor = this.eaRead(mode, reg, 2) & 0xFFFF;
                if (!divisor) return;
                const dd = this.d[dn] >>> 0;
                this.cycles += divuCycles(dd, divisor) - 140;
                const rem = dd % divisor, q = (dd - rem) / divisor;
                if (q > 0xFFFF) {
                    this.sr = (this.sr | SR_V | SR_N) & ~(SR_Z | SR_C);
                } else {
                    this.d[dn] = (rem << 16) | q;
                    this.flagsLogic(q, 2);
                }
            } else {                                        /* DIVS.W */
                const divisor = (this.eaRead(mode, reg, 2) << 16) >> 16;
                if (!divisor) return;
                const dd = this.d[dn];
                this.cycles += divsCycles(dd, divisor) - 158;
                const rem = dd % divisor, q = (dd - rem) / divisor;
                if (q > 32767 || q < -32768) {
                    this.sr = (this.sr | SR_V | SR_N) & ~(SR_Z | SR_C);
                } else {
                    this.d[dn] = ((rem & 0xFFFF) << 16) | (q & 0xFFFF);
                    this.flagsLogic(q, 2);
                }
            }
            return;
        }
        if ((op & 0x01F0) === 0x0100) { this.opXbcd(op, 0); return; }   /* SBCD */
        const isz = szb === 0 ? 1 : szb === 1 ? 2 : 4;
        let r;
        if (!dir) {
            const src = this.eaRead(mode, reg, isz);
            r = cut(this.d[dn] | src, isz);
            this.dnWrite(dn, r, isz);
        } else {
            const dst = this.rmr(mode, reg, isz);
            r = cut(dst | this.d[dn], isz);
            this.rmw(mode, reg, isz, this.ea, r);
        }
        this.flagsLogic(r, isz);
    }

    /* group 9: SUB / SUBA / SUBX */
    grp9(op) {
        const dn = (op >> 9) & 7, dir = (op >> 8) & 1;
        const mode = (op >> 3) & 7, reg = op & 7;
        const szb = (op >> 6) & 3;
        if (szb === 3) {                                    /* SUBA */
            const isz = dir ? 4 : 2;
            const v = this.eaRead(mode, reg, isz);
            this.a[dn] -= isz === 2 ? (v << 16) >> 16 : v;
            return;
        }
        const isz = szb === 0 ? 1 : szb === 1 ? 2 : 4;
        if (dir && mode <= 1) {                             /* SUBX */
            let src, dst;
            if (mode === 0) { src = cut(this.d[reg], isz); dst = cut(this.d[dn], isz); }
            else {
                this.a[reg] -= step(isz, reg);
                src = this.rd(this.a[reg], isz);
                this.a[dn] -= step(isz, dn);
                dst = this.rd(this.a[dn], isz);
            }
            const x = (this.sr & SR_X) ? 1 : 0;
            const r = cut(dst - src - x, isz);
            if (mode === 0) this.dnWrite(dn, r, isz);
            else this.wr(this.a[dn], isz, r);
            this.flagsSubx(dst, (src + x) >>> 0, isz);
            return;
        }
        if (!dir) {
            const src = this.eaRead(mode, reg, isz);
            const dv = this.d[dn];
            const r = cut(dv - src, isz);
            this.flagsSub(dv, src, isz);
            this.dnWrite(dn, r, isz);
        } else {
            const src = cut(this.d[dn], isz);
            const dst = this.rmr(mode, reg, isz);
            const r = cut(dst - src, isz);
            this.flagsSub(dst, src, isz);
            this.rmw(mode, reg, isz, this.ea, r);
        }
    }

    /* group B: CMP / CMPA / CMPM / EOR */
    grpB(op) {
        const dn = (op >> 9) & 7, dir = (op >> 8) & 1;
        const mode = (op >> 3) & 7, reg = op & 7;
        const szb = (op >> 6) & 3;
        if (szb === 3) {                                    /* CMPA */
            const isz = dir ? 4 : 2;
            const v = this.eaRead(mode, reg, isz);
            this.flagsCmp(this.a[dn], isz === 2 ? (v << 16) >> 16 : v, 4);
            return;
        }
        const isz = szb === 0 ? 1 : szb === 1 ? 2 : 4;
        if (!dir) {
            const src = this.eaRead(mode, reg, isz);
            this.flagsCmp(this.d[dn], src, isz);
        } else if (mode === 1) {                            /* CMPM */
            const src = this.eaRead(3, reg, isz);
            const dst = this.eaRead(3, dn, isz);
            this.flagsCmp(dst, src, isz);
        } else {                                            /* EOR */
            const dst = this.rmr(mode, reg, isz);
            const r = (dst ^ cut(this.d[dn], isz)) >>> 0;
            this.rmw(mode, reg, isz, this.ea, r);
            this.flagsLogic(r, isz);
        }
    }

    /* group C: AND / MULU / MULS / ABCD / EXG */
    grpC(op) {
        const dn = (op >> 9) & 7, dir = (op >> 8) & 1;
        const mode = (op >> 3) & 7, reg = op & 7;
        const szb = (op >> 6) & 3;
        if (szb === 3) {
            if (!dir) {                                     /* MULU.W */
                const src = this.eaRead(mode, reg, 2) & 0xFFFF;
                for (let b = src; b; b &= b - 1) this.cycles += 2;
                const r = (this.d[dn] & 0xFFFF) * src;
                this.d[dn] = r;
                this.flagsLogic(r, 4);
            } else {                                        /* MULS.W */
                const src = (this.eaRead(mode, reg, 2) << 16) >> 16;
                for (let b = ((src << 1) ^ src) & 0xFFFF; b; b &= b - 1) this.cycles += 2;
                const r = Math.imul((this.d[dn] << 16) >> 16, src);
                this.d[dn] = r;
                this.flagsLogic(r, 4);
            }
            return;
        }
        if ((op & 0x01F0) === 0x0100) { this.opXbcd(op, 1); return; }   /* ABCD */
        if (dir && ((szb === 1 && mode <= 1) || (szb === 2 && mode === 1))) {   /* EXG */
            const X = (szb === 1 && mode === 1) ? this.a : this.d;
            const Y = mode === 1 ? this.a : this.d;
            const t = X[dn]; X[dn] = Y[reg]; Y[reg] = t;
            return;
        }
        const isz = szb === 0 ? 1 : szb === 1 ? 2 : 4;
        let r;
        if (!dir) {
            const src = this.eaRead(mode, reg, isz);
            r = cut(this.d[dn] & src, isz);
            this.dnWrite(dn, r, isz);
        } else {
            const v = this.rmr(mode, reg, isz);
            r = cut(v & this.d[dn], isz);
            this.rmw(mode, reg, isz, this.ea, r);
        }
        this.flagsLogic(r, isz);
    }

    /* group D: ADD / ADDA / ADDX */
    grpD(op) {
        const dn = (op >> 9) & 7, dir = (op >> 8) & 1;
        const mode = (op >> 3) & 7, reg = op & 7;
        const szb = (op >> 6) & 3;
        if (szb === 3) {                                    /* ADDA */
            const isz = dir ? 4 : 2;
            const v = this.eaRead(mode, reg, isz);
            this.a[dn] += isz === 2 ? (v << 16) >> 16 : v;
            return;
        }
        const isz = szb === 0 ? 1 : szb === 1 ? 2 : 4;
        if (dir && mode <= 1) {                             /* ADDX */
            let src, dst;
            if (mode === 0) { src = cut(this.d[reg], isz); dst = cut(this.d[dn], isz); }
            else {
                this.a[reg] -= step(isz, reg);
                src = this.rd(this.a[reg], isz);
                this.a[dn] -= step(isz, dn);
                dst = this.rd(this.a[dn], isz);
            }
            const x = (this.sr & SR_X) ? 1 : 0;
            const r = cut(dst + src + x, isz);
            if (mode === 0) this.dnWrite(dn, r, isz);
            else this.wr(this.a[dn], isz, r);
            this.flagsAddx(dst, (src + x) >>> 0, isz);
            return;
        }
        if (!dir) {
            const src = this.eaRead(mode, reg, isz);
            const dv = this.d[dn];
            const r = cut(dv + src, isz);
            this.flagsAdd(dv, src, isz);
            this.dnWrite(dn, r, isz);
        } else {
            const src = cut(this.d[dn], isz);
            const dst = this.rmr(mode, reg, isz);
            const r = cut(dst + src, isz);
            this.flagsAdd(dst, src, isz);
            this.rmw(mode, reg, isz, this.ea, r);
        }
    }

    /* group E: shifts and rotates */
    grpE(op) {
        const dir = (op >> 8) & 1;
        const mode = (op >> 3) & 7, reg = op & 7;
        const szb = (op >> 6) & 3;
        if (szb === 3) {                                    /* memory, one bit */
            const v = this.rmr(mode, reg, 2);
            const a = this.ea;
            let r;
            switch ((op >> 9) & 7) {
            case 0: r = dir ? this.doAsl(v, 1, 2) : this.doAsr(v, 1, 2); break;
            case 1: r = dir ? this.doLsl(v, 1, 2) : this.doLsr(v, 1, 2); break;
            case 2: r = dir ? this.doRoxl(v, 1, 2) : this.doRoxr(v, 1, 2); break;
            case 3: r = dir ? this.doRol(v, 1, 2) : this.doRor(v, 1, 2); break;
            default: r = v; break;
            }
            this.rmw(mode, reg, 2, a, r);
            return;
        }
        const isz = szb === 0 ? 1 : szb === 1 ? 2 : 4;
        const cnt = (op & 0x20) ? this.d[(op >> 9) & 7] & 63 : (((op >> 9) & 7) || 8);
        this.cycles += 2 * cnt;
        const v = cut(this.d[reg], isz);
        let r;
        switch ((op >> 3) & 3) {
        case 0: r = dir ? this.doAsl(v, cnt, isz) : this.doAsr(v, cnt, isz); break;
        case 1: r = dir ? this.doLsl(v, cnt, isz) : this.doLsr(v, cnt, isz); break;
        case 2: r = dir ? this.doRoxl(v, cnt, isz) : this.doRoxr(v, cnt, isz); break;
        default: r = dir ? this.doRol(v, cnt, isz) : this.doRor(v, cnt, isz); break;
        }
        this.dnWrite(reg, r, isz);
    }
}
