/*
 * model1.c — the Model 1 sound board, for the browser.
 *
 * Daytona USA runs on the original Model 2, which kept Model 1's sound board:
 * a 68000 at 10 MHz running the game's sound driver, two MultiPCM sample
 * chips and a YM3438, told what to play down an 8251 UART by the i960. This
 * is that board as MAME builds it (src/mame/shared/segam1audio.cpp): the same
 * memory map, the same clocks and the same mix, with the 68000 m2-hle2's (the
 * core the Model 2 board in board.c runs on) and the two chips MAME's own
 * (model1_chips.cpp).
 *
 * It has the surface board.c has, so the page and the worklet drive either
 * one the same way, plus snd_rate(): this board makes MultiPCM's own rate,
 * 10 MHz / 224 = 44642.857 Hz, not 44.1 kHz.
 *
 *   snd_init(p, np, s, ns)  the program ROMs as the zip holds them, laid end
 *                           to end (MAME's ROM_LOAD16_WORD_SWAP), and the two
 *                           MultiPCM regions of 4 MB each, end to end
 *   snd_send(b)             one byte down the i960's sound UART
 *   snd_render(n)           n samples as float stereo pairs at snd_out()
 *
 * Timing. Everything runs off the 68000's cycle count. Each output sample is
 * 224 of its cycles; the YM3438 runs at 8 MHz, so 0.8 of its clocks to one of
 * the 68000's, and makes a sample every 144 of them, which is mixed in at the
 * MultiPCM's rate by holding the last (MAME resamples; at these two rates the
 * difference is far above anything a driver's music has in it). The UART
 * takes a byte every 320 us, 31250 baud with a start and a stop bit, as the
 * i960's does.
 *
 * Built by build.sh into js/sound/model1.wasm.
 */
#define NDEBUG 1
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "log.h"
#undef LOG_INFO
#undef LOG_WARN
#undef LOG_ERROR
#undef LOG_DEBUG
#define LOG_INFO(...)  ((void)0)
#define LOG_WARN(...)  ((void)0)
#define LOG_ERROR(...) ((void)0)
#define LOG_DEBUG(...) ((void)0)

#include "m68k.h"
#include "m68k_exec.h"

void m1_chips_init(float pcm_rate, const uint8_t *pcm1, const uint8_t *pcm2);
void m1_pcm_write(int chip, uint32_t offset, uint8_t data);
void m1_pcm_bank(int chip, uint32_t bank);
void m1_pcm_sample(int chip, int32_t *l, int32_t *r);
void m1_ym_advance(uint64_t clock);
uint8_t m1_ym_read(uint32_t offset);
void m1_ym_write(uint32_t offset, uint8_t data);
void m1_ym_sample(int32_t *l, int32_t *r);

#define CPU_HZ        10000000u
#define PCM_DIV       224u
#define YM_DIV        144u               /* YM3438 clocks a sample */
#define BYTE_CYCLES   3200u              /* 10 bits at 31250 baud */
#define PROG_SIZE     0xC0000u           /* MAME's region */
#define PCM_SIZE      0x400000u

#define SND_BLOCK 1024u
#define SND_QUEUE 256u

static m68k_state_t s_cpu;
static uint8_t s_prog[PROG_SIZE];
static uint8_t s_ram[0x10000];
static float   s_out[SND_BLOCK * 2];

/* The UART as the 68000 sees it: a received byte, whether one is waiting,
 * and whether the driver has turned the receiver on. Bytes the page sends
 * queue here and arrive one per BYTE_CYCLES. */
static struct {
    uint8_t  data, rxrdy, mode_done, rxe;
    uint8_t  queue[SND_QUEUE];
    uint32_t qr, qw;
    uint64_t next_at;
} s_uart;

static uint64_t s_ym_samples;            /* YM3438 samples made so far */
static int32_t  s_ym_l, s_ym_r;

#define EXPORT __attribute__((used, visibility("default")))

/* ---- the 68000's memory ---------------------------------------------------- */

static uint8_t uart_read(uint32_t reg) {
    if (reg == 0) {
        s_uart.rxrdy = 0;
        return s_uart.data;
    }
    /* TxRDY, TxEMPTY and DSR always; RxRDY when a byte is in. */
    return 0x85 | (s_uart.rxrdy ? 0x02 : 0);
}

static void uart_write(uint32_t reg, uint8_t v) {
    if (reg == 0) return;                /* the board sends nothing we listen to */
    /* The first control write after reset is the mode, the rest commands;
     * command bit 6 is an internal reset back to expecting a mode. */
    if (!s_uart.mode_done) { s_uart.mode_done = 1; return; }
    if (v & 0x40) { s_uart.mode_done = 0; s_uart.rxe = 0; return; }
    s_uart.rxe = (v >> 2) & 1;
}

/* A device on the low byte of each word (umask 0x00ff): the byte at the odd
 * address, or the low half of a word. */
static int dev_byte(uint32_t a, int sz, uint32_t *reg) {
    if (sz == 1 && !(a & 1)) return 0;
    *reg = (a & 0xF) >> 1;
    return 1;
}

static uint32_t m1_read(void *ctx, uint32_t a, int sz) {
    (void)ctx;
    a &= 0xFFFFFF;
    if (sz == 4) return (m1_read(ctx, a, 2) << 16) | m1_read(ctx, a + 2, 2);
    uint32_t reg, v = 0;
    if (a < 0x40000 || (a >= 0x80000 && a < 0xA0000)) {
        uint32_t o = a < 0x40000 ? a : a - 0x80000 + 0x20000;
        v = sz == 1 ? s_prog[o] : (uint32_t)(s_prog[o & ~1u] << 8 | s_prog[o | 1]);
        return v;
    }
    if (a >= 0xF00000 && a < 0xF10000) {
        uint32_t o = a & 0xFFFF;
        return sz == 1 ? s_ram[o] : (uint32_t)(s_ram[o & ~1u] << 8 | s_ram[o | 1]);
    }
    if (a >= 0xC20000 && a < 0xC20004 && dev_byte(a, sz, &reg)) v = uart_read(reg);
    else if (a >= 0xD00000 && a < 0xD00008 && dev_byte(a, sz, &reg)) v = m1_ym_read(reg);
    return v;                            /* MultiPCM reads 0; the rest is open */
}

static void m1_write(void *ctx, uint32_t a, uint32_t v, int sz) {
    (void)ctx;
    a &= 0xFFFFFF;
    if (sz == 4) { m1_write(ctx, a, v >> 16, 2); m1_write(ctx, a + 2, v & 0xFFFF, 2); return; }
    uint32_t reg;
    if (a >= 0xF00000 && a < 0xF10000) {
        uint32_t o = a & 0xFFFF;
        if (sz == 1) s_ram[o] = (uint8_t)v;
        else { s_ram[o & ~1u] = (uint8_t)(v >> 8); s_ram[o | 1] = (uint8_t)v; }
        return;
    }
    /* The bank registers take the word; a byte at the even address lands in
     * its high half, which leaves bits 0-1 clear. */
    if ((a & ~1u) == 0xC50000 || (a & ~1u) == 0xC70000) {
        uint32_t w = sz == 2 ? v : (a & 1) ? v : v << 8;
        m1_pcm_bank(a >= 0xC70000, w & 3);
        return;
    }
    if (!dev_byte(a, sz, &reg)) return;
    if (a >= 0xC20000 && a < 0xC20004) uart_write(reg, (uint8_t)v);
    else if (a >= 0xC40000 && a < 0xC40008) m1_pcm_write(0, reg, (uint8_t)v);
    else if (a >= 0xC60000 && a < 0xC60008) m1_pcm_write(1, reg, (uint8_t)v);
    else if (a >= 0xD00000 && a < 0xD00008) m1_ym_write(reg, (uint8_t)v);
}

/* ---- running it ------------------------------------------------------------ */

EXPORT void *snd_alloc(uint32_t n) { return malloc(n); }
EXPORT float *snd_out(void) { return s_out; }
EXPORT double snd_rate(void) { return (double)CPU_HZ / PCM_DIV; }

EXPORT int snd_init(const uint8_t *prog, uint32_t prog_size, const uint8_t *samples, uint32_t samples_size) {
    memset(s_prog, 0, sizeof s_prog);
    uint32_t n = prog_size < PROG_SIZE ? prog_size : PROG_SIZE;
    for (uint32_t i = 0; i + 1 < n; i += 2) { s_prog[i] = prog[i + 1]; s_prog[i + 1] = prog[i]; }
    if (samples_size < 2 * PCM_SIZE) return 0;
    memset(s_ram, 0, sizeof s_ram);
    memset(&s_uart, 0, sizeof s_uart);
    s_ym_samples = 0;
    s_ym_l = s_ym_r = 0;
    m1_chips_init((float)CPU_HZ / PCM_DIV, samples, samples + PCM_SIZE);

    m68k_reset(&s_cpu);
    s_cpu.read_cb = m1_read;
    s_cpu.write_cb = m1_write;
    s_cpu.mem_ctx = NULL;
    memset((void *)s_cpu.rmap, 0, sizeof s_cpu.rmap);
    memset(s_cpu.wmap, 0, sizeof s_cpu.wmap);
    for (uint32_t pg = 0; pg < 4; pg++) s_cpu.rmap[pg] = s_prog + (pg << 16);
    for (uint32_t pg = 0; pg < 2; pg++) s_cpu.rmap[8 + pg] = s_prog + 0x20000 + (pg << 16);
    s_cpu.rmap[0xF0] = s_ram;
    m68k_startup(&s_cpu);
    return s_cpu.cpu.pc != 0;
}

EXPORT int snd_send(uint32_t b) {
    if (s_uart.qw - s_uart.qr >= SND_QUEUE) return 0;
    s_uart.queue[s_uart.qw++ % SND_QUEUE] = (uint8_t)b;
    return 1;
}

/* Run the 68000 up to cycle `until`, delivering UART bytes and taking the
 * receive interrupt on the way. The YM3438 is kept up to date before every
 * instruction, so a timer the driver polls expires when it should. */
static void run_until(uint64_t until) {
    m68k_cpu_t *c = &s_cpu.cpu;
    while (c->cycles < until) {
        if (s_uart.qr != s_uart.qw && !s_uart.rxrdy && s_uart.rxe && c->cycles >= s_uart.next_at) {
            s_uart.data = s_uart.queue[s_uart.qr++ % SND_QUEUE];
            s_uart.rxrdy = 1;
            s_uart.next_at = c->cycles + BYTE_CYCLES;
        }
        m1_ym_advance(c->cycles * 4 / 5);
        if (s_uart.rxrdy && m68k_interrupt(&s_cpu, 2)) continue;
        if (c->stopped || c->halted) { c->cycles = until; break; }
        m68k_step(&s_cpu);
    }
}

static void one_sample(float *out) {
    run_until(s_cpu.cpu.cycles - s_cpu.cpu.cycles % PCM_DIV + PCM_DIV);
    uint64_t ym_clock = s_cpu.cpu.cycles * 4 / 5;
    m1_ym_advance(ym_clock);
    while ((s_ym_samples + 1) * YM_DIV <= ym_clock) {
        m1_ym_sample(&s_ym_l, &s_ym_r);
        s_ym_samples++;
    }
    int32_t l1, r1, l2, r2;
    m1_pcm_sample(0, &l1, &r1);
    m1_pcm_sample(1, &l2, &r2);
    /* segam1audio's routes: the YM3438 at 0.30, each MultiPCM at 0.5. */
    out[0] = (0.30f * s_ym_l + 0.5f * (l1 + l2)) * (1.0f / 32768.0f);
    out[1] = (0.30f * s_ym_r + 0.5f * (r1 + r2)) * (1.0f / 32768.0f);
}

EXPORT uint32_t snd_render(uint32_t n) {
    if (n > SND_BLOCK) n = SND_BLOCK;
    for (uint32_t i = 0; i < n; i++) one_sample(s_out + i * 2);
    return n;
}

#ifdef SND_NATIVE_TEST
/* g++: play a command stream into a WAV, to hear the board without a browser.
 *   model1 <prog> <pcm> <out.wav> <seconds> <at:hexbytes>...
 * e.g. 1.0:AE1007 plays 0xAE 0x10 0x07 one second in. */
#include <stdio.h>
static uint8_t *slurp(const char *p, uint32_t *n) {
    FILE *f = fopen(p, "rb"); if (!f) return NULL;
    fseek(f, 0, SEEK_END); *n = (uint32_t)ftell(f); fseek(f, 0, SEEK_SET);
    uint8_t *b = malloc(*n); if (fread(b, 1, *n, f) != *n) return NULL; fclose(f); return b;
}
int main(int argc, char **argv) {
    if (argc < 5) return 2;
    uint32_t np, ns;
    uint8_t *p = slurp(argv[1], &np), *s = slurp(argv[2], &ns);
    if (!p || !s || !snd_init(p, np, s, ns)) { fprintf(stderr, "load failed\n"); return 1; }
    double rate = snd_rate();
    uint32_t total = (uint32_t)(atof(argv[4]) * rate);
    FILE *w = fopen(argv[3], "wb");
    uint32_t data = total * 4, riff = 36 + data, fmt = 16, irate = (uint32_t)(rate + 0.5), bps = irate * 4;
    uint16_t pcm = 1, ch = 2, align = 4, bits = 16;
    fwrite("RIFF", 1, 4, w); fwrite(&riff, 4, 1, w); fwrite("WAVEfmt ", 1, 8, w);
    fwrite(&fmt, 4, 1, w); fwrite(&pcm, 2, 1, w); fwrite(&ch, 2, 1, w); fwrite(&irate, 4, 1, w);
    fwrite(&bps, 4, 1, w); fwrite(&align, 2, 1, w); fwrite(&bits, 2, 1, w);
    fwrite("data", 1, 4, w); fwrite(&data, 4, 1, w);
    int next = 5;
    double peak = 0;
    for (uint32_t t = 0; t < total; t += 256) {
        while (next < argc && atof(argv[next]) * rate <= t) {
            const char *h = strchr(argv[next], ':') + 1;
            for (; h[0] && h[1]; h += 2) { char b[3] = { h[0], h[1], 0 }; snd_send((uint32_t)strtoul(b, NULL, 16)); }
            next++;
        }
        uint32_t k = total - t < 256 ? total - t : 256;
        snd_render(k);
        for (uint32_t i = 0; i < k * 2; i++) {
            float v = s_out[i]; if (v > peak) peak = v; if (-v > peak) peak = -v;
            if (v > 1) v = 1; if (v < -1) v = -1;
            int16_t x = (int16_t)(v * 32767.0f); fwrite(&x, 2, 1, w);
        }
    }
    fclose(w);
    printf("peak %.3f, 68000 pc %06X, uart rxe %d, left %u\n", peak, s_cpu.cpu.pc, s_uart.rxe, s_uart.qw - s_uart.qr);
    return 0;
}
#endif
