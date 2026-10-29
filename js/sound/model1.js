/*
 * model1.js — the Model 1 sound board's chips: two MultiPCMs (Yamaha
 * YMW-258-F, Sega 315-5560), a YM3438's timers and the 68000's own i8251.
 * Daytona USA and Virtua Cop run on the original Model 2, which kept this
 * board in place of the SCSP one (MAME src/mame/shared/segam1audio.cpp).
 * A port of m2-hle2's src/board/model1_sound.h; board.js puts the 68000 in
 * front of it.
 *
 * 68000 address map (10 MHz):
 *   0x000000-0x03FFFF  program ROM
 *   0x080000-0x09FFFF  program ROM +0x20000 again (the upper socket's mirror)
 *   0xC20000-0xC20003  i8251, on the low byte (umask 0x00ff)
 *   0xC40000-0xC40007  MultiPCM 1, low byte; 0xC50000 its sample bank
 *   0xC60000-0xC60007  MultiPCM 2, low byte; 0xC70000 its sample bank
 *   0xD00000-0xD00007  YM3438, low byte
 *   0xF00000-0xF0FFFF  RAM
 *
 * MultiPCM: MAME's gew.cpp and multipcm.cpp (BSD-3-Clause, Miguel Angel
 * Horna). Each chip addresses 4 MB: the first megabyte of its ROM at 0, a
 * bank of it the 68000 picks at 0x100000, the rest reads 0. The chip makes
 * 10 MHz / 224 = 44642.857 samples a second; here it makes the board's
 * 44.1 kHz ones, so the pitch steps, the envelope rates and the LFOs are
 * scaled by that ratio and play at the speed MAME's do.
 *
 * YM3438: only the timers and the busy flag (ymfm's ym2612). The driver keeps
 * its tempo by polling the timer flags, but Daytona never keys an FM voice.
 */

export const M1_CPU_HZ = 10000000;
const OUT_HZ = 44100;
const VOICES = 28;
export const M1_PCM_SIZE = 0x400000;
const YM_PRESCALE = 144;
const TX_FIFO = 32;

const TL_SHIFT = 12;
const EG_SHIFT = 16;
const LFO_SHIFT = 8;

const ATTACK = 0, DECAY1 = 1, DECAY2 = 2, RELEASE = 3;

/* ---- the tables every chip shares ---- */

const attackStep = new Uint32Array(0x40);
const decayReleaseStep = new Uint32Array(0x40);
const freqStep = new Uint32Array(0x400);
const leftPan = new Int32Array(0x800);
const rightPan = new Int32Array(0x800);
const linToExp = new Int32Array(0x400);
const tlSteps = new Int32Array(2);
const pitchTable = new Int32Array(256);
const amplitudeTable = new Int32Array(256);
const pitchScale = Array.from({ length: 8 }, () => new Int32Array(256));
const amplitudeScale = Array.from({ length: 8 }, () => new Int32Array(256));
const lfoStep = new Uint32Array(8);

const VALUE_TO_CHANNEL = [
    0, 1, 2, 3, 4, 5, 6, -1,
    7, 8, 9, 10, 11, 12, 13, -1,
    14, 15, 16, 17, 18, 19, 20, -1,
    21, 22, 23, 24, 25, 26, 27, -1,
];

const BASE_TIMES = [
    0, 0, 0, 0,
    6222.95, 4978.37, 4148.66, 3556.01,
    3111.47, 2489.21, 2074.33, 1778.00,
    1555.74, 1244.63, 1037.19, 889.02,
    777.87, 622.31, 518.59, 444.54,
    388.93, 311.16, 259.32, 222.27,
    194.47, 155.60, 129.66, 111.16,
    97.23, 77.82, 64.85, 55.60,
    48.62, 38.91, 32.43, 27.80,
    24.31, 19.46, 16.24, 13.92,
    12.15, 9.75, 8.12, 6.98,
    6.08, 4.90, 4.08, 3.49,
    3.04, 2.49, 2.13, 1.90,
    1.72, 1.41, 1.18, 1.04,
    0.91, 0.73, 0.59, 0.50,
    0.45, 0.45, 0.45, 0.45,
];

const fixed = (bits, v) => Math.trunc(2 ** bits * v) >>> 0;

function buildTables() {
    /* The level-and-pan gains. */
    for (let level = 0; level < 0x80; level++) {
        const totalLevel = Math.pow(10, (level * -24 / 64) / 20) / 4;
        for (let pan = 0; pan < 0x10; pan++) {
            let pl, pr;
            if (pan === 0x8) { pl = 0; pr = 0; }
            else if (pan === 0x0) { pl = 1; pr = 1; }
            else if (pan & 0x8) {
                const inv = 0x10 - pan;
                pl = 1;
                pr = (inv & 7) === 7 ? 0 : Math.pow(10, (inv * -12 / 4) / 20);
            } else {
                pr = 1;
                pl = (pan & 7) === 7 ? 0 : Math.pow(10, (pan * -12 / 4) / 20);
            }
            leftPan[(pan << 7) | level] = fixed(TL_SHIFT, pl * totalLevel);
            rightPan[(pan << 7) | level] = fixed(TL_SHIFT, pr * totalLevel);
        }
    }
    /* MAME's envelope and level-fade rates are per chip sample; these are per
     * board sample, which comes this much less often. */
    const ratio = M1_CPU_HZ / 224 / OUT_HZ;
    /* The pitch step at the chip's rate, 4096 x rate x (1024 + i) / 1024:
     * integers, (10 MHz / 224) x 4096 / 1024 = 10 MHz / 56. */
    for (let i = 0; i < 0x400; i++) freqStep[i] = Math.floor(M1_CPU_HZ * (1024 + i) / 56);
    const adr = 14.32833;
    for (let i = 4; i < 0x40; i++) {
        attackStep[i] = Math.trunc((0x400 << EG_SHIFT) / (BASE_TIMES[i] * 44100 / 1000) * ratio);
        decayReleaseStep[i] = Math.trunc((0x400 << EG_SHIFT) / (BASE_TIMES[i] * adr * 44100 / 1000) * ratio);
    }
    attackStep[0x3F] = 0x400 << EG_SHIFT;
    tlSteps[0] = Math.trunc(-(0x80 << TL_SHIFT) / (78.2 * 44100 / 1000) * ratio);
    tlSteps[1] = Math.trunc((0x80 << TL_SHIFT) / (78.2 * 2 * 44100 / 1000) * ratio);
    for (let i = 0; i < 0x400; i++) {
        const db = -(96 - (96 * i / 0x400));
        linToExp[i] = fixed(TL_SHIFT, Math.pow(10, db / 20));
    }
    /* The LFOs' waves, their depths and their rates (the C's float tables). */
    const f = Math.fround;
    const lfoFreq = [0.168, 2.019, 3.196, 4.206, 5.215, 5.888, 6.224, 7.066].map(f);
    const phaseLimit = [0, 3.378, 5.065, 6.750, 10.114, 20.170, 40.180, 79.307].map(f);
    const ampLimit = [0, 0.4, 0.8, 1.5, 3.0, 6.0, 12.0, 24.0].map(f);
    for (let i = 0; i < 256; i++) {
        if (i < 64) pitchTable[i] = i * 2 + 128;
        else if (i < 128) pitchTable[i] = 383 - i * 2;
        else if (i < 192) pitchTable[i] = 384 - i * 2;
        else pitchTable[i] = i * 2 - 383;
        amplitudeTable[i] = i < 128 ? 255 - (i * 2) : (i * 2) - 256;
    }
    for (let t = 0; t < 8; t++) {
        for (let i = -128; i < 128; i++)
            pitchScale[t][i + 128] = fixed(LFO_SHIFT, Math.pow(2, (phaseLimit[t] * i / 128) / 1200));
        for (let i = 0; i < 256; i++)
            amplitudeScale[t][i] = fixed(LFO_SHIFT, Math.pow(10, (-ampLimit[t] * i / 256) / 20));
        lfoStep[t] = fixed(LFO_SHIFT, lfoFreq[t] * 256 / OUT_HZ);
    }
}
buildTables();

/* ---- MultiPCM ---- */

class Lfo {
    constructor() {
        this.phase = 0;
        this.phaseStep = 0;
        this.amplitude = 0;   /* 1 = the amplitude tables, 0 = the pitch ones */
        this.scale = 0;
    }

    compute(freq, scale, amplitude) {
        this.phaseStep = lfoStep[freq];
        this.amplitude = amplitude;
        this.scale = scale;
    }

    step() {
        this.phase = (this.phase + this.phaseStep) & 0xFFFF;
        const table = this.amplitude ? amplitudeTable : pitchTable;
        const scale = this.amplitude ? amplitudeScale[this.scale] : pitchScale[this.scale];
        return scale[table[(this.phase >> LFO_SHIFT) & 0xFF]] << (TL_SHIFT - LFO_SHIFT);
    }
}

class Slot {
    constructor() {
        this.regs = new Uint8Array(11);
        this.playing = false;
        /* the sample's header */
        this.start = 0; this.loop = 0; this.end = 0; this.format = 0;
        this.attackReg = 0; this.decay1Reg = 0; this.decay2Reg = 0; this.decayLevel = 0;
        this.releaseReg = 0; this.keyRateScale = 0; this.lfoVibratoReg = 0; this.lfoAmplitudeReg = 0;
        this.offset = 0;
        this.octave = 0;
        this.pitch = 0;
        this.step = 0;
        this.pan = 0;
        this.totalLevel = 0;
        this.destTotalLevel = 0;
        this.totalLevelStep = 0;
        this.prevSample = 0;
        /* the envelope */
        this.volume = 0;
        this.state = ATTACK;
        this.attackRate = 0; this.decay1Rate = 0; this.decay2Rate = 0; this.releaseRate = 0; this.egDecayLevel = 0;
        this.lfoFrequency = 0;
        this.pitchLfo = new Lfo();
        this.vibrato = 0;
        this.amplitudeLfo = new Lfo();
        this.tremolo = 0;
    }

    egCalc() {
        let octave = this.octave;
        if (octave & 8) octave -= 16;
        const rate = this.keyRateScale !== 0xF ? (octave + this.keyRateScale) * 2 + ((this.pitch >> 9) & 1) : 0;
        this.attackRate = getRate(attackStep, rate, this.attackReg) | 0;
        this.decay1Rate = getRate(decayReleaseStep, rate, this.decay1Reg) | 0;
        this.decay2Rate = getRate(decayReleaseStep, rate, this.decay2Reg) | 0;
        this.releaseRate = getRate(decayReleaseStep, rate, this.releaseReg) | 0;
        this.egDecayLevel = 0xF - this.decayLevel;
    }

    egUpdate() {
        switch (this.state) {
        case ATTACK:
            /* a 64-bit product in the C; it stays inside 2^53 */
            this.volume += Math.floor(((0x817 << (EG_SHIFT - 1)) - this.volume) * this.attackRate / 16777216);
            if (this.volume >= (0x3FF << EG_SHIFT)) {
                this.state = this.decay1Rate >= (0x400 << EG_SHIFT) ? DECAY2 : DECAY1;
                this.volume = 0x3FF << EG_SHIFT;
            }
            break;
        case DECAY1:
            this.volume = (this.volume - this.decay1Rate) | 0;
            if (this.volume <= 0) this.volume = 0;
            if (this.volume >> (EG_SHIFT + 6) <= this.egDecayLevel) this.state = DECAY2;
            break;
        case DECAY2:
            this.volume = (this.volume - this.decay2Rate) | 0;
            if (this.volume <= 0) this.volume = 0;
            break;
        case RELEASE:
            this.volume = (this.volume - this.releaseRate) | 0;
            if (this.volume <= 0) { this.volume = 0; this.playing = false; }
            break;
        default:
            return 1 << TL_SHIFT;
        }
        return linToExp[this.volume >> EG_SHIFT];
    }

    retrigger() {
        this.offset = 0;
        this.prevSample = 0;
        this.totalLevel = (this.destTotalLevel << TL_SHIFT) >>> 0;
        this.egCalc();
        this.state = ATTACK;
        this.volume = (0x3FF - 0x2A0) << EG_SHIFT;
    }

    /* MAME: (freq_step << oct) / chip rate, a step per chip sample; here per
     * board sample, freq_step being at the chip's rate. */
    updateStep() {
        const oct = (this.octave - 1) & 0xF;
        let pitch = freqStep[this.pitch];
        if (oct & 0x8) pitch >>>= (16 - oct);
        else pitch = (pitch << oct) >>> 0;
        this.step = Math.floor(pitch / OUT_HZ);
    }
}

function getRate(steps, rate, val) {
    if (val === 0) return steps[0];
    if (val === 0xF) return steps[0x3F];
    let r = 4 * val + rate;
    if (r < 0) r = 0;
    if (r > 0x3F) r = 0x3F;
    return steps[r];
}

class MultiPCM {
    constructor() {
        this.slots = Array.from({ length: VOICES }, () => new Slot());
        this.curSlot = 0;
        this.address = 0;
        this.bank = 0;
        /* this chip's 4 MB of the sample set, and how much of it there is */
        this.rom = null;
        this.romSize = 0;
    }

    /* A byte of the chip's 4 MB space. */
    byte(a) {
        a &= 0x3FFFFF;
        if (a >= 0x200000) return 0;
        if (a >= 0x100000) a = (this.bank << 20) | (a & 0xFFFFF);
        return a < this.romSize ? this.rom[a] : 0;
    }

    initSample(sl, index) {
        const a = index * 12;
        const b = (o) => this.byte(a + o);
        let start = (b(0) << 16) | (b(1) << 8) | b(2);
        sl.format = (start >>> 20) & 0xFE;
        sl.start = start & 0x3FFFFF;
        sl.loop = (b(3) << 8) | b(4);
        sl.end = 0x10000 - ((b(5) << 8) | b(6));
        sl.attackReg = (b(8) >> 4) & 0xF;
        sl.decay1Reg = b(8) & 0xF;
        sl.decay2Reg = b(9) & 0xF;
        sl.decayLevel = (b(9) >> 4) & 0xF;
        sl.releaseReg = b(10) & 0xF;
        sl.keyRateScale = (b(10) >> 4) & 0xF;
        sl.lfoVibratoReg = b(7);
        sl.lfoAmplitudeReg = b(11) & 0xF;
    }

    writeSlot(sl, reg, data) {
        sl.regs[reg] = data;
        switch (reg) {
        case 0:
            sl.pan = (data >> 4) & 0xF;
            break;
        case 1:
            this.initSample(sl, sl.regs[1] | ((sl.regs[2] & 1) << 8));
            sl.regs[7] = (sl.attackReg << 4) | sl.decay1Reg;
            sl.regs[8] = (sl.decayLevel << 4) | sl.decay2Reg;
            sl.regs[9] = (sl.keyRateScale << 4) | sl.releaseReg;
            this.writeSlot(sl, 6, sl.lfoVibratoReg);
            this.writeSlot(sl, 10, sl.lfoAmplitudeReg);
            if (sl.playing) sl.retrigger();
            break;
        case 2:
        case 3:
            sl.octave = sl.regs[3] >> 4;
            sl.pitch = ((sl.regs[3] & 0xF) << 6) | (sl.regs[2] >> 2);
            sl.updateStep();
            break;
        case 4:
            if (data & 0x80) {
                sl.playing = true;
                sl.retrigger();
            } else if (sl.playing) {
                if (sl.releaseReg !== 0xF) sl.state = RELEASE;
                else sl.playing = false;
            }
            break;
        case 5:
            sl.destTotalLevel = (data >> 1) & 0x7F;
            if (!(data & 1))
                sl.totalLevelStep = (sl.totalLevel >>> TL_SHIFT) > sl.destTotalLevel ? tlSteps[0] : tlSteps[1];
            else
                sl.totalLevel = (sl.destTotalLevel << TL_SHIFT) >>> 0;
            break;
        case 6:
        case 10:
            sl.lfoFrequency = (sl.regs[6] >> 3) & 7;
            sl.vibrato = sl.regs[6] & 7;
            sl.tremolo = sl.regs[10] & 7;
            if (data) {
                sl.pitchLfo.compute(sl.lfoFrequency, sl.vibrato, 0);
                sl.amplitudeLfo.compute(sl.lfoFrequency, sl.tremolo, 1);
            }
            break;
        case 7:
        case 8:
        case 9:
            sl.attackReg = sl.regs[7] >> 4;
            sl.decay1Reg = sl.regs[7] & 0xF;
            sl.decayLevel = sl.regs[8] >> 4;
            sl.decay2Reg = sl.regs[8] & 0xF;
            sl.keyRateScale = sl.regs[9] >> 4;
            sl.releaseReg = sl.regs[9] & 0xF;
            sl.egCalc();
            break;
        }
    }

    write(offset, data) {
        switch (offset) {
        case 0:
            if (this.address < 11 && this.curSlot >= 0) this.writeSlot(this.slots[this.curSlot], this.address, data);
            break;
        case 1:
            this.curSlot = VALUE_TO_CHANNEL[data & 0x1F];
            break;
        case 2:
            this.address = data;
            break;
        }
    }

    /* One output sample, as gew_pcm_device::sound_stream_update makes it,
     * clamped to 16 bits, into this.l / this.r. */
    sample() {
        let smpl = 0, smpr = 0;
        for (let i = 0; i < VOICES; i++) {
            const sl = this.slots[i];
            if (!sl.playing) continue;
            const vol = (sl.totalLevel >>> TL_SHIFT) | (sl.pan << 7);
            const spos = sl.offset >>> TL_SHIFT;
            let step = sl.step;
            let csample;
            const fpart = sl.offset & ((1 << TL_SHIFT) - 1);
            if (sl.format & 4) {             /* 12-bit, two samples in three bytes */
                const adr = sl.start + (spos >>> 1) * 3;
                if (!(spos & 1)) csample = ((this.byte(adr) << 8) | ((this.byte(adr + 1) & 0xF) << 4)) << 16 >> 16;
                else csample = ((this.byte(adr + 2) << 8) | (this.byte(adr + 1) & 0xF0)) << 16 >> 16;
            } else {
                csample = (this.byte(sl.start + spos) << 8) << 16 >> 16;
            }
            let s = (csample * fpart + sl.prevSample * ((1 << TL_SHIFT) - fpart)) >> TL_SHIFT;
            if (sl.vibrato) step = (Math.imul(step, sl.pitchLfo.step()) >>> 0) >>> TL_SHIFT;
            sl.offset = (sl.offset + step) >>> 0;
            if (spos !== (sl.offset >>> TL_SHIFT)) sl.prevSample = csample;
            if (sl.offset >= ((sl.end << TL_SHIFT) >>> 0))
                sl.offset = (sl.offset - (((sl.end - sl.loop) << TL_SHIFT) >>> 0)) >>> 0;
            if ((sl.totalLevel >>> TL_SHIFT) !== sl.destTotalLevel)
                sl.totalLevel = (sl.totalLevel + sl.totalLevelStep) >>> 0;
            if (sl.tremolo) s = Math.imul(s, sl.amplitudeLfo.step()) >> TL_SHIFT;
            s = Math.imul(s, sl.egUpdate()) >> 10;
            smpl += Math.imul(leftPan[vol & 0x7FF], s) >> TL_SHIFT;
            smpr += Math.imul(rightPan[vol & 0x7FF], s) >> TL_SHIFT;
        }
        this.l = smpl < -32768 ? -32768 : smpl > 32767 ? 32767 : smpl;
        this.r = smpr < -32768 ? -32768 : smpr > 32767 ? 32767 : smpr;
    }
}

/* ---- YM3438: timers and busy ---- */

class YM3438Timers {
    constructor() {
        this.addr = 0;
        this.r24 = 0; this.r25 = 0; this.r26 = 0; this.r27 = 0;
        this.status = 0;          /* bit 0 timer A, bit 1 timer B */
        this.running = [0, 0];
        this.timerAt = [-1, -1];  /* YM clock the timer expires on, -1 = stopped */
        this.busyEnd = 0;         /* YM clock the busy flag drops */
        this.now = 0;             /* YM clocks (8 MHz) */
    }

    updateTimer(t, enable, delta) {
        if (enable && !this.running[t]) {
            let period = t === 0 ? 1024 - ((this.r24 << 2) | (this.r25 & 3)) : 16 * (256 - this.r26);
            period += delta;
            this.timerAt[t] = this.now + period * YM_PRESCALE;
            this.running[t] = 1;
        } else if (!enable) {
            this.timerAt[t] = -1;
            this.running[t] = 0;
        }
    }

    modeWrite(data) {
        this.r27 = data;
        const reset = (((data >> 5) & 1) << 1) | ((data >> 4) & 1);
        this.status &= ~reset & 0xFF;
        /* timer B's x16 is free-running, so its first tick comes early (ymfm) */
        this.updateTimer(1, (data >> 1) & 1, -(Math.floor(this.now / YM_PRESCALE) & 15));
        this.updateTimer(0, data & 1, 0);
    }

    advance(to) {
        for (;;) {
            let t = -1;
            for (let i = 0; i < 2; i++)
                if (this.timerAt[i] >= 0 && this.timerAt[i] <= to && (t < 0 || this.timerAt[i] < this.timerAt[t])) t = i;
            if (t < 0) break;
            this.now = this.timerAt[t];
            if (t === 0 && (this.r27 & 0x04)) this.status |= 1;
            else if (t === 1 && (this.r27 & 0x08)) this.status |= 2;
            this.running[t] = 0;
            this.updateTimer(t, 1, 0);
        }
        if (to > this.now) this.now = to;
    }

    read(offset) {
        if ((offset & 3) !== 0) return 0;
        return this.status | (this.now < this.busyEnd ? 0x80 : 0);
    }

    write(offset, data) {
        switch (offset & 3) {
        case 0: this.addr = data; return;
        case 2: this.addr = 0x100 | data; return;
        case 1:
            if (this.addr & 0x100) return;
            switch (this.addr) {
            case 0x24: this.r24 = data; break;
            case 0x25: this.r25 = data; break;
            case 0x26: this.r26 = data; break;
            case 0x27: this.modeWrite(data); break;
            /* 0x28 key-ons: the board has no FM voices to play them */
            }
            break;
        case 3:
            if (!(this.addr & 0x100)) return;
            break;
        }
        this.busyEnd = this.now + 32 * 6;
    }
}

/* ---- the board's chips ---- */

export class Model1Chips {
    /* samples: the set's sample ROMs, chip 1's 4 MB then chip 2's. */
    constructor(samples) {
        this.pcm = [new MultiPCM(), new MultiPCM()];
        this.setSamples(samples);
        this.reset();
    }

    setSamples(samples) {
        const size = samples ? samples.length : 0;
        const n1 = Math.min(size, M1_PCM_SIZE);
        const n2 = size > M1_PCM_SIZE ? size - M1_PCM_SIZE : 0;
        this.pcm[0].rom = n1 ? samples.subarray(0, n1) : null;
        this.pcm[0].romSize = n1;
        this.pcm[1].rom = n2 ? samples.subarray(M1_PCM_SIZE) : null;
        this.pcm[1].romSize = n2;
    }

    reset() {
        for (const p of this.pcm) {
            p.slots = Array.from({ length: VOICES }, () => new Slot());
            p.curSlot = 0;
            p.address = 0;
            p.bank = 0;
        }
        this.ym = new YM3438Timers();
        /* the 68000's i8251 */
        this.rxData = 0; this.rxrdy = 0; this.modeDone = 0; this.rxe = 0;
        this.tx = new Uint8Array(TX_FIFO);   /* bytes the 68000 sent the i960 */
        this.txR = 0; this.txW = 0;
        this.cycFrac = 0;                    /* 68000 clocks owed to the next sample, x44100 */
    }

    /* A byte off the serial line into the 68000's receiver. A receiver that
     * is off ignores it; one that still holds a byte loses the old one. */
    rx(b) {
        if (!this.rxe) return;
        this.rxData = b;
        this.rxrdy = 1;
    }

    uartRead(reg) {
        if (reg === 0) { this.rxrdy = 0; return this.rxData; }
        return 0x85 | (this.rxrdy ? 0x02 : 0);   /* TxRDY, TxEMPTY, DSR; RxRDY */
    }

    uartWrite(reg, v) {
        if (reg === 0) {
            if (((this.txW - this.txR) & 0xFF) < TX_FIFO) { this.tx[this.txW % TX_FIFO] = v; this.txW = (this.txW + 1) & 0xFF; }
            return;
        }
        /* The first control write after a reset is the mode, the rest
         * commands; command bit 6 is an internal reset back to a mode. */
        if (!this.modeDone) { this.modeDone = 1; return; }
        if (v & 0x40) { this.modeDone = 0; this.rxe = 0; return; }
        this.rxe = (v >> 2) & 1;
    }

    txReady() { return this.txR !== this.txW; }
    txPop() { const b = this.tx[this.txR % TX_FIFO]; this.txR = (this.txR + 1) & 0xFF; return b; }

    /* The 68000 clocks to the next board sample: 10 MHz / 44.1 kHz = 226.757. */
    sampleCycles() {
        this.cycFrac += M1_CPU_HZ % OUT_HZ;
        let n = Math.floor(M1_CPU_HZ / OUT_HZ);
        if (this.cycFrac >= OUT_HZ) { this.cycFrac -= OUT_HZ; n++; }
        return n;
    }

    /* The board's output sample into this.l / this.r: the two MultiPCMs at
     * 0.5 each (segam1audio's routes; the YM3438 makes nothing). */
    sample() {
        let l1 = 0, r1 = 0, l2 = 0, r2 = 0;
        const [a, b] = this.pcm;
        if (a.romSize) { a.sample(); l1 = a.l; r1 = a.r; }
        if (b.romSize) { b.sample(); l2 = b.l; r2 = b.r; }
        this.l = (l1 + l2) >> 1;
        this.r = (r1 + r2) >> 1;
    }
}
