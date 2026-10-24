/*
 * sharc.js — an ADSP-21062 SHARC interpreter, for the Model 2B coprocessor.
 *
 * Model 2B puts a SHARC where Model 2A has the TGP, and some games (Last Bronx,
 * Virtual-On) upload a program of their own into it rather than use the one on
 * the board. To pose Last Bronx's fighters the explorer runs that program as
 * the board does: the i960's command words go in through a FIFO, the answers
 * come out of another, and the matrices land in buffer RAM. This module is
 * only the CPU; the caller wires the board in through `extRead` / `extWrite`
 * and the flag inputs.
 *
 * It is a word-for-word port of m2-hle2's src/board/sharc_cpu.h, itself a port
 * of MAME's interpreter (devices/cpu/sharc, BSD-3-Clause, Ville Linde), and it
 * computes the same bits: a differential test runs both on Last Bronx's
 * program. The quirks MAME has, sharc_cpu.h keeps and so does this:
 *   - the fixed-point multiplier sign-extends its "unsigned" operands;
 *   - the dual Fa = Fx + Fy, Fs = Fx - Fy of two infinities stores the
 *     integer pattern converted to float, not the pattern;
 *   - Rn = Rn OR LSHIFT Rx BY Ry shifts right arithmetically (the immediate
 *     form logically), and BIT TST ASTAT loses the BTF it sets;
 *   - MODE1.TRUNC only reaches FIX; the other float ops round to nearest.
 * Float maths is on IEEE single bits: a register is a u32, read as a float
 * through a shared Float32Array and stored back through it, so a double never
 * reaches a register. (A float32 sum or product taken in doubles and rounded
 * once is the correctly rounded float32 result.) Any NaN stores 0xFFFFFFFF.
 *
 * A fatal error in MAME (an unknown register, a stack over- or underflow, an
 * opcode it lacks) is a warning here and stops `run` with 'fault'. Not done,
 * as in the C: DMA transfers (a start warns), bit-reverse, the timer, link
 * ports.
 *
 * Memory, the 2-Mbit part:
 *   PM 0x20000-0x24FFF block 0; block 1 at 0x28000/0x30000/0x38000. A 48-bit
 *      PM word is two numbers here, hi (bits 32-47) and lo (bits 0-31).
 *   DM 0x00000-0x000FF IOP registers; 0x20000-0x27FFF block 0, block 1 at the
 *      mirrors; 0x40000-0x7FFFF the same blocks as short words (sign-extended
 *      when MODE1.SSE). DM at or above 0x80000 is the board's: Model 2B has
 *      FIFO in at 0x0400000, FIFO out at 0x0C00000, buffer RAM at 0x1400000
 *      (offset & 0x7FFF) and the copro_data ROM at 0x1C00000.
 *   FLAG0 is "FIFO in empty" and FLAG1 "FIFO out full": the board calls
 *   setFlagInput whenever they change, from inside its hooks too.
 *
 * Timing is synchronous: `run(max)` executes up to `max` instructions (one
 * cycle each) and stops early when the core blocks. An external access the
 * board refuses ('stall') is rolled back and retried by the next run; IDLE
 * waits for an interrupt; and a busy-wait ('spin') is an instruction that
 * leaves the core as it found it, a jump to itself (`if flag0_in jump (pc,0)`)
 * or a one-instruction DO UNTIL over a NOP. Only the board can end one.
 */

/* ASTAT */
const AZ = 0x1, AV = 0x2, AN = 0x4, AC = 0x8, AS = 0x10, AI = 0x20;
const MN = 0x40, MV = 0x80, MU = 0x100, MI = 0x200, AF = 0x400;
const SV = 0x800, SZ = 0x1000, SS = 0x2000, BTF = 0x40000;
const FLGS = 0x780000, FLG_SHIFT = 19;
/* STKY */
const AUS = 0x1, AVS = 0x2, AOS = 0x4, AIS = 0x20, MVS = 0x80, MUS = 0x100, MIS = 0x200;
const PCFL = 0x200000, PCEM = 0x400000, SSOV = 0x800000, SSEM = 0x1000000;
const LSOV = 0x2000000, LSEM = 0x4000000;
/* MODE1 */
const M1_BR8 = 0x1, M1_BR0 = 0x2, M1_SRCU = 0x4, M1_SRD1H = 0x8, M1_SRD1L = 0x10;
const M1_SRD2H = 0x20, M1_SRD2L = 0x40, M1_SRRFH = 0x80, M1_SRRFL = 0x400;
const M1_IRPTEN = 0x1000, M1_ALUSAT = 0x2000, M1_SSE = 0x4000, M1_TRUNC = 0x8000;
const M2_FLGO_SHIFT = 15;

const F_SIGN = 0x80000000, F_EXP = 0x7f800000, F_MANT = 0x007fffff;
const F_INF = 0x7f800000, F_NAN = 0xffffffff, F_MAXT = 0x7f7fffff;

const EXT_BASE = 0x80000;
const PCSTACK = 30, LSTACK = 6;

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const u2f = (u) => { u32[0] = u; return f32[0]; };
/* a value rounded to float32 -> its bits; any NaN is 0xFFFFFFFF */
const f2u = (f) => {
    if (f !== f) return F_NAN;
    f32[0] = f;
    return u32[0];
};

const sext = (v, n) => (n >= 32 ? v >>> 0 : ((v << (32 - n)) >> (32 - n)) >>> 0);
const mask = (n) => (n >= 32 ? 0xffffffff : ((1 << n) >>> 0) - 1);
const asr = (x, n) => ((x | 0) >> n) >>> 0;
/* std::rotl: a negative count rotates right */
function rotl(x, s) {
    const r = s % 32;
    if (r === 0) return x >>> 0;
    if (r > 0) return ((x << r) | (x >>> (32 - r))) >>> 0;
    return ((x >>> -r) | (x << (32 + r))) >>> 0;
}
/* a logical shift by a signed count, nothing left past 31 */
function lsh(x, s) {
    if (s < 0) return s > -32 ? x >>> -s : 0;
    return s < 32 ? (x << s) >>> 0 : 0;
}
/* nearbyintf: round to nearest, ties to even */
function roundEven(v) {
    const r = Math.round(v);
    return r - v === 0.5 && r % 2 !== 0 ? r - 1 : r;
}
const hex = (v, n) => (v >>> 0).toString(16).toUpperCase().padStart(n, '0');

/*
 * The 64-bit values of the fixed-point multiplier (MRF, MRB and its products)
 * are two u32 halves. These helpers leave their result in H and L.
 */
let H = 0, L = 0;
function umul32(a, b) {
    const al = a & 0xffff, ah = a >>> 16, bl = b & 0xffff, bh = b >>> 16;
    const mid = al * bh + ah * bl;
    const low = al * bl + (mid % 65536) * 65536;
    L = low >>> 0;
    H = (ah * bh + Math.floor(mid / 65536) + Math.floor(low / 4294967296)) >>> 0;
}
function smul32(a, b) {
    umul32(a >>> 0, b >>> 0);
    if (a & 0x80000000) H = (H - b) >>> 0;
    if (b & 0x80000000) H = (H - a) >>> 0;
}
function add64(h1, l1, h2, l2) {
    const l = l1 + l2;
    L = l >>> 0;
    H = (h1 + h2 + (l > 0xffffffff ? 1 : 0)) >>> 0;
}
function sub64(h1, l1, h2, l2) {
    const l = l1 - l2;
    L = l >>> 0;
    H = (h1 - h2 - (l < 0 ? 1 : 0)) >>> 0;
}
/* round a fractional MR to nearest (ties to even) at bit 32 */
function roundMr(h, l) {
    const tie = l === 0x80000000;
    add64(h, l, 0, 0x80000000);
    if (tie) { L = 0; H = (H & ~1) >>> 0; }
}

/* The seed tables of RECIPS and RSQRTS (MAME compute.hxx). */
const RECIPS_LUT = new Uint32Array([
    0x7f8000, 0x7e0000, 0x7c0000, 0x7a0000, 0x780000, 0x760000, 0x740000, 0x720000,
    0x700000, 0x6f0000, 0x6d0000, 0x6b0000, 0x6a0000, 0x680000, 0x660000, 0x650000,
    0x630000, 0x610000, 0x600000, 0x5e0000, 0x5d0000, 0x5b0000, 0x5a0000, 0x590000,
    0x570000, 0x560000, 0x540000, 0x530000, 0x520000, 0x500000, 0x4f0000, 0x4e0000,
    0x4c0000, 0x4b0000, 0x4a0000, 0x490000, 0x470000, 0x460000, 0x450000, 0x440000,
    0x430000, 0x410000, 0x400000, 0x3f0000, 0x3e0000, 0x3d0000, 0x3c0000, 0x3b0000,
    0x3a0000, 0x390000, 0x380000, 0x370000, 0x360000, 0x350000, 0x340000, 0x330000,
    0x320000, 0x310000, 0x300000, 0x2f0000, 0x2e0000, 0x2d0000, 0x2c0000, 0x2b0000,
    0x2a0000, 0x290000, 0x280000, 0x280000, 0x270000, 0x260000, 0x250000, 0x240000,
    0x230000, 0x230000, 0x220000, 0x210000, 0x200000, 0x1f0000, 0x1f0000, 0x1e0000,
    0x1d0000, 0x1c0000, 0x1c0000, 0x1b0000, 0x1a0000, 0x190000, 0x190000, 0x180000,
    0x170000, 0x170000, 0x160000, 0x150000, 0x140000, 0x140000, 0x130000, 0x120000,
    0x120000, 0x110000, 0x100000, 0x100000, 0x0f0000, 0x0f0000, 0x0e0000, 0x0d0000,
    0x0d0000, 0x0c0000, 0x0c0000, 0x0b0000, 0x0a0000, 0x0a0000, 0x090000, 0x090000,
    0x080000, 0x070000, 0x070000, 0x060000, 0x060000, 0x050000, 0x050000, 0x040000,
    0x040000, 0x030000, 0x030000, 0x020000, 0x020000, 0x010000, 0x010000, 0x000000,
]);
const RSQRTS_LUT = new Uint32Array([
    0x350000, 0x330000, 0x320000, 0x300000, 0x2f0000, 0x2e0000, 0x2d0000, 0x2b0000,
    0x2a0000, 0x290000, 0x280000, 0x270000, 0x260000, 0x250000, 0x230000, 0x220000,
    0x210000, 0x200000, 0x1f0000, 0x1e0000, 0x1e0000, 0x1d0000, 0x1c0000, 0x1b0000,
    0x1a0000, 0x190000, 0x180000, 0x170000, 0x160000, 0x160000, 0x150000, 0x140000,
    0x130000, 0x130000, 0x120000, 0x110000, 0x100000, 0x100000, 0x0f0000, 0x0e0000,
    0x0e0000, 0x0d0000, 0x0c0000, 0x0b0000, 0x0b0000, 0x0a0000, 0x0a0000, 0x090000,
    0x080000, 0x080000, 0x070000, 0x070000, 0x060000, 0x050000, 0x050000, 0x040000,
    0x040000, 0x030000, 0x030000, 0x020000, 0x020000, 0x010000, 0x010000, 0x000000,
    0x7f8000, 0x7e0000, 0x7c0000, 0x7a0000, 0x780000, 0x760000, 0x740000, 0x730000,
    0x710000, 0x6f0000, 0x6e0000, 0x6c0000, 0x6a0000, 0x690000, 0x670000, 0x660000,
    0x640000, 0x630000, 0x620000, 0x600000, 0x5f0000, 0x5e0000, 0x5c0000, 0x5b0000,
    0x5a0000, 0x590000, 0x570000, 0x560000, 0x550000, 0x540000, 0x530000, 0x520000,
    0x510000, 0x4f0000, 0x4e0000, 0x4d0000, 0x4c0000, 0x4b0000, 0x4a0000, 0x490000,
    0x480000, 0x470000, 0x460000, 0x450000, 0x450000, 0x440000, 0x430000, 0x420000,
    0x410000, 0x400000, 0x3f0000, 0x3e0000, 0x3e0000, 0x3d0000, 0x3c0000, 0x3b0000,
    0x3a0000, 0x3a0000, 0x390000, 0x380000, 0x370000, 0x370000, 0x360000, 0x350000,
]);

const isZero = (r) => (r & 0x7fffffff) === 0;
const isDoz = (r) => (r & F_EXP) === 0;
const isDenorm = (r) => (r & F_EXP) === 0 && (r & F_MANT) !== 0;
const emax = (r) => (r & F_EXP) === F_EXP;
const isNan = (r) => (r & F_EXP) === F_EXP && (r & F_MANT) !== 0;
const isInf = (r) => (r & 0x7fffffff) === F_INF;
const flush = (r) => ((r & F_EXP) === 0 ? r & F_SIGN : r);
const unbiased = (r) => ((r >>> 23) & 0xff) - 127;
const biased = (e) => (((e + 127) & 0xff) << 23) >>> 0;
const nanAdd = (a, b) => isNan(a) || isNan(b) || (emax(a) && emax(b) && ((a ^ b) & F_SIGN) !== 0);
const nanSub = (a, b) => isNan(a) || isNan(b) || (emax(a) && emax(b) && ((a ^ b) & F_SIGN) === 0);
const nanMul = (a, b) => (emax(a) && ((a & F_MANT) !== 0 || isZero(b))) ||
    (emax(b) && ((b & F_MANT) !== 0 || isZero(a)));

/*
 * The instruction groups, MAME's s_sharc_opcode_table: mask and bits on the
 * top nine bits of the opcode shifted to (index << 7).
 */
const OP_DM_PM = 1, OP_COMPUTE = 2, OP_UREG_DMPM = 3, OP_IMMMOD = 4, OP_UREG_UREG = 5;
const OP_SHIFT_DMPM = 6, OP_SHIFT = 7, OP_COMPUTE_MODIFY = 8, OP_DIRECT = 9;
const OP_INDIRECT = 10, OP_JUMP_DM = 11, OP_RTS = 12, OP_RTI = 13, OP_DO_COUNTER = 14;
const OP_DO_UNTIL = 15, OP_UREG_DIRECT = 16, OP_UREG_INDIRECT = 17, OP_IMM_DMPM = 18;
const OP_IMM_UREG = 19, OP_SYSREG_BITOP = 20, OP_MODIFY = 21, OP_PUSH_POP = 22;
const OP_NOP = 23, OP_IDLE = 24;
const OP_LIST = [
    [0xe000, 0x2000, OP_DM_PM], [0xff00, 0x0100, OP_COMPUTE],
    [0xe000, 0x4000, OP_UREG_DMPM], [0xf000, 0x6000, OP_IMMMOD],
    [0xf000, 0x7000, OP_UREG_UREG], [0xf000, 0x8000, OP_SHIFT_DMPM],
    [0xff00, 0x0200, OP_SHIFT], [0xff00, 0x0400, OP_COMPUTE_MODIFY],
    [0xff00, 0x0600, OP_DIRECT], [0xff00, 0x0700, OP_DIRECT],
    [0xff00, 0x0800, OP_INDIRECT], [0xff00, 0x0900, OP_INDIRECT],
    [0xe000, 0xc000, OP_JUMP_DM], [0xe000, 0xe000, OP_JUMP_DM],
    [0xff00, 0x0a00, OP_RTS], [0xff00, 0x0b00, OP_RTI],
    [0xfe00, 0x0c00, OP_DO_COUNTER], [0xff00, 0x0e00, OP_DO_UNTIL],
    [0xfc00, 0x1000, OP_UREG_DIRECT], [0xe000, 0xa000, OP_UREG_INDIRECT],
    [0xf000, 0x9000, OP_IMM_DMPM], [0xff00, 0x0f00, OP_IMM_UREG],
    [0xff00, 0x1400, OP_SYSREG_BITOP], [0xff80, 0x1600, OP_MODIFY],
    [0xff00, 0x1700, OP_PUSH_POP], [0xff80, 0x0000, OP_NOP],
    [0xff80, 0x0080, OP_IDLE],
];
const OPS = new Uint8Array(512);
for (let i = 0; i < 512; i++) {
    const op = i << 7;
    const hit = OP_LIST.find(([m, b]) => (op & m) === b);
    OPS[i] = hit ? hit[2] : 0;
}

/* the multiplier result a PM read leaves (pmRead48) */
let PH = 0, PL = 0;

const newDag = () => ({
    i: new Uint32Array(8), m: new Uint32Array(8), b: new Uint32Array(8), l: new Uint32Array(8),
});

const STOP_NAMES = ['budget', 'stall', 'idle', 'spin', 'halted', 'fault'];
const STOP_BUDGET = 0, STOP_STALL = 1, STOP_IDLE = 2, STOP_SPIN = 3, STOP_HALTED = 4, STOP_FAULT = 5;

export class Sharc {
    /**
     * @param {object} board
     *   extRead(addr)      DM at or above 0x80000: the word, or null to stall
     *   extWrite(addr, v)  false to stall (and then it must not have written)
     *   flagOut(n, state)  optional: a FLAG pin the program drives
     *   log(message)       optional: warnings (default console.warn)
     */
    constructor({ extRead = () => 0, extWrite = () => true, flagOut = () => {}, log } = {}) {
        this.extRead = extRead;
        this.extWrite = extWrite;
        this.flagOut = flagOut;
        this.log = log || ((m) => console.warn(m));
        this.r = new Uint32Array(16);
        this.regAlt = new Uint32Array(16);
        this.dag1 = newDag();       /* DM, I0-I7 */
        this.dag2 = newDag();       /* PM, I8-I15 */
        this.dag1Alt = newDag();
        this.dag2Alt = newDag();
        this.pcstack = new Uint32Array(PCSTACK);
        this.lcstack = new Uint32Array(LSTACK);
        this.lastack = new Uint32Array(LSTACK);
        this.statusStack = new Uint32Array(10);     /* mode1, astat pairs */
        this.flag = new Uint32Array(4);
        this.msgr = new Uint32Array(8);
        this.dma = [];
        for (let i = 0; i < 8; i++) this.dma.push({});
        /* The stacks as a stalled instruction found them. */
        this.saved = {
            pcstack: new Uint32Array(PCSTACK), lcstack: new Uint32Array(LSTACK),
            lastack: new Uint32Array(LSTACK),
        };
        this.blk = new Uint32Array(0x10000);        /* block 1 from 0x8000 */
        this.reset();
    }

    /** Power-on (MAME device_reset with HOST boot); the core stays halted. */
    reset() {
        this.r.fill(0);
        this.regAlt.fill(0);
        for (const d of [this.dag1, this.dag2, this.dag1Alt, this.dag2Alt]) {
            d.i.fill(0); d.m.fill(0); d.b.fill(0); d.l.fill(0);
        }
        this.mrfH = 0; this.mrfL = 0; this.mrbH = 0; this.mrbL = 0;
        this.pxH = 0; this.pxL = 0;
        this.delaySlot1 = 0; this.delaySlot2 = 0;
        this.astat = 0; this.astatOld = 0; this.astatOld2 = 0; this.astatOld3 = 0;
        this.mode1 = 0; this.mode2 = 0; this.irptl = 0; this.ustat1 = 0; this.ustat2 = 0;
        this.pcstkp = 0; this.pcstack.fill(0);
        this.lcntr = 0; this.lstkp = 0; this.lcstack.fill(0); this.lastack.fill(0);
        this.statusStack.fill(0); this.statusStkp = 0;
        this.irqPending = 0; this.activeIrq = 0; this.interruptActive = 0; this.idle = 0;
        this.latCycles = 0; this.latData = 0; this.latPrev = 0;
        this.sseView = 0;
        this.flag.fill(0);
        this.sysstat = 0; this.msgr.fill(0); this.dmaStatus = 0; this.extdmaShift = 0;
        for (const d of this.dma) {
            d.control = 0; d.intIndex = 0; d.intModifier = 0; d.intCount = 0; d.chainPtr = 0;
            d.genPurpose = 0; d.extIndex = 0; d.extModifier = 0; d.extCount = 0;
        }
        this.iopWriteNum = 0; this.iopData = 0;
        this.extLatch = 0; this.stalled = 0; this.spin = 0;
        this.fault = 0; this.stop = STOP_BUDGET; this.cycles = 0;
        this.opLo = 0; this.opHi = 0;
        this.blk.fill(0);

        const d = this.dma[6];
        d.intIndex = 0x20000;
        d.intModifier = 1;
        d.intCount = 0x100;
        d.extIndex = 0x400000;
        d.extModifier = 1;
        d.extCount = 0x600;
        d.control = 0xa1;
        this.pc = 0x20004;
        this.daddr = 0x20005;
        this.faddr = 0x20006;
        this.nfaddr = 0x20007;
        this.stky = PCEM | SSEM | LSEM;
        this.imask = 0x0003;
        this.pcstk = 0x00ffffff;
        this.curlcntr = 0xffffffff;
        this.laddrUnpack(0xffffffff);
        this.syscon = 0x00000010;
        this.latReg = -1;
        this.flag[0] = 1;           /* FIFO in: empty */
        this.halted = 1;
    }

    /**
     * Reset, upload `halfwords` as the HOST boot does (MAME external_dma_write:
     * DMA6 packs three halfwords into each PM word from 0x20000, low first)
     * and release the core at 0x20005.
     */
    loadProgram(halfwords) {
        this.reset();
        for (let n = 0; n < halfwords.length; n++) this.dma6Write(n, halfwords[n] & 0xffff);
        this.halted = 0;
    }

    /**
     * One IOP register written by the host over the external port (MAME
     * external_iop_write; Last Bronx uploads its program through EPB0 this
     * way). With SYSCON.HBW the bus is 16 bits wide, so two writes make a
     * word, but for EPB0 (0x04), which the DMA unpacks itself.
     */
    externalIopWrite(reg, v) {
        if ((this.syscon & 0x10) && reg !== 0x04) {
            if ((this.iopWriteNum++ & 1) === 0) {
                this.iopData = v & 0xffff;
                return;
            }
            this.iopData = (this.iopData | ((v & 0xffff) << 16)) >>> 0;
        } else {
            this.iopData = v >>> 0;
        }
        if (reg === 0x1c) this.dma[6].control = this.iopData;
        else this.iopW(reg, this.iopData);
    }

    /** Release a core held since reset (after uploading through the IOP). */
    boot() { this.halted = 0; }

    /** FLAG0-3 inputs (Model 2B: FLAG0 = FIFO in empty, FLAG1 = FIFO out full). */
    setFlagInput(n, state) {
        if (n < 0 || n > 3) return;
        if ((this.mode2 >>> (M2_FLGO_SHIFT + n)) & 1)
            this.log(`sharc: flag ${n} input set while it is an output`);
        this.flag[n] = state ? 1 : 0;
    }

    /** IRQ0-2 lines (IRQn is interrupt 8 - n). */
    setIrq(line, state) {
        if (line < 0 || line > 2) return;
        if (state) this.irqPending |= 1 << (8 - line);
        else this.irqPending &= ~(1 << (8 - line));
    }

    /**
     * Run up to `maxCycles` instructions. The number run is `this.cycles` (a
     * stalled access is not counted: it is retried). Returns why it stopped:
     * 'budget', 'stall', 'idle', 'spin', 'halted' (before boot) or 'fault'.
     */
    run(maxCycles) {
        this.cycles = 0;
        if (this.fault) { this.stop = STOP_FAULT; return 'fault'; }
        if (this.halted) { this.stop = STOP_HALTED; return 'halted'; }
        if (this.irqPending) {
            this.checkInterrupts();
            this.idle = 0;
        }
        this.stop = STOP_BUDGET;
        if (this.idle) { this.stop = STOP_IDLE; return 'idle'; }
        while (this.cycles < maxCycles) {
            const why = this.step();
            if (why !== STOP_BUDGET) {
                this.stop = why;
                break;
            }
        }
        return STOP_NAMES[this.stop];
    }

    fatal(what, v) {
        if (!this.fault) {
            this.log(`sharc: ${what} (${hex(v, 8)}) at PC ${hex(this.pc, 5)}, op ` +
                `${hex(this.opHi, 4)}${hex(this.opLo, 8)}`);
        }
        this.fault = 1;
    }

    /* ---- Memory ------------------------------------------------------------ */

    /* The blk index of the first cell of PM word `a`, or -1 (MAME pm_r);
     * `this.slot` is which of the four 0x1000-word slots it falls in. */
    pmCell(a) {
        a &= 0xffffff;
        if (a < 0x20000 || a >= 0x40000 || (a & 0x7fff) >= 0x5000) return -1;
        const off = a & 0x7fff;
        this.slot = off >> 12;
        return ((a & 0x18000) ? 0x8000 : 0) + (off & 0xfff) + (this.slot >> 1) * 0x3000;
    }

    /* PM word -> PH (bits 32-47), PL (bits 0-31) */
    pmRead48(a) {
        const c = this.pmCell(a), b = this.blk;
        if (c < 0) { PH = 0; PL = 0; return; }
        if (this.slot & 1) {
            const w = b[c + 0x2000];
            PH = w >>> 16;
            PL = ((w << 16) | (b[c + 0x1000] & 0xffff)) >>> 0;
        } else {
            const w = b[c];
            PH = w >>> 16;
            PL = ((w << 16) | (b[c + 0x1000] >>> 16)) >>> 0;
        }
    }

    pmWrite48(a, hi, lo) {
        const c = this.pmCell(a), b = this.blk;
        if (c < 0) return;
        const top = ((lo >>> 16) | (hi << 16)) >>> 0;
        if (this.slot & 1) {
            b[c + 0x1000] = (b[c + 0x1000] & 0xffff0000) | (lo & 0xffff);
            b[c + 0x2000] = top;
        } else {
            b[c] = top;
            b[c + 0x1000] = (b[c + 0x1000] & 0xffff) | ((lo & 0xffff) << 16);
        }
    }

    /* PM as 32 bits: bits 16-47 of the word */
    pmRead32(a) {
        const c = this.pmCell(a);
        if (c < 0) return 0;
        return this.blk[c + ((this.slot & 1) ? 0x2000 : 0)];
    }

    pmWrite32(a, v) {
        const c = this.pmCell(a);
        if (c >= 0) this.blk[c + ((this.slot & 1) ? 0x2000 : 0)] = v;
    }

    iopR(reg) {
        if (reg >= 0x08 && reg <= 0x0f) return this.msgr[reg - 8];
        if (reg === 0x37) return this.dmaStatus;
        if (reg > 0x01) this.log(`sharc: IOP read ${hex(reg, 2)} at ${hex(this.pc, 5)} -> 0`);
        return 0;
    }

    iopW(reg, v) {
        if (reg === 0x00) {
            this.syscon = v >>> 0;
        } else if (reg === 0x04) {
            this.dma6Write(this.extdmaShift, v);
            this.extdmaShift = (this.extdmaShift + 1) % 3;
        } else if (reg >= 0x08 && reg <= 0x0f) {
            this.msgr[reg - 8] = v;
        } else if (reg === 0x1c || reg === 0x1d) {
            this.dma[reg - 0x16].control = v >>> 0;
            if (v & 1) this.log(`sharc: DMA${reg - 0x16} start (${hex(v, 8)}) not emulated`);
        } else if (reg >= 0x40 && reg <= 0x4f) {
            const d = this.dma[reg < 0x48 ? 6 : 7];
            v >>>= 0;
            switch (reg & 7) {
            case 0: d.intIndex = v; break;
            case 1: d.intModifier = v; break;
            case 2: d.intCount = v; break;
            case 3: d.chainPtr = v; break;
            case 4: d.genPurpose = v; break;
            case 5: d.extIndex = v; break;
            case 6: d.extModifier = v; break;
            default: d.extCount = v; break;
            }
        } else if (reg > 0x03 && reg !== 0x14 && reg !== 0x17 && reg !== 0x20) {
            this.log(`sharc: IOP write ${hex(reg, 2)} = ${hex(v, 8)} at ${hex(this.pc, 5)} ignored`);
        }
    }

    shortRead(a) {
        const h = a & 0xffff;
        const w = this.blk[((a & 0x30000) ? 0x8000 : 0) + (h >> 1)];
        const v = (h & 1) ? w >>> 16 : w & 0xffff;
        return this.sseView ? sext(v, 16) : v;
    }

    shortWrite(a, v) {
        const h = a & 0xffff;
        const k = ((a & 0x30000) ? 0x8000 : 0) + (h >> 1);
        const w = this.blk[k];
        this.blk[k] = (h & 1) ? (w & 0xffff) | (v << 16) : (w & 0xffff0000) | (v & 0xffff);
    }

    /* internal DM, or the word an external read latched before compute */
    dmRead(a) {
        if (a >= EXT_BASE) return this.extLatch;
        if (a >= 0x40000) return this.shortRead(a);
        if (a >= 0x20000) return this.blk[((a & 0x18000) ? 0x8000 : 0) + (a & 0x7fff)];
        return a < 0x100 ? this.iopR(a) : 0;
    }

    /* internal DM; an external write was done before compute */
    dmWrite(a, v) {
        if (a >= EXT_BASE) return;
        if (a >= 0x40000) this.shortWrite(a, v);
        else if (a >= 0x20000) this.blk[((a & 0x18000) ? 0x8000 : 0) + (a & 0x7fff)] = v;
        else if (a < 0x100) this.iopW(a, v);
    }

    /* The external half of a DM access, done before any of the instruction's
     * side effects. False when the board stalled it: the handler returns at
     * once and step() rolls the instruction back. */
    ext(a, wr, v) {
        if (a < EXT_BASE) return true;
        if (wr) {
            if (this.extWrite(a, v >>> 0) !== false) return true;
        } else {
            const x = this.extRead(a);
            if (x !== null && x !== undefined) {
                this.extLatch = x >>> 0;
                return true;
            }
        }
        this.stalled = 1;
        return false;
    }

    /* MAME external_dma_write, DMA channel 6 as the HOST boot sets it up */
    dma6Write(n, data) {
        const d = this.dma[6];
        const index = ((d.intIndex & 0x1ffff) | 0x20000) >>> 0;
        const mswf = (d.control >>> 8) & 1;
        const pmode = (d.control >>> 6) & 3;
        if (pmode === 0) {
            if ((d.control >>> 5) & 1) this.pmWrite32(index, data);
            else this.dmWrite(index, data);
            d.intIndex = (d.intIndex + d.intModifier) >>> 0;
        } else if (pmode === 2) {
            const word = n % 3;
            const shift = (mswf ? 2 - word : word) * 16;
            this.pmRead48(index);
            let hi = PH, lo = PL;
            data &= 0xffff;
            if (shift === 32) hi = data;
            else if (shift === 16) lo = ((lo & 0xffff) | (data << 16)) >>> 0;
            else lo = ((lo & 0xffff0000) | data) >>> 0;
            this.pmWrite48(index, hi, lo);
            if (word === 2) d.intIndex = (d.intIndex + d.intModifier) >>> 0;
        } else {
            this.fatal('external DMA packing mode', pmode);
        }
    }

    /* ---- Pipeline, stacks -------------------------------------------------- */

    changePc(n) {
        this.pc = n;
        this.daddr = n;
        this.faddr = (n + 1) >>> 0;
        this.nfaddr = (n + 2) >>> 0;
    }

    jump(delayed, n) {
        if (delayed) {
            this.nfaddr = n;
            this.delaySlot1 = this.pc;
            this.delaySlot2 = this.daddr;
        } else {
            this.changePc(n);
        }
    }

    pushPc() {
        if (this.pcstkp >= PCSTACK) {
            this.fatal('PC stack overflow', this.pcstkp);
            return;
        }
        if (this.pcstkp > 0) this.pcstack[this.pcstkp - 1] = this.pcstk;
        this.pcstkp++;
        this.stky &= ~PCEM;
        if (this.pcstkp >= PCSTACK) this.stky |= PCFL;
    }

    popPc() {
        if (this.pcstkp === 0) {
            this.fatal('PC stack underflow', 0);
            return this.pc;
        }
        const result = this.pcstk;
        this.pcstkp--;
        this.pcstack[this.pcstkp] = this.pcstk;
        if (this.pcstkp > 0) {
            this.pcstk = this.pcstack[this.pcstkp - 1];
        } else {
            this.pcstk = 0x00ffffff;
            this.stky |= PCEM;
        }
        this.stky &= ~PCFL;
        return result;
    }

    laddrPack() {
        return ((this.laddrType << 30) | (this.laddrCode << 24) | this.laddrAddr) >>> 0;
    }

    laddrUnpack(v) {
        this.laddrAddr = v & 0xffffff;
        this.laddrCode = (v >>> 24) & 0x1f;
        this.laddrType = (v >>> 30) & 3;
    }

    pushLoop() {
        if (this.lstkp >= LSTACK) {
            this.fatal('loop stack overflow', this.lstkp);
            return;
        }
        if (this.lstkp > 0) {
            this.lcstack[this.lstkp - 1] = this.curlcntr;
            this.lastack[this.lstkp - 1] = this.laddrPack();
        }
        this.curlcntr = this.lcntr;
        this.laddrUnpack(this.lastack[this.lstkp]);
        this.lstkp++;
        this.lcntr = this.lstkp < LSTACK ? this.lcstack[this.lstkp] : 0xffffffff;
        this.stky &= ~LSEM;
    }

    popLoop() {
        if (this.lstkp === 0) {
            this.fatal('loop stack underflow', 0);
            return;
        }
        this.lstkp--;
        this.lcntr = this.curlcntr;
        this.lastack[this.lstkp] = this.laddrPack();
        if (this.lstkp > 0) {
            this.curlcntr = this.lcstack[this.lstkp - 1];
            this.laddrUnpack(this.lastack[this.lstkp - 1]);
        } else {
            this.curlcntr = 0xffffffff;
            this.laddrUnpack(0xffffffff);
            this.stky |= LSEM;
        }
    }

    saveStacks() {
        const s = this.saved;
        s.pcstk = this.pcstk; s.pcstkp = this.pcstkp; s.pcstack.set(this.pcstack);
        s.lcntr = this.lcntr; s.curlcntr = this.curlcntr; s.lstkp = this.lstkp;
        s.lcstack.set(this.lcstack); s.lastack.set(this.lastack);
        s.laddrAddr = this.laddrAddr; s.laddrCode = this.laddrCode; s.laddrType = this.laddrType;
        s.stky = this.stky;
    }

    restoreStacks() {
        const s = this.saved;
        this.pcstk = s.pcstk; this.pcstkp = s.pcstkp; this.pcstack.set(s.pcstack);
        this.lcntr = s.lcntr; this.curlcntr = s.curlcntr; this.lstkp = s.lstkp;
        this.lcstack.set(s.lcstack); this.lastack.set(s.lastack);
        this.laddrAddr = s.laddrAddr; this.laddrCode = s.laddrCode; this.laddrType = s.laddrType;
        this.stky = s.stky;
    }

    pushStatus() {
        this.statusStkp++;
        if (this.statusStkp >= 5) {
            this.fatal('status stack overflow', this.statusStkp);
            return;
        }
        const k = (this.statusStkp - 1) * 2;
        this.statusStack[k] = this.getUreg(0x7b);
        this.statusStack[k + 1] = this.getUreg(0x7c);
        this.stky &= ~SSEM;
    }

    popStatus() {
        if (this.statusStkp <= 0) {
            this.fatal('status stack underflow', 0);
            return;
        }
        this.statusStkp--;
        const k = this.statusStkp * 2;
        this.setUreg(0x7b, this.statusStack[k]);
        this.setUreg(0x7c, (this.astat & FLGS) | (this.statusStack[k + 1] & ~FLGS));
        if (this.statusStkp === 0) this.stky |= SSEM;
    }

    /* ---- Universal registers ----------------------------------------------- */

    /* MODE1's alternate-register bits swap these four of I, M, L and B */
    static swapDagHalf(a, b, base) {
        for (let k = base; k < base + 4; k++) {
            let t;
            t = a.i[k]; a.i[k] = b.i[k]; b.i[k] = t;
            t = a.m[k]; a.m[k] = b.m[k]; b.m[k] = t;
            t = a.l[k]; a.l[k] = b.l[k]; b.l[k] = t;
            t = a.b[k]; a.b[k] = b.b[k]; b.b[k] = t;
        }
    }

    swapRegs(base) {
        for (let k = base; k < base + 8; k++) {
            const t = this.r[k];
            this.r[k] = this.regAlt[k];
            this.regAlt[k] = t;
        }
    }

    /* MAME systemreg_write_latency_effect: MODE1 takes two instructions */
    latencyEffect() {
        const data = this.latData;
        const diff = data ^ this.latPrev;
        if (this.latReg !== 0xb) {
            this.fatal('latency effect on unknown register', this.latReg);
            return;
        }
        this.mode1 = data;
        if (diff & (M1_BR8 | M1_BR0 | M1_SRCU)) this.fatal('MODE1 bit-reverse / MR alternate', data);
        if (diff & M1_SRD1H) Sharc.swapDagHalf(this.dag1, this.dag1Alt, 4);
        if (diff & M1_SRD1L) Sharc.swapDagHalf(this.dag1, this.dag1Alt, 0);
        if (diff & M1_SRD2H) Sharc.swapDagHalf(this.dag2, this.dag2Alt, 4);
        if (diff & M1_SRD2L) Sharc.swapDagHalf(this.dag2, this.dag2Alt, 0);
        if (diff & M1_SRRFH) this.swapRegs(8);
        if (diff & M1_SRRFL) this.swapRegs(0);
        if (diff & M1_SSE) this.sseView = (data & M1_SSE) ? 1 : 0;
        this.latReg = -1;
    }

    addLatency(reg, data, prev) {
        if (this.latCycles > 0) this.latencyEffect();
        this.latCycles = 2;
        this.latReg = reg;
        this.latData = data;
        this.latPrev = prev;
    }

    /* ASTAT as read: the FLAG bits of the input pins are the pins */
    getAstat() {
        let r = this.astat;
        const outs = (this.mode2 >>> M2_FLGO_SHIFT) & 0xf;
        r &= (outs << FLG_SHIFT) | ~FLGS;
        for (let i = 0; i < 4; i++)
            if (!((outs >> i) & 1)) r |= this.flag[i] << (FLG_SHIFT + i);
        return r >>> 0;
    }

    getUreg(ureg) {
        const reg = ureg & 0xf;
        const d = (reg & 8) ? this.dag2 : this.dag1;
        switch ((ureg >> 4) & 0xf) {
        case 0x0: return this.r[reg];
        case 0x1: return d.i[reg & 7];
        case 0x2:
            /* M8-M15 read sign-extended from bit 23, M0-M7 as stored */
            if ((reg & 8) && (d.m[reg & 7] & 0x800000)) return (d.m[reg & 7] | 0xff000000) >>> 0;
            return d.m[reg & 7];
        case 0x3: return d.l[reg & 7];
        case 0x4: return d.b[reg & 7];
        case 0x6:
            switch (reg) {
            case 0x4: return this.pcstk;
            case 0x5: return this.pcstkp;
            case 0x7: return this.curlcntr;
            case 0x8: return this.lcntr;
            }
            break;
        case 0x7:
            switch (reg) {
            case 0x0: return this.ustat1;
            case 0x1: return this.ustat2;
            case 0x9: return this.irptl >>> 0;
            case 0xa: return this.mode2;
            case 0xb: return this.mode1;
            case 0xc: return this.getAstat();
            case 0xd: return this.imask >>> 0;
            case 0xe: return this.stky >>> 0;
            }
            break;
        case 0xd:
            switch (reg) {
            case 0xb: return this.pxL;
            case 0xc: return this.pxL & 0xffff;
            case 0xd: return ((this.pxL >>> 16) | (this.pxH << 16)) >>> 0;
            }
            break;
        }
        this.fatal('GET_UREG unknown register', ureg);
        return 0;
    }

    setPcstkp(data) {
        if (this.pcstkp >= 31) return;
        const prev = this.pcstkp;
        this.pcstkp = data & 0x1f;
        if (prev > 0) this.pcstack[prev - 1] = this.pcstk;
        if (prev < this.pcstkp) {
            if (this.pcstkp >= 31) {
                this.fatal('PC stack overflow', this.pcstkp);
                return;
            }
            this.pcstk = this.pcstack[this.pcstkp - 1];
            this.stky &= ~PCEM;
            if (this.pcstkp >= PCSTACK) this.stky |= PCFL;
        } else if (prev > this.pcstkp) {
            if (this.pcstkp > 0) {
                this.pcstk = this.pcstack[this.pcstkp - 1];
            } else {
                this.pcstk = 0x00ffffff;
                this.stky |= PCEM;
            }
            this.stky &= ~PCFL;
        }
    }

    setMode2(data) {
        const set = ~this.mode2 & data;
        this.mode2 = data >>> 0;
        for (let i = 0; i < 4; i++)
            if ((set >>> (M2_FLGO_SHIFT + i)) & 1) this.flagOut(i, (this.astat >>> (FLG_SHIFT + i)) & 1);
    }

    setAstat(data) {
        const outs = ((this.mode2 >>> M2_FLGO_SHIFT) & 0xf) << FLG_SHIFT;
        const flags = (this.astat ^ data) & outs;
        this.astat = data >>> 0;
        for (let i = 0; i < 4; i++)
            if ((flags >>> (FLG_SHIFT + i)) & 1) this.flagOut(i, (data >>> (FLG_SHIFT + i)) & 1);
    }

    setUreg(ureg, data) {
        const reg = ureg & 0xf;
        const d = (reg & 8) ? this.dag2 : this.dag1;
        switch ((ureg >> 4) & 0xf) {
        case 0x0: this.r[reg] = data; return;
        case 0x1: d.i[reg & 7] = data; return;
        case 0x2: d.m[reg & 7] = data; return;
        case 0x3: d.l[reg & 7] = data; return;
        case 0x4:                   /* loading B loads I too */
            d.b[reg & 7] = data;
            d.i[reg & 7] = data;
            return;
        case 0x6:
            switch (reg) {
            case 0x4:
                if (this.pcstkp > 0 && this.pcstkp < 31) this.pcstk = data & 0x00ffffff;
                return;
            case 0x5: this.setPcstkp(data); return;
            case 0x7:
                if (this.lstkp > 0 && this.lstkp < 7) this.curlcntr = data >>> 0;
                return;
            case 0x8:
                if (this.lstkp < LSTACK) this.lcntr = data >>> 0;
                return;
            }
            break;
        case 0x7:
            switch (reg) {
            case 0x0: this.ustat1 = data >>> 0; return;
            case 0x1: this.ustat2 = data >>> 0; return;
            case 0x9: this.irptl = data >>> 0; return;
            case 0xa: this.setMode2(data); return;
            case 0xb:
                this.addLatency(0xb, data >>> 0, this.mode1);
                this.mode1 = data >>> 0;
                return;
            case 0xc: this.setAstat(data); return;
            case 0xd:
                this.checkInterrupts();
                this.imask = data >>> 0;
                return;
            case 0xe: {
                const keep = LSEM | LSOV | SSEM | SSOV | PCEM | PCFL;
                this.stky = ((this.stky & keep) | (data & ~keep)) >>> 0;
                return;
            }
            }
            break;
        case 0xd:
            if (reg === 0xc) {
                this.pxL = ((this.pxL & 0xffff0000) | (data & 0xffff)) >>> 0;
                return;
            }
            if (reg === 0xd) {
                this.pxL = ((this.pxL & 0xffff) | (data << 16)) >>> 0;
                this.pxH = data >>> 16;
                return;
            }
            break;
        }
        this.fatal('SET_UREG unknown register', ureg);
    }

    /* ---- Conditions -------------------------------------------------------- */

    condLt() {
        const a = this.astat;
        if (a & AF) return (a & AN) !== 0 && !(a & AZ);
        return ((a & AN) !== 0) !== ((a & AV) !== 0 && !(this.mode1 & M1_ALUSAT));
    }

    condLe() {
        const a = this.astat;
        if (a & AZ) return true;
        if (a & AF) return (a & AN) !== 0;
        return ((a & AN) !== 0) !== ((a & AV) !== 0 && !(this.mode1 & M1_ALUSAT));
    }

    /* conditions 0x00-0x0E; 0x10-0x1E are their negations */
    condBase(low) {
        switch (low) {
        case 0: return (this.astat & AZ) !== 0;
        case 1: return this.condLt();
        case 2: return this.condLe();
        case 3: return (this.astat & AC) !== 0;
        case 4: return (this.astat & AV) !== 0;
        case 5: return (this.astat & MV) !== 0;
        case 6: return (this.astat & MN) !== 0;
        case 7: return (this.astat & SV) !== 0;
        case 8: return (this.astat & SZ) !== 0;
        case 9: case 10: case 11: case 12: return this.flag[low - 9] !== 0;
        case 13: return (this.astat & BTF) !== 0;
        default: return false;
        }
    }

    ifCond(c) {
        if ((c & 0xf) === 0xf)      /* NOT LCE / TRUE */
            return (c & 0x10) ? true : this.curlcntr !== 1;
        const v = this.condBase(c & 0xf);
        return (c & 0x10) ? !v : v;
    }

    doCond(c) {
        if ((c & 0xf) === 0xf)      /* LCE / FALSE (FOREVER) */
            return (c & 0x10) ? false : this.curlcntr === 1;
        const v = this.condBase(c & 0xf);
        return (c & 0x10) ? !v : v;
    }

    /* ---- Interrupts -------------------------------------------------------- */

    checkInterrupts() {
        if (!(this.imask & this.irqPending) || !(this.mode1 & M1_IRPTEN) || this.interruptActive ||
            this.pc === this.delaySlot1 || this.pc === this.delaySlot2)
            return;
        let which = 0;
        while (which < 32 && !((this.irqPending >> which) & 1)) which++;
        this.pushPc();
        this.pcstk = this.idle ? (this.pc + 1) >>> 0 : this.daddr;
        this.irptl = (this.irptl | (1 << which)) >>> 0;
        if (which >= 6 && which <= 8) this.pushStatus();
        this.changePc(0x20000 + which * 4);
        this.activeIrq = which;
        this.irqPending &= ~(1 << which);
        this.interruptActive = 1;
    }

    /* the CI bit of a jump: clear the interrupt being served */
    clearInterrupt() {
        if (this.activeIrq >= 6 && this.activeIrq <= 8) this.popStatus();
        this.interruptActive = 0;
        this.irptl = (this.irptl & ~(1 << this.activeIrq)) >>> 0;
    }

    /* ---- Compute: flag and float helpers ----------------------------------- */

    trunc() { return (this.mode1 & M1_TRUNC) !== 0; }
    aluClear() { this.astat &= ~(AZ | AN | AV | AC | AS | AI); }
    mulClear() { this.astat &= ~(MN | MV | MU | MI); }
    setAz(r) { if (r === 0) this.astat |= AZ; }
    setAn(r) { if (r & F_SIGN) this.astat |= AN; }
    setMn(r) { if (r & F_SIGN) this.astat |= MN; }
    setSz(r) { if (r === 0) this.astat |= SZ; }
    aluNan() { this.astat |= AI; this.stky |= AIS; }
    avAdd(r, a, b) { if (~(a ^ b) & (a ^ r) & F_SIGN) { this.astat |= AV; this.stky |= AOS; } }
    avSub(r, a, b) { if ((a ^ b) & (a ^ r) & F_SIGN) { this.astat |= AV; this.stky |= AOS; } }
    acAdd(r, a) { if (r < a) this.astat |= AC; }        /* both u32 */
    acSub(r, a) { if (r <= a) this.astat |= AC; }

    /* int32(floorf / nearbyintf), or the truncation `towardZero` asks for
     * under TRUNC; NaN and out of range give 0x80000000, as on x86 */
    fixBits(r, towardZero) {
        const f = u2f(r);
        const v = !this.trunc() ? roundEven(f) : towardZero ? Math.trunc(f) : Math.floor(f);
        if (v !== v || v >= 2147483648 || v < -2147483648) return 0x80000000;
        return v >>> 0;
    }

    /* the integer ALU epilogue: ALUSAT, AN, AZ, store, clear AF */
    intOut(rn, r) {
        if ((this.mode1 & M1_ALUSAT) && (this.astat & AV)) r = (asr(r, 31) ^ F_SIGN) >>> 0;
        this.setAn(r);
        this.setAz(r);
        this.r[rn] = r;
        this.astat &= ~AF;
    }

    /* PASS, AND, OR, XOR, NOT, MIN, MAX, CLIP: AN and AZ of the result */
    logicOut(rn, r) {
        r >>>= 0;
        this.aluClear();
        this.setAn(r);
        this.setAz(r);
        this.r[rn] = r;
        this.astat &= ~AF;
    }

    /* FLOAT_ALU_RESULT: overflow saturates under TRUNC, underflow flushes */
    faluResult(r) {
        if (isInf(r)) {
            this.astat |= AV;
            this.stky |= AVS;
            if (this.trunc()) r = ((r & F_SIGN) | F_MAXT) >>> 0;
        } else if (isDoz(r)) {
            this.astat |= AZ;
            if (r & F_MANT) this.stky |= AUS;
            r = (r & F_SIGN) >>> 0;
        }
        return r;
    }

    /* FADD / FSUB / FAVG on register bits (kind 0, 1, 2) */
    faddsub(a, b, kind) {
        let r;
        if (kind === 1 ? nanSub(a, b) : nanAdd(a, b)) {
            r = F_NAN;
            this.aluNan();
        } else {
            const x = u2f(flush(a));
            const y = u2f(flush(b) ^ (kind === 1 ? F_SIGN : 0));
            let f = Math.fround(x + y);
            if (kind === 2) f *= 0.5;
            r = this.faluResult(f2u(f));
            this.setAn(r);
        }
        this.astat |= AF;
        return r;
    }

    fabsBits(x) {
        let r;
        if (isNan(x)) {
            r = F_NAN;
            this.aluNan();
        } else {
            if (isDoz(x)) {
                r = 0;
                this.astat |= AZ;
            } else {
                r = (x & ~F_SIGN) >>> 0;
            }
            if (x & F_SIGN) this.astat |= AS;
        }
        this.astat |= AF;
        return r;
    }

    /* FMIN / FMAX: std::min(a, b) is (b < a) ? b : a, std::max (a < b) ? b : a */
    fminmax(a, b, max) {
        let r;
        if (isNan(a) || isNan(b)) {
            r = F_NAN;
            this.aluNan();
        } else {
            const fa = u2f(a), fb = u2f(b);
            r = (max ? fa < fb : fb < fa) ? b : a;
            if (u2f(r) < 0) this.astat |= AN;
            if (isZero(r)) this.astat |= AZ;
        }
        this.astat |= AF;
        return r;
    }

    /* MAME FADD_FSUB, both infinite: the integer pattern converted to float */
    infQuirk(x) {
        const v = ((x & F_SIGN) | (this.trunc() ? F_MAXT : F_INF)) >>> 0;
        return f2u(v);
    }

    /* Fa = Fx + Fy, Fs = Fx - Fy: the results in this.ra and this.rs */
    faddfsub(a, b) {
        if (isNan(a) || isNan(b)) {
            this.ra = this.rs = F_NAN;
            this.aluNan();
        } else if (!emax(a) || !emax(b)) {
            const x = u2f(flush(a));
            const y = u2f(flush(b));
            this.ra = this.faluResult(f2u(x + y));
            this.rs = this.faluResult(f2u(x - y));
            this.setAn(this.ra | this.rs);
        } else {
            if ((a ^ b) & F_SIGN) {
                this.ra = F_NAN;
                this.rs = this.infQuirk(a);
            } else {
                this.ra = this.infQuirk(a);
                this.rs = F_NAN;
            }
            this.setAn(a);
            this.astat |= AV | AI;
            this.stky |= AVS | AIS;
        }
        this.astat |= AF;
    }

    scalb(x, ry) {
        const sign = (x & F_SIGN) >>> 0;
        const e = (unbiased(x) + this.r[ry]) | 0;
        if (e > 127) {
            this.astat |= AV;
            return (sign | F_INF) >>> 0;
        }
        if (e < -126) {
            this.astat |= AZ;
            return sign;
        }
        return (sign | biased(e) | (x & F_MANT)) >>> 0;
    }

    fmulBits(a, b) {
        if (nanMul(a, b)) {
            this.astat |= MI;
            this.stky |= MIS;
            return F_NAN;
        }
        const r = f2u(u2f(a) * u2f(b));
        this.setMn(r);
        if (isInf(r)) {
            this.astat |= MV;
            this.stky |= MVS;
        } else if (isDenorm(r)) {
            this.astat |= MU;
            this.stky |= MUS;
        }
        return r;
    }

    /* ABS(Fx + Fy), ABS(Fx - Fy) */
    fabsAddsub(rn, a, b, sub) {
        let r;
        this.aluClear();
        if (sub ? nanSub(a, b) : nanAdd(a, b)) {
            r = F_NAN;
            this.aluNan();
        } else {
            const x = u2f(flush(a));
            const y = u2f(flush(b) ^ (sub ? F_SIGN : 0));
            r = f2u(x + y) & 0x7fffffff;
            if (r === F_EXP) {
                this.astat |= AV;
                this.stky |= AVS;
                if (this.trunc()) r = F_MAXT;
            } else if (isDoz(r)) {
                this.astat |= AZ;
                if (r & F_MANT) this.stky |= AUS;
                r = 0;
            }
        }
        this.r[rn] = r;
        this.astat |= AF;
    }

    /* -Fx (neg) or PASS Fx */
    fnegPass(rn, x, neg) {
        let r;
        this.aluClear();
        if (isNan(x)) {
            r = F_NAN;
            this.aluNan();
        } else {
            if (isDoz(x)) {
                r = ((neg ? ~x : x) & F_SIGN) >>> 0;
                this.astat |= AZ;
            } else {
                r = (neg ? x ^ F_SIGN : x) >>> 0;
            }
            this.setAn(r);
        }
        this.r[rn] = r;
        this.astat |= AF;
    }

    /* FIX Fx [BY Ry]: rAlu is the (scaled) float the integer comes from; the
     * multifunction FIX (`clear` false) truncates toward zero */
    fixOut(rn, rAlu, src, clear) {
        const i = this.fixBits(rAlu, !clear);
        if (clear) this.aluClear();
        this.setAn(i);
        this.setAz(i);
        if (isDenorm(rAlu)) this.stky |= AUS;
        if (isNan(src)) this.astat |= AI;
        this.r[rn] = i;
        this.astat |= AF;
    }

    floatFlags(r) {
        this.setAn(r);
        if (isDoz(r)) this.astat |= AZ;
        if (isDenorm(r)) this.stky |= AUS;
        this.astat |= AF;
    }

    /* the compare accumulator: the last eight "greater than"s in ASTAT 24-31 */
    compAccum() {
        let acc = (this.astat >>> 1) & 0x7f000000;
        if ((this.astat & (AZ | AN)) === 0) acc |= 0x80000000;
        this.astat = ((this.astat & 0x00ffffff) | acc) >>> 0;
    }

    /* ---- ALU ---------------------------------------------------------------- */

    alu(c) {
        const op = (c >>> 12) & 0xff;
        const rn = (c >>> 8) & 0xf, rx = (c >>> 4) & 0xf, ry = c & 0xf;
        const R = this.r;
        const X = R[rx], Y = R[ry];
        if ((op & 0x70) === 0x70) {     /* 0x7X dual add/sub, 0xFX float dual */
            if (op & 0x80) this.dualFaddFsub(rn, op & 0xf, rx, ry);
            else this.dualAddSub(rn, op & 0xf, rx, ry);
            return;
        }
        let r;
        switch (op) {
        case 0x01:                      /* Rn = Rx + Ry */
            r = (X + Y) >>> 0;
            this.aluClear();
            this.avAdd(r, X, Y);
            this.acAdd(r, X);
            this.intOut(rn, r);
            return;
        case 0x02:                      /* Rn = Rx - Ry */
            r = (X - Y) >>> 0;
            this.aluClear();
            this.avSub(r, X, Y);
            this.acSub(r, X);
            this.intOut(rn, r);
            return;
        case 0x05: {                    /* Rn = Rx + Ry + CI */
            const ci = (this.astat & AC) ? 1 : 0;
            r = (X + Y + ci) >>> 0;
            this.aluClear();
            this.avAdd(r, X, Y);
            this.acAdd(r, X);
            if (ci === 1 && Y === 0xffffffff) this.astat |= AC;
            this.intOut(rn, r);
            return;
        }
        case 0x06: {                    /* Rn = Rx - Ry + CI - 1 */
            const ci = (this.astat & AC) ? 1 : 0;
            r = (X - Y + ci - 1) >>> 0;
            this.aluClear();
            this.avSub(r, X, Y);
            if (ci !== 0 || Y !== 0xffffffff) this.acSub(r, X);
            this.intOut(rn, r);
            return;
        }
        case 0x0a:                      /* COMP(Rx, Ry) */
            this.aluClear();
            if (X === Y) this.astat |= AZ;
            else if ((X | 0) < (Y | 0)) this.astat |= AN;
            this.compAccum();
            this.astat &= ~AF;
            return;
        case 0x21: this.logicOut(rn, X); return;
        case 0x22:                      /* Rn = -Rx */
            r = (0 - X) >>> 0;
            this.aluClear();
            this.avSub(r, 0, X);
            this.acSub(r, 0);
            this.intOut(rn, r);
            return;
        case 0x25: {                    /* Rn = Rx + CI */
            r = (X + ((this.astat & AC) ? 1 : 0)) >>> 0;
            this.aluClear();
            this.avAdd(r, X, 0);
            this.acAdd(r, X);
            this.intOut(rn, r);
            return;
        }
        case 0x26: {                    /* Rn = Rx + CI - 1 */
            r = (X + ((this.astat & AC) ? 1 : 0) - 1) >>> 0;
            this.aluClear();
            this.avSub(r, X, 0);
            this.acSub(r, X);
            this.intOut(rn, r);
            return;
        }
        case 0x29:                      /* Rn = Rx + 1 */
            r = (X + 1) >>> 0;
            this.aluClear();
            this.avAdd(r, X, 1);
            this.acAdd(r, X);
            this.intOut(rn, r);
            return;
        case 0x2a:                      /* Rn = Rx - 1 */
            r = (X - 1) >>> 0;
            this.aluClear();
            this.avSub(r, X, 1);
            this.acSub(r, X);
            this.intOut(rn, r);
            return;
        case 0x30:                      /* Rn = ABS Rx */
            r = (X & F_SIGN) ? (0 - X) >>> 0 : X;
            this.aluClear();
            if (r & F_SIGN) {
                this.astat |= AV;
                this.stky |= AOS;
                if (this.mode1 & M1_ALUSAT) r = 0x7fffffff;
            }
            this.setAn(r);
            this.setAz(r);
            if (X & F_SIGN) this.astat |= AS;
            R[rn] = r;
            this.astat &= ~AF;
            return;
        case 0x40: this.logicOut(rn, X & Y); return;
        case 0x41: this.logicOut(rn, X | Y); return;
        case 0x42: this.logicOut(rn, X ^ Y); return;
        case 0x43: this.logicOut(rn, ~X); return;
        case 0x61: this.logicOut(rn, (Y | 0) < (X | 0) ? Y : X); return;
        case 0x62: this.logicOut(rn, (X | 0) < (Y | 0) ? Y : X); return;
        case 0x63: {                    /* CLIP Rx BY Ry, |INT_MIN| wrapping */
            const a = (Y & F_SIGN) ? (0 - Y) >>> 0 : Y;
            const hi = a | 0, lo = (0 - a) | 0, v = X | 0;
            this.logicOut(rn, v < lo ? lo : (hi < v ? hi : v));
            return;
        }
        case 0x81: this.aluClear(); R[rn] = this.faddsub(X, Y, 0); return;
        case 0x82: this.aluClear(); R[rn] = this.faddsub(X, Y, 1); return;
        case 0x89: this.aluClear(); R[rn] = this.faddsub(X, Y, 2); return;
        case 0x8a:                      /* COMP(Fx, Fy) */
            this.aluClear();
            if (isNan(X) || isNan(Y)) this.aluNan();
            else if (u2f(X) === u2f(Y)) this.astat |= AZ;
            else if (u2f(X) < u2f(Y)) this.astat |= AN;
            this.compAccum();
            this.astat |= AF;
            return;
        case 0x91: this.fabsAddsub(rn, X, Y, false); return;
        case 0x92: this.fabsAddsub(rn, X, Y, true); return;
        case 0xa1: this.fnegPass(rn, X, false); return;
        case 0xa2: this.fnegPass(rn, X, true); return;
        case 0xb0: this.aluClear(); R[rn] = this.fabsBits(X); return;
        case 0xbd:                      /* Fn = SCALB Fx BY Ry */
            this.aluClear();
            if (isNan(X)) {
                this.aluNan();
                R[rn] = F_NAN;
            } else {
                r = this.scalb(X, ry);
                this.setAn(r);
                if (isZero(r)) this.astat |= AZ;
                if (isDenorm(r)) this.stky |= AUS;
                R[rn] = r;
            }
            this.astat |= AF;
            return;
        case 0xc1:                      /* Rn = LOGB Fx */
            this.aluClear();
            if (isInf(X)) {
                R[rn] = F_INF;
                this.astat |= AV;
            } else if (isZero(X)) {
                R[rn] = F_SIGN | F_INF;
                this.astat |= AV;
            } else if (isNan(X)) {
                R[rn] = F_NAN;
                this.aluNan();
            } else {
                const e = unbiased(X) >>> 0;
                this.setAn(e);
                this.setAz(e);
                R[rn] = e;
            }
            this.astat |= AF;
            return;
        case 0xc4:                      /* Fn = RECIPS Fx */
            this.aluClear();
            if (isNan(X)) {
                r = F_NAN;
                this.aluNan();
            } else if (isZero(X)) {
                r = ((X & F_SIGN) | F_INF) >>> 0;
                this.astat |= AV;
            } else {
                let e = -unbiased(X) - 1;
                let m = RECIPS_LUT[(X & F_MANT) >>> 16];
                if (e > 125 || e < -126) {
                    e = 0;
                    m = 0;
                } else {
                    e = (e + 127) & 0xff;
                }
                r = ((X & F_SIGN) | (e << 23) | m) >>> 0;
                this.setAn(X);
                if (isZero(r)) this.astat |= AZ;
            }
            R[rn] = r;
            this.astat |= AF;
            return;
        case 0xc5: {                    /* Fn = RSQRTS Fx */
            if (X > 0x80000000 || isNan(X)) {
                r = F_NAN;
            } else {
                const half = unbiased(X) >> 1;
                r = ((X & F_SIGN) | biased(-half - 1) | RSQRTS_LUT[(X & 0xffffff) >>> 17]) >>> 0;
            }
            this.aluClear();
            if (X === 0x80000000) this.astat |= AN;
            if (isZero(r)) this.astat |= AZ;
            if (isZero(X)) this.astat |= AV;
            if (isNan(X) || (X & F_SIGN)) {
                this.astat |= AI;
                this.stky |= AIS;
            }
            R[rn] = r;
            this.astat |= AF;
            return;
        }
        case 0xc9: this.fixOut(rn, X, X, true); return;
        case 0xca:                      /* Fn = FLOAT Rx */
            R[rn] = f2u(X | 0);
            this.aluClear();
            this.floatFlags(R[rn]);
            return;
        case 0xd9: this.fixOut(rn, this.scalb(X, ry), X, true); return;
        case 0xda: {                    /* Fn = FLOAT Rx BY Ry */
            const x = f2u(X | 0);
            this.aluClear();
            R[rn] = this.scalb(x, ry);
            this.floatFlags(R[rn]);
            return;
        }
        case 0xe0:                      /* Fn = Fx COPYSIGN Fy */
            this.aluClear();
            if (isNan(X) || isNan(Y)) {
                r = F_NAN;
                this.aluNan();
            } else {
                r = (Y & F_SIGN) >>> 0;
                if (r) this.astat |= AN;
                if (isDoz(X)) this.astat |= AZ;
                else r = (r | (X & ~F_SIGN)) >>> 0;
            }
            R[rn] = r;
            this.astat |= AF;
            return;
        case 0xe1: this.aluClear(); R[rn] = this.fminmax(X, Y, false); return;
        case 0xe2: this.aluClear(); R[rn] = this.fminmax(X, Y, true); return;
        case 0xe3:                      /* Fn = CLIP Fx BY Fy */
            this.aluClear();
            if (isNan(X) || isNan(Y)) {
                r = F_NAN;
                this.aluNan();
            } else {
                if (isDoz(X) || isDoz(Y)) {
                    r = (X & F_SIGN) >>> 0;
                    this.astat |= AZ;
                } else {
                    const hi = u2f(Y & ~F_SIGN), lo = u2f(Y | F_SIGN), v = u2f(X);
                    r = v < lo ? (Y | F_SIGN) >>> 0 : (hi < v ? (Y & ~F_SIGN) >>> 0 : X);
                    if (isZero(r)) this.astat |= AZ;
                }
                this.setAn(r);
            }
            R[rn] = r;
            this.astat |= AF;
            return;
        default:
            this.fatal('unimplemented ALU operation', op);
        }
    }

    /* Ra = Rx + Ry, Rs = Rx - Ry */
    dualAddSub(ra, rs, rx, ry) {
        const x = this.r[rx], y = this.r[ry];
        let rAdd = (x + y) >>> 0, rSub = (x - y) >>> 0;
        const avA = (~(x ^ y) & (x ^ rAdd) & F_SIGN) !== 0;
        const avS = ((x ^ y) & (x ^ rSub) & F_SIGN) !== 0;
        this.aluClear();
        if (avA || avS) {
            this.astat |= AV;
            this.stky |= AOS;
        }
        if (rAdd < x || rSub <= x) this.astat |= AC;
        if (this.mode1 & M1_ALUSAT) {
            if (avA) rAdd = (asr(rAdd, 31) ^ F_SIGN) >>> 0;
            if (avS) rSub = (asr(rSub, 31) ^ F_SIGN) >>> 0;
        }
        if (rAdd === 0 || rSub === 0) this.astat |= AZ;
        this.setAn(rAdd | rSub);
        this.r[ra] = rAdd;
        this.r[rs] = rSub;
        this.astat &= ~AF;
    }

    /* Fa = Fx + Fy, Fs = Fx - Fy */
    dualFaddFsub(fa, fs, fx, fy) {
        this.aluClear();
        this.faddfsub(this.r[fx], this.r[fy]);
        this.r[fa] = this.ra;
        this.r[fs] = this.rs;
    }

    /* ---- Multiplier --------------------------------------------------------- */

    mulFlags(h, l) {
        this.setMn(l);
        if (h !== 0 && h !== 0xffffffff) this.astat |= MV;
        if (h === 0 && l !== 0) this.astat |= MU;
    }

    /* MAME compute_mul_fixed: op bit 2 -> MR (bit 1 MRB), bits 7-6 pick
     * SAT/RND (0), Rx*Ry (1), MR + (2), MR - (3); bit 3 fractional, bit 0
     * round. Both operands are sign-extended whatever bits 4-5 say. */
    mulFixed(op, rn, rx, ry) {
        const toMr = (op & 4) !== 0, frac = (op & 8) !== 0, b = (op & 2) !== 0;
        const mh = b ? this.mrbH : this.mrfH, ml = b ? this.mrbL : this.mrfL;
        if ((op >> 6) === 0) {
            const k = (op >> 4) & 3;
            if (k === 0) {
                if (frac) {
                    H = mh; L = ml;
                } else if (op & 1) {
                    /* the int64 clamped to int32 */
                    if (mh === ((ml & 0x80000000) ? 0xffffffff : 0)) { H = mh; L = ml; }
                    else if (mh & 0x80000000) { H = 0xffffffff; L = 0x80000000; }
                    else { H = 0; L = 0x7fffffff; }
                } else if (mh) {
                    H = 0; L = 0xffffffff;
                } else {
                    H = mh; L = ml;
                }
            } else if (k === 1) {
                if (frac) roundMr(mh, ml);
                else { H = 0; L = 0; }
                if ((op & 4) && frac) L = 0;
            } else {
                this.fatal('multiplier operation not implemented', op);
                return;
            }
        } else {
            smul32(this.r[rx], this.r[ry]);
            if (frac) { H = ((H << 1) | (L >>> 31)) >>> 0; L = (L << 1) >>> 0; }
            const kind = op >> 6;
            if (kind === 2) add64(mh, ml, H, L);
            else if (kind === 3) sub64(mh, ml, H, L);
            if (frac && (op & 1)) roundMr(H, L);
            if ((op & 4) && frac && (op & 1)) L = 0;
        }
        this.mulClear();
        if (toMr) {
            if (b) { this.mrbH = H; this.mrbL = L; } else { this.mrfH = H; this.mrfL = L; }
            this.setMn(H);
            return;
        }
        const out = frac ? H : L;
        this.setMn(out);
        if (!frac && H !== 0 && H !== 0xffffffff) this.astat |= MV;
        if (frac && H === 0 && L !== 0) this.astat |= MU;
        this.r[rn] = out;
    }

    mul(c) {
        const op = (c >>> 12) & 0xff;
        const rn = (c >>> 8) & 0xf, rx = (c >>> 4) & 0xf, ry = c & 0xf;
        const X = this.r[rx], Y = this.r[ry];
        switch (op) {
        case 0x14: case 0x15: this.mrfH = 0; this.mrfL = 0; return;
        case 0x16: case 0x17: this.mrbH = 0; this.mrbL = 0; return;
        case 0x30:
            this.mulClear();
            this.r[rn] = this.fmulBits(X, Y);
            return;
        case 0x40: umul32(X, Y); break;
        case 0x70: smul32(X, Y); break;
        case 0xb0: smul32(X, Y); add64(this.mrfH, this.mrfL, H, L); break;
        case 0xb2: smul32(X, Y); add64(this.mrbH, this.mrbL, H, L); break;
        default:
            if (op >= 0x40 || op < 0x20) this.mulFixed(op, rn, rx, ry);
            else this.fatal('multiplier operation not implemented', op);
            return;
        }
        this.mulClear();
        this.mulFlags(H, L);
        this.r[rn] = L;
    }

    /* ---- Shifter ------------------------------------------------------------ */

    /* One shift operation; `byReg` for Rn = shift Rx BY Ry (p is Ry's value),
     * else the immediate form (p the 12-bit data). */
    shiftOp(op, rn, rx, p, byReg) {
        const R = this.r;
        const x = R[rx];
        const bit = p & 0x3f, len = (p >>> 6) & 0x3f;
        let s;
        switch (op) {
        case 0x00:                      /* LSHIFT */
            s = byReg ? p | 0 : (p << 24) >> 24;
            R[rn] = lsh(x, s);
            if (s > 0) this.astat |= SV;
            this.setSz(R[rn]);
            return;
        case 0x01:                      /* ASHIFT, immediate only */
            if (byReg) break;
            s = (p << 24) >> 24;
            if (s < 0) R[rn] = asr(x, s > -32 ? -s : 31);
            else R[rn] = s < 32 ? (x << s) >>> 0 : 0;
            if (s > 0) this.astat |= SV;
            this.setSz(R[rn]);
            return;
        case 0x02:                      /* ROT */
            if (byReg) {
                R[rn] = rotl(x, p | 0);
                if ((p | 0) > 0) this.astat |= SV;
            } else {
                R[rn] = rotl(x, (p << 24) >> 24);
            }
            this.setSz(R[rn]);
            return;
        case 0x08:                      /* Rn = Rn OR LSHIFT */
            s = (p << 24) >> 24;
            if (byReg) {
                /* MAME shifts the int32: arithmetic to the right */
                if (s < 0) R[rn] |= s > -32 ? asr(x, -s) : 0;
                else R[rn] |= s < 32 ? x << s : 0;
                if (s > 0) this.astat |= SV;
                this.setSz(R[rn]);
            } else {
                /* logical, and SZ from the shifted value */
                const r = lsh(x, s);
                if (s > 0) this.astat |= SV;
                this.setSz(r);
                R[rn] |= r;
            }
            return;
        case 0x10:                      /* FEXT */
            R[rn] = len === 0 || bit >= 32 ? 0 : asr(x, bit) & mask(len);
            this.setSz(R[rn]);
            if (bit + len > 32) this.astat |= SV;
            return;
        case 0x11:                      /* FDEP, immediate only */
            if (byReg) break;
            R[rn] = len === 0 || bit >= 32 ? 0 : (x & mask(len)) << bit;
            this.setSz(R[rn]);
            if (bit + len > 32) this.astat |= SV;
            return;
        case 0x12:                      /* FEXT (SE) */
            if (len === 0 || bit >= 32) R[rn] = 0;
            else if (bit + len > 32) R[rn] = x >>> bit;
            else R[rn] = sext(asr(x, bit), len);
            this.setSz(R[rn]);
            if (bit + len > 32) this.astat |= SV;
            return;
        case 0x13:                      /* FDEP (SE), immediate only */
            if (byReg) break;
            R[rn] = len === 0 || bit >= 32 ? 0 : sext(x, len) << bit;
            this.setSz(R[rn]);
            if (bit + len > 32) this.astat |= SV;
            return;
        case 0x19:                      /* Rn = Rn OR FDEP */
            if (len !== 0 && bit < 32) R[rn] |= (x & mask(len)) << bit;
            this.setSz(R[rn]);
            if (bit + len > 32) this.astat |= SV;
            return;
        case 0x30: case 0x31: case 0x32: {      /* BSET, BCLR, BTGL */
            if (op === 0x32 && byReg) break;
            const b = p < 32 ? (1 << p) >>> 0 : 0;
            if (p >= 32) this.astat |= SV;
            R[rn] = op === 0x30 ? x | b : (op === 0x31 ? x & ~b : x ^ b);
            this.setSz(R[rn]);
            return;
        }
        case 0x33:                      /* BTST */
            if (p < 32) this.setSz((x & ((1 << p) >>> 0)) >>> 0);
            else this.astat |= SZ | SV;
            return;
        }
        this.fatal(byReg ? 'shift operation not implemented' : 'unimplemented shift operation', op);
    }

    shift(c) {
        this.astat &= ~(SZ | SV | SS);
        this.shiftOp((c >>> 14) & 0x3f, (c >>> 8) & 0xf, (c >>> 4) & 0xf, this.r[c & 0xf], true);
    }

    /* ---- Multi-function ------------------------------------------------------ */

    multi(c) {
        const multiop = (c >>> 16) & 0x3f;
        const R = this.r;
        const fm = (c >>> 12) & 0xf, fa = (c >>> 8) & 0xf;
        const fxm = (c >>> 6) & 3, fym = ((c >>> 4) & 3) + 4;
        const fxa = ((c >>> 2) & 3) + 8, fya = (c & 3) + 12;
        if (multiop >= 0x30) {          /* Fm = Fxm * Fym, Fa = Fxa + Fya, Fs = Fxa - Fya */
            this.mulClear();
            this.aluClear();
            const rMul = this.fmulBits(R[fxm], R[fym]);
            this.faddfsub(R[fxa], R[fya]);
            R[fm] = rMul;
            R[fa] = this.ra;
            R[multiop & 0xf] = this.rs;
            return;
        }
        switch (multiop) {
        case 0x00: {                    /* MR -> ureg */
            const ai = fm, rk = fa;
            switch (ai) {
            case 0: this.setUreg(rk, this.mrfL); break;
            case 1: this.setUreg(rk, this.mrfH); break;
            case 4: this.setUreg(rk, this.mrbL); break;
            case 5: this.setUreg(rk, this.mrbH); break;
            default: this.fatal('mr_to_reg: unknown ai', ai); break;
            }
            this.mulClear();
            return;
        }
        case 0x01: {                    /* ureg -> MR */
            const ai = fm, v = this.getUreg(fa);
            switch (ai) {
            case 0: this.mrfL = v; break;
            case 1: this.mrfH = v; break;
            case 4: this.mrbL = v; break;
            case 5: this.mrbH = v; break;
            default: this.fatal('reg_to_mr: unknown ai', ai); break;
            }
            this.mulClear();
            return;
        }
        case 0x04: case 0x05: {         /* Rm = Rxm * Rym (SSFR), Ra = Rxa +/- Rya */
            const sub = multiop === 0x05;
            const xa = R[fxa], ya = R[fya];
            smul32(R[fxm], R[fym]);
            const rMul = ((L >>> 31) | (H << 1)) >>> 0;
            const rAlu = (sub ? xa - ya : xa + ya) >>> 0;
            this.mulClear();
            this.setMn(rMul);
            this.aluClear();
            this.setAn(rAlu);
            this.setAz(rAlu);
            if (sub) {
                this.avSub(rAlu, xa, ya);
                this.acSub(rAlu, xa);
            } else {
                this.avAdd(rAlu, xa, ya);
                this.acAdd(rAlu, xa);
            }
            R[fm] = rMul;
            R[fa] = rAlu;
            this.astat &= ~AF;
            return;
        }
        case 0x18: case 0x19: case 0x1c: case 0x1d: case 0x1e: case 0x1f: {
            /* Fm = Fxm * Fym, Fa = <ALU op> */
            this.mulClear();
            this.aluClear();
            const rMul = this.fmulBits(R[fxm], R[fym]);
            const xa = R[fxa], ya = R[fya];
            let rAlu;
            switch (multiop) {
            case 0x18: rAlu = this.faddsub(xa, ya, 0); break;
            case 0x19: rAlu = this.faddsub(xa, ya, 1); break;
            case 0x1c: rAlu = this.faddsub(xa, ya, 2); break;
            case 0x1d: rAlu = this.fabsBits(xa); break;
            case 0x1e: rAlu = this.fminmax(xa, ya, true); break;
            default: rAlu = this.fminmax(xa, ya, false); break;
            }
            R[fm] = rMul;
            R[fa] = rAlu;
            return;
        }
        case 0x1a: {                    /* Fm = Fxm * Fym, Fa = FLOAT Rxa BY Rya */
            this.mulClear();
            this.aluClear();
            const rMul = this.fmulBits(R[fxm], R[fym]);
            const rAlu = this.scalb(f2u(R[fxa] | 0), fya);
            if (u2f(rAlu) < 0) this.astat |= AN;
            if (isDoz(rAlu)) this.astat |= AZ;
            if (isDenorm(rAlu)) this.stky |= AUS;
            R[fm] = rMul;
            R[fa] = rAlu;
            this.astat |= AF;
            return;
        }
        case 0x1b: {                    /* Fm = Fxm * Fym, Ra = FIX Fxa BY Rya */
            this.mulClear();
            this.aluClear();
            const rMul = this.fmulBits(R[fxm], R[fym]);
            const src = R[fxa];
            const rAlu = this.scalb(src, fya);
            R[fm] = rMul;
            this.fixOut(fa, rAlu, src, false);
            return;
        }
        }
        this.fatal('multi-function opcode not implemented', multiop);
    }

    /* MAME COMPUTE: the 23-bit compute field */
    compute(c) {
        if (c & 0x400000) {
            this.multi(c);
            return;
        }
        switch ((c >>> 20) & 3) {
        case 0: this.alu(c); break;
        case 1: this.mul(c); break;
        case 2: this.shift(c); break;
        default: this.fatal('invalid single-function operation', c); break;
        }
    }

    /* ---- Instructions (MAME sharcops.hxx) ------------------------------------ */

    /* UPDATE_CIRCULAR_BUFFER: the buffer is [B, B+L) */
    static postmod(d, i, mod) {
        d.i[i] = d.i[i] + mod;
        if (d.l[i] === 0) return;
        const v = d.i[i];
        if (v >= ((d.b[i] + d.l[i]) >>> 0)) d.i[i] = v - d.l[i];
        else if (v < d.b[i]) d.i[i] = v + d.l[i];
    }

    /* a DM or PM data access of a register; DM external halves are done */
    xferDreg(pm, a, wr, dreg, v) {
        if (wr) {
            if (pm) this.pmWrite32(a, v);
            else this.dmWrite(a, v);
        } else {
            this.r[dreg] = pm ? this.pmRead32(a) : this.dmRead(a);
        }
    }

    xferUreg(pm, a, wr, ureg, v) {
        if (pm && ureg === 0xdb) {      /* PX through PM is always 48-bit */
            if (wr) {
                this.pmWrite48(a, this.pxH, this.pxL);
            } else {
                this.pmRead48(a);
                this.pxH = PH;
                this.pxL = PL;
            }
        } else if (wr) {
            if (pm) this.pmWrite32(a, v);
            else this.dmWrite(a, v);
        } else {
            this.setUreg(ureg, pm ? this.pmRead32(a) : this.dmRead(a));
        }
    }

    /* a jump that changes nothing but the PC, to itself, is a busy-wait */
    goto(delayed, target, pure) {
        if (!delayed && pure && target === this.pc) this.spin = 1;
        this.jump(delayed, target);
    }

    call(delayed, target, ret) {
        this.pushPc();
        this.pcstk = ret >>> 0;
        this.jump(delayed, target);
    }

    /* RTS / RTI: IF cond return [, compute] / IF ... ELSE compute */
    ret(lo) {
        const j = (lo >>> 26) & 1, e = (lo >>> 25) & 1;
        const c = lo & 0x7fffff;
        if (!this.ifCond(this.cond)) {
            if (e && c) this.compute(c);
            return;
        }
        if (!e && c) this.compute(c);
        this.jump(j, this.popPc());
    }

    doLoop(address, code, type) {
        this.pushPc();
        this.pushLoop();
        this.pcstk = (this.pc + 1) >>> 0;
        this.laddrAddr = address >>> 0;
        this.laddrCode = code;
        this.laddrType = type;
    }

    /* the instruction lo (bits 0-31), hi (32-47); `this.cond` is bits 33-37 */
    exec(lo, hi) {
        const d1 = this.dag1, d2 = this.dag2;
        switch (OPS[(hi >>> 7) & 0x1ff]) {
        case OP_DM_PM: {                /* 001: compute / dreg <-> DM / dreg <-> PM */
            const pmDreg = (lo >>> 23) & 0xf, dmDreg = (hi >>> 1) & 0xf;
            const pmm = (lo >>> 27) & 7, pmi = ((lo >>> 30) | (hi << 2)) & 7;
            const dmm = (hi >>> 6) & 7, dmi = (hi >>> 9) & 7;
            const pmd = (hi >>> 5) & 1, dmd = (hi >>> 12) & 1;
            const pv = this.r[pmDreg], dv = this.r[dmDreg];
            if (!this.ext(d1.i[dmi], dmd, dv)) return;
            if (lo & 0x7fffff) this.compute(lo & 0x7fffff);
            this.xferDreg(1, d2.i[pmi], pmd, pmDreg, pv);
            Sharc.postmod(d2, pmi, d2.m[pmm]);
            this.xferDreg(0, d1.i[dmi], dmd, dmDreg, dv);
            Sharc.postmod(d1, dmi, d1.m[dmm]);
            return;
        }
        case OP_COMPUTE:                /* 000 00001: compute */
            if (this.ifCond(this.cond) && (lo & 0x7fffff)) this.compute(lo & 0x7fffff);
            return;
        case OP_UREG_DMPM: {            /* 010: compute / ureg <-> DM|PM, pre or post-modify */
            const i = (hi >>> 9) & 7, m = (hi >>> 6) & 7;
            const g = hi & 1, d = lo >>> 31, post = (hi >>> 12) & 1;
            const ureg = (lo >>> 23) & 0xff;
            if (!this.ifCond(this.cond)) return;
            const pu = this.getUreg(ureg);
            const dag = g ? d2 : d1;
            const a = post ? dag.i[i] : (dag.i[i] + dag.m[m]) >>> 0;
            if (!g && !this.ext(a, d, pu)) return;
            if (lo & 0x7fffff) this.compute(lo & 0x7fffff);
            this.xferUreg(g, a, d, ureg, pu);
            if (post) Sharc.postmod(dag, i, dag.m[m]);
            return;
        }
        case OP_IMMMOD: {               /* 0110: compute / dreg <-> DM|PM, immediate modify */
            const wr = (hi >>> 7) & 1, pm = (hi >>> 8) & 1;
            const u = (hi >>> 6) & 1, i = (hi >>> 9) & 7;
            const dreg = (lo >>> 23) & 0xf;
            const mod = sext(((lo >>> 27) | (hi << 5)) & 0x3f, 6);
            const v = this.r[dreg];
            if (!this.ifCond(this.cond)) return;
            const dag = pm ? d2 : d1;
            const a = u ? dag.i[i] : (dag.i[i] + mod) >>> 0;
            if (!pm && !this.ext(a, wr, v)) return;
            if (lo & 0x7fffff) this.compute(lo & 0x7fffff);
            this.xferDreg(pm, a, wr, dreg, v);
            if (u) Sharc.postmod(dag, i, mod);
            return;
        }
        case OP_UREG_UREG: {            /* 0111: compute / ureg <-> ureg */
            if (!this.ifCond(((lo >>> 31) | (hi << 1)) & 0x1f)) return;
            const v = this.getUreg((hi >>> 4) & 0xff);
            if (lo & 0x7fffff) this.compute(lo & 0x7fffff);
            this.setUreg((lo >>> 23) & 0xff, v);
            return;
        }
        case OP_SHIFT_DMPM: {           /* 1000: immediate shift / dreg <-> DM|PM */
            const i = (hi >>> 9) & 7, m = (hi >>> 6) & 7;
            const g = hi & 1, d = lo >>> 31;
            const dreg = (lo >>> 23) & 0xf;
            if (!this.ifCond(this.cond)) return;
            const v = this.r[dreg];
            const dag = g ? d2 : d1;
            if (!g && !this.ext(dag.i[i], d, v)) return;
            this.immShift(lo);
            this.xferDreg(g, dag.i[i], d, dreg, v);
            Sharc.postmod(dag, i, dag.m[m]);
            return;
        }
        case OP_SHIFT:                  /* 000 00010: immediate shift */
            if (this.ifCond(this.cond)) this.immShift(lo);
            return;
        case OP_COMPUTE_MODIFY: {       /* 000 00100: compute / modify */
            const g = (hi >>> 6) & 1, m = (lo >>> 27) & 7, i = ((lo >>> 30) | (hi << 2)) & 7;
            if (!this.ifCond(this.cond)) return;
            if (lo & 0x7fffff) this.compute(lo & 0x7fffff);
            const dag = g ? d2 : d1;
            Sharc.postmod(dag, i, dag.m[m]);
            return;
        }
        case OP_DIRECT: {               /* 000 0011x: direct (or relative) jump or call */
            const j = (lo >>> 26) & 1, call = (hi >>> 7) & 1, rel = (hi >>> 8) & 1;
            if (!this.ifCond(this.cond)) return;
            const target = rel ? (this.pc + sext(lo & 0xffffff, 24)) >>> 0 : lo & 0xffffff;
            if (call) {
                const ret = rel ? this.pc + (j ? 3 : 1) : (j ? this.nfaddr : this.daddr);
                this.call(j, target, ret);
                return;
            }
            if ((lo >>> 24) & 1) this.clearInterrupt();
            if ((hi >>> 6) & 1) {
                this.popPc();
                this.popLoop();
            }
            this.goto(j, target, !((lo >>> 24) & 1) && !((hi >>> 6) & 1));
            return;
        }
        case OP_INDIRECT: {             /* 000 0100x: indirect jump or call, with compute */
            const j = (lo >>> 26) & 1, e = (lo >>> 25) & 1, call = (hi >>> 7) & 1;
            const c = lo & 0x7fffff;
            if (!call && ((lo >>> 24) & 1)) this.clearInterrupt();
            if (!this.ifCond(this.cond)) {
                if (e && c) this.compute(c);
                return;
            }
            if (!e && c) this.compute(c);
            const target = (hi >>> 8) & 1
                ? (this.pc + sext(((lo >>> 27) | (hi << 5)) & 0x3f, 6)) >>> 0
                : (d2.i[((lo >>> 30) | (hi << 2)) & 7] + d2.m[(lo >>> 27) & 7]) >>> 0;
            if (call) {
                this.call(j, target, j ? this.nfaddr : this.daddr);
                return;
            }
            if ((hi >>> 6) & 1) {
                this.popPc();
                this.popLoop();
            }
            this.goto(j, target, !((lo >>> 24) & 1) && !((hi >>> 6) & 1) && (e || c === 0));
            return;
        }
        case OP_JUMP_DM: {              /* 11x: indirect jump, else compute / dreg <-> DM */
            const d = (hi >>> 12) & 1, dmi = (hi >>> 9) & 7, dmm = (hi >>> 6) & 7;
            const dreg = (lo >>> 23) & 0xf;
            if (this.ifCond(this.cond)) {
                const target = (hi >>> 13) & 1
                    ? (this.pc + sext(((lo >>> 27) | (hi << 5)) & 0x3f, 6)) >>> 0
                    : (d2.i[((lo >>> 30) | (hi << 2)) & 7] + d2.m[(lo >>> 27) & 7]) >>> 0;
                this.goto(0, target, true);
                return;
            }
            const v = this.r[dreg];
            if (!this.ext(d1.i[dmi], d, v)) return;
            if (lo & 0x7fffff) this.compute(lo & 0x7fffff);
            this.xferDreg(0, d1.i[dmi], d, dreg, v);
            Sharc.postmod(d1, dmi, d1.m[dmm]);
            return;
        }
        case OP_RTS:                    /* 000 01010 */
            this.ret(lo);
            return;
        case OP_RTI:                    /* 000 01011 */
            this.irptl = (this.irptl & ~(1 << this.activeIrq)) >>> 0;
            this.ret(lo);
            if (this.activeIrq >= 6 && this.activeIrq <= 8) this.popStatus();
            this.interruptActive = 0;
            this.checkInterrupts();
            return;
        case OP_DO_COUNTER: {           /* 000 0110x: DO <addr> UNTIL LCE */
            const offset = sext(lo & 0xffffff, 24) | 0;
            const dist = offset < 0 ? -offset : offset;
            const type = dist === 1 ? 1 : (dist === 2 ? 2 : 3);
            if ((hi >>> 8) & 1) this.lcntr = this.getUreg(hi & 0xff);
            else this.lcntr = ((lo >>> 24) | (hi << 8)) & 0xffff;
            this.doLoop(this.pc + offset, 0xf, type);
            return;
        }
        case OP_DO_UNTIL:               /* 000 01110: DO <addr> UNTIL cond */
            this.doLoop(this.pc + (sext(lo & 0xffffff, 24) | 0), this.cond, 0);
            return;
        case OP_UREG_DIRECT: {          /* 000 100 G D: ureg <-> DM|PM, direct address */
            const ureg = hi & 0xff, wr = (hi >>> 8) & 1, pm = (hi >>> 9) & 1;
            const v = wr ? this.getUreg(ureg) : 0;
            if (!pm && !this.ext(lo, wr, v)) return;
            this.xferUreg(pm, lo, wr, ureg, v);
            return;
        }
        case OP_UREG_INDIRECT: {        /* 101 G III D: ureg <-> DM|PM, I + offset */
            const ureg = hi & 0xff, wr = (hi >>> 8) & 1, pm = (hi >>> 12) & 1;
            const i = (hi >>> 9) & 7;
            const offset = pm && !wr ? lo & 0xffffff : lo;
            const a = ((pm ? d2 : d1).i[i] + offset) >>> 0;
            const v = wr ? this.getUreg(ureg) : 0;
            if (!pm && !this.ext(a, wr, v)) return;
            this.xferUreg(pm, a, wr, ureg, v);
            return;
        }
        case OP_IMM_DMPM: {             /* 1001: immediate data -> DM|PM */
            const i = (hi >>> 9) & 7, m = (hi >>> 6) & 7, g = (hi >>> 5) & 1;
            const dag = g ? d2 : d1;
            if (!g && !this.ext(dag.i[i], 1, lo)) return;
            if (g) this.pmWrite32(dag.i[i], lo);
            else this.dmWrite(dag.i[i], lo);
            Sharc.postmod(dag, i, dag.m[m]);
            return;
        }
        case OP_IMM_UREG:               /* 000 01111: immediate data -> ureg */
            this.setUreg(hi & 0xff, lo);
            return;
        case OP_SYSREG_BITOP: {         /* 000 10100: BIT SET/CLR/TGL/TST/XOR sreg data */
            const bop = (hi >>> 5) & 7, sreg = 0x70 | (hi & 0xf);
            let src = this.getUreg(sreg);
            switch (bop) {
            case 0: src = (src | lo) >>> 0; break;
            case 1: src = (src & ~lo) >>> 0; break;
            case 2: src = (src ^ lo) >>> 0; break;
            case 4: case 5: {
                const btf = bop === 4 ? ((src & lo) >>> 0) === lo : src === lo;
                if (btf) this.astat |= BTF;
                else this.astat &= ~BTF;
                break;
            }
            default:
                this.fatal('sysreg_bitop: invalid bitop', bop);
                return;
            }
            this.setUreg(sreg, src);    /* MAME: a TST of ASTAT writes the old ASTAT back */
            return;
        }
        case OP_MODIFY:                 /* 000 10110 0: MODIFY (I, data) */
            Sharc.postmod((hi >>> 6) & 1 ? d2 : d1, hi & 7, lo);
            return;
        case OP_PUSH_POP:               /* 000 10111: PUSH/POP LOOP, STS, PCSTK */
            if (hi & 0x80) this.pushLoop();
            if (hi & 0x40) this.popLoop();
            if (hi & 0x20) this.pushStatus();
            if (hi & 0x10) this.popStatus();
            if (hi & 0x08) this.pushPc();
            if (hi & 0x04) this.popPc();
            return;
        case OP_NOP:
            return;
        case OP_IDLE:
            this.daddr = this.pc;
            this.faddr = (this.pc + 1) >>> 0;
            this.nfaddr = (this.pc + 2) >>> 0;
            this.idle = 1;
            return;
        default:
            this.fatal('unimplemented opcode', hi);
        }
    }

    immShift(lo) {
        this.astat &= ~(SZ | SV | SS);
        const data = ((lo >>> 8) & 0xff) | ((lo >>> 19) & 0xf00);
        this.shiftOp((lo >>> 16) & 0x3f, (lo >>> 4) & 0xf, lo & 0xf, data, false);
    }

    /* ---- Execution ----------------------------------------------------------- */

    /* MAME's loop-end check, before the instruction at the loop's last address */
    loopEnd() {
        if (this.laddrType !== 0) {
            this.curlcntr = (this.curlcntr - 1) >>> 0;
            if (this.curlcntr === 0) {
                this.popLoop();
                this.popPc();
            } else {
                this.changePc(this.pcstk);
            }
            return;
        }
        if (((this.pc - this.pcstk) >>> 0) > 2) this.astat = this.astatOld3;
        if (this.doCond(this.laddrCode)) {
            this.popLoop();
            this.popPc();
        } else {
            /* a one-instruction DO UNTIL over a NOP: waiting on its condition */
            if (this.pcstk === this.pc && this.opLo === 0 && this.opHi === 0) this.spin = 1;
            this.changePc(this.pcstk);
        }
        this.astat = this.astatOld;
    }

    /* one instruction; STOP_BUDGET when the core can go on */
    step() {
        const pc = this.pc, daddr = this.daddr, faddr = this.faddr, nfaddr = this.nfaddr;
        const a0 = this.astat, a1 = this.astatOld, a2 = this.astatOld2, a3 = this.astatOld3;

        this.pc = daddr;
        this.daddr = faddr;
        this.faddr = nfaddr;
        this.nfaddr = (nfaddr + 1) >>> 0;
        this.astatOld3 = a2;
        this.astatOld2 = a1;
        this.astatOld = a0;
        this.pmRead48(this.pc);
        const lo = PL, hi = PH;
        this.opLo = lo;
        this.opHi = hi;
        this.cond = (hi >>> 1) & 0x1f;
        this.stalled = 0;
        this.spin = 0;

        const loop = !(this.stky & LSEM) && this.pc === this.laddrAddr;
        if (loop) {
            this.saveStacks();
            this.loopEnd();
        }

        this.exec(lo, hi);

        if (this.stalled) {             /* put the core back: retried next run */
            this.pc = pc; this.daddr = daddr; this.faddr = faddr; this.nfaddr = nfaddr;
            this.astat = a0; this.astatOld = a1; this.astatOld2 = a2; this.astatOld3 = a3;
            if (loop) this.restoreStacks();
            this.spin = 0;
            return STOP_STALL;
        }

        if (this.latCycles > 0 && --this.latCycles <= 0) this.latencyEffect();
        this.cycles++;

        if (this.fault) return STOP_FAULT;
        if (this.idle) return STOP_IDLE;
        if (this.spin && this.latCycles <= 0) return STOP_SPIN;
        return STOP_BUDGET;
    }
}
