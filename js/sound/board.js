/*
 * board.js — the Model 2 and Model 1 sound boards, in JavaScript.
 *
 * A port of m2-hle2's sound board (src/board/sound.h, at 6a15509), which is
 * graded against MAME's note for note: the game's own sound driver on a
 * 68000 (m68k.js), and the chips it drives. That is the Model 2 board's SCSP
 * (scsp.js), or, for Daytona USA and Virtua Cop, the board the original
 * Model 2 kept from Model 1: two MultiPCMs and a YM3438 (model1.js). Where
 * m2-hle2 has a game's driver ported to C, the C makes the same sound as the
 * 68000 does; here every driver runs on the 68000.
 *
 * What the page sends is what the i960 sends: three-byte MIDI-framed
 * commands, 0xAE 0x10 0x04 for South Island's music, down the i960's UART.
 *
 *   new SoundBoardChip(model1)   which board
 *   init(program, samples)       the program ROMs as the zip holds them, laid
 *                                end to end, and the sample ROMs laid end to
 *                                end (on the Model 1 board each MultiPCM's
 *                                4 MB, the first chip's then the second's);
 *                                boots the board; false if nothing loaded
 *   send(byte)                   one byte down the i960's sound UART
 *   render(l, r, at, n)          n samples at 44.1 kHz into two Float32Arrays
 */

import { M68K } from './m68k.js';
import { SCSP } from './scsp.js';
import { Model1Chips } from './model1.js';

const RAM_SIZE = 0x80000;
const ROM_BASE = 0x600000;
const ROM_SIZE = 0x80000;
const SCSP_BASE = 0x100000;
const SCSP_SIZE = 0x1000;
const SNDCTL_BASE = 0x400000;
const SNDCTL_SIZE = 2;
const CYCLES_PER_SAMPLE = 256;   /* 11.2896 MHz / 44.1 kHz */
const IPL_LEAD = 4;              /* see step */
const QUEUE = 256;               /* the page's bytes, waiting for the UART */

/* ---- the sound UART and its serial line ----
 *
 * The i960's UART is a uPD71051 (an i8251) clocked at 16 x 31250 baud, and
 * its TxD runs into the SCSP's serial receiver (MAME model2.cpp). A byte goes
 * out as a start bit, eight data bits and a stop bit, 32 us each, and the
 * SCSP takes it when it samples the stop bit:
 *   - the UART's bit clock is free-running from power-on, its ticks at 18 us
 *     mod 32 us of board time;
 *   - a byte written to an idle UART starts at the next tick after the write;
 *   - the UART holds ONE more byte, which starts the tick the line frees, and
 *     TxRDY is up whenever that holding register is empty;
 *   - the receiver samples each bit 1.5 bit times after its edge, so the byte
 *     lands 9.5 bit times after the start bit: 304 us.
 * Time on the line is in units of 1/625 of a 68000 clock period, in which a
 * microsecond is exactly 7056. */
const UART_FIFO = 32;
const SER_UNIT = 625;
const SER_US = 7056;
const SER_BIT = 32 * SER_US;
const SER_PHASE = 18 * SER_US;
const SER_FRAME = 10 * SER_BIT;
const SER_RX = 19 * SER_BIT / 2;

export class SoundBoardChip {
    constructor(model1) {
        this.model1 = !!model1;
        this.ram = new Uint8Array(RAM_SIZE);
        this.rom = new Uint8Array(ROM_SIZE);
        this.romLoaded = false;
        this.samples = null;
        this.samplesSize = 0;
        this.bank4 = 0x200000;
        this.bank5 = 0x600000;
        this.budget = 0;
        this.cpu = new M68K();
        this.scsp = new SCSP(this.ram, () => this.cpu.cycles);
        this.m1 = new Model1Chips(null);
        /* the i960's UART and the serial line to the chip */
        this.uByte = new Uint8Array(UART_FIFO);
        this.uWrote = new Float64Array(UART_FIFO);
        this.uR = 0; this.uW = 0; this.uCount = 0;
        this.uStart = 0;     /* units: the byte on the line began its start bit */
        this.uDeliver = 0;   /* clock period the chip takes it, 0 = taken */
        /* the page's bytes */
        this.queue = new Uint8Array(QUEUE);
        this.qR = 0; this.qW = 0;
    }

    /* ---- the 68000's bus, Model 2 ---- */

    /* A byte anywhere a page map does not reach (an access across a page). */
    romByte(a) {
        if (a < RAM_SIZE) return this.ram[a];
        if (a >= ROM_BASE && a < ROM_BASE + ROM_SIZE) return this.rom[a - ROM_BASE];
        if (!this.samples) return 0;
        let o;
        if (a >= 0x800000 && a < 0xA00000) o = a - 0x800000;
        else if (a >= 0xA00000 && a < 0xE00000) o = this.bank4 + (a - 0xA00000);
        else if (a >= 0xE00000) o = this.bank5 + (a - 0xE00000);
        else return 0;
        return o < this.samplesSize ? this.samples[o] : 0;
    }

    read2(addr, sz) {
        addr &= 0xFFFFFF;
        if (addr >= SCSP_BASE && addr < SCSP_BASE + SCSP_SIZE) return this.scsp.read(addr - SCSP_BASE, sz);
        /* only pages mapPages leaves off come here: the DSP's delay line */
        if (addr + sz <= RAM_SIZE) this.scsp.ramTouch(addr, sz, 0);
        let v = 0;
        for (let i = 0; i < sz; i++) v = (v << 8) | this.romByte((addr + i) & 0xFFFFFF);
        return v >>> 0;
    }

    write2(addr, val, sz) {
        addr &= 0xFFFFFF;
        if (addr + sz <= RAM_SIZE) {
            this.scsp.ramTouch(addr, sz, 1);   /* a write into the DSP's ring wakes it */
            const p = this.ram;
            if (sz === 1) { p[addr] = val; return; }
            if (sz === 2) { p[addr] = val >>> 8; p[addr + 1] = val; return; }
            p[addr] = val >>> 24; p[addr + 1] = val >>> 16; p[addr + 2] = val >>> 8; p[addr + 3] = val;
            return;
        }
        if (addr >= SCSP_BASE && addr < SCSP_BASE + SCSP_SIZE) {
            const s = this.scsp, lo = s.dspLo, hi = s.dspHi;
            s.write(addr - SCSP_BASE, val >>> 0, sz);
            if (s.dspLo !== lo || s.dspHi !== hi) this.mapPages();
            return;
        }
        if (addr >= SNDCTL_BASE && addr < SNDCTL_BASE + SNDCTL_SIZE) {
            if (this.samplesSize > 0x800000) {                 /* bigger sets bank their upper half */
                this.bank4 = (val & 0x20) ? 0x200000 : 0x800000;
                this.bank5 = (val & 0x20) ? 0x600000 : 0xA00000;
                this.mapPages();
            }
        }
        /* ROM and unmapped space ignore writes */
    }

    /* ---- the 68000's bus, Model 1 ---- */

    read1(a, sz) {
        a &= 0xFFFFFF;
        if (sz === 4) return ((this.read1(a, 2) << 16) | this.read1(a + 2, 2)) >>> 0;
        let p = -1, mem = this.rom;
        if (a < 0x40000) p = a;
        else if (a >= 0x80000 && a < 0xA0000) p = a - 0x60000;
        else if (a >= 0xF00000 && a < 0xF10000) { p = a & 0xFFFF; mem = this.ram; }
        if (p >= 0) return sz === 1 ? mem[p] : (mem[p] << 8) | mem[p + 1];
        /* The chips sit on the low byte of each word (umask 0x00ff). */
        if (sz === 1 && !(a & 1)) return 0;
        const reg = (a & 0xF) >> 1;
        if (a >= 0xC20000 && a < 0xC20004) return this.m1.uartRead(reg);
        if (a >= 0xD00000 && a < 0xD00008) {
            this.m1.ym.advance(this.ymClock());
            return this.m1.ym.read(reg);
        }
        return 0;                                /* MultiPCM reads 0; the rest is open */
    }

    write1(a, v, sz) {
        a &= 0xFFFFFF;
        if (sz === 4) { this.write1(a, v >>> 16, 2); this.write1(a + 2, v & 0xFFFF, 2); return; }
        if (a >= 0xF00000 && a < 0xF10000) {
            const p = a & 0xFFFF;
            if (sz === 1) this.ram[p] = v;
            else { this.ram[p] = v >>> 8; this.ram[p + 1] = v; }
            return;
        }
        /* The bank registers take the word; a byte at the even address lands
         * in its high half and leaves bits 0-1 clear. */
        if ((a & ~1) === 0xC50000 || (a & ~1) === 0xC70000) {
            const w = sz === 2 ? v : (a & 1) ? v : v << 8;
            this.m1.pcm[a >= 0xC70000 ? 1 : 0].bank = w & 3;
            return;
        }
        if (sz === 1 && !(a & 1)) return;
        const reg = (a & 0xF) >> 1;
        v &= 0xFF;
        if (a >= 0xC20000 && a < 0xC20004) this.m1.uartWrite(reg, v);
        else if (a >= 0xC40000 && a < 0xC40008) this.m1.pcm[0].write(reg, v);
        else if (a >= 0xC60000 && a < 0xC60008) this.m1.pcm[1].write(reg, v);
        else if (a >= 0xD00000 && a < 0xD00008) {
            this.m1.ym.advance(this.ymClock());
            this.m1.ym.write(reg, v);
        }
    }

    /* The YM3438's clock, 8 MHz to the 68000's 10. */
    ymClock() { return Math.floor(this.cpu.cycles * 4 / 5); }

    /* The 68000's direct-read pages: every region a read does nothing to but
     * read. A page is mapped only when all of it reads from one run of bytes;
     * a sample window past the end of the set stays on the callback and reads
     * its zeros there. Rebuilt whenever what backs a page changes. */
    mapPages() {
        const m = this.cpu.rmap, w = this.cpu.wmap;
        m.fill(null);
        w.fill(0);
        if (this.model1) {
            if (this.romLoaded) {
                for (let pg = 0; pg < 4; pg++) m[pg] = this.rom.subarray(pg << 16, (pg + 1) << 16);
                for (let pg = 0; pg < 2; pg++) m[8 + pg] = this.rom.subarray(0x20000 + (pg << 16), 0x20000 + ((pg + 1) << 16));
            }
            m[0xF0] = this.ram.subarray(0, 0x10000);
            return;
        }
        /* MAME model2.cpp model2_snd: one wait state on every sound RAM and
         * SCSP access ("the same waitstate weights as Saturn"). */
        /* Not the pages the DSP keeps its delay line in: a read there tells
         * the chip (scsp.js ramTouch), which can change whether its DSP
         * sleeps. */
        const lo = this.scsp.dspLo, hi = this.scsp.dspHi;
        for (let pg = 0; pg < RAM_SIZE >> 16; pg++) {
            w[pg] = 1;
            if (!((pg << 16) < hi && lo < ((pg + 1) << 16))) m[pg] = this.ram.subarray(pg << 16, (pg + 1) << 16);
        }
        w[SCSP_BASE >> 16] = 1;
        if (this.romLoaded)
            for (let pg = 0; pg < ROM_SIZE >> 16; pg++) m[(ROM_BASE >> 16) + pg] = this.rom.subarray(pg << 16, (pg + 1) << 16);
        if (this.samples) {
            /* 0x800000 the set's first 2 MB, 0xA00000 and 0xE00000 its banks */
            for (let pg = 0x80; pg < 0x100; pg++) {
                const a = pg << 16;
                let o;
                if (a < 0xA00000) o = a - 0x800000;
                else if (a < 0xE00000) o = this.bank4 + (a - 0xA00000);
                else o = this.bank5 + (a - 0xE00000);
                if (o + 0x10000 <= this.samplesSize) m[pg] = this.samples.subarray(o, o + 0x10000);
            }
        }
    }

    /* ---- the serial line ---- */

    /* A 68000 clock in the line's units, and the first clock at or after a
     * time in them: 625 units a clock period at 11.2896 MHz; at the Model 1
     * board's 10 MHz, 705.6. */
    serUnits(clock) { return this.model1 ? Math.floor(clock * 3528 / 5) : clock * SER_UNIT; }
    serClock(units) { return this.model1 ? Math.floor((units * 5 + 3527) / 3528) : Math.floor((units + SER_UNIT - 1) / SER_UNIT); }

    /* the first bit tick strictly after u (units) */
    static tickAfter(u) {
        if (u < SER_PHASE) return SER_PHASE;
        return SER_PHASE + (Math.floor((u - SER_PHASE) / SER_BIT) + 1) * SER_BIT;
    }

    /* The byte at the head of the queue goes onto the line: at freeAt (the
     * tick the previous byte's stop bit ended on) if it was waiting for the
     * line, else at the first tick after its write. */
    uartBegin(freeAt) {
        const w = this.uWrote[this.uR];
        this.uStart = w < freeAt ? freeAt : SoundBoardChip.tickAfter(w);
        this.uDeliver = this.serClock(this.uStart + SER_RX);
    }

    /* Bring the line up to the 68000's clock: hand the chip the byte whose
     * stop bit it has sampled, and start the next byte where the line freed. */
    uartService(now) {
        while (this.uCount) {
            if (this.uDeliver) {
                if (now < this.uDeliver) return;
                if (this.model1) this.m1.rx(this.uByte[this.uR]);
                else this.scsp.midiIn(this.uByte[this.uR]);
                this.uDeliver = 0;
            }
            const end = this.uStart + SER_FRAME;
            if (this.serUnits(now) < end) return;          /* the stop bit is still going out */
            this.uR = (this.uR + 1) & (UART_FIFO - 1);
            this.uCount--;
            if (this.uCount) this.uartBegin(end);
        }
    }

    /* A byte written to the UART at clock period `clock`. */
    uartWrite(b, clock) {
        this.uartService(clock);
        if (this.uCount === UART_FIFO) return;
        this.uByte[this.uW] = b;
        this.uWrote[this.uW] = this.serUnits(clock);
        this.uW = (this.uW + 1) & (UART_FIFO - 1);
        if (this.uCount++ === 0) this.uartBegin(0);
    }

    /* TxRDY: the holding register is empty (the chip holds one byte behind
     * the one on the line). */
    uartTxRdy() { return this.uCount < 2; }

    /* ---- lifecycle ---- */

    init(program, samples) {
        /* MAME's ROM_LOAD16_WORD_SWAP: the zip holds the program ROM a byte
         * pair at a time the other way round. */
        const n = Math.min(program.length, ROM_SIZE);
        this.rom.fill(0xFF);
        for (let i = 0; i + 1 < n; i += 2) { this.rom[i] = program[i + 1]; this.rom[i + 1] = program[i]; }
        this.samples = samples;
        this.samplesSize = samples.length;
        this.m1.setSamples(samples);
        this.reset();
        this.romLoaded = true;
        this.boot();
        this.qR = this.qW = 0;
        return true;
    }

    reset() {
        this.ram.fill(0);
        this.cpu.reset();
        this.scsp.reset();
        this.budget = 0;
        this.uR = this.uW = this.uCount = 0;
        this.uStart = this.uDeliver = 0;
        this.bank4 = 0x200000;
        this.bank5 = 0x600000;
        this.m1.reset();
        this.setBus();
        this.mapPages();
    }

    setBus() {
        const c = this.cpu;
        c.read = this.model1 ? (a, sz) => this.read1(a, sz) : (a, sz) => this.read2(a, sz);
        c.write = this.model1 ? (a, v, sz) => this.write1(a, v, sz) : (a, v, sz) => this.write2(a, v, sz);
    }

    /* MAME model2.cpp reset_model2_scsp: the 68000's reset vectors come from
     * the first 16 bytes of the program ROM, copied into sound RAM. The Model
     * 1 board's are in its ROM. */
    boot() {
        if (!this.model1) this.ram.set(this.rom.subarray(0, 16));
        this.cpu.reset();
        this.setBus();
        this.mapPages();
        this.cpu.startup();
    }

    /* ---- running ---- */

    /* One step of the 68000 inside a sample's budget: an interrupt taken, an
     * instruction run, or the rest of the budget spent stopped. Answers false
     * when the budget is gone that way.
     *
     * The 68000 samples its interrupt lines IPL_LEAD periods before an
     * instruction ends (MAME's m68000 loads the pending interrupt with the
     * instruction's last prefetch): a timer that expires later than that, or
     * a byte the serial line lands later than that, is only acted on after
     * the next instruction. The mask it compares against is the one the
     * instruction leaves. */
    step() {
        const m = this.cpu;
        if (m.halted) { this.budget = 0; return false; }
        const c0 = m.cycles;
        const sampled = c0 >= IPL_LEAD ? c0 - IPL_LEAD : 0;
        this.scsp.timers(sampled);
        if (this.uCount) this.uartService(sampled);
        const lvl = this.scsp.irqLevel();
        if (lvl > m.ipl() && m.interrupt(lvl)) {
            /* taken */
        } else if (m.stopped) {
            m.cycles += this.budget;   /* time passes while it waits */
            this.budget = 0;
            return false;
        } else {
            m.stepCore();
        }
        this.budget -= m.cycles - c0;
        return true;
    }

    /* step on the Model 1 board: the i8251's RxRDY is its one interrupt,
     * level 2 (segam1audio.cpp). The YM3438's timers catch up when the
     * driver reads or writes the chip. */
    step1() {
        const m = this.cpu;
        if (m.halted) { this.budget = 0; return false; }
        const c0 = m.cycles;
        const sampled = c0 >= IPL_LEAD ? c0 - IPL_LEAD : 0;
        if (this.uCount) this.uartService(sampled);
        if (this.m1.rxrdy && m.ipl() < 2 && m.interrupt(2)) {
            /* taken */
        } else if (m.stopped) {
            m.cycles += this.budget;
            this.budget = 0;
            return false;
        } else {
            m.stepCore();
        }
        this.budget -= m.cycles - c0;
        return true;
    }

    /* One output sample into l[i] / r[i]. */
    runSample(l, r, i) {
        if (this.model1) {
            const m1 = this.m1;
            this.budget += m1.sampleCycles();
            while (this.budget > 0 && this.step1()) {}
            m1.sample();
            l[i] = m1.l * (1 / 32768);
            r[i] = m1.r * (1 / 32768);
            return;
        }
        this.budget += CYCLES_PER_SAMPLE;
        while (this.budget > 0 && this.step()) {}
        const s = this.scsp;
        s.tick();
        l[i] = s.outL * (1 / 32768);
        r[i] = s.outR * (1 / 32768);
    }

    send(b) {
        if (this.qW - this.qR >= QUEUE) return false;
        this.queue[this.qW++ % QUEUE] = b;
        return true;
    }

    /* The Model 1 board's receiver drops what arrives before its driver turns
     * it on, and keeps one byte, which the next overwrites, until the driver
     * takes it. The i960 is still booting all that while; the page sends at
     * once, so on that board a byte waits here until the receiver is on and
     * has handed on the last. */
    listening() {
        return !this.model1 || (this.m1.rxe && !this.m1.rxrdy && !this.uCount);
    }

    /* n samples into l and r from `at`. While a byte waits for the UART the
     * board is offered it before each sample, as the i960 polls TxRDY, a run
     * of one sample at a time; otherwise the n are one run. The SCSP hears
     * where each run ends (scsp.js sync), as m2-hle2's does. */
    render(l, r, at, n) {
        if (!this.romLoaded) {
            l.fill(0, at, at + n);
            r.fill(0, at, at + n);
            return;
        }
        const end = at + n;
        for (let i = at; i < end;) {
            let stop = end;
            if (this.qR !== this.qW) {
                stop = i + 1;
                this.uartService(this.cpu.cycles);
                if (this.listening() && this.uartTxRdy()) this.uartWrite(this.queue[this.qR++ % QUEUE], this.cpu.cycles);
            }
            for (; i < stop; i++) this.runSample(l, r, i);
            if (!this.model1) this.scsp.sync();
        }
    }
}
