/*
 * i960.js — enough of an i960 KB to run a game's own routines out of the
 * program ROM.
 *
 * Dead or Alive draws each stage with a routine of its own (js/doa.js), and
 * rather than port twelve routines by hand the explorer runs them, against a
 * bus that answers the board's coprocessor and geometrizer ports with a
 * recorder. The decoding follows MAME's i960 core and stf-tools' i960dis.mjs:
 *
 *   CTRL 0x08-0x1F  displacement sext24, from the instruction
 *   COBR 0x20-0x3F  src1 bits 19-23 (a literal under bit 13), src2 14-18,
 *                   displacement sext13
 *   REG  0x58-0x7F  opcode (w >> 20 & 0xFF0) | (w >> 7 & 0xF); src1 0-4,
 *                   src2 14-18, dst 19-23; bits 11 and 12 make src1 and src2
 *                   literals, and for the real ops a set bit names fp0-fp3 or a
 *                   constant (0x10 is 0.0, 0x16 is 1.0), as bit 13 does dst
 *   MEM  0x80-0xCF  MEMA below mode 4 (offset 0-11, plus abase under bit 13);
 *                   MEMB modes 4 (abase), 5 (ip + 8 + disp), 7 (abase + index),
 *                   0xC (disp), 0xD (+abase), 0xE (+index), 0xF (all three)
 *
 * Registers 0-15 are r0-r15, the locals a call saves (r0 pfp, r1 sp, r2 rip),
 * and 16-31 g0-g15, g15 being fp. A call frame is MAME's: the new fp is sp
 * rounded up to 64, and sp sits 64 above it.
 */

const PFP = 0, SP = 1, RIP = 2, FP = 31;
/* Condition codes: greater, equal, less. Unordered is none of them. */
const CC_G = 1, CC_E = 2, CC_L = 4;

const sext = (v, bits) => (v << (32 - bits)) >> (32 - bits);
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const f64 = new Float64Array(1);
const u64 = new Uint32Array(f64.buffer);
const bitsToFloat = (b) => { u32[0] = b; return f32[0]; };
const floatToBits = (v) => { f32[0] = v; return u32[0]; };

/* A comparison's condition code. */
function compare(a, b) {
    if (a < b) return CC_L;
    if (a > b) return CC_G;
    return a === b ? CC_E : 0;
}

/* Integer REG ops: (src1, src2, dst's old value, cpu) -> result. Unsigned
 * values come in as u32 and signed ones are taken with `| 0` where it matters. */
const LOGIC = {
    0x580: (a, b) => b ^ (1 << (a & 31)),
    0x581: (a, b) => b & a,
    0x582: (a, b) => b & ~a,
    0x583: (a, b) => b | (1 << (a & 31)),
    0x584: (a, b) => ~b & a,
    0x586: (a, b) => b ^ a,
    0x587: (a, b) => b | a,
    0x588: (a, b) => ~(b | a),
    0x589: (a, b) => ~(b ^ a),
    0x58a: (a) => ~a,
    0x58b: (a, b) => b | ~a,
    0x58c: (a, b) => b & ~(1 << (a & 31)),
    0x58d: (a, b) => ~b | a,
    0x58e: (a, b) => ~(b & a),
    0x58f: (a, b, d, cpu) => (cpu.cc & CC_E ? b | (1 << (a & 31)) : b & ~(1 << (a & 31))),
    0x590: (a, b) => b + a,
    0x591: (a, b) => b + a,
    0x592: (a, b) => b - a,
    0x593: (a, b) => b - a,
    0x598: (a, b) => (a > 31 ? 0 : b >>> a),
    0x59a: (a, b) => (a > 31 ? 0 : Math.trunc((b | 0) / 2 ** a)),
    0x59b: (a, b) => (b | 0) >> Math.min(a, 31),
    0x59c: (a, b) => (a > 31 ? 0 : b << a),
    0x59d: (a, b) => (b << (a & 31)) | (b >>> ((32 - (a & 31)) & 31)),
    0x59e: (a, b) => (a > 31 ? 0 : b << a),
    0x5cc: (a) => a,
    0x650: (a, b, d) => (b & a) | (d & ~a),
    0x651: (a, b, d) => (d >>> (a & 31)) & (b >= 32 ? 0xffffffff : (1 << b) - 1),
    0x701: (a, b) => Math.imul(a, b),
    0x708: (a, b) => (a ? (b >>> 0) % (a >>> 0) : 0),
    0x70b: (a, b) => (a ? Math.trunc((b >>> 0) / (a >>> 0)) : 0),
    0x741: (a, b) => Math.imul(a, b),
    0x748: (a, b) => (a | 0 ? (b | 0) % (a | 0) : 0),
    0x749: (a, b) => { const r = a | 0 ? (b | 0) % (a | 0) : 0; return r && (r < 0) !== ((a | 0) < 0) ? r + (a | 0) : r; },
    0x74b: (a, b) => (a | 0 ? Math.trunc((b | 0) / (a | 0)) : 0),
};

/* Integer compares that set the condition code and maybe write dst. */
const COMPARES = {
    0x5a0: (a, b) => [compare(a >>> 0, b >>> 0)],
    0x5a1: (a, b) => [compare(a | 0, b | 0)],
    0x5a4: (a, b) => [compare(a >>> 0, b >>> 0), b + 1],
    0x5a5: (a, b) => [compare(a | 0, b | 0), b + 1],
    0x5a6: (a, b) => [compare(a >>> 0, b >>> 0), b - 1],
    0x5a7: (a, b) => [compare(a | 0, b | 0), b - 1],
};

/* Branch masks: the low three bits of a conditional op. */
const taken = (cc, mask) => (mask ? (cc & mask) !== 0 : cc === 0);

/*
 * The real ops, as (op, long-real?) -> what they take and give. `kind`:
 *   'bin'  dst = f(src1, src2)       'un'  dst = f(src1)
 *   'cmp'  cc  = compare(src1, src2) 'toi' integer dst from a real src1
 *   'fromi' real dst from an integer src1
 */
const REAL = {
    0x674: { kind: 'fromi', f: (a) => a | 0 },
    0x675: { kind: 'fromi', long: true, f: (a) => a | 0 },
    0x684: { kind: 'cmp' }, 0x685: { kind: 'cmp' },
    0x694: { kind: 'cmp', long: true }, 0x695: { kind: 'cmp', long: true },
    0x688: { kind: 'un', f: Math.sqrt }, 0x698: { kind: 'un', long: true, f: Math.sqrt },
    0x68b: { kind: 'un', f: Math.round }, 0x69b: { kind: 'un', long: true, f: Math.round },
    0x68c: { kind: 'un', f: Math.sin }, 0x69c: { kind: 'un', long: true, f: Math.sin },
    0x68d: { kind: 'un', f: Math.cos }, 0x69d: { kind: 'un', long: true, f: Math.cos },
    0x68e: { kind: 'un', f: Math.tan }, 0x69e: { kind: 'un', long: true, f: Math.tan },
    0x680: { kind: 'bin', f: (a, b) => Math.atan2(b, a) },
    0x690: { kind: 'bin', long: true, f: (a, b) => Math.atan2(b, a) },
    0x6c0: { kind: 'toi', f: Math.round }, 0x6c1: { kind: 'toi', long: true, f: Math.round },
    0x6c2: { kind: 'toi', f: Math.trunc }, 0x6c3: { kind: 'toi', long: true, f: Math.trunc },
    0x6c9: { kind: 'un', f: (a) => a }, 0x6d9: { kind: 'un', long: true, f: (a) => a },
    0x6e1: { kind: 'un', long: true, f: (a) => a }, 0x6e9: { kind: 'un', long: true, f: (a) => a },
    0x78b: { kind: 'bin', f: (a, b) => b / a }, 0x79b: { kind: 'bin', long: true, f: (a, b) => b / a },
    0x78c: { kind: 'bin', f: (a, b) => b * a }, 0x79c: { kind: 'bin', long: true, f: (a, b) => b * a },
    0x78d: { kind: 'bin', f: (a, b) => b - a }, 0x79d: { kind: 'bin', long: true, f: (a, b) => b - a },
    0x78f: { kind: 'bin', f: (a, b) => b + a }, 0x79f: { kind: 'bin', long: true, f: (a, b) => b + a },
};

/* MEM loads and stores: bytes moved, signed?, registers. */
const LOADS = {
    0x80: [1, false], 0x88: [2, false], 0x90: [4, false], 0x98: [4, false, 2],
    0xa0: [4, false, 3], 0xb0: [4, false, 4], 0xc0: [1, true], 0xc8: [2, true],
};
const STORES = {
    0x82: [1], 0x8a: [2], 0x92: [4], 0x9a: [4, 2], 0xa2: [4, 3], 0xb2: [4, 4], 0xc2: [1], 0xca: [2],
};

export class I960 {
    /**
     * @param {object} bus  read8/16/32 and write8/16/32, addresses as u32
     */
    constructor(bus) {
        this.bus = bus;
        this.r = new Uint32Array(32);
        this.fp = new Float64Array(4);
        this.cc = 0;
        this.ip = 0;
        this.frames = [];
        /* Addresses a call is answered at by a function instead of the ROM:
         * fn(cpu) runs in place of the routine and the call returns at once. */
        this.hooks = new Map();
        this.steps = 0;
    }

    /**
     * Call `entry` with g0.. = `args` and run until it returns.
     * @returns {boolean} whether it returned inside `maxSteps`
     */
    call(entry, args = [], { maxSteps = 2_000_000, stack = 0x5f0000 } = {}) {
        this.r.fill(0);
        args.forEach((v, i) => { this.r[16 + i] = v; });
        this.r[FP] = stack;
        this.r[SP] = stack + 64;
        const depth = this.frames.length;
        this.ip = 0xfffffff0;
        this.doCall(entry);
        for (this.steps = 0; this.steps < maxSteps; this.steps++) {
            if (this.frames.length === depth) return true;
            this.step();
        }
        this.frames.length = depth;
        return false;
    }

    reg(i) { return this.r[i]; }
    setReg(i, v) { this.r[i] = v; }

    doCall(target) {
        const hook = this.hooks.get(target);
        if (hook) {
            hook(this);
            return;
        }
        this.r[RIP] = this.ip;
        this.frames.push(this.r.slice(0, 16));
        const fp = this.r[FP];
        this.r[PFP] = fp;
        this.r[FP] = (this.r[SP] + 63) & ~63;
        this.r[SP] = this.r[FP] + 64;
        this.ip = target >>> 0;
    }

    doRet() {
        const saved = this.frames.pop();
        const fp = this.r[PFP];
        if (saved) this.r.set(saved, 0);
        this.r[FP] = fp;
        this.ip = this.r[RIP];
    }

    step() {
        const ip = this.ip;
        const w = this.bus.read32(ip);
        const op = w >>> 24;
        this.ip = ip + 4;
        if (op < 0x20) this.ctrl(op, w, ip);
        else if (op < 0x40) this.cobr(op, w, ip);
        else if (op < 0x80) this.regOp(w, ip);
        else this.mem(op, w, ip);
    }

    unknown(ip, w) {
        throw new Error(`i960: unhandled 0x${w.toString(16).padStart(8, '0')} at 0x${ip.toString(16)}`);
    }

    ctrl(op, w, ip) {
        const to = (ip + (sext(w & 0xfffffc, 24))) >>> 0;
        if (op === 0x08) this.ip = to;
        else if (op === 0x09) this.doCall(to);
        else if (op === 0x0a) this.doRet();
        else if (op === 0x0b) { this.r[30] = this.ip; this.ip = to; }
        else if (op >= 0x10 && op <= 0x17) { if (taken(this.cc, op & 7)) this.ip = to; }
        /* The faults are checks the game never fails here. */
        else if (op < 0x18 || op > 0x1f) this.unknown(ip, w);
    }

    cobr(op, w, ip) {
        const s1 = (w >>> 19) & 31;
        const s2 = (w >>> 14) & 31;
        const to = (ip + sext(w & 0x1ffc, 13)) >>> 0;
        if (op < 0x28) {
            /* test*: the condition into the register src1 names. */
            this.r[s1] = taken(this.cc, op & 7) ? 1 : 0;
            return;
        }
        const a = w & 0x2000 ? s1 : this.r[s1];
        const b = this.r[s2];
        if (op === 0x30 || op === 0x37) {
            const set = (b >>> (a & 31)) & 1;
            this.cc = set ? CC_E : 0;
            if ((op === 0x37) === !!set) this.ip = to;
            return;
        }
        this.cc = op < 0x38 ? compare(a >>> 0, b >>> 0) : compare(a | 0, b | 0);
        if (taken(this.cc, op & 7)) this.ip = to;
    }

    regOp(w, ip) {
        const opc = ((w >>> 20) & 0xff0) | ((w >>> 7) & 0xf);
        const s1 = w & 31, s2 = (w >>> 14) & 31, dst = (w >>> 19) & 31;
        if (REAL[opc]) { this.realOp(opc, w, s1, s2, dst); return; }
        const a = w & 0x800 ? s1 : this.r[s1];
        const b = w & 0x1000 ? s2 : this.r[s2];
        if (LOGIC[opc]) { this.r[dst] = LOGIC[opc](a, b, this.r[dst], this); return; }
        if (COMPARES[opc]) {
            const [cc, v] = COMPARES[opc](a, b);
            this.cc = cc;
            if (v !== undefined) this.r[dst] = v;
            return;
        }
        this.regMisc(opc, w, ip, a, b, s1, dst);
    }

    regMisc(opc, w, ip, a, b, s1, dst) {
        if (opc === 0x5dc || opc === 0x5ec || opc === 0x5fc) {
            const n = opc === 0x5dc ? 2 : opc === 0x5ec ? 3 : 4;
            const vals = [];
            for (let k = 0; k < n; k++) vals.push(w & 0x800 ? (k ? 0 : s1) : this.r[s1 + k]);
            vals.forEach((v, k) => { this.r[dst + k] = v; });
        } else if (opc === 0x5a2 || opc === 0x5a3) {
            if (!(this.cc & CC_L)) {
                const le = opc === 0x5a2 ? a >>> 0 <= b >>> 0 : (a | 0) <= (b | 0);
                this.cc = le ? CC_E : CC_G;
            }
        } else if (opc === 0x5ae) {
            this.cc = (b >>> (a & 31)) & 1 ? CC_E : 0;
        } else if (opc === 0x5ac) {
            let hit = false;
            for (let k = 0; k < 32; k += 8) hit ||= ((a >>> k) & 0xff) === ((b >>> k) & 0xff);
            this.cc = hit ? CC_E : 0;
        } else if (opc === 0x640 || opc === 0x641) {
            this.scanBits(opc, a, dst);
        } else if (opc === 0x670) {
            const p = BigInt.asUintN(64, BigInt(a >>> 0) * BigInt(b >>> 0));
            this.r[dst] = Number(p & 0xffffffffn);
            this.r[dst + 1] = Number(p >> 32n);
        } else if (opc === 0x645 || opc === 0x654 || opc === 0x655 || opc === 0x66b || opc === 0x66c
            || opc === 0x66d || opc === 0x66f || opc === 0x5b0 || opc === 0x5b2) {
            /* Process controls, trace marks and the carry ops: nothing here needs them. */
            if (opc === 0x5b0) this.r[dst] = b + a;
            if (opc === 0x5b2) this.r[dst] = b - a - 1;
        } else {
            this.unknown(ip, w);
        }
    }

    scanBits(opc, a, dst) {
        const want = opc === 0x641 ? 1 : 0;
        for (let k = 31; k >= 0; k--) {
            if (((a >>> k) & 1) === want) { this.r[dst] = k; this.cc = CC_E; return; }
        }
        this.r[dst] = 0xffffffff;
        this.cc = 0;
    }

    /* A real operand: fp0-fp3 or a constant under its mode bit, else the
     * register (or register pair) read as a single (or a double). */
    realIn(idx, lit, long) {
        if (lit) {
            if (idx < 4) return this.fp[idx];
            return idx === 0x16 ? 1 : 0;
        }
        if (!long) return bitsToFloat(this.r[idx]);
        u64[0] = this.r[idx & 0x1e];
        u64[1] = this.r[(idx & 0x1e) + 1];
        return f64[0];
    }

    realOut(idx, toFp, long, v) {
        if (toFp) { this.fp[idx & 3] = v; return; }
        if (!long) { this.r[idx] = floatToBits(v); return; }
        f64[0] = v;
        this.r[idx & 0x1e] = u64[0];
        this.r[(idx & 0x1e) + 1] = u64[1];
    }

    realOp(opc, w, s1, s2, dst) {
        const R = REAL[opc];
        const m1 = !!(w & 0x800), m2 = !!(w & 0x1000), m3 = !!(w & 0x2000);
        const long = !!R.long;
        if (R.kind === 'fromi') { this.realOut(dst, m3, long, R.f(m1 ? s1 : this.r[s1])); return; }
        if (R.kind === 'toi') {
            const v = R.f(this.realIn(s1, m1, long));
            if (long) {
                const big = BigInt.asUintN(64, BigInt(Number.isFinite(v) ? v : 0));
                this.r[dst] = Number(big & 0xffffffffn);
                this.r[dst + 1] = Number(big >> 32n);
            } else this.r[dst] = v | 0;
            return;
        }
        const a = this.realIn(s1, m1, long);
        if (R.kind === 'cmp') { this.cc = compare(a, this.realIn(s2, m2, long)); return; }
        const v = R.kind === 'un' ? R.f(a) : R.f(a, this.realIn(s2, m2, long));
        this.realOut(dst, m3, long, v);
    }

    /* The effective address of a MEM instruction, and how long it was. */
    ea(w, ip) {
        const mode = (w >>> 10) & 15;
        const abase = this.r[(w >>> 14) & 31];
        if (!(mode & 4)) {
            const offset = w & 0xfff;
            return [(w & 0x2000 ? abase + offset : offset) >>> 0, 4];
        }
        const index = this.r[w & 31] << ((w >>> 7) & 7);
        if (mode === 4) return [abase, 4];
        if (mode === 7) return [(abase + index) >>> 0, 4];
        const disp = this.bus.read32(ip + 4);
        if (mode === 5) return [(ip + 8 + disp) >>> 0, 8];
        if (mode === 0xc) return [disp >>> 0, 8];
        if (mode === 0xd) return [(disp + abase) >>> 0, 8];
        if (mode === 0xe) return [(disp + index) >>> 0, 8];
        if (mode === 0xf) return [(disp + abase + index) >>> 0, 8];
        this.unknown(ip, w);
        return [0, 4];
    }

    mem(op, w, ip) {
        const [addr, len] = this.ea(w, ip);
        this.ip = ip + len;
        const reg = (w >>> 19) & 31;
        if (op === 0x8c) { this.r[reg] = addr; return; }
        if (LOADS[op]) { this.load(addr, reg, ...LOADS[op]); return; }
        if (STORES[op]) { this.store(addr, reg, ...STORES[op]); return; }
        if (op === 0x84) { this.ip = addr; return; }
        if (op === 0x85) { this.r[reg] = this.ip; this.ip = addr; return; }
        if (op === 0x86) { this.doCall(addr); return; }
        this.unknown(ip, w);
    }

    load(addr, reg, size, signed, count = 1) {
        const bus = this.bus;
        if (size === 1) { const v = bus.read8(addr); this.r[reg] = signed ? sext(v, 8) : v; return; }
        if (size === 2) { const v = bus.read16(addr); this.r[reg] = signed ? sext(v, 16) : v; return; }
        for (let k = 0; k < count; k++) this.r[reg + k] = bus.read32(addr + 4 * k, k, count);
    }

    store(addr, reg, size, count = 1) {
        const bus = this.bus;
        if (size === 1) { bus.write8(addr, this.r[reg] & 0xff); return; }
        if (size === 2) { bus.write16(addr, this.r[reg] & 0xffff); return; }
        for (let k = 0; k < count; k++) bus.write32(addr + 4 * k, this.r[reg + k], k, count);
    }
}

export { bitsToFloat, floatToBits };
