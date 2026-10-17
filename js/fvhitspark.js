/*
 * fvhitspark.js — Fighting Vipers' throw spark (TECHNICAL.md, "The throw
 * spark"): the flash a thrown fighter's own motion puts on its head or arm
 * as it lands.
 *
 * Script op 30 (0x1C93C) writes its byte to player +0xC56. The same frame,
 * after the script, 0x278DC sets that bit in +0x770 and, unless +0x1A4 has
 * bit 16, takes the first free of five records at mod_fa_effect +0x748: the
 * point is player +0x1F4 + 12 * (+0x770), a slot the mask names, not the bit,
 * read before the frame's pose is made, so the pose of the frame before; the
 * flags are 0x101. 0x2DB78 then picks each record's models by its age and
 * counts the age up, and 0x2DDE8 draws what it picked on the next frame,
 * turned to face the camera.
 *
 * Everything here is in the pose's board frame (y up).
 */
import { resolveData } from './motion.js';

/* 0x278DC writes nothing while +0x1A4 has bit 16. */
const FLAG_NONE = 1 << 16;

function readBook(rom, { at, halved = false }) {
    const r = resolveData(rom, at);
    const count = r.view.getUint32(r.off, true);
    const models = Array.from({ length: count }, (_, i) => r.view.getUint16(r.off + 8 + i * 2, true));
    return { count, scale: r.view.getFloat32(r.off + 4, true), models, halved };
}

/**
 * 0x2DB78's two flipbooks for a record with flag bit 8, as op 30 makes it:
 * +0x1E from the first, by age, and +0x20 from the second, by half the age,
 * each while the age is under its count. Each is a u32 count, the size, then
 * the models; the record is freed once the first runs out.
 */
export function readHitSpark(rom) {
    const S = rom.game.rig?.hitSpark;
    if (!S) return null;
    const books = S.books.map((b) => readBook(rom, b));
    return { books, life: books[0].count };
}

/** Every model the flipbooks can pick, to build before they are needed. */
export function hitSparkModels(spark) {
    return [...new Set(spark.books.flatMap((b) => b.models).filter((m) => m > 0))];
}

/* The age of op `o`'s record on `frame`, or -1 while it has none. */
function recordAge(spark, o, frame, flags) {
    const age = frame - o.frame - 1;
    if (age >= spark.life || o.slot >= 16 || (flags?.[o.frame] ?? 0) & FLAG_NONE) return -1;
    return age;
}

/*
 * What 0x2DDE8 draws on `frame` of a motion: for each op 30 a frame or more
 * before, while its record lives, each model its age picks, at the slot's
 * point on the frame before the op's, sized by its book and turned by `turn`
 * (the camera's, each axis's image in turn, as the pose keeps a turn).
 * `poseAt(frame)` gives the board-frame pose; `flags` is +0x1A4 by frame
 * (or null).
 */
export function hitSparkDraws(spark, script, frame, { poseAt, flags = null, turn }) {
    const out = [];
    for (const o of script?.ops ?? []) {
        const age = recordAge(spark, o, frame, flags);
        if (age < 0) continue;
        const t = poseAt(Math.max(1, o.frame - 1))[o.slot].t.slice();
        for (const b of spark.books) {
            const i = b.halved ? age >> 1 : age;
            if (age >= b.count || !b.models[i]) continue;
            out.push({ model: b.models[i], r: turn.map((v) => v * b.scale), t });
        }
    }
    return out;
}
