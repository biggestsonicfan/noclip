/*
 * board.c — the Model 2 sound board, for the browser.
 *
 * The board itself is m2-hle2's (src/board/sound.h): the game's own 68000
 * sound driver running on a 68000 core, the SCSP it drives, and the sample
 * ROMs. That board is graded against MAME's, note for note, so nothing here
 * models sound — this file only gives it a surface a page can call:
 *
 *   snd_alloc(n)            memory for the ROMs, which the page copies in
 *   snd_init(p, np, s, ns)  the program ROM as the zip holds it, and the
 *                           sample ROMs laid end to end; boots the 68000
 *   snd_send(b)             one byte down the i960's sound UART
 *   snd_render(n)           n samples at 44.1 kHz, as float stereo pairs at
 *                           snd_out(); n at most SND_BLOCK
 *
 * What the page sends is what the i960 sends: three-byte MIDI-framed commands,
 * 0xAE 0x10 0x04 for South Island's music. The UART takes one byte while one
 * is on the line and the i960 only writes when TxRDY says it may, so the bytes
 * wait in a queue here and go out at that same pace — a whole command still
 * lands in about a millisecond, as on the board.
 *
 * Built by build.sh into js/sound/board.wasm.
 */
#define NDEBUG 1
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* The board logs what it loads, to a file and a window the page does not
 * have; a page wants none of it, and libc's stdio behind it is most of what a
 * wasm build would otherwise import. */
#include "log.h"
#undef LOG_INFO
#undef LOG_WARN
#undef LOG_ERROR
#undef LOG_DEBUG
#define LOG_INFO(...)  ((void)0)
#define LOG_WARN(...)  ((void)0)
#define LOG_ERROR(...) ((void)0)
#define LOG_DEBUG(...) ((void)0)

#include "sound.h"

#define SND_BLOCK 1024u
#define SND_QUEUE 256u

static float   s_out[SND_BLOCK * 2];
static uint8_t s_queue[SND_QUEUE];
static uint32_t s_qr, s_qw;

#define EXPORT __attribute__((used, visibility("default")))

EXPORT void *snd_alloc(uint32_t n) { return malloc(n); }
EXPORT float *snd_out(void) { return s_out; }

EXPORT int snd_init(const uint8_t *prog, uint32_t prog_size, const uint8_t *samples, uint32_t samples_size) {
    /* MAME's ROM_LOAD16_WORD_SWAP (m2-hle2 profiles/sfight.h): the zip holds
     * the program ROM a byte pair at a time the other way round. */
    static uint8_t swapped[M68K_ROM_SIZE];
    uint32_t n = prog_size < M68K_ROM_SIZE ? prog_size : M68K_ROM_SIZE;
    for (uint32_t i = 0; i + 1 < n; i += 2) { swapped[i] = prog[i + 1]; swapped[i + 1] = prog[i]; }
    sound_load_samples(samples, samples_size);
    sound_reset();
    sound_load_rom(swapped, n);
    s_qr = s_qw = 0;
    return g_sound.rom_loaded ? 1 : 0;
}

EXPORT int snd_send(uint32_t b) {
    if (s_qw - s_qr >= SND_QUEUE) return 0;
    s_queue[s_qw++ % SND_QUEUE] = (uint8_t)b;
    return 1;
}

EXPORT uint32_t snd_render(uint32_t n) {
    if (n > SND_BLOCK) n = SND_BLOCK;
    for (uint32_t i = 0; i < n; i++) {
        if (s_qr != s_qw) {
            sound_uart_service(&g_sound, g_sound.m68k.cpu.cycles);
            if (sound_uart_txrdy(&g_sound))
                sound_uart_write(&g_sound, s_queue[s_qr++ % SND_QUEUE], g_sound.m68k.cpu.cycles);
        }
        uint32_t w0 = g_sound.out_w;
        sound_run(1);
        if (g_sound.out_w != w0) {
            s_out[i * 2]     = g_sound.out[(w0 & (SOUND_OUT_FRAMES - 1)) * 2]     * (1.0f / 32768.0f);
            s_out[i * 2 + 1] = g_sound.out[(w0 & (SOUND_OUT_FRAMES - 1)) * 2 + 1] * (1.0f / 32768.0f);
        } else {
            s_out[i * 2] = s_out[i * 2 + 1] = 0.0f;
        }
        g_sound.out_r = g_sound.out_w;
    }
    return n;
}

#ifdef SND_NATIVE_TEST
/* gcc -DSND_NATIVE_TEST: play one command stream into a WAV, to hear the
 * wrapper without a browser.  board <prog> <samples> <out.wav> <code> [seconds] */
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
    uint32_t code = (uint32_t)strtoul(argv[4], NULL, 16);
    double secs = argc > 5 ? atof(argv[5]) : 20.0;
    uint32_t total = (uint32_t)(secs * SOUND_RATE);
    FILE *w = fopen(argv[3], "wb");
    uint32_t data = total * 4, riff = 36 + data, fmt = 16, rate = SOUND_RATE, bps = SOUND_RATE * 4;
    uint16_t pcm = 1, ch = 2, align = 4, bits = 16;
    fwrite("RIFF", 1, 4, w); fwrite(&riff, 4, 1, w); fwrite("WAVEfmt ", 1, 8, w);
    fwrite(&fmt, 4, 1, w); fwrite(&pcm, 2, 1, w); fwrite(&ch, 2, 1, w); fwrite(&rate, 4, 1, w);
    fwrite(&bps, 4, 1, w); fwrite(&align, 2, 1, w); fwrite(&bits, 2, 1, w);
    fwrite("data", 1, 4, w); fwrite(&data, 4, 1, w);
    double peak = 0;
    for (uint32_t t = 0; t < total; t += 441) {
        if (t == 441 * 10) { snd_send(0xA0); snd_send(0); snd_send(1); snd_send(0xA0); snd_send(0); snd_send(3); snd_send(0xA0); snd_send(3); snd_send(0x60); }
        if (t == 441 * 50) { snd_send(code >> 16); snd_send((code >> 8) & 0x7F); snd_send(code & 0x7F); }
        snd_render(441);
        for (int i = 0; i < 441 * 2; i++) {
            float v = s_out[i]; if (v > peak) peak = v; if (-v > peak) peak = -v;
            int16_t x = (int16_t)(v * 32767.0f); fwrite(&x, 2, 1, w);
        }
    }
    fclose(w);
    printf("peak %.3f, 68000 pc %06X\n", peak, g_sound.m68k.cpu.pc);
    return 0;
}
#endif
