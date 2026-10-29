/*
 * scsp.js — Yamaha YMF292 "SCSP", the Model 2 sound board's sound chip.
 *
 * A port of m2-hle2's src/board/scsp.h (commit 6a15509), which follows MAME's
 * scsp.cpp / scspdsp.cpp; every sample comes out bit for bit as the C chip
 * makes it (checked sample for sample against it on Sonic the Fighters',
 * Virtua Fighter 2's and Sega Rally's drivers, on the 68000, and through the
 * whole board on Dead or Alive's and The House of the Dead's too). A DSP
 * program that has run a while unchanged is compiled to a function of its own
 * (dspCompile), which does the same arithmetic three times as fast.
 *
 * The C chip makes its samples late ("the chip's own time"): it only counts
 * sample boundaries, and makes what it owes when something looks. This one
 * makes each sample at tick(), from the state as it stands; the C chip's
 * catch-up rules exist to give exactly that answer, so the samples, the slot
 * monitor and KYONB read the same. One piece of the lazy machinery does show
 * in the output, and is kept: "a quiet DSP" (the C default, g_scsp_exact 0)
 * stops running the DSP while it is silent, a 68000 write into its delay ring
 * wakes it only while samples are owed, and the stop is refused while the
 * chip is `coupled` (worked out after register writes, as the C does). So the
 * host tells the chip the two things that decide "owed":
 *   - sync()                 at the end of each run, where sound_run calls
 *                            scsp_sync;
 *   - ramTouch(addr, sz, w)  before every 68000 access to sound RAM (w = 1 for
 *                            a write), where sound.h calls scsp_ram_touch.
 *                            Reads may be passed or not outside the DSP's
 *                            64 KB pages; they do nothing there.
 *
 * Interface:
 *   new SCSP(ram, clock)   ram: Uint8Array(0x80000), sound RAM, big-endian
 *                          words, shared with the 68000; clock(): the 68000's
 *                          clock-period count (what scsp_reset's &cycles gives)
 *   reset()                scsp_reset
 *   read(off, sz)          scsp_read: off 0..0xFFF into the registers, sz 1/2/4
 *   write(off, val, sz)    scsp_write
 *   peek16(off)            scsp_peek16, no side effects
 *   timers(now)            scsp_timers
 *   irqLevel()             scsp_irq_level
 *   tick()                 scsp_tick: makes the sample now, into this.outL and
 *                          this.outR (int16 values)
 *   sync()                 the host's scsp_sync at the end of a run (above)
 *   ramTouch(addr, sz, w)  scsp_ram_touch (above)
 *   midiIn(b)              scsp_midi_in
 *   midiRoom()             scsp_midi_room
 *   moAvailable(), moPop() the MIDI out ring the i960 reads (sound.h's mo /
 *                          mo_r / mo_w): moPop() returns 0 when it is empty
 *
 * Registers (16-bit, big-endian, offsets from the chip base):
 *   0x000-0x3FF  32 slots x 0x20
 *   0x400-0x42F  common: MVOL, RBL/RBP, MIDI in/out, monitor, DMA, timers,
 *                interrupts (SCIEB/SCIPD/SCIRE/SCILV0-2), MCIEB/MCIPD/MCIRE
 *   0x600-0x6FF  sound stack (the last output of each slot, for FM)
 *   0x700-0x77F  DSP COEF, 0x780-0x7BF MADRS (0x7C0-0x7FF nothing), 0x800-0xBFF MPRO,
 *   0xC00-0xEFF  DSP TEMP / MEMS / MIXS / EFREG read-back
 */

const SHIFT = 12;            /* play position: 20.12 samples */
const EG_SHIFT = 16;
const LFO_SHIFT = 8;

const ATTACK = 0, DECAY1 = 1, DECAY2 = 2, RELEASE = 3;

/* interrupt sources: bit numbers in SCIEB / SCIPD / SCIRE / SCILVn */
const INT_MIDI_IN = 3;
const INT_TIMER_A = 6;
const INT_TIMER_B = 7;       /* timer C shares timer B's SCILV bit */

const RAM_SIZE = 0x80000;

/* "A quiet DSP" thresholds (scsp.h defaults) */
const DSP_QUIET = 512;
const DSP_QUIET_EF = 2;
const DSP_QUIET_RUN = 128;

/* MPRO step flags (scsp.h SCSP_DF_*) */
const DF_IW_SELF = 1 << 0, DF_TWT = 1 << 1, DF_XSEL = 1 << 2, DF_BSEL = 1 << 3, DF_ZERO = 1 << 4,
    DF_NEGB = 1 << 5, DF_YRL = 1 << 6, DF_Y_COEF = 1 << 7, DF_Y_YREG = 1 << 8, DF_SAT = 1 << 9,
    DF_FRCL = 1 << 10, DF_ADRL = 1 << 11, DF_ADRL_SH = 1 << 12, DF_TABLE = 1 << 13, DF_ADREB = 1 << 14;

/* ---- tables (computed as the C does: float where it uses float) ---------- */

const fr = Math.fround;

const EG_TABLE = new Int32Array(0x400);
const LPAN = new Int32Array(0x10000), RPAN = new Int32Array(0x10000);
const AR_TABLE = new Int32Array(64), DR_TABLE = new Int32Array(64);
/* LFO waveforms, [saw, square, triangle, noise] x 256 */
const ALFO = new Int32Array(4 * 256), PLFO = new Int32Array(4 * 256);
/* The pitch LFO scales (rows 0-7, by PLFOS) then the amplitude ones (rows
 * 8-15, by ALFOS), in one array: the noise waveform's pitch table holds
 * 128 - a, so a lookup can land one past its row, on the next row's first
 * entry, as in MAME. */
const LFO_SCALE = new Int32Array(16 * 256);
const LFO_STEP = new Uint32Array(32);   /* the LFO's phase step by LFOF */

const AR_MS = [
    100000, 100000, 8100.0, 6900.0, 6000.0, 4800.0, 4000.0, 3400.0, 3000.0, 2400.0, 2000.0, 1700.0, 1500.0,
    1200.0, 1000.0, 860.0, 760.0, 600.0, 500.0, 430.0, 380.0, 300.0, 250.0, 220.0, 190.0, 150.0, 130.0, 110.0, 95.0,
    76.0, 63.0, 55.0, 47.0, 38.0, 31.0, 27.0, 24.0, 19.0, 15.0, 13.0, 12.0, 9.4, 7.9, 6.8, 6.0, 4.7, 3.8, 3.4, 3.0, 2.4,
    2.0, 1.8, 1.6, 1.3, 1.1, 0.93, 0.85, 0.65, 0.53, 0.44, 0.40, 0.35, 0.0, 0.0];
const DR_MS = [
    100000, 100000, 118200.0, 101300.0, 88600.0, 70900.0, 59100.0, 50700.0, 44300.0, 35500.0, 29600.0, 25300.0, 22200.0, 17700.0,
    14800.0, 12700.0, 11100.0, 8900.0, 7400.0, 6300.0, 5500.0, 4400.0, 3700.0, 3200.0, 2800.0, 2200.0, 1800.0, 1600.0, 1400.0, 1100.0,
    920.0, 790.0, 690.0, 550.0, 460.0, 390.0, 340.0, 270.0, 230.0, 200.0, 170.0, 140.0, 110.0, 98.0, 85.0, 68.0, 57.0, 49.0, 43.0, 34.0,
    28.0, 25.0, 22.0, 18.0, 14.0, 12.0, 11.0, 8.5, 7.1, 6.1, 5.4, 4.3, 3.6, 3.1];
const LFO_HZ = [
    0.17, 0.19, 0.23, 0.27, 0.34, 0.39, 0.45, 0.55, 0.68, 0.78, 0.92, 1.10, 1.39, 1.60, 1.87, 2.27,
    2.87, 3.31, 3.92, 4.79, 6.15, 7.18, 8.60, 10.8, 14.4, 17.2, 21.5, 28.7, 43.1, 57.4, 86.1, 172.3].map(fr);
const ASCALE_DB = [0.0, 0.4, 0.8, 1.5, 3.0, 6.0, 12.0, 24.0].map(fr);
const PSCALE_CENT = [0.0, 7.0, 13.5, 27.0, 55.0, 112.0, 230.0, 494.0].map(fr);
const SDL_DB = [-1000000.0, -36.0, -30.0, -24.0, -18.0, -12.0, -6.0, 0.0].map(fr);

/* powf, as glibc / musl round it (correctly rounded on every input the
 * tables use: checked against the C's tables). */
function powf(x, y) { return fr(Math.pow(x, y)); }

/* the TL attenuation: one step of dB per bit */
function tlGain(itl) {
    const steps = [0.4, 0.8, 1.5, 3.0, 6.0, 12.0, 24.0, 48.0];
    let db = fr(0);
    for (let b = 0; b < 8; b++) if (itl & (1 << b)) db = fr(db - fr(steps[b]));
    return powf(10, fr(db / 20));
}

/* the pan attenuation of the quieter side (0xF in the low bits mutes it) */
function panGain(ipan) {
    const steps = [3.0, 6.0, 12.0, 24.0];
    let db = fr(0);
    for (let b = 0; b < 4; b++) if (ipan & (1 << b)) db = fr(db - fr(steps[b]));
    return (ipan & 0xF) === 0xF ? 0 : powf(10, fr(db / 20));
}

function lcgStep(s) { return (Math.imul(s, 1103515245) + 12345) >>> 0; }

(function buildTables() {
    for (let i = 0; i < 0x400; i++) {
        const db = fr(fr(3 * (i - 0x3FF)) / 32);
        EG_TABLE[i] = Math.trunc(fr(powf(10, fr(db / 20)) * 4096));
    }
    /* level/pan: index = TL | PAN << 8 | SDL << 13 */
    const tl = new Float64Array(256), pan = new Float64Array(32), sdl = new Float64Array(8);
    for (let i = 0; i < 256; i++) tl[i] = tlGain(i);
    for (let i = 0; i < 32; i++) pan[i] = panGain(i);
    for (let i = 1; i < 8; i++) sdl[i] = powf(10, fr(SDL_DB[i] / 20));
    for (let i = 0; i < 0x10000; i++) {
        const itl = i & 0xFF, ipan = (i >> 8) & 0x1F, isdl = (i >> 13) & 7;
        const p = pan[ipan];
        const lp = ipan < 0x10 ? p : 1, rp = ipan < 0x10 ? 1 : p;
        LPAN[i] = Math.trunc(fr(4096 * fr(fr(fr(4 * lp) * tl[itl]) * sdl[isdl])));
        RPAN[i] = Math.trunc(fr(4096 * fr(fr(fr(4 * rp) * tl[itl]) * sdl[isdl])));
    }
    for (let i = 2; i < 64; i++) {
        const scale = 1 << EG_SHIFT;
        AR_TABLE[i] = AR_MS[i] !== 0 ? Math.trunc((1023 * 1000.0) / (44100.0 * AR_MS[i]) * scale) : 1024 << EG_SHIFT;
        DR_TABLE[i] = Math.trunc((1023 * 1000.0) / (44100.0 * DR_MS[i]) * scale);
    }
    let seed = 0x5C5B;
    for (let i = 0; i < 256; i++) {
        ALFO[i] = 255 - i;
        PLFO[i] = i < 128 ? i : i - 256;
        ALFO[256 + i] = i < 128 ? 255 : 0;
        PLFO[256 + i] = i < 128 ? 127 : -128;
        ALFO[512 + i] = i < 128 ? 255 - i * 2 : i * 2 - 256;
        PLFO[512 + i] = i < 64 ? i * 2 : i < 128 ? 255 - i * 2 : i < 192 ? 256 - i * 2 : i * 2 - 511;
        seed = lcgStep(seed);
        const a = (seed >>> 8) & 0xFF;          /* MAME: machine().rand() */
        ALFO[768 + i] = a;
        PLFO[768 + i] = 128 - a;
    }
    for (let s = 0; s < 8; s++) {
        for (let i = -128; i < 128; i++) {
            const cents = fr(fr(PSCALE_CENT[s] * i) / 128);
            LFO_SCALE[s * 256 + i + 128] = Math.trunc(fr(256 * powf(2, fr(cents / 1200))));
        }
        for (let i = 0; i < 256; i++) {
            const db = fr(fr(-ASCALE_DB[s] * i) / 256);
            LFO_SCALE[(8 + s) * 256 + i] = Math.trunc(fr(256 * powf(10, fr(db / 20))));
        }
    }
    for (let f = 0; f < 32; f++) LFO_STEP[f] = Math.trunc(fr(256 * fr(fr(LFO_HZ[f] * 256) / 44100)));
})();

/* the largest entry of each LFO scale row, for the slots' RAM ranges */
const LFO_SCALE_MAX = new Int32Array(16);
for (let r = 0; r < 16; r++) {
    let mx = 0;
    for (let k = 0; k < 256; k++) if (LFO_SCALE[r * 256 + k] > mx) mx = LFO_SCALE[r * 256 + k];
    LFO_SCALE_MAX[r] = mx;
}

/* The delay line's 16-bit float, MAME's format (scsp.h scsp_dsp_pack / unpack). */
function dspPack(val) {
    const sign = (val >>> 23) & 1;
    const temp = (val ^ (val << 1)) & 0xFFFFFF;
    const exponent = Math.clz32(((temp << 8) | 0x80000) >>> 0);
    const mant = ((val << (exponent - (exponent === 12 ? 1 : 0))) >>> 11) & 0x7FF;
    return mant | sign << 15 | exponent << 11;
}

function dspUnpack(val) {
    const sign = (val >> 15) & 1;
    let exponent = (val >> 11) & 0xF;
    let uval = (val & 0x7FF) << 11;
    if (exponent > 11) { exponent = 11; uval |= sign << 22; }
    else uval |= (sign ^ 1) << 22;
    uval |= sign << 23;
    uval = (uval << 8) >> 8;
    return uval >> exponent;
}

/* A DSP program as a JavaScript function: dspStep's loop with each step's
 * fields made constants and the branches they decide taken out, which runs
 * the program three times as fast as reading the fields every step. The same
 * arithmetic in the same order, so the same samples. Answers null where the
 * global scope will not compile code (a Content-Security-Policy without
 * 'unsafe-eval'); dspStep then interprets the program as before. */
function dspCompile(c) {
    const L = [];
    for (let st = 0; st < c.opsRun; st++) {
        const f = c.opF[st];
        const usesTr = !(f & DF_ZERO) && !(f & DF_BSEL) || !(f & DF_XSEL);
        L.push(`/* ${st} */`);
        L.push((f & DF_IW_SELF) ? 'inputs = memval;' : `inputs = (inb[${c.opIra[st]}] << 8) >> 8;`);
        if (c.opIwa[st] !== 0x3F) L.push(`inb[${c.opIwa[st]}] = memval;`);
        if (usesTr) L.push(`tr = (temp[(${c.opTra[st]} + dec) & 0x7F] << 8) >> 8;`);
        let b;
        if (f & DF_ZERO) b = '0';
        else b = (f & DF_NEGB) ? `(-${(f & DF_BSEL) ? 'acc' : 'tr'} | 0)` : (f & DF_BSEL) ? 'acc' : 'tr';
        const x = (f & DF_XSEL) ? 'inputs' : 'tr';
        const ys = (f & DF_Y_YREG) ? 'yreg' : (f & DF_Y_COEF) ? `coef[${c.opCoef[st]}]` : 'frc';
        L.push(`y = (((${ys} >> ${c.opYsh[st]}) & ${c.opYmask[st]}) << 19) >> 19;`);
        if (f & DF_YRL) L.push('yreg = inputs;');
        const v = c.opDbl[st] ? 'acc * 2' : 'acc';
        if (f & DF_SAT) L.push(`v = ${v}; shifted = v > 0x7FFFFF ? 0x7FFFFF : v < -0x800000 ? -0x800000 : v;`);
        else L.push(`shifted = ((${v} | 0) << 8) >> 8;`);
        L.push(`acc = (Math.imul(${x} >> 12, y) + (Math.imul(${x} & 0xFFF, y) >> 12) + ${b}) | 0;`);
        if (f & DF_TWT) L.push(`temp[(${c.opTwa[st]} + dec) & 0x7F] = shifted;`);
        if (f & DF_FRCL) L.push(`frc = (shifted >> ${c.opFrcSh[st]}) & ${c.opFrcMask[st]};`);
        if (c.opMem[st]) {
            const eb = (f & DF_ADREB) ? ' + (adrs & 0x0FFF)' : '';
            const nx = c.opNxadr[st] ? ' + 1' : '';
            L.push((f & DF_TABLE)
                ? `addr = (madrs[${c.opMasa[st]}]${eb}${nx}) & 0xFFFF;`
                : `addr = (madrs[${c.opMasa[st]}] + dec${eb}${nx}) & rblMask;`);
            L.push('addr = ((addr + rbp) << 1) & 0xFFFFF;');
            if (c.opMrd[st]) {
                L.push(`w = addr + 1 < ${RAM_SIZE} ? (ram[addr] << 8) | ram[addr + 1] : s.ramW(addr);`);
                L.push(c.opNofl[st] ? 'memval = w << 8;' : 'memval = dspUnpack(w);');
            }
            if (c.opMwt[st]) L.push(`s.ramWW(addr, ${c.opNofl[st] ? '(shifted >> 8) & 0xFFFF' : 'dspPack(shifted)'});`);
        }
        if (f & DF_ADRL) L.push((f & DF_ADRL_SH) ? 'adrs = (shifted >> 12) & 0xFFF;' : 'adrs = inputs >> 16;');
        if (c.opEwa[st] !== 16) L.push(`efs[${c.opEwa[st]}] += shifted >> 8;`);
    }
    try {
        return new Function('dspPack', 'dspUnpack', `return function (s, inb, temp, coef, madrs, ram, efs, dec, rblMask, rbp) {
    let acc = 0, memval = 0, frc = 0, yreg = 0, adrs = 0, inputs = 0, tr = 0, y = 0, v = 0, shifted = 0, addr = 0, w = 0;
${L.join('\n')}
};`)(dspPack, dspUnpack);
    } catch (e) {
        return null;
    }
}

/* Samples a program runs unchanged before it is compiled: the driver writes
 * one a word at a time, and compiling each half-written one would cost more
 * than it saves. */
const DSP_COMPILE_AFTER = 256;

class Slot {
    constructor() {
        this.r = new Uint16Array(16);    /* register words 0x00..0x1E */
        this.active = 0; this.backwards = 0; this.state = RELEASE;
        this.cur = 0; this.nxt = 0; this.step = 0;   /* play position and pitch, SHIFT fixed (uint32) */
        this.vol = 0;                    /* envelope, 0 (silent) .. 0x3FF << EG_SHIFT */
        this.ar = 0; this.d1r = 0; this.d2r = 0; this.rr = 0; this.dl = 0;
        this.eghold = 0;
        /* LFOs: table and scale are offsets into PLFO/ALFO and LFO_SCALE; -1 = none set yet */
        this.plfoPhase = 0; this.plfoStep = 0; this.plfoTab = 0; this.plfoScale = -1;
        this.alfoPhase = 0; this.alfoStep = 0; this.alfoTab = 0; this.alfoScale = -1;
        /* output gains from LPAN / RPAN (scsp_slot_gains) */
        this.gMixs = 0; this.gDl = 0; this.gDr = 0; this.gSous = 0; this.gEl = 0; this.gEr = 0;
    }
    clear() {
        this.r.fill(0);
        this.active = 0; this.backwards = 0; this.state = RELEASE;
        this.cur = 0; this.nxt = 0; this.step = 0; this.vol = 0;
        this.ar = 0; this.d1r = 0; this.d2r = 0; this.rr = 0; this.dl = 0; this.eghold = 0;
        this.plfoPhase = 0; this.plfoStep = 0; this.plfoTab = 0; this.plfoScale = -1;
        this.alfoPhase = 0; this.alfoStep = 0; this.alfoTab = 0; this.alfoScale = -1;
        this.gains();
    }
    gains() {
        /* SDIR sends the raw sample past the envelope AND past TL, into the DSP
         * feed and the direct mix as well as the sound stack (MAME). */
        const r = this.r;
        const tl = (r[6] & 0x100) ? 0 : r[6] & 0xFF;
        const dir = tl | ((r[0xB] >> 8) & 0x1F) << 8 | ((r[0xB] >> 13) & 7) << 13;
        const eff = (r[0xB] & 0x1F) << 8 | ((r[0xB] >> 5) & 7) << 13;
        this.gMixs = LPAN[tl | (r[0xA] & 7) << 13];
        this.gDl = LPAN[dir];
        this.gDr = RPAN[dir];
        this.gSous = LPAN[tl | 7 << 13];
        this.gEl = LPAN[eff];
        this.gEr = RPAN[eff];
    }
    pitchStep() {
        const r8 = this.r[8];
        const oct = ((((r8 >> 11) & 0xF) ^ 8) - 8) + SHIFT - 10;
        const fn = (r8 & 0x3FF) + 1024;
        return oct >= 0 ? fn << oct : fn >> -oct;
    }
    lfo() {
        const r9 = this.r[9];
        const step = LFO_STEP[(r9 >> 10) & 0x1F];
        if ((r9 >> 5) & 7) {
            this.plfoStep = step; this.plfoTab = ((r9 >> 8) & 3) * 256; this.plfoScale = ((r9 >> 5) & 7) * 256;
        }
        if (r9 & 7) {
            this.alfoStep = step; this.alfoTab = ((r9 >> 3) & 3) * 256; this.alfoScale = (8 + (r9 & 7)) * 256;
        }
    }
    start() {
        const r = this.r;
        const octave = (((r[8] >> 11) & 0xF) ^ 8) - 8;
        const krs = (r[5] >> 10) & 0xF;
        /* MAME: key rate scaling adds to the base even for rate 0 (hardware: 0 = never) */
        const base = krs !== 0xF ? octave + 2 * krs + ((r[8] >> 9) & 1) : 0;
        this.active = 1;
        this.cur = 0;
        this.nxt = 1 << SHIFT;
        this.step = this.pitchStep();
        this.ar = rate(AR_TABLE, base, r[4] & 0x1F);
        this.d1r = rate(DR_TABLE, base, (r[4] >> 6) & 0x1F);
        this.d2r = rate(DR_TABLE, base, (r[4] >> 11) & 0x1F);
        this.rr = rate(DR_TABLE, base, r[5] & 0x1F);
        this.dl = 0x1F - ((r[5] >> 5) & 0x1F);
        this.eghold = (r[4] & 0x20) ? 1 : 0;
        this.state = ATTACK;
        this.vol = 0x17F << EG_SHIFT;
        this.backwards = 0;
        this.lfo();
    }
    /* keyoff: into release (KYONB is cleared either way, which the driver reads) */
    stop(keyoff) {
        if (keyoff) this.state = RELEASE;
        else this.active = 0;
        this.r[0] &= ~0x0800;
    }
    /* envelope level for this sample, SHIFT fixed (linear in attack) */
    egUpdate() {
        switch (this.state) {
        case ATTACK:
            this.vol += this.ar;
            if (this.vol >= (0x3FF << EG_SHIFT)) {
                if (!(this.r[5] & 0x4000)) {
                    this.state = DECAY1;
                    if (this.d1r >= (1024 << EG_SHIFT)) this.state = DECAY2;
                }
                this.vol = 0x3FF << EG_SHIFT;
            }
            if (this.eghold) return 0x3FF << (SHIFT - 10);
            break;
        case DECAY1:
            this.vol -= this.d1r;
            if (this.vol <= 0) this.vol = 0;
            if ((this.vol >> (EG_SHIFT + 5)) <= this.dl) this.state = DECAY2;
            break;
        case DECAY2:
            if (((this.r[4] >> 11) & 0x1F) === 0) break;
            this.vol -= this.d2r;
            if (this.vol <= 0) this.vol = 0;
            break;
        case RELEASE:
            this.vol -= this.rr;
            if (this.vol <= 0) { this.vol = 0; this.stop(0); }
            break;
        }
        return (this.vol >> EG_SHIFT) << (SHIFT - 10);
    }
    /* one of the slot's two positions (at address addr) against the loop, by LPCTL */
    loop(lpctl, addr, pos, lsa, lea) {
        switch (lpctl) {
        case 0:                                     /* no loop */
            if (addr >= lsa && addr >= lea) this.stop(0);
            return pos;
        case 1:                                     /* forward loop */
            if (addr >= lea) return (lsa * 4096 + (pos - lea * 4096)) >>> 0;
            return pos;
        case 2:                                     /* reverse loop */
            if (addr >= lsa && !this.backwards) {
                this.backwards = 1;
                return (lea * 4096 - (pos - lsa * 4096)) >>> 0;
            }
            if ((addr < lsa || (pos & 0x80000000)) && this.backwards)
                return (lea * 4096 - (lsa * 4096 - pos)) >>> 0;
            return pos;
        default:                                    /* alternating */
            if (addr >= lea) {
                this.backwards = 1;
                return (lea * 4096 - (pos - lea * 4096)) >>> 0;
            }
            if ((addr < lsa || (pos & 0x80000000)) && this.backwards) {
                this.backwards = 0;
                return (lsa * 4096 + (lsa * 4096 - pos)) >>> 0;
            }
            return pos;
        }
    }
}

function rate(table, base, r) {
    const x = base + (r << 1);
    return table[x < 0 ? 0 : x > 63 ? 63 : x];
}

export class SCSP {
    constructor(ram, clock) {
        this.ram = ram;
        this.clock = clock;
        this.slot = [];
        for (let i = 0; i < 32; i++) this.slot.push(new Slot());
        this.c = new Uint16Array(0x18);      /* common registers 0x400..0x42E, as words */
        this.sous = new Int16Array(128);     /* sound stack; slots write [ptr & 63] in turn */
        this.mi = new Uint8Array(32);
        this.mo = new Uint8Array(32);
        this.timCnt = new Uint16Array(3);    /* MAME: 0xFFFF once expired, reload << 8 after a write */
        this.timDue = [0, 0, 0];             /* expiry in clock periods; 0 = not running */
        /* the DSP */
        this.coef = new Int16Array(64);
        this.madrs = new Uint16Array(32);
        this.mpro = new Uint16Array(128 * 4);
        this.temp = new Int32Array(128);
        this.mems = new Int32Array(32);
        this.mixs = new Int32Array(16);
        this.efreg = new Int16Array(16);
        this.exts = new Int16Array(2);
        /* mpro[] decoded (scsp_dsp_decode) */
        this.opF = new Int32Array(128);
        this.opIra = new Uint8Array(128); this.opTra = new Uint8Array(128); this.opTwa = new Uint8Array(128);
        this.opCoef = new Uint8Array(128); this.opMasa = new Uint8Array(128);
        this.opIwa = new Uint8Array(128); this.opEwa = new Uint8Array(128);
        this.opDbl = new Uint8Array(128); this.opYsh = new Uint8Array(128); this.opFrcSh = new Uint8Array(128);
        this.opYmask = new Uint16Array(128); this.opFrcMask = new Uint16Array(128);
        this.opMem = new Uint8Array(128); this.opMrd = new Uint8Array(128); this.opMwt = new Uint8Array(128);
        this.opNofl = new Uint8Array(128); this.opNxadr = new Uint8Array(128);
        /* per-sample scratch */
        this.inb = new Int32Array(0x40);     /* the DSP step's input bank: MEMS, MIXS << 4, EXTS << 8 */
        this.efs = new Int16Array(17);       /* EFREG being made; [16] takes steps that write none */
        this.mixAcc = new Int32Array(16);    /* this sample's sends into MIXS */
        this.outL = 0; this.outR = 0;
        this.reset();
    }

    reset() {
        for (let i = 0; i < 32; i++) this.slot[i].clear();
        this.c.fill(0);
        this.mslc = 0;
        this.mslcData = 0;
        this.sous.fill(0);
        this.sousPtr = 0;
        this.mi.fill(0); this.miR = 0; this.miW = 0; this.miDrops = 0;
        this.mo.fill(0); this.moR = 0; this.moW = 0;
        this.timCnt.fill(0xFFFF);
        this.timDue[0] = this.timDue[1] = this.timDue[2] = 0;
        this.timNext = Infinity;
        this.lvlTa = 0; this.lvlTbc = 0; this.lvlMidi = 0;
        this.lines = 0;
        this.mcieb = 0; this.mcipd = 0;
        this.coef.fill(0); this.madrs.fill(0); this.mpro.fill(0);
        this.temp.fill(0); this.mems.fill(0); this.mixs.fill(0); this.efreg.fill(0); this.exts.fill(0);
        this.dec = 0;
        this.rbp = 0;
        this.rbl = 8 * 1024;
        this.stopped = 1;
        this.lastStep = 0;
        this.opsOk = 0; this.opsLast = 0; this.opsRun = 0;
        this.dspFn = null; this.dspRuns = 0; this.dspNoCompile = false;
        this.noise = 0x12345678;
        this.samples = 0;
        /* the C chip's lazy bookkeeping, as far as it shows (see the top) */
        this.owed = 0;
        this.coupled = 0;
        this.dspLo = 0; this.dspHi = 0;
        this.dspFrozen = 0; this.dspZeroRun = 0; this.dspCheckIn = 0;
        this.recouple();
        this.outL = 0; this.outR = 0;
    }

    /* ---- RAM ---- */

    ramB(a) {
        a &= 0xFFFFF;
        return a < RAM_SIZE ? this.ram[a] : 0;
    }
    ramW(a) {
        a &= 0xFFFFF;
        if (a + 1 < RAM_SIZE) return (this.ram[a] << 8) | this.ram[a + 1];
        return (this.ramB(a) << 8) | this.ramB(a + 1);   /* the end of RAM, or past it */
    }
    ramWW(a, v) {
        a &= 0xFFFFF;
        if (a + 1 < RAM_SIZE) { this.ram[a] = v >> 8; this.ram[a + 1] = v; }
    }

    /* ---- one sample ---- */

    /* one sample of one active slot; writes the sound stack entry at ptr */
    slotSample(sl, ptr) {
        const r = sl.r;
        const r0 = r[0];
        const ssctl = (r0 >> 7) & 3;
        if (ssctl === 3) return 0;                       /* "cannot be used" */

        /* the pitch step for this sample, through the pitch LFO */
        let step = sl.step;
        if ((r[9] >> 5) & 7) {
            sl.plfoPhase = (sl.plfoPhase + sl.plfoStep) & 0xFFFF;
            const p = LFO_SCALE[sl.plfoScale + PLFO[sl.plfoTab + (sl.plfoPhase >> LFO_SHIFT)] + 128] << (SHIFT - LFO_SHIFT);
            step = Math.floor(step * p / 4096) >>> 0;
        }

        /* the waveform where it stands: PCM out of sound RAM (FM moving the
         * read), or the noise source; then SBCTL's bit flips */
        let sample = 0;
        const pcm8 = r0 & 0x10;
        let a1, a2;
        if (pcm8) { a1 = sl.cur >>> SHIFT; a2 = sl.nxt >>> SHIFT; }
        else { a1 = (sl.cur >>> (SHIFT - 1)) & ~1; a2 = (sl.nxt >>> (SHIFT - 1)) & ~1; }
        const r7 = r[7];
        if (r7) {                                        /* FM from the sound stack */
            let smp = ((this.sous[(ptr + ((r7 >> 6) & 0x3F)) & 63] + this.sous[(ptr + (r7 & 0x3F)) & 63]) / 2) | 0;
            smp = (smp * 1024) >> (0x1A - (r7 >> 12));
            if (!pcm8) smp *= 2;
            a1 = (a1 + smp) >>> 0; a2 = (a2 + smp) >>> 0;
        }
        const sa = ((r0 & 0xF) << 16) | r[1];
        const frac = sl.cur & 0xFFF;
        if (ssctl === 0) {
            if (pcm8) {
                const p1 = (this.ramB(sa + a1) << 24) >> 24, p2 = (this.ramB(sa + a2) << 24) >> 24;
                sample = ((p1 * 256) * (4096 - frac) + (p2 * 256) * frac) >> SHIFT;
            } else {
                const p1 = (this.ramW(sa + a1) << 16) >> 16, p2 = (this.ramW(sa + a2) << 16) >> 16;
                sample = (p1 * (4096 - frac) + p2 * frac) >> SHIFT;
            }
        } else if (ssctl === 1) {
            this.noise = lcgStep(this.noise);            /* MAME: unknown algorithm */
            sample = ((this.noise >>> 8) << 16) >> 16;
        }
        const sbctl = (r0 >> 9) & 3;
        if (sbctl & 1) sample ^= 0x7FFF;
        if (sbctl & 2) sample = ((sample ^ 0x8000) << 16) >> 16;

        /* the slot steps on, and both positions meet the loop */
        const cur = sl.backwards ? (sl.cur - step) >>> 0 : (sl.cur + step) >>> 0;
        const nxt = (cur + 4096) >>> 0;
        const lsa = r[2], lea = r[3], lpctl = (r0 >> 5) & 3;
        const ad0 = cur >>> SHIFT, ad1 = nxt >>> SHIFT;
        if (ad0 >= lsa && !sl.backwards && (r[5] & 0x4000) && sl.state === ATTACK) sl.state = DECAY1;
        sl.cur = sl.loop(lpctl, ad0, cur, lsa, lea);
        sl.nxt = sl.loop(lpctl, ad1, nxt, lsa, lea);

        if (!(r[6] & 0x100)) {                           /* not SDIR: amplitude LFO and envelope */
            if (r[9] & 7) {
                sl.alfoPhase = (sl.alfoPhase + sl.alfoStep) & 0xFFFF;
                const a = LFO_SCALE[sl.alfoScale + ALFO[sl.alfoTab + (sl.alfoPhase >> LFO_SHIFT)]] << (SHIFT - LFO_SHIFT);
                sample = (sample * a) >> SHIFT;
            }
            if (sl.state === ATTACK) sample = (sample * sl.egUpdate()) >> SHIFT;
            else sample = (sample * EG_TABLE[sl.egUpdate() >> (SHIFT - 10)]) >> SHIFT;
        }
        if (!(r[6] & 0x200)) this.sous[ptr] = (sample * sl.gSous) >> (SHIFT + 1);
        return sample;
    }

    /* A sample boundary has passed: make the sample (slots, the DSP, the mix). */
    tick() {
        const mixAcc = this.mixAcc;
        mixAcc.fill(0);
        let l = 0, r = 0;
        const sp = this.sousPtr;
        for (let i = 0; i < 32; i++) {
            const sl = this.slot[i];
            if (!sl.active) continue;
            const smp = this.slotSample(sl, (sp + i) & 63);
            const isel = (sl.r[0xA] >> 3) & 0xF;
            mixAcc[isel] += (smp * sl.gMixs) >> (SHIFT - 2);
            l += (smp * sl.gDl) >> SHIFT;
            r += (smp * sl.gDr) >> SHIFT;
        }
        this.sousPtr = sp ^ 32;

        /* the slot monitor's latch: the slot MSLC names now, as this sample left it */
        const ms = this.slot[this.mslc];
        this.mslcData = (((ms.cur >>> (SHIFT + 12)) & 0xF) << 7) | ((ms.state & 3) << 5) |
            ((0x1F - (ms.vol >> (EG_SHIFT + 5))) & 0x1F);

        /* the sends into the DSP, a DSP step, its effect outputs onto the mix */
        const mixs = this.mixs;
        let nz = 0;
        for (let j = 0; j < 16; j++) { mixs[j] += mixAcc[j]; nz |= mixAcc[j]; }
        if (this.dspDue(nz)) this.dspStep();
        const ef = this.efreg;
        for (let j = 0; j < 16; j++) {
            const e = ef[j];
            if (!e) continue;
            const sl = this.slot[j];
            l += (e * sl.gEl) >> SHIFT;
            r += (e * sl.gEr) >> SHIFT;
        }

        /* to the DAC: 18-bit or 16-bit, the master volume */
        if (this.c[0] & 0x0100) {
            l = (l < -131072 ? -131072 : l > 131071 ? 131071 : l) >> 2;
            r = (r < -131072 ? -131072 : r > 131071 ? 131071 : r) >> 2;
        } else {
            l >>= 2; r >>= 2;
            l = l < -32768 ? -32768 : l > 32767 ? 32767 : l;
            r = r < -32768 ? -32768 : r > 32767 ? 32767 : r;
        }
        const mvol = this.c[0] & 0xF;                    /* MAME: output gain MVOL / 15 */
        this.outL = (((l * mvol) / 15) | 0) << 16 >> 16;
        this.outR = (((r * mvol) / 15) | 0) << 16 >> 16;
        this.samples++;

        /* the C chip owes it until the host syncs (or it syncs itself) */
        this.owed++;
        if (this.coupled || this.owed === 1024) this.owed = 0;
    }

    /* the host's scsp_sync at the end of a run */
    sync() { this.owed = 0; }

    /* The 68000 is about to touch sz bytes of sound RAM at addr (scsp_ram_touch):
     * an access to the DSP's ring makes the C chip catch up, and a write there
     * wakes a quiet DSP. */
    ramTouch(addr, sz, write) {
        if (!this.owed) return;
        if (addr < this.dspHi && this.dspLo < addr + sz) {
            this.owed = 0;
            if (write) this.dspWake();
        }
    }

    /* ---- DSP ---- */

    dspStart() {
        this.stopped = 0;
        let i;
        for (i = 127; i >= 0; i--) {
            const p = i * 4, m = this.mpro;
            if (m[p] || m[p + 1] || m[p + 2] || m[p + 3]) break;
        }
        this.lastStep = i + 1;
    }

    dspDecode() {
        this.opsRun = this.lastStep;
        const m = this.mpro;
        for (let st = 0; st < 128; st++) {
            const p0 = m[st * 4], p1 = m[st * 4 + 1], p2 = m[st * 4 + 2], p3 = m[st * 4 + 3];
            const ysel = (p1 >> 13) & 3, sh = (p2 >> 4) & 3;
            const iwt = (p1 >> 5) & 1, iwa = p1 & 0x1F;
            const mwt = (p2 >> 14) & 1, mrd = (p2 >> 13) & 1;
            const ira = (p1 >> 6) & 0x3F;
            this.opIra[st] = ira;
            this.opTra[st] = (p0 >> 8) & 0x7F;
            this.opTwa[st] = p0 & 0x7F;
            this.opCoef[st] = (p3 >> 9) & 0x3F;
            this.opMasa[st] = (p3 >> 2) & 0x1F;
            this.opIwa[st] = iwt ? iwa : 0x3F;
            this.opEwa[st] = (p2 >> 12) & 1 ? (p2 >> 8) & 0xF : 16;
            this.opDbl[st] = sh === 1 || sh === 2 ? 1 : 0;
            /* Y: FRC, COEF >> 3, YREG[23:11] or YREG[15:4], all read as 13-bit signed */
            this.opYsh[st] = ysel === 0 ? 0 : ysel === 1 ? 3 : ysel === 2 ? 11 : 4;
            this.opYmask[st] = ysel === 3 ? 0x0FFF : 0x1FFF;
            this.opFrcSh[st] = sh === 3 ? 0 : 11;
            this.opFrcMask[st] = sh === 3 ? 0x0FFF : 0x1FFF;
            /* MAME: the delay memory is only touched on odd steps */
            const omrd = mrd && (st & 1), omwt = mwt && (st & 1);
            this.opMrd[st] = omrd ? 1 : 0;
            this.opMwt[st] = omwt ? 1 : 0;
            this.opMem[st] = omrd || omwt ? 1 : 0;
            this.opNofl[st] = (p3 >> 15) & 1;
            this.opNxadr[st] = p3 & 1;
            let f = 0;
            if (iwt && ira === iwa) f |= DF_IW_SELF;
            if ((p0 >> 7) & 1) f |= DF_TWT;
            if ((p1 >> 15) & 1) f |= DF_XSEL;
            if (p2 & 1) f |= DF_BSEL;
            if ((p2 >> 1) & 1) f |= DF_ZERO;
            if ((p2 >> 2) & 1) f |= DF_NEGB;
            if ((p2 >> 3) & 1) f |= DF_YRL;
            if (ysel === 1) f |= DF_Y_COEF;
            if (ysel >= 2) f |= DF_Y_YREG;
            if (sh <= 1) f |= DF_SAT;
            if ((p2 >> 6) & 1) f |= DF_FRCL;
            if ((p2 >> 7) & 1) f |= DF_ADRL;
            if (sh === 3) f |= DF_ADRL_SH;
            if ((p2 >> 15) & 1) f |= DF_TABLE;
            if ((p3 >> 1) & 1) f |= DF_ADREB;
            this.opF[st] = f;
            /* An IRA past EXTS ends the program on that step, before it does anything. */
            if (ira > 0x31 && st < this.opsRun) this.opsRun = st;
        }
        this.opsOk = 1;
        this.opsLast = this.lastStep;
        this.dspFn = null;
        this.dspRuns = 0;
    }

    dspStep() {
        if (this.stopped) return;
        if (!this.opsOk || this.opsLast !== this.lastStep) this.dspDecode();
        const efs = this.efs;
        efs.fill(0);
        const inb = this.inb;
        const mixs = this.mixs;
        inb.set(this.mems, 0);
        for (let i = 0; i < 16; i++) inb[0x20 + i] = mixs[i] << 4;
        inb[0x30] = this.exts[0] * 256;
        inb[0x31] = this.exts[1] * 256;

        const temp = this.temp, coef = this.coef, madrs = this.madrs, ram = this.ram;
        const dec = this.dec, rblMask = this.rbl - 1, rbp = this.rbp << 12;
        const run = this.opsRun;
        if (!this.dspFn && !this.dspNoCompile && ++this.dspRuns === DSP_COMPILE_AFTER) {
            this.dspFn = dspCompile(this);
            if (!this.dspFn) this.dspNoCompile = true;
        }
        if (this.dspFn) this.dspFn(this, inb, temp, coef, madrs, ram, this.efs, dec, rblMask, rbp);
        else this.dspInterpret(inb, temp, coef, madrs, ram, dec, rblMask, rbp);
        const mems = this.mems, efreg = this.efreg;
        for (let i = 0; i < 32; i++) mems[i] = inb[i];
        for (let i = 0; i < 16; i++) efreg[i] = efs[i];
        /* DEC down a step and MIXS cleared, unless the program ended early on a bad IRA */
        if (run < this.lastStep) return;
        /* kept to 16 bits, all any mask reads of it, so it stays a small integer */
        this.dec = (this.dec - 1) & 0xFFFF;
        mixs.fill(0);
    }

    /* the program a step at a time, reading each step's fields */
    dspInterpret(inb, temp, coef, madrs, ram, dec, rblMask, rbp) {
        const efs = this.efs;
        const opF = this.opF, opIra = this.opIra, opTra = this.opTra, opTwa = this.opTwa, opCoef = this.opCoef,
            opMasa = this.opMasa, opIwa = this.opIwa, opEwa = this.opEwa, opDbl = this.opDbl, opYsh = this.opYsh,
            opYmask = this.opYmask, opFrcSh = this.opFrcSh, opFrcMask = this.opFrcMask, opMem = this.opMem,
            opMrd = this.opMrd, opMwt = this.opMwt, opNofl = this.opNofl, opNxadr = this.opNxadr;
        let acc = 0, memval = 0, frc = 0, yreg = 0, adrs = 0;
        const run = this.opsRun;
        for (let st = 0; st < run; st++) {
            const f = opF[st];
            let inputs = (inb[opIra[st]] << 8) >> 8;
            if (f & DF_IW_SELF) inputs = memval;
            inb[opIwa[st]] = memval;

            const tr = (temp[(opTra[st] + dec) & 0x7F] << 8) >> 8;
            let b = (f & DF_BSEL) ? acc : tr;
            if (f & DF_NEGB) b = -b | 0;
            if (f & DF_ZERO) b = 0;
            const x = (f & DF_XSEL) ? inputs : tr;

            let ys = (f & DF_Y_COEF) ? coef[opCoef[st]] : frc;
            if (f & DF_Y_YREG) ys = yreg;
            const y = (((ys >> opYsh[st]) & opYmask[st]) << 19) >> 19;
            if (f & DF_YRL) yreg = inputs;

            const v = opDbl[st] ? acc * 2 : acc;
            let shifted;
            if (f & DF_SAT) shifted = v > 0x7FFFFF ? 0x7FFFFF : v < -0x800000 ? -0x800000 : v;
            else shifted = ((v | 0) << 8) >> 8;

            /* (x * y) >> 12 of a 24-bit x and a 13-bit y, in two halves that fit 32 bits */
            acc = (Math.imul(x >> 12, y) + (Math.imul(x & 0xFFF, y) >> 12) + b) | 0;

            if (f & DF_TWT) temp[(opTwa[st] + dec) & 0x7F] = shifted;
            if (f & DF_FRCL) frc = (shifted >> opFrcSh[st]) & opFrcMask[st];

            if (opMem[st]) {
                let addr;
                if (f & DF_TABLE) {
                    addr = madrs[opMasa[st]] + ((f & DF_ADREB) ? adrs & 0x0FFF : 0) + opNxadr[st];
                    addr &= 0xFFFF;
                } else {
                    addr = madrs[opMasa[st]] + dec + ((f & DF_ADREB) ? adrs & 0x0FFF : 0) + opNxadr[st];
                    addr &= rblMask;
                }
                addr = ((addr + rbp) << 1) & 0xFFFFF;
                if (opMrd[st]) {
                    const w = addr + 1 < RAM_SIZE ? (ram[addr] << 8) | ram[addr + 1] : this.ramW(addr);
                    memval = opNofl[st] ? w << 8 : dspUnpack(w);
                }
                if (opMwt[st]) this.ramWW(addr, opNofl[st] ? (shifted >> 8) & 0xFFFF : dspPack(shifted));
            }
            if (f & DF_ADRL) adrs = (f & DF_ADRL_SH) ? (shifted >> 12) & 0xFFF : inputs >> 16;
            const ewa = opEwa[st];
            efs[ewa] = efs[ewa] + (shifted >> 8);
        }
    }

    /* ---- A quiet DSP (scsp.h): skipped while its inputs are silent and its
     * state within a margin; that changes the output by a few LSB against the
     * DSP run every sample, so it is kept, as the C does by default. ---- */

    dspWake() {
        this.dspFrozen = 0;
        this.dspZeroRun = 0;
        this.dspCheckIn = 0;
    }

    dspRegsQuiet() {
        for (let i = 0; i < 16; i++) if (this.mixs[i]) return false;
        if (this.exts[0] || this.exts[1]) return false;
        for (let i = 0; i < 16; i++) if (this.efreg[i] > DSP_QUIET_EF || this.efreg[i] < -DSP_QUIET_EF) return false;
        for (let i = 0; i < 128; i++) if (this.temp[i] > DSP_QUIET || this.temp[i] < -DSP_QUIET) return false;
        for (let i = 0; i < 32; i++) if (this.mems[i] > DSP_QUIET || this.mems[i] < -DSP_QUIET) return false;
        return true;
    }

    /* how the program uses delay memory: 0 not at all, 1 only the ring of
     * packed floats, -1 some other way (TABLE or NOFL) */
    dspRingUse() {
        let ring = 0;
        for (let st = 1; st < this.lastStep; st += 2) {
            const p2 = this.mpro[st * 4 + 2];
            if (!((p2 >> 13) & 3)) continue;
            if ((p2 >> 15) & 1) return -1;
            if ((p2 >> 8) & 1) return -1;
            ring = 1;
        }
        return ring;
    }

    dspRingQuiet() {
        const lo = this.rbp << 13;
        if (lo + 2 * this.rbl > RAM_SIZE) return false;
        for (let i = 0; i < this.rbl; i++) {
            const v = dspUnpack(this.ramW(lo + 2 * i));
            if (v > DSP_QUIET || v < -DSP_QUIET) return false;
        }
        return true;
    }

    dspQuiet() {
        if (this.coupled || this.stopped || !this.dspRegsQuiet()) return false;
        const ring = this.dspRingUse();
        if (ring < 0) return false;
        return !ring || this.dspRingQuiet();
    }

    /* whether this sample's DSP step runs; nz: any MIXS input this sample */
    dspDue(nz) {
        if (nz | this.exts[0] | this.exts[1]) { this.dspWake(); return true; }
        if (this.dspFrozen) return false;
        if (this.dspZeroRun < 0xFF) this.dspZeroRun++;
        if (this.dspZeroRun < DSP_QUIET_RUN) return true;
        if (this.dspCheckIn) { this.dspCheckIn--; return true; }
        if (this.dspQuiet()) { this.dspFrozen = 1; return false; }
        this.dspCheckIn = this.rbl < 0xFFFF ? this.rbl : 0xFFFF;
        return true;
    }

    /* ---- coupling (scsp_recouple): only `coupled` and the DSP's RAM range
     * are kept, for the quiet DSP and ramTouch ---- */

    /* the sound RAM a running slot may read, into this.rlo / this.rhi */
    slotRange(sl) {
        this.rlo = 0; this.rhi = 0;
        const r = sl.r;
        if (!sl.active || ((r[0] >> 7) & 3) !== 0) return;
        this.rhi = RAM_SIZE;
        const lsa = r[2], lea = r[3];
        if (r[7]) return;                                /* FM moves the read anywhere */
        let step = sl.step;
        if ((r[9] >> 5) & 7) {
            if (sl.plfoScale < 0) return;
            const mx = LFO_SCALE_MAX[sl.plfoScale >> 8];
            step = Math.floor(step * (mx * 16) / 4096);
        }
        const adv = Math.floor(step / 4096) + 1;
        const top0 = lsa > lea ? lsa : lea;
        const lp = (r[0] >> 5) & 3;
        const cA = sl.cur >>> SHIFT, nA = sl.nxt >>> SHIFT;
        if (lp !== 0 && (lsa > lea || lea - lsa <= adv)) return;
        if (lp >= 2 && (lsa < adv || (sl.backwards && cA < lsa))) return;
        if (sl.backwards && lp < 2) return;
        if (cA > top0 || nA > top0 + 1) return;
        let top = top0 + 2 * adv + 3;
        const pcm8 = r[0] & 0x10;
        if (lp === 1) {
            top = (lea - 1) >>> 0;
            if (cA > top) top = cA;
            if (nA > top) top = nA;
            if (pcm8) top++;
        }
        const sa = ((r[0] & 0xF) << 16) | r[1];
        const end = sa + (pcm8 ? top : top * 2 + 2);
        if (end > 0xFFFFF) return;                       /* wraps */
        this.rlo = sa;
        this.rhi = end < RAM_SIZE ? end : RAM_SIZE;
        if (this.rlo > this.rhi) this.rlo = this.rhi;
    }

    recouple() {
        /* the DSP's delay line, [lo, hi); none while it is stopped */
        let lo = 0, hi = 0;
        if (!this.stopped) {
            let span = 0;
            for (let st = 1; st < this.lastStep; st += 2) {
                const p2 = this.mpro[st * 4 + 2];
                if (!((p2 >> 13) & 3)) continue;
                if ((p2 >> 15) & 1) span = 0x10000;
                else if (span < this.rbl) span = this.rbl;
            }
            lo = this.rbp << 13;
            const e = lo + 2 * span;
            hi = e < RAM_SIZE ? e : RAM_SIZE;
            if (lo > hi) lo = hi;
        }
        this.dspLo = lo; this.dspHi = hi;
        let c = 0;
        for (let i = 0; i < 32; i++) {
            const sl = this.slot[i];
            if (!sl.active) continue;
            const r = sl.r;
            if (((r[0] >> 7) & 3) === 1 || r[7]) { c = 1; break; }   /* noise, FM */
            this.slotRange(sl);
            if (this.rlo < hi && lo < this.rhi) { c = 1; break; }      /* reads the delay line */
        }
        this.coupled = c;
    }

    /* ---- interrupts and timers ---- */

    level(src) {
        const c = this.c;
        return ((c[0x12] >> src) & 1) | (((c[0x13] >> src) & 1) << 1) | (((c[0x14] >> src) & 1) << 2);
    }

    /* MAME: the first pending, enabled source in the order timer A, B, C, MIDI
     * raises its line and the rest wait; lines stay up until SCIRE (or an
     * empty MIDI buffer) drops them, and the 68000 takes the highest line held. */
    checkIrq() {
        const c = this.c;
        let pend = c[0x10];
        const en = c[0x0F];
        if (this.miW !== this.miR) { c[0x10] |= 0x08; pend |= 0x08; }
        if (!pend) return;
        if (pend & en & 0x040) { this.lines |= 1 << this.lvlTa; return; }
        if (pend & en & 0x080) { this.lines |= 1 << this.lvlTbc; return; }
        if (pend & en & 0x100) { this.lines |= 1 << this.lvlTbc; return; }
        if (pend & en & 0x008) { this.lines |= 1 << this.lvlMidi; return; }
    }

    /* the interrupt level the 68000 sees, 0 = none */
    irqLevel() {
        let l = this.lines & 0xFE, lvl = 0;
        while ((l >>= 1)) lvl++;
        return lvl;
    }

    timerNext() {
        let n = Infinity;
        for (let t = 0; t < 3; t++) if (this.timDue[t] && this.timDue[t] < n) n = this.timDue[t];
        this.timNext = n;
    }

    timerFire(t) {
        this.timDue[t] = 0;
        this.timCnt[t] = 0xFFFF;
        this.c[0x10] |= 0x40 << t;
        this.c[0x0C + t] |= 0x00FF;
        if (t === 0) this.mcipd |= 0x40;                 /* the main-CPU side, unused on Model 2 */
        this.checkIrq();
    }

    /* Fire any timer whose moment has come; the 68000 calls this between instructions. */
    timers(now) {
        if (now < this.timNext) return;
        for (let t = 0; t < 3; t++) if (this.timDue[t] && this.timDue[t] <= now) this.timerFire(t);
        this.timerNext();
    }

    /* ---- DMA ---- */

    dma() {
        const c = this.c;
        let dmea = ((c[0x0A] & 0xF000) << 4) | (c[0x09] & 0xFFFE);
        let drga = c[0x0A] & 0x0FFE;
        const dtlg = c[0x0B] & 0x0FFE;
        const ddir = (c[0x0B] >> 13) & 1, dgate = (c[0x0B] >> 14) & 1;
        const k0 = c[0x09], k1 = c[0x0A], k2 = c[0x0B];
        for (let i = 0; i < dtlg; i += 2, dmea += 2) {
            if (ddir) { this.ramWW(dmea, dgate ? 0 : this.r16(drga)); if (!dgate) drga += 2; }
            else { this.w16(drga, dgate ? 0 : this.ramW(dmea)); drga += 2; }
        }
        if (!ddir) { c[0x09] = k0; c[0x0A] = k1; c[0x0B] = k2; }
        c[0x0B] &= ~0x1000;
        /* MAME pulses the DMA-end interrupt when SCIEB bit 4 is set; no Model 2
         * driver enables it (scsp.h leaves it out too). */
    }

    /* ---- register access ---- */

    /* whether a register write changes what the chip makes (the C chip syncs) */
    static writeSyncs(addr, v) {
        if (addr < 0x400) return true;
        if (addr < 0x430) {
            const r = (addr - 0x400) >> 1;
            return r === 0x00 || r === 0x01 || (r === 0x0B && (v & 0x1000) !== 0);
        }
        return addr >= 0x600;
    }

    w16(addr, v) {
        addr &= 0xFFFF;
        const sy = SCSP.writeSyncs(addr, v);
        if (sy) this.owed = 0;
        this.w16Now(addr, v);
        if (sy) this.recouple();
    }

    w16Slot(addr, v) {
        const sl = this.slot[addr >> 5];
        const r = (addr & 0x1F) >> 1;
        sl.r[r] = v;
        switch (r) {
        case 0x0:
            if (sl.r[0] & 0x1000) {                      /* KYONEX: one strobe commits every slot's KYONB */
                for (let i = 0; i < 32; i++) {
                    const s2 = this.slot[i];
                    if ((s2.r[0] & 0x0800) && s2.state === RELEASE) s2.start();
                    if (!(s2.r[0] & 0x0800)) s2.stop(1);
                }
                sl.r[0] &= ~0x1000;
            }
            break;
        case 0x8: sl.step = sl.pitchStep(); break;
        case 0x5: sl.rr = rate(DR_TABLE, 0, sl.r[5] & 0x1F); sl.dl = 0x1F - ((sl.r[5] >> 5) & 0x1F); break;
        case 0x9: sl.lfo(); break;
        case 0x6: case 0xA: case 0xB: sl.gains(); break;
        }
    }

    w16Timer(r, v) {
        const t = r - 0x0C;
        const reload = v & 0xFF;
        this.timCnt[t] = reload << 8;
        /* Timed from the write, to the clock period. MAME: 255 leaves a running timer running. */
        if (reload !== 255) {
            this.timDue[t] = this.clock() + (((255 - reload) << ((v >> 8) & 7)) << 8);
            this.timerNext();
        }
    }

    w16Scire(v) {
        const c = this.c;
        c[0x10] &= ~c[0x11];
        if (v & 0x040) this.lines &= ~(1 << this.lvlTa);
        if (v & 0x180) this.lines &= ~(1 << this.lvlTbc);
        if (v & 0x008) this.lines &= ~(1 << this.lvlMidi);
        this.lines &= 0xFF;
        this.checkIrq();
        /* MAME, from hardware: an acknowledged timer that has expired pends again */
        for (let t = 0; t < 3; t++) if (this.timCnt[t] === 0xFFFF) c[0x10] |= 0x40 << t;
    }

    w16Common(addr, v) {
        const r = (addr - 0x400) >> 1;
        this.c[r] = v;
        switch (r) {
        case 0x01:
            this.rbl = (8 * 1024) << ((v >> 7) & 3);
            this.rbp = v & 0x3F;
            this.dspWake();
            break;
        case 0x03:                                       /* MIDI out */
            this.mo[this.moW & 31] = v;
            this.moW = (this.moW + 1) & 31;
            break;
        case 0x04: this.mslc = (v >> 11) & 0x1F; break;  /* only MSLC is writable */
        case 0x0B: if (v & 0x1000) this.dma(); break;
        case 0x0C: case 0x0D: case 0x0E: this.w16Timer(r, v); break;
        case 0x0F: this.checkIrq(); break;               /* SCIEB */
        case 0x11: this.w16Scire(v); break;              /* SCIRE */
        case 0x12: case 0x13: case 0x14:                 /* SCILV0-2 */
            this.lvlTa = this.level(INT_TIMER_A);
            this.lvlTbc = this.level(INT_TIMER_B);
            this.lvlMidi = this.level(INT_MIDI_IN);
            break;
        case 0x15: this.mcieb = v; break;
        case 0x16: if (v & 0x20) this.mcipd |= 0x20; break;
        case 0x17: this.mcipd &= ~v; break;
        }
    }

    w16Now(addr, v) {
        if (addr < 0x400) { this.w16Slot(addr, v); return; }
        if (addr < 0x430) { this.w16Common(addr, v); return; }
        if (addr < 0x600) return;
        if (addr < 0x700) { this.sous[(addr - 0x600) >> 1] = v; return; }
        this.dspWake();                                  /* a new coefficient, tap or program wakes it */
        if (addr < 0x780) { this.coef[(addr - 0x700) >> 1] = v; return; }
        /* MADRS is 32 words, 0x780-0x7BF; 0x7C0-0x7FF is not a mirror of it (scsp.h) */
        if (addr < 0x7C0) { this.madrs[(addr - 0x780) >> 1] = v; return; }
        if (addr < 0x800) return;
        if (addr < 0xC00) {
            this.mpro[(addr - 0x800) >> 1] = v;
            this.opsOk = 0;
            if (addr === 0xBF0) this.dspStart();
        }
    }

    r16Common(addr) {
        const r = (addr - 0x400) >> 1;
        const c = this.c;
        switch (r) {
        case 0x02: {                                     /* MIDI in */
            const v = (c[0x02] & 0xFF00) | this.mi[this.miR];
            if (this.miR !== this.miW) this.miR = (this.miR + 1) & 31;
            if (this.miR === this.miW) {
                this.lines &= ~(1 << this.lvlMidi) & 0xFF;
                c[0x10] &= ~0x08;
            }
            c[0x02] = v;
            break;
        }
        case 0x04:                                       /* slot monitor: the latch of the last sample */
            c[0x04] = this.mslcData;
            break;
        case 0x15: c[0x15] = this.mcieb; break;
        case 0x16: c[0x16] = this.mcipd; break;
        }
        return c[r];
    }

    r16Dsp(addr) {
        if (addr < 0x780) return this.coef[(addr - 0x700) >> 1] & 0xFFFF;
        if (addr < 0x7C0) return this.madrs[(addr - 0x780) >> 1];
        if (addr < 0x800) return 0;
        if (addr < 0xC00) return this.mpro[(addr - 0x800) >> 1];
        if (addr < 0xE00) { const t = this.temp[(addr >> 2) & 0x7F]; return (addr & 2) ? t & 0xFFFF : (t >> 16) & 0xFFFF; }
        if (addr < 0xE80) { const t = this.mems[(addr >> 2) & 0x1F]; return (addr & 2) ? t & 0xFFFF : (t >> 16) & 0xFFFF; }
        if (addr < 0xEC0) { const t = this.mixs[(addr >> 2) & 0xF]; return (addr & 2) ? t & 0xFFFF : (t >> 16) & 0xFFFF; }
        if (addr < 0xEE0) return this.efreg[(addr - 0xEC0) >> 1] & 0xFFFF;
        if (addr < 0xEE4) return this.exts[(addr - 0xEE0) >> 1] & 0xFFFF;
        return 0;
    }

    /* a read with the side effects the 68000's own reads have (MIDI buffer, monitor) */
    r16(addr) {
        addr &= 0xFFFF;
        if (this.owed && ((addr >= 0x600 && addr < 0x700) || addr >= 0xC00)) this.owed = 0;
        if (addr < 0x400) return this.slot[addr >> 5].r[(addr & 0x1F) >> 1];
        if (addr < 0x430) return this.r16Common(addr);
        if (addr < 0x600) return 0;
        if (addr < 0x700) return this.sous[(addr - 0x600) >> 1] & 0xFFFF;
        return this.r16Dsp(addr);
    }

    /* a debugger's read: no side effects */
    peek16(addr) {
        addr &= 0xFFFF;
        if (addr < 0x400) return this.slot[addr >> 5].r[(addr & 0x1F) >> 1];
        if (addr < 0x430) return this.c[(addr - 0x400) >> 1];
        if (addr >= 0x700 && addr < 0x780) return this.coef[(addr - 0x700) >> 1] & 0xFFFF;
        if (addr >= 0x800 && addr < 0xC00) return this.mpro[(addr - 0x800) >> 1];
        return 0;
    }

    /* The 68000's view: a byte access reads the whole word (with its side
     * effects) and a byte write merges into it; a long is two words. */
    read(off, sz) {
        if (sz === 1) {
            const w = this.r16(off & ~1);
            return (off & 1) ? w & 0xFF : w >> 8;
        }
        if (sz === 2) return this.r16(off & ~1);
        const hi = this.r16(off & ~1);
        return ((hi << 16) | this.r16((off & ~1) + 2)) >>> 0;
    }

    write(off, val, sz) {
        if (sz === 1) {
            const a = off & ~1;
            let w = this.r16(a);
            w = (off & 1) ? (w & 0xFF00) | (val & 0xFF) : (w & 0x00FF) | ((val & 0xFF) << 8);
            this.w16(a, w);
        } else if (sz === 2) {
            this.w16(off & ~1, val & 0xFFFF);
        } else {
            this.w16(off & ~1, (val >>> 16) & 0xFFFF);
            this.w16((off & ~1) + 2, val & 0xFFFF);
        }
    }

    /* A full ring drops the byte rather than lap the read pointer (scsp.h). */
    midiIn(b) {
        if (((this.miW + 1) & 31) === this.miR) { this.miDrops++; return; }
        this.mi[this.miW] = b;
        this.miW = (this.miW + 1) & 31;
        this.checkIrq();
    }

    /* free space in the MIDI input ring */
    midiRoom() { return 31 - ((this.miW - this.miR) & 31); }

    /* the MIDI out ring, which the i960 reads through the UART */
    moAvailable() { return this.moR !== this.moW; }
    moPop() {
        if (this.moR === this.moW) return 0;
        const b = this.mo[this.moR];
        this.moR = (this.moR + 1) & 31;
        return b;
    }
}
