/*
 * ambience.js — a stage's own sound effects, the way Virtua Fighter 2 plays them.
 *
 * Beside the song, a stage can have sounds of its own: a crowd that cheers as
 * the round starts and murmurs through it, birds, water. The game plays them
 * from a task that runs every frame, 0x43ABC, which sends the sound board the
 * same kind of command the song is (0x43888 queues it). The task takes four
 * flags in its work, set by the scene and round routines:
 *
 *   bit 30  the scene starts (0xDAC8): the stage's code in the table at
 *           data 0x1E940, once
 *   bit 27  a round starts (0xBB64, 0xC174, 0xDACC): the one at 0x1E980
 *   bit 28  a round ends (0xBCA4 and four more): the one at 0x1E9C0
 *   bit 29  while the round runs: the stage's ambient player, which the jump
 *           table at 0x44044 picks by stage
 *
 * Each table is sixteen codes by stage, 0 for none. The ambient players are
 * code, not data, and are ported below one by one, keyed by the address the
 * jump table sends a stage to; an address with nothing here plays nothing,
 * which is what 0x43C98, the shared exit, does. Each counts frames since it
 * last played and throws the game's 16-bit random number (0x94D0) every frame;
 * the throws here are the page's own, so the timing is the game's in kind but
 * not frame for frame.
 */

import { commandBytes } from './sound.js';

const FRAME_MS = 1000 / 60;
/* Never run more than this many frames at once, after a tab was hidden. */
const MAX_CATCH_UP = 30;

const rand16 = () => Math.floor(Math.random() * 0x10000);
const pick = (r, a, b, c = b) => ((r & 1) === 0 ? a : (r & 2) === 0 ? b : c);

/*
 * The ambient players. Each takes the frame count since its last sound (`t`,
 * already counted up for this frame) and returns { code, t }: the command to
 * send, 0 for none, and the count to keep.
 */
const PLAYERS = {
    /* 1 in ~43 frames, at least 52 apart: one of two calls. */
    0x43b50(t) {
        const r = rand16();
        if (r > 0x600 || t < 52) return { code: 0, t };
        return { code: (r & 1) === 0 ? 0x9d292d : 0x9d2a3c, t: 0 };
    },
    /* Every 192 frames, the same sound. */
    0x43b80(t) {
        if (t < 192) return { code: 0, t };
        return { code: 0x99155a, t: 0 };
    },
    /* The crowd: a rare shout on any frame, a swell 128 frames in, and every
     * so often after that one of three cheers. */
    0x43b98(t, send) {
        const r = rand16();
        if (r >= 0xfff8) return { code: 0x990f28, t };
        if (t === 128) send(0x9e2950);
        if (r > 0x400 || t < 128) return { code: 0, t };
        return { code: pick(r, 0x9e2264, 0x9e2864, 0x9d2c7f), t: 0 };
    },
    /* 1 in 32 frames, at least 64 apart: one of three. */
    0x43bfc(t) {
        const r = rand16();
        if (r > 0x800 || t < 64) return { code: 0, t };
        return { code: pick(r, 0x9d2c7f, 0x9d2b7f, 0x9d277f), t: 0 };
    },
    /* A rare one of two on any frame, one sound 128 frames in, and a long
     * call now and then after 512. */
    0x43c38(t) {
        const r = rand16();
        if (r >= 0xffc0) return { code: (r & 1) === 0 ? 0x9d2d28 : 0x9d2e7f, t };
        if (t === 128) return { code: 0x891e32, t };
        if (r > 0x100 || t < 512) return { code: 0, t };
        return { code: 0x991e32, t: 0 };
    },
};

/**
 * The stage sounds of one stage, sent to a running board.
 */
export class StageSounds {
    /**
     * @param {object} rom   the loaded set; `rom.game.sound.ambience` names the tables
     * @param {object} board a started SoundBoard
     */
    constructor(rom, board) {
        this.rom = rom;
        this.board = board;
        this.spec = rom.game.sound.ambience;
        this.timer = null;
    }

    code(table, stage) {
        return this.rom.mainDataView.getUint32(table + (stage & 0xf) * 4, true);
    }

    send(code) {
        if (code) this.board.send(commandBytes(code));
    }

    /* The scene and the round start: the two one-shots, then the player. */
    start(stage) {
        this.stop();
        const A = this.spec;
        this.send(this.code(A.scene, stage));
        this.send(this.code(A.round, stage));
        const at = this.rom.mainCpuView.getUint32(A.players + (stage & 0xf) * 4, true);
        const player = PLAYERS[at];
        if (!player) return;
        let t = 0;
        let last = performance.now();
        const send = (c) => this.send(c);
        this.timer = setInterval(() => {
            const now = performance.now();
            let frames = Math.floor((now - last) / FRAME_MS);
            if (frames > MAX_CATCH_UP) {
                frames = MAX_CATCH_UP;
                last = now;
            } else {
                last += frames * FRAME_MS;
            }
            for (let i = 0; i < frames; i++) {
                const out = player(t + 1, send);
                t = out.t;
                this.send(out.code);
            }
        }, FRAME_MS);
    }

    stop() {
        clearInterval(this.timer);
        this.timer = null;
    }

    /** Whether the game has any stage sound for this stage. */
    static any(rom, stage) {
        const A = rom.game.sound?.ambience;
        if (!A) return false;
        const at = rom.mainCpuView.getUint32(A.players + (stage & 0xf) * 4, true);
        const one = (table) => rom.mainDataView.getUint32(table + (stage & 0xf) * 4, true) !== 0;
        return !!PLAYERS[at] || one(A.scene) || one(A.round);
    }
}
