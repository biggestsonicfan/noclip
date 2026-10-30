/*
 * dsb.js — the songs of a game whose music is on a Digital Sound Board.
 *
 * Sega Touring Car Championship and Top Skater keep their music on a board of
 * its own beside the Model 2 sound board: a DSB, a CPU and an MPEG decoder
 * playing MPEG-1 Layer II out of 8 or 16 MB of ROM. The i960 sends it a song
 * number down the same UART; its program looks the song up in a table and
 * tells the decoder where to start and stop, and what to play next. That is
 * all it does with the music, so the page reads the same table rather than
 * running the CPU, and plays what it says with MAME's decoder (mpeg.js) on the
 * audio thread (dsbworklet.js).
 *
 * A song comes out as { parts: [[start, end], …], loop, volume, pan }: byte
 * ranges of the MPEG ROM played one after another, `loop` the part play goes
 * back to after the last (-1: stop there), `volume` 0..1 and `pan` the
 * board's (0 stereo, 1 the left channel on both, 2 the right).
 *
 * Two boards, `game.sound.board`:
 *
 * - 'dsbz80', a Z80 (Touring Car). Its program copies 0x1000-0x6FFF of the ROM
 *   to RAM at 0xA000; the copy starts with three pointers — the songs' list,
 *   the segments' table, then the song count — and the master volume. A
 *   segment is two 24-bit addresses, start and end. A song is two zero bytes,
 *   its volume, its pan, then segment numbers, ended by F0 (stop after the
 *   last) or F1 and the RAM address of the one to go back to. F2 (a fade, 4
 *   bytes) and F3 (a volume, 1) no song uses.
 * - 'dsb2', a 68000 (Top Skater), its program word-swapped. 0x8000 points at
 *   the songs' pointers and 0x800A is one more than the song count. A song is
 *   a word of flags (bit 15: it loops), its start and end, a fade word, a
 *   volume a channel (0x80, and MAME's DSB2 plays every song at full volume)
 *   and, looping, where it loops from: the program starts the song, then sets
 *   the decoder's start to that, which it goes back to at the end.
 */

/* The i960's first message to Touring Car's board, AF 01 50: the master
 * volume. */
const STCC_MASTER = 0x50;

export function dsbSongs(board, program) {
    return board === 'dsb2' ? dsb2Songs(program) : dsbz80Songs(program);
}

function dsbz80Songs(p) {
    const at = (ram) => ram - 0x9000;
    const word = (ram) => p[at(ram)] | (p[at(ram) + 1] << 8);
    const long24 = (o) => (p[o] << 16) | (p[o + 1] << 8) | p[o + 2];
    const list = word(0xA000), segs = word(0xA002), count = p[at(0xA004)];
    const segment = (n) => {
        const o = at(segs) + n * 6;
        return [long24(o), long24(o + 3)];
    };
    const songs = [];
    for (let n = 1; n < count; n++) {
        const rec = word(list + (n - 1) * 2);
        const parts = [], starts = [];
        let loop = -1;
        for (let a = rec + 4; ;) {
            const b = p[at(a)];
            if (b < 0xF0) { starts.push(a); parts.push(segment(b)); a++; }
            else if (b === 0xF1) { loop = starts.indexOf(word(a + 1)); break; }
            else if (b === 0xF2) a += 5;
            else if (b === 0xF3) a += 2;
            else break;
        }
        const e8 = stccAttenuation(p[at(rec + 2)], STCC_MASTER);
        songs.push({ parts, loop, volume: (~e8 & 0x7F) / 128, pan: p[at(rec + 3)] & 3 });
    }
    return songs;
}

/* The program's routine 0x5CA: a song's volume byte scaled by the master
 * volume, as the attenuation it writes to the decoder (port E8). */
function stccAttenuation(e, master) {
    let hl = ((master * 2) & 0xFF) << 8;
    for (let i = 0; i < 7; i++) {
        const carry = hl & 0x8000;
        hl = (hl << 1) & 0xFFFF;
        if (carry) hl = (hl + e) & 0xFFFF;
    }
    const a = ((hl << 2) & 0xFFFF) >> 8;
    return a < 0x80 ? a : 0x7F;
}

function dsb2Songs(swapped) {
    const p = new Uint8Array(swapped.length);
    for (let i = 0; i + 1 < p.length; i += 2) { p[i] = swapped[i + 1]; p[i + 1] = swapped[i]; }
    const v = new DataView(p.buffer);
    const list = v.getUint32(0x8000), count = v.getUint16(0x800A);
    const songs = [];
    for (let n = 1; n < count; n++) {
        const rec = v.getUint32(list + (n - 1) * 4);
        const flags = v.getUint16(rec), start = v.getUint32(rec + 2), end = v.getUint32(rec + 6);
        const parts = [[start, end]];
        if (flags & 0x8000) parts.push([v.getUint32(rec + 14), end]);
        songs.push({ parts, loop: flags & 0x8000 ? 1 : -1, volume: 0x7F / 128, pan: 0 });
    }
    return songs;
}
