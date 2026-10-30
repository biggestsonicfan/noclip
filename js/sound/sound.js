/*
 * sound.js — the game's music, played by the game's own sound board.
 *
 * Nothing here is a recording or a guess at one. Each game's sound board runs
 * the game's own sound driver out of its program ROM, and the page runs an
 * emulation of that board, built to WebAssembly, on the audio thread
 * (worklet.js). It is told what to play the way the i960 tells it: commands
 * down its UART. There are two boards (`game.sound.board`), and m2-hle2
 * emulates both and grades them against MAME's; board.wasm is that emulation
 * (tools/sound/board.c):
 *
 * - 'model2', the Model 2 board: a 68000 and a Yamaha SCSP.
 * - 'model1', the board the original Model 2 kept from Model 1: a 68000, two
 *   MultiPCM sample chips and a YM3438. Daytona USA and Virtua Cop.
 *
 * Two games keep their music on a Digital Sound Board instead, MPEG audio out
 * of ROM: 'dsbz80' (Sega Touring Car Championship) and 'dsb2' (Top Skater).
 * The page reads those boards' song tables and decodes the MPEG itself
 * (dsb.js); `samples` are then the MPEG ROMs.
 *
 * Where m2-hle2 knows the driver build — Sonic The Fighters, Virtua Fighter 2,
 * Fighting Vipers, Sega Rally, Dead or Alive, Virtual-On, Dynamite Cop, The
 * House of the Dead, Daytona and Virtua Cop — the driver runs ported to C, in
 * about half the 68000's time; the rest keep theirs on the 68000. The chips
 * are the same either way.
 *
 * A game whose driver names its own boot commands (Dead or Alive's) gives them
 * as `boot` and `stop` for the Model 2 board too, and `warmup`, the seconds
 * its driver takes to start listening after a reset: the board runs that long
 * before the first command goes down.
 *
 * It costs nothing until it is switched on. Then it reads the sound ROMs out of
 * the zips — the program and 8 MB of samples, which the views never touch —
 * and runs the board at a few per cent of one core. Switched off, the audio
 * context is suspended and the board stops with it.
 */

import { dsbSongs } from './dsb.js';

/* What the Model 2 board is sent. ROUND_INT and the boot path send all sound
 * off and two settings the driver wants from the game first (m2-hle2
 * tools/snd_stimuli.py opens every capture with the same three); each new
 * stage starts with all sound off again. A game on the Model 1 board names its
 * own, in games.js. */
const MODEL2 = {
    boot: [0xA0, 0x00, 0x01, 0xA0, 0x00, 0x03, 0xA0, 0x03, 0x60],
    stop: [0xA0, 0x00, 0x01],
};

function boardOf(spec) {
    if (spec.board?.startsWith('dsb')) return { dsb: spec.board, stop: [] };
    if (spec.board !== 'model1') return { model1: false, boot: spec.boot ?? MODEL2.boot, stop: spec.stop ?? MODEL2.stop };
    return { model1: true, boot: spec.boot, stop: spec.stop };
}

/* A command as the i960 sends it: the status byte and two 7-bit data bytes. */
export function commandBytes(code) {
    return [(code >>> 16) & 0xFF, (code >>> 8) & 0x7F, code & 0x7F];
}

/* The songs the game can start a stage with, when it lets the player pick one
 * (Daytona's VR buttons), or the explorer does (Dead or Alive's fighters'
 * themes): [{ code, label, index }], `index` the song's place in the table,
 * or null. `buttons` are labels in table order, `picks` [index, label]. */
export function musicChoices(rom) {
    const m = rom.game.sound?.music;
    if (!m) return null;
    if (m.list) return listedSongs(rom, m.list);
    const picks = m.picks ?? m.buttons.map((label, i) => [i, label]);
    return picks.map(([index, label]) => ({ label, index, code: songAt(rom, index) }));
}

/* A game whose own sound test names its songs (`list`): every one of them,
 * read out of the program ROM as the sound test reads them, with the name it
 * prints. Two shapes:
 *
 * - `named`: records `stride` bytes apart from `at`, the song number and
 *   the command's middle byte, then the name inline (Virtual-On's). The
 *   status byte is `status`.
 * - `codes`: whole commands `stride` bytes apart from `at`, each followed
 *   (`then`, a byte offset into the record) by the command the game sends
 *   right after it, and the names in a table of pointers (`names`), one a
 *   song (Dynamite Cop's), or a pointer in the record itself, `nameAt`
 *   bytes in (Last Bronx's).
 * - `ids`: the game's sound IDs, `first` on, each a 3-byte command at
 *   `at` + 3 * ID and a name through the pointer at `names` + 4 * ID, the
 *   pointers into the program's copy in RAM, `ramBase` above the ROM (Sega
 *   Rally's).
 * - `songs`: a Digital Sound Board's song numbers, 1 to `count`, each sent
 *   as `status`, `middle`, number, and named through the pointer at
 *   `names` + 4 * (number - 1) (Touring Car's and Top Skater's).
 * - `groups`: no names and no table in the i960's program, only the sound
 *   driver's: [middle byte, count, first entry (0 if left out)] for each of
 *   its groups, every sound in them listed by its command (Power Sled's),
 *   labelled `label` and a number ("sound 1" if no `label`).
 *
 * `count` bounds the list; `skip` leaves records out by number; `strip` is
 * a prefix every name has (SDB_, S_BGM_), left off. Read once a
 * ROM set. */
const listed = new WeakMap();
function listedSongs(rom, L) {
    if (!listed.has(rom)) listed.set(rom, readListedSongs(rom, L));
    return listed.get(rom);
}

/* Where a build keeps a `codes` table, when it is not given (`at`): the run of
 * `count` records whose commands count up from `first`, as the five Dynamite
 * Cop builds' do wherever their programs put it. */
function findListed(rom, L) {
    const view = rom.mainCpuView;
    const span = (L.count - 1) * L.stride;
    for (let at = 0; at + span + 4 <= view.byteLength; at += 4) {
        let i = 0;
        while (i < L.count && view.getUint32(at + i * L.stride, true) === L.first + i) i++;
        if (i === L.count) return at;
    }
    return -1;
}

function nameAt(bytes, at, max = 32, strip) {
    let s = '';
    for (let i = 0; i < max && bytes[at + i]; i++) s += String.fromCharCode(bytes[at + i]);
    s = s.trim();
    return strip && s.startsWith(strip) ? s.slice(strip.length) : s;
}

function readListedSongs(rom, L) {
    if (L.groups) {
        return L.groups.flatMap(([mid, count, first = 0]) => Array.from({ length: count }, (_, n) => (L.status << 16) | (mid << 8) | (first + n)))
            .map((code, index) => ({ label: `${L.label ?? 'sound'} ${index + 1}`, index, code }));
    }
    if (L.songs) {
        const view = rom.mainCpuView;
        // L.where[index], when given, is where the game plays the song.
        return Array.from({ length: L.count }, (_, index) => {
            const name = nameAt(rom.maincpu, view.getUint32(L.names + index * 4, true));
            const where = L.where?.[index];
            return { label: where ? `${name}: ${where}` : name, index, code: (L.status << 16) | (L.middle << 8) | (index + 1) };
        });
    }
    const view = rom.mainCpuView;
    const bytes = rom.maincpu;
    const base = L.ids ? 0 : L.at ?? findListed(rom, L);
    if (base < 0) return null;
    const text = (at, max) => nameAt(bytes, at, max, L.strip);
    const out = [];
    for (let i = 0; i < L.count; i++) {
        if (L.skip?.includes(i)) continue;
        const at = base + i * L.stride;
        if (L.ids) {
            const id = L.first + i;
            out.push({ label: text(view.getUint32(L.names + id * 4, true) - L.ramBase), index: i, code: soundId(rom, id) });
        } else if (L.named) {
            const code = (L.status << 16) | (bytes[at + 1] << 8) | bytes[at];
            out.push({ label: text(at + 2), index: i, code });
        } else {
            const code = view.getUint32(at, true);
            const then = L.then === undefined ? undefined : commandBytes(view.getUint32(at + L.then, true));
            const name = L.nameAt === undefined ? L.names + i * 4 : at + L.nameAt;
            out.push({ label: text(view.getUint32(name, true)), index: i, code, then });
        }
    }
    return out;
}

/* A sound ID's command, out of a game's table of them (music.list.ids). */
function soundId(rom, id) {
    const b = rom.maincpu, at = rom.game.sound.music.list.at + id * 3;
    return (b[at] << 16) | (b[at + 1] << 8) | b[at + 2];
}

function songAt(rom, index) {
    const m = rom.game.sound.music;
    return rom[`${m.region}View`].getUint32(m.table + index * 4, true);
}

/* The song a stage slot starts with — its own, or `pick` (an index into
 * musicChoices) — as { code, index }, code 0 for none. */
export function stageMusic(rom, slot, pick = -1) {
    const spec = rom.game.sound;
    if (spec?.music && pick >= 0) {
        const { code, index, then } = musicChoices(rom)[pick];
        return { code, index, then };
    }
    if (spec?.music?.slotMask !== undefined) {
        const index = slot & spec.music.slotMask;
        return { code: songAt(rom, index), index };
    }
    /* `songs` are the stages a game starts somewhere other than its table
     * (Dead or Alive's boss fight), or every stage of a game that picks its
     * song in code rather than from a table (Virtua Cop); `none` the code a
     * table holds for a stage with no song, if not 0. */
    const own = spec?.songs?.[slot];
    if (own !== undefined) return { code: own, index: slot & 0xF };
    if (spec?.stageSongs) return orderedSong(rom, spec.stageSongs, slot);
    const at = spec?.stageMusic;
    if (at === undefined) return { code: 0, index: -1 };
    /* A table of sound IDs rather than commands (Sega Rally's). */
    if (spec.music?.list?.ids) return { code: soundId(rom, rom.mainCpuView.getUint32(at + slot * 4, true)), index: slot };
    /* The program ROM's for every game but Virtua Fighter 2 and Fighting
     * Vipers, whose tables are in the data ROM. */
    const view = rom[`${spec.stageMusicRegion ?? 'mainCpu'}View`];
    const code = view.getUint32(at + (slot & 0xF) * 4, true);
    return { code: code === spec.none ? 0 : code, index: slot & 0xF };
}

/* A song table in the game's own order of stages rather than by stage number
 * (Last Bronx's): `count` commands in a row, each one of the sixteen from
 * `first`, found wherever the build keeps them; `order` the program's table
 * of the stage number each entry is for, one word an entry. */
const ordered = new WeakMap();
function orderedSong(rom, S, slot) {
    const view = rom.mainCpuView;
    if (!ordered.has(rom)) {
        const song = (at) => (view.getUint32(at, true) & ~0xF) === S.first;
        let at = 0;
        const fits = (a) => {
            for (let i = 0; i < S.count; i++) if (!song(a + i * 4)) return false;
            return true;
        };
        while (at + S.count * 4 <= view.byteLength && !fits(at)) at += 4;
        ordered.set(rom, at + S.count * 4 <= view.byteLength ? at : -1);
    }
    const at = ordered.get(rom);
    for (let i = 0; at >= 0 && i < S.count; i++) {
        if (view.getUint32(S.order + i * 4, true) === slot) return { code: view.getUint32(at + i * 4, true), index: i };
    }
    return { code: 0, index: -1 };
}

export function soundSupported(game) {
    return !!game.sound && typeof AudioWorkletNode !== 'undefined' && typeof WebAssembly !== 'undefined';
}

export class SoundBoard {
    constructor() {
        this.ctx = null;
        this.node = null;
        this.gain = null;
        this.starting = null;
        this.game = null;
        /* 'C' or '68000': who runs the sound program, once booted. */
        this.driver = null;
    }

    /* Read the ROMs and boot the board, once per ROM set. */
    start(rom, onProgress = () => {}) {
        if (this.game === rom.game.id && this.starting) return this.starting;
        this.close();
        this.game = rom.game.id;
        this.starting = this.boot(rom, onProgress).catch((err) => {
            this.close();
            throw err;
        });
        return this.starting;
    }

    async boot(rom, onProgress) {
        const spec = rom.game.sound;
        this.kind = boardOf(spec);
        this.spec = spec;
        /* Asked for at the board's own rate so nothing resamples it; a browser
         * that will not is caught up in the worklet. Created here, inside the
         * click that switched the music on, which is what lets it start. */
        let ctx;
        try {
            ctx = new AudioContext({ sampleRate: this.kind.dsb ? 32000 : 44100, latencyHint: 'playback' });
        } catch {
            ctx = new AudioContext({ latencyHint: 'playback' });
        }
        this.ctx = ctx;
        const resumed = ctx.resume();
        if (this.kind.dsb) {
            await this.bootDsb(rom, onProgress);
            await resumed;
            return;
        }
        const [wasm] = await Promise.all([
            fetch(new URL('./board.wasm', import.meta.url)).then((r) => {
                if (!r.ok) throw new Error(`board.wasm: ${r.status}`);
                return r.arrayBuffer();
            }),
            ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url)),
        ]);

        onProgress('reading the sound program');
        /* One program chip, or several laid end to end as the region
         * loads them. */
        const chips = typeof spec.program[0] === 'string' ? [spec.program] : spec.program;
        const parts = [];
        for (const chip of chips) parts.push(await rom.readChip(...chip));
        const program = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        parts.reduce((at, p) => (program.set(p, at), at + p.length), 0);
        /* Each chip at its place in the region: 2 MB apart, or `sampleChip`
         * for a set of bigger chips (House of the Dead's two of 4 MB). A null
         * is a socket the board leaves empty (Desert Tank's first MultiPCM
         * has one chip), its place zeros. */
        const chip = spec.sampleChip ?? 0x200000;
        const size = spec.samples.length * chip;
        const samples = new Uint8Array(size);
        for (let i = 0; i < spec.samples.length; i++) {
            if (!spec.samples[i]) continue;
            onProgress(`reading sample ROM ${i + 1} of ${spec.samples.length}`);
            samples.set(await rom.readChip(...spec.samples[i]), i * chip);
        }

        const node = new AudioWorkletNode(ctx, 'model2-sound', {
            numberOfInputs: 0, outputChannelCount: [2],
        });
        const ready = new Promise((resolve, reject) => {
            node.port.onmessage = (e) => {
                if (e.data.type === 'ready') {
                    this.driver = e.data.driver;
                    console.info(`sound board: ${rom.game.id}'s driver runs ${e.data.driver === 'C' ? 'in C' : 'on the 68000'}`);
                    resolve();
                }
                else if (e.data.type === 'error') reject(new Error(e.data.message));
            };
        });
        const prog = program.slice().buffer;
        if (spec.warmup) onProgress('starting the sound program');
        node.port.postMessage({
            type: 'init', wasm, model1: this.kind.model1, program: prog, samples: samples.buffer, warmup: spec.warmup ?? 0,
        },
            [wasm, prog, samples.buffer]);
        await ready;
        this.gain = new GainNode(ctx, { gain: this.volume ?? 2 });
        node.connect(this.gain).connect(ctx.destination);
        this.node = node;
        this.send(this.kind.boot);
        await resumed;
    }

    /* A Digital Sound Board: its song table out of its program, its MPEG ROMs
     * end to end, and the player (dsbworklet.js). */
    async bootDsb(rom, onProgress) {
        const spec = this.spec, ctx = this.ctx;
        const loaded = ctx.audioWorklet.addModule(new URL('./dsbworklet.js', import.meta.url));
        onProgress('reading the sound program');
        this.songs = dsbSongs(spec.board, await rom.readChip(...spec.program));
        const chip = spec.sampleChip ?? 0x200000;
        const mpeg = new Uint8Array(spec.samples.length * chip);
        for (let i = 0; i < spec.samples.length; i++) {
            onProgress(`reading MPEG ROM ${i + 1} of ${spec.samples.length}`);
            mpeg.set(await rom.readChip(...spec.samples[i]), i * chip);
        }
        await loaded;
        const node = new AudioWorkletNode(ctx, 'dsb-sound', { numberOfInputs: 0, outputChannelCount: [2] });
        const ready = new Promise((resolve) => {
            node.port.onmessage = (e) => { if (e.data.type === 'ready') resolve(); };
        });
        node.port.postMessage({ type: 'init', rom: mpeg.buffer }, [mpeg.buffer]);
        await ready;
        this.driver = 'MPEG';
        this.gain = new GainNode(ctx, { gain: this.volume ?? 2 });
        node.connect(this.gain).connect(ctx.destination);
        this.node = node;
    }

    send(bytes) {
        this.node?.port.postMessage({ type: 'send', bytes });
    }

    /* Stop what is playing and start `code`, or just stop for 0. `index`
     * is the song's place in the game's table, for a game that sends more
     * than the song for some of them (game.sound.after); `then`, the bytes
     * a listed song is followed by (listedSongs). */
    play(code, index = -1, then = []) {
        /* A DSB's song is the command's last byte, from 1. */
        if (this.kind.dsb) {
            this.node?.port.postMessage({ type: 'play', song: code ? this.songs[(code & 0xFF) - 1] ?? null : null });
            return;
        }
        const stop = this.kind.stop;
        if (!code) { this.send(stop); return; }
        const after = this.spec.after;
        /* `replaces`: a song takes over from the one playing by itself, and
         * a stop sent just ahead of it swallows it (DOA's driver). */
        this.send([...(this.spec.replaces ? [] : stop), ...commandBytes(code),
            ...(after?.song?.[index] ?? []), ...then, ...(after?.every ?? [])]);
    }

    setVolume(v) {
        this.volume = v;
        if (this.gain) this.gain.gain.value = v;
    }

    suspend() { return this.ctx?.suspend(); }
    resume() { return this.ctx?.resume(); }

    close() {
        this.node?.disconnect();
        this.ctx?.close();
        this.ctx = this.node = this.gain = this.starting = null;
        this.game = null;
    }
}
