// Grade the explorer's Dead or Alive stage routines against the board's RAM
// that dump.lua saved: seeded with MAME's RAM at a frame, the routine's passes
// must leave the stage's state (0x5A0000-0x5A7667) as MAME's later frame has it.
//
//   node tools/doa-stages/grade.mjs path/to/doa.zip /dev/shm/doa
//
// k300 -> k301 is a frame, k301 -> k600 299 of them. The board does not run a
// stage exactly once a frame: as it falls behind it runs one twice, or skips
// one. So the passes are counted the way the stage task does, by its tick
// (0x5A75F0, 0x80 a pass). The frame count goes on a pass at a time here, so a
// stage that reads it (8) can be a count off after a doubled frame. Stage 0's
// backdrop follows the camera, which these runs hold still, and so do stage
// 10's (0x6D3A4) and stage 2's ring of eight (0x67388, run only while the
// camera is in range); stage 11 scrolls its sky (0x702E0), not run here.
import fs from 'fs';
import path from 'path';
import { loadRomSet } from '../../js/romset.js';
import { runStageRoutine } from '../../js/doa.js';

const [zip, dir] = process.argv.slice(2);
const buf = fs.readFileSync(zip);
const rom = await loadRomSet([buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)]);
const D = rom.game.doa, S = D.stageSetup, cv = rom.mainCpuView;
const RAM = 0x500000, STAGE = 0x5a0000, LEN = 0x7668, TICK = 0x5a75f0;
const dumps = fs.readdirSync(dir);
const dump = (s, k) => {
    const f = dumps.find((x) => x.startsWith(`s${s}_k${k}_`));
    return f && { clock: parseInt(f.split('_c')[1], 16), ram: fs.readFileSync(path.join(dir, f)) };
};

/* The routine's passes from `from`, and the stage words that differ from `to`. */
function differ(s, from, to, passes) {
    const entry = cv.getUint32(D.routines + 4 * s, true), own = cv.getUint32(S.table + 4 * s, true);
    const { run } = runStageRoutine(rom, entry, { init: [S.common, own], frames: 0, clock: from.clock, tick: S.tick });
    run.ram.set(from.ram);
    const rv = new DataView(run.ram.buffer);
    for (let k = 0; k < passes; k++) run.step();
    const out = [];
    for (let o = STAGE - RAM; o < STAGE - RAM + LEN; o += 4) {
        if (rv.getUint32(o, true) !== to.ram.readUInt32LE(o)) out.push(o + RAM);
    }
    return out;
}

const passes = (a, b) => ((b.ram.readUInt32LE(TICK - RAM) - a.ram.readUInt32LE(TICK - RAM)) >>> 0) / 0x80;
const hex = (a) => a.toString(16);
for (let s = 0; s < 16; s++) {
    const [a, b, c] = [300, 301, 600].map((k) => dump(s, k));
    if (!a || !b) continue;
    const one = differ(s, a, b, passes(a, b)), long = c && differ(s, b, c, passes(b, c));
    console.log(`stage ${s}: a frame (${passes(a, b)} passes) ${one.length} words off` +
        (long ? `, 299 frames (${passes(b, c)} passes) ${long.length} off` : ''));
    for (const w of [...one, ...(long ?? [])].slice(0, 6)) console.log(`    ${hex(w)}`);
}
