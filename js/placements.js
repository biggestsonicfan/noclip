/*
 * placements.js — The House of the Dead's stages, read the way its program reads
 * them.
 *
 * There is no stage record. A chapter's scenery is a table of placements in the
 * program ROM — a model and a world position each — and a set of zone lists
 * that say which placements are drawn while that zone is current. What makes a
 * zone current, and which texture set is loaded while it is, is a script: the
 * chapter runs a list of sections, each a list of scripts in a small bytecode
 * the interpreter at loc_50700 walks. So a stage here is assembled out of three
 * tables:
 *
 *   off_92DB0[chapter]  placements: 24-byte records {model, x, y, z, cycle, far}
 *   off_92D90[chapter]  zones: 50 bytes each, placement indices ending in 0xFF
 *   off_E0000[chapter]  sections -> scripts, whose opcodes 20 and 79 set the
 *                       zone and load a texture set
 *
 * with `off_83360[chapter][section]`, the set each section loads as it starts.
 *
 * The courtyard and the mansion of the first chapter are drawn under different
 * texture sets, and one atlas can hold only one, so a stage in the list is a
 * chapter and a set: every zone the chapter's scripts make current while that
 * set is loaded, and every placement those zones draw. That also puts the model
 * under the colours the game shows it with, which is what the Models tab reads
 * back out of it.
 */

import { gameLighting } from './stages.js';

/* The draw loop at 0x3DB10 reads a placement 24 bytes wide and a zone 50. */
const PLACEMENT_BYTES = 24;
const ZONE_BYTES = 50;
const END = 0xffffffff;

/*
 * How many words each opcode of the stage script takes, read off its handler
 * in the table at 0x94550. The walk only needs to step over an instruction to
 * reach the next, so an opcode's meaning matters here only for the two it
 * reads — 20, which makes a zone current (sub_50890), and 79, which loads a
 * texture set (sub_50EE0 -> sub_2B720).
 */
const OP_ZONE = 20;
const OP_LOAD_SET = 79;
const OP_CAMERA = 60;
/* Which sky shell is behind the arena, and whether it is drawn — see `sky` in
 * js/games.js. 70 takes an index into the profile's table, 71 an enable whose
 * 1 drifts the dome and 2 holds it still. */
const OP_SKY = 70;
const OP_SKY_ON = 71;
/* 90 queues its word for the sound board (0x67860 in the finished game: the
 * word after the opcode, to the send queue at 0x154D0). Most are effects; the
 * ones on channel 0x10, 0xA010xx, are the music, and a chapter's scripts start
 * its song with one. */
const OP_SOUND = 90;
const isSong = (code) => (code >>> 8) === 0xa010;
const ONE_WORD = new Set([16, 34, 83]);
const TWO_WORDS = new Set([13, 14, 15, 20, 32, 33, 40, 69, 70, 71, 72, 73, 74, 75, 77, 78, 79,
    80, 81, 82, 84, 85, 88, 89, 90, 91]);
const THREE_WORDS = new Set([26, 68, 76, 87]);
/* Spawns and two list setters: the opcode, pointers, and a -1. */
const LISTS = new Set([9, 10, 11, 12, 50, 51]);
/* Of those, the four whose entries are pointers to a spawn record. 50 and 51
 * carry plain numbers and are not read. */
const SPAWN_OPS = new Set([9, 10, 11, 12]);
const SPAWN_BYTES = 0x28;
/* 92 halts and 93 moves on to the next script. */
const ENDS = new Set([92, 93]);

function inRom(rom, p, bytes = 4) {
    return p > 0 && p !== END && p + bytes <= rom.maincpu.length;
}

/*
 * Walk one script, handing each instruction to `visit` as (opcode, pointer).
 *
 * Opcode 60 queues a camera command whose payload follows it inline, and its
 * argument packs the payload's length in words above the low four bits. A -1
 * on its own closes an inline block and is stepped over.
 */
function walkScript(rom, at, visit) {
    const dv = rom.mainCpuView;
    for (let p = at, n = 0; inRom(rom, p) && n < 4096; n++) {
        const op = dv.getUint32(p, true);
        visit(op, p);
        if (ENDS.has(op)) return;
        if (op === END || ONE_WORD.has(op)) p += 4;
        else if (TWO_WORDS.has(op)) p += 8;
        else if (THREE_WORDS.has(op)) p += 12;
        else if (op === OP_CAMERA) p += 8 + (dv.getUint32(p + 4, true) >>> 4) * 4;
        else if (LISTS.has(op)) {
            let q = p + 4;
            while (inRom(rom, q) && dv.getUint32(q, true) !== END) q += 4;
            p = q + 4;
        } else {
            return;     /* nothing the table decodes: stop rather than guess */
        }
    }
}

/*
 * The props a spawn list puts in the room, as the object table names them.
 *
 * The record's shape is the spawn opcode's handler's, not a guess at it. It
 * reads
 *
 *     ld   (r9), g4            ; +0x00 picks the task the object runs
 *     ld   off_AFDD0[g4*4], g0
 *     call _TaskOpen
 *     ldob 0x24(r9), g4
 *     stos g4, 0xCC(r8)        ; +0x24, a byte, is the object type
 *     ldos 0x20(r9), g4        ; whose low two bits say how the position reads
 *     addo r9, 8, g13          ; and the position is at +0x08
 *
 * So the type is the byte at 0x24 — the first word is which task it runs, which
 * is why it ranges past any type the object table holds — and the position is
 * three floats at 0x08 in every mode. The two modes past 1 interpolate a
 * position between two points rather than standing one still; their first three
 * floats are still where the object starts.
 *
 * Only the types the game treats as an ordinary standing object are put up.
 * Each type also has a handler, and 77 of the finished game's 125 share one —
 * the routine that draws the table's model where the object was spawned and
 * does nothing else. The rest have handlers of their own and are left out,
 * all but those on sixteen handlers, which are read below, one class that
 * stands a row of props (see standRow), one that stands a table of them
 * (see standTable) and two that stand a fixed group of them about their own
 * place (see standGroup).
 *
 * Types 97 to 101 are room 4's walls and shutters (PN_r4_04 pieces), and they
 * share one handler, 0x3E510 in the first revision. Its init clears the byte
 * 0x53E871; its task closes as a prop does (0x3ED60) and then switches on
 * `type - 97` and draws through 0x413B0, which is the prop's draw command for
 * command: the place at +0x20, the three turns at +0x2C, +0x30 and +0x34, the
 * scale at +0x94, the model at +0x54. Before the draw:
 *
 *     97   +0x30 += 0x80 every frame; once 0x53E871 is set, y drops 0.4 a
 *          frame down to 54
 *     98   once 0x53E871 is set, z rises 0.25 a frame up to 2077.6
 *     99   once 0x53E871 is set, z falls 0.25 a frame down to 1977.6
 *     100  while 0x53E871 is clear and event flag 0x70 (0x51E330) is set,
 *          +0x30 += 0x50 a frame; past 0x9FFF it sets 0x53E871
 *     101  while 0x53E871 is clear and flag 0x70 is set, +0x30 -= 0x50
 *
 * Flag 0x70 is one of the event flags at 0x51E2C0, which objects set when
 * the player sets them off (0x48AC). Op 88 sets it at 0xFD1BC, in the very
 * script that spawns the five, but some 0x5AA camera frames into zone 8,
 * after the op 83 and 84 waits; the explorer runs no clock inside a zone.
 * (0xF94BC sets it too, in chapter 3, which spawns none of them.) So the
 * five stand as spawned, with 97 turning on its own every frame. Everything after the flag is left out. Chapter 4's
 * section 4 spawns them, and so does the attract demo, where MAME draws all
 * five at their records for 1448 frames, 97 turning 0x80 a frame, and the
 * flag never set.
 *
 * Types 30, 31 and 86 are the glass cases (PN_case00a) and the roof pieces
 * (PN_s3_rf_kop01a), on the handler 0x3B050 in the first revision. It closes
 * as a prop does (0x3ED60) and draws through 0x413B0 with the model and scale
 * the spawn gave it (0x417F0: +0x54 and +0x94 from the type's entry), so
 * until it breaks it is a prop. It breaks once its event flag is up: 31 on
 * flag 5, 30 on 6, and 86 on 0x50 to 0x54 by its x, bit for bit (505, 515,
 * 532, 549, 557.9). Then it opens the shards (0x3F210) and takes the type's
 * second model (PN_case01a, _02a, PN_s3_rf_kop_dam01a) for good. No script
 * sets 5 or 6 (an object does, 0x90848, after flag 4 from play). Chapter 3's
 * scripts spawn the five roof pieces in zone 14 and set 0x52 to 0x54 later
 * in the same zone (op 88, 0x67830), two scripts and some frames on; 0x50
 * and 0x51 only the player's shots set. The explorer runs no clock inside a
 * zone, so all seven stand as spawned, and the break is left out.
 *
 * Types 104 and 108 are props that step their model, on handlers of their
 * own in the first revision, 0x3E8B0 and 0x3E8F0. Each closes as a prop does
 * (0x3ED60), adds one to +0x54 every frame, and draws through 0x413B0:
 *
 *     ld   (g6), g5            ; the model at +0x54
 *     mov  g5, 0, g4
 *     lda  0x1(g5), g5         ; one on
 *     lda  0x185b, g7
 *     cmpible g4, g7, ...      ; kept while the old one was 0x185B or below,
 *     subo 2, g7, g5           ; else back to 0x1859
 *
 * so 104 loops PN_kakaaa01a to 04a (0x1859 to 0x185C), four frames, and 108
 * (0x1114, then back to 0x10E4) loops PN_pushukeke00a to 49a, fifty. 104
 * starts from the type's own model, which 0x417F0 gave it; 108 gets the
 * number 0x33B00 returns, rem 49, added on at spawn (0x38AE4), which the
 * explorer has not got, so it starts from the type's model too. Nothing else
 * stops them; the explorer steps them on its frame while animate is ticked.
 *
 * Type 69 steps its model the same way on 0x3D860, back to 0xA06 past 0xA22:
 * PN_powa00a to 29a, twenty-nine. It does not close as a prop does. It closes
 * once the zone's clock (0x51E51C) passes +0x30C, which the spawn sets by
 * section (0x38A7C): 99 in section 3, 268 in 9, 1048 in 11 and 12, the three
 * sections that spawn one. The explorer runs no clock inside a zone, so the
 * three stand and loop as spawned. The prototype's 69 (0x32F30) is the same
 * loop at its own models, but it closes once the camera frame passes those
 * same numbers, the clock propZones already runs, so there it keeps the
 * zones it is drawn in (`until`).
 *
 * Type 96, a fan (PN_koba01a), turns its third angle (+0x34) on 0x3E4A0 by
 * +0x31C a frame, which is 0x800 while the zone's clock is short of 1440; past
 * it, a fan beyond x 500 slows by 4 a frame to a stop. Chapter 3's two stand
 * either side of 500 (Stage 3 set 8), and the explorer, with no clock inside a
 * zone, turns both 0x800 a frame as they do from their spawn.
 *
 * Type 77, a wall (PN_r2_05_kabe01a), draws on 0x3D930 as a prop does, but
 * does not close as one: past 458 on the zone's clock it breaks
 * (PN_r2_05_kabe_dam01a and its pieces, 0x39E10), and past 723 it closes.
 * Chapter 2's one (Stage 2 set 5) stands whole here, as it does until then.
 * The prototype's 77 (0x33000) takes the same two numbers off the camera
 * frame instead, the clock propZones runs, so there it keeps the zones it is
 * drawn in, up to 723 (`until`); it too stands whole.
 *
 * Type 84 (PN_niku_001) closes as a prop does (0x3ED60) and draws on 0x3DE20
 * through 0x413B0. Once bit 1 or 2 of its flags (+0x58) is set, it queues the
 * type's sound and calls 0x429A0, then steps PN_niku_002 to 120 a model a
 * frame and stands at 001 again. What sets those bits is not traced; MAME's
 * attract demo never does, so chapter 2's two (Stage 2 set 5) stand at 001.
 *
 * Type 93 (PN_eneene00a) is one of four on 0x3E180. It closes as a prop does
 * (0x3ED60), steps +0x54 back to 0xD58 once the model it stepped from is past
 * 0xD79, so PN_eneene00a to 34a, thirty-five, and draws through 0x413B0. It
 * also closes once the zone's clock (0x51E51C) reaches 430, which the
 * explorer, with no clock inside a zone, leaves out: chapter 4's one (Stage 4
 * set 4) loops.
 *
 * The other three on 0x3E180 stand as props. 95 (PN_sekom01a) draws through
 * 0x413B0 and closes once the zone's clock passes 601 in section 0
 * (0x51F350), or 338 in section 3, where it takes PN_sekom02a (0x16CF)
 * instead. 87 (PN_st3_card01a) and 88 (PN_sousa00a) draw through 0x413B0
 * and close as props do; past 311 on the clock 88 takes PN_sousa01a, and
 * once a shot sets bit 1 or 2 of +0x58 (0x41890 clears them every frame)
 * either is thrown about by 0x33B00's numbers for 20 frames. The clock and
 * the shots are left out: chapter 3's three (Stage 3 set 8) and chapter 4's
 * one (Stage 4 set 4) stand as spawned.
 *
 * Type 122 is not a prop but an item's spawner: its handler, 0x3C5A0, is
 * the routine a shot prop calls to drop a life (0x3A700), and it opens an
 * item task on 0x3C310 with PN_item_life (0x312) at +0x54, scale 2.2, the
 * spawner's x and z, its y less the type's floor offset plus 2, and of its
 * angles only +0x30. In chapter 4 (0x51F351 = 3) it keeps that yaw and
 * closes its own task, so each spawns one item; elsewhere it would turn the
 * item to the camera. The item closes as a prop does (0x3ED60) and draws
 * every frame until a shot sets bit 28 of +0x58; then it blinks and closes
 * 120 frames on, which the explorer, with no shots, leaves out. Chapter 4's
 * four (Stage 4 set 9) stand here.
 *
 * Type 123 drops a coin the same way: its handler, 0x3C9D0, opens a task on
 * 0x3C730 with PN_kinka00a (0x3B5), scale 1.4, the spawner's x and z, y the
 * float at 0x51E3C0 plus 0.22, +0x2C 0x4000 (on its edge) and the yaw at 0,
 * and in chapter 4 closes its own task. The coin closes as a prop does and
 * turns its yaw 0x1000 a frame until a shot sets bit 28 of +0x58 (left out).
 * Chapter 4's five (Stage 4 set 9) spin here while animate is ticked.
 *
 * Type 121 (PN_kikai_b) closes as a prop does (0x3ED60) and draws on 0x3EB30
 * through 0x413B0 until a shot sets bit 1 or 2 of +0x58; then it breaks, and
 * sets event flag 0x56, or 0x55 with a life (0x3C5A0) if bit 5 is set. Its
 * init closes it at once if that flag is already up (0x55 at 1 drops the life
 * first), unless it has a camera window (+0x64). Only 0x3EB30 and the life
 * item (0x3C3D4) write 0x55 and 0x56; no script does. Chapter 3's section 0
 * spawns two in script 8 (0xF59E0, 0xF5A40), with window row 0x1F, which
 * closes them at 0x159 on the zone's clock, and two more in script 10
 * (0xF5A10, 0xF5A70) at the same places, turns and scale: the same machines,
 * taken over by objects that know whether the first were shot. So one stands
 * at each place (Stage 3 set 8), and the shot is left out.
 *
 * Type 67 (PN_r2_01_futa, a chained lid) does the same on 0x3E010: it closes
 * as a prop does, draws through 0x413B0 and steps to its breaking models only
 * once a shot sets bit 1 or 2 of +0x58. Chapter 2's section 0 spawns one
 * (0xEC720, Stage 2 set 5); the shot is left out.
 *
 * Type 78 (PN_r2do_01a) on 0x3DA60 is a door, opening on event flag 0x0E,
 * only while the section byte (0x51F350) is 1. In any other section it
 * closes as a prop does and draws 0x413B0's commands with its own model and
 * size: PN_door_n4a (0x165) at 0.9, 1.4 and 1.0 on x, y and z. Chapter 2's
 * section 9 spawns the only one (0xF05A0, Stage 2 set 7).
 *
 * Type 68 (PN_furukagi00a) on 0x3D6E0 draws through 0x413B0 as a prop does,
 * but does not close as one: once the zone's clock passes 521 it counts 227
 * frames and closes. It swings (bit 28 of +0x58, turning +0x34) once a shot
 * sets bit 1 or 2 of +0x58, or once the byte 0x51EFB0 has been 1 for 45
 * frames; the explorer opens neither. Chapter 1's section 13 spawns the only
 * one (0xE92C0, Stage 1 set 3), and it stands still here.
 *
 * The prototype's 68 (0x32E80) counts +0x50 from its spawn and closes past
 * 190 frames, and it turns +0x34 as a spring (+0x304 its speed) that is kicked
 * only past camera frame 593, once +0x2E4 has counted past 55. Its one
 * record (0xE8620, Stage 1 set 3) is the finished game's, turned only in yaw,
 * so it stands still until kicked. It closes on its 191st frame, camera frame
 * 595, in the op 81 wait that holds the camera there: it keeps the zones its
 * 190 frames are drawn in (`frames`). The kicks come on its 137th and 169th
 * frames, with the camera held past 593, and the swing is left out.
 *
 * The prototype's 78 and 79 (PN_r2do_01a and 01b), on 0x33130, are the two
 * halves of a door. Each frame they draw through 0x35AD0 and nothing else,
 * never calling 0x33320, until the byte 0x51E50E is set; then they take a
 * push and a spin, fall, and close once below y -35. Only enemies' own
 * routines set that byte (states of 0x568B0's table at 0x57B90 and 0x57FC0,
 * and 0x3A6FC), and the explorer opens none, so chapter 2's section 1 pair
 * (0xEBBE0 and 0xEBC10, Stage 2 set 5) stand shut to the chapter's end
 * (`stays`), and the burst is left out.
 *
 * Type 14 (PN_jinmengyo_01, scale 0.3) on 0x3B550 is a fish that swims a
 * path of its own: its record stands at the origin, and each frame the
 * handler closes as a prop does, then puts it at t along segment +0x2F8 of
 * a uniform quadratic B-spline through the points at 0xAE7F0 —
 * 0.5(1-t)², t(1-t)+0.5 and 0.5t² of points s, s+1 and s+2 — and steps t
 * by 0.01, to segment s+1 once past 1, and back to 0 past 3. The six
 * points close on themselves, so it loops every 404 frames. It turns to
 * where it went, by coprocessor function 0x0F on the step: +0x2C the pitch
 * and +0x30 the negated heading, kept from the frame before when t has
 * just started again. It draws PN_jinmengyo_01 plus +0x50 rem 40, +0x50
 * counting draws, through 0x413B0. Chapter 2's section 4, script 6 spawns
 * the only one (0xEEB00, Stage 2 set 6). The prototype's 0x312B0 is the
 * same routine on its own offsets and the same points (at 0x85900); its
 * only one is 0xED950, in its own Stage 2 set 6.
 *
 * Type 0 is nothing at all — its entry names PN_space and its handler slot is a
 * null pointer — so the table's own shape excludes it.
 *
 * Records are keyed by their own address, because a script listed by two
 * sections is walked twice and would otherwise stand its props up twice.
 */
function spawnProps(rom, at, set, out, section, chapter) {
    const O = rom.game.objects;
    if (!O) return;
    const dv = rom.mainCpuView;
    for (let q = at + 4; inRom(rom, q); q += 4) {
        const rec = dv.getUint32(q, true);
        if (rec === END) break;
        if (!inRom(rom, rec, SPAWN_BYTES)) continue;
        if (out.has(rec)) continue;
        /*
         * The word the spawner reads first is not the type: it is the object's
         * class, an index into a table of the routines that open a task —
         * `ld off_AFDD0[g4*4], g0 / call _TaskOpen`. Only one of them, the one
         * the profile names, is the generic object that goes on to draw the
         * type's model; the rest are the doors, the bodies and the effects,
         * which stand nothing here. Every other field is filled the same way
         * whatever the class, which is why they all looked like props.
         */
        const cls = dv.getUint32(rec, true);
        if (!inRom(rom, O.classes + cls * 4)) continue;
        const opens = dv.getUint32(O.classes + cls * 4, true);
        /* A class that stands a row of props of its own (see standRow). */
        const row = O.rows?.find((r) => r.init === opens);
        if (row) { standRow(rom, rec, row, set, out); continue; }
        /* And one that stands a room's furniture out of a table. */
        const table = O.tables?.find((r) => r.init === opens);
        if (table) { standTable(rom, rec, table, set, out); continue; }
        /* And the two that stand a group about their own place. */
        const group = O.groups?.find((r) => r.init === opens);
        if (group) { standGroup(rom, rec, group, set, out, chapter); continue; }
        /* And one that stands models of its own at places of its own. */
        const fixed = O.fixed?.find((r) => r.init === opens);
        if (fixed) { standFixed(rom, rec, fixed, set, out); continue; }
        const facing = O.facing?.find((r) => r.init === opens);
        if (facing) { standFacing(rom, rec, facing, set, out); continue; }
        if (opens !== O.generic) continue;
        const type = rom.maincpu[rec + O.type];
        if (!(type > 0 && type < O.count)) continue;
        const handler = dv.getUint32(O.handlers + type * 4, true);
        const room4 = O.room4 && handler === O.room4.handler;
        const cases = O.cases && handler === O.cases.handler;
        const clocked = O.clocked && handler === O.clocked.handler;
        const meat = O.meat && handler === O.meat.handler;
        const cycle = O.cycles?.find((c) => c.handler === handler && (!c.types || c.types.includes(type)));
        const spinner = O.spinners?.find((c) => c.handler === handler);
        const item = O.items?.find((c) => c.handler === handler);
        const plain = O.plain?.find((c) => c.handler === handler && c.types.includes(type));
        const swimmer = O.swimmers?.find((c) => c.handler === handler);
        if (handler !== O.prop && !room4 && !cases && !clocked && !meat && !cycle && !spinner && !item
            && !plain && !swimmer) continue;
        if (plain && section === plain.door) continue;
        if (plain?.onePerPlace && [...out.values()].some((o) => o.type === type
            && o.pos[0] === dv.getFloat32(rec + 8, true) && o.pos[1] === dv.getFloat32(rec + 12, true)
            && o.pos[2] === dv.getFloat32(rec + 16, true))) continue;
        const model = item ? item.model : plain?.sections?.[section] ?? plain?.model
            ?? dv.getUint32(O.table + type * O.stride + O.model, true);
        if (!model || model >= rom.game.modelTable.count) continue;
        /* The size it is drawn at: the handler loads the type's float at
         * +0x28 into the task and hands it to the draw on all three axes --
         * `ld 0x94(r4), g4` written to 0x84, 0x88 and 0x8C of the matrix
         * command. Fifty of the seventy-three types are 1.0, which is why only
         * the ones that are not showed up: the vases at 0.5 and 1.4, the moon
         * at 0.25, the pile of bones at 1.5. */
        const scale = item ? item.scale : O.scale === undefined ? 1
            : dv.getFloat32(O.table + type * O.stride + O.scale, true);
        /* The three words after the position are the angles, copied straight
         * across to the task: `ld 0x14(r9), g4 / st g4, 0x2C(r8)` and the two
         * that follow. They are the turn the scenery uses, a whole circle to
         * 0x10000, and they are almost all a quarter turn of yaw. */
        out.set(rec, {
            type,
            model,
            set,
            scale: scale > 0 ? scale : 1,
            /* A size of its own on each axis, which type 78 draws at. */
            ...(plain?.axes ? { axes: plain.axes } : {}),
            pos: [dv.getFloat32(rec + 8, true),
                item?.y ?? dv.getFloat32(rec + 12, true) + (item?.lift ?? 0),
                dv.getFloat32(rec + 16, true)],
            /* An item keeps only the record's yaw (see above); a coin starts
             * at yaw 0, tipped on its edge. */
            turn: [item ? item.tip ?? 0 : dv.getUint32(rec + 20, true) & 0xffff,
                item?.yaw ?? dv.getUint32(rec + 24, true) & 0xffff,
                item ? 0 : dv.getUint32(rec + 28, true) & 0xffff],
            /* Room 4's first piece turns on its own (see above). */
            ...(room4 && type === O.room4.first ? { spin: O.room4.spin } : {}),
            /* And type 96 turns its third (see above). */
            ...(spinner ? { spin: spinner.rate, spinAxis: spinner.axis } : {}),
            /* And a coin its yaw (see above). */
            ...(item?.spin ? { spin: item.spin } : {}),
            /* And these two step their model (see above). */
            ...(cycle && cycle.last >= model ? {
                cycle: Array.from({ length: cycle.last - model + 1 }, (_, i) => model + i),
            } : {}),
            /* And the prototype's 69 and 77 close on the camera frame (see
             * above). */
            ...(cycle?.until ? { until: cycle.until } : {}),
            ...(clocked?.until ? { until: clocked.until } : {}),
            /* And the prototype's 68 closes after its own count of frames. */
            ...(plain?.frames ? { frames: plain.frames } : {}),
            /* And the prototype's door halves never close by themselves. */
            ...(plain?.stays ? { stays: true } : {}),
            /* And the fish swims its path, stepping its model (see above). */
            ...(swimmer ? {
                cycle: Array.from({ length: swimmer.models }, (_, i) => model + i),
                swim: swimPath(rom, swimmer),
            } : {}),
        });
        const o = out.get(rec);
        if (o.swim) o.ops = (frame) => propOps({ ...o, ...o.swim(frame) });
    }
}

/*
 * A spawn class that stands a row of props rather than one: its task opens
 * `count` tasks on the plain prop handler, gives each the type, the place and
 * a model of its own, and closes. Chapter 2's class 131 (0x39B50 in the first
 * revision):
 *
 *     lda  0x3A210, g0         ; the prop handler
 *     call _TaskOpen
 *     stos r7, 0xCC(r4)        ; type 51
 *     call 0x417F0             ; the type's model and scale; +0x2EC the script
 *     ld   0xAFBB0[i*4], g6    ; z: the table's float, less 14, plus 249.749
 *     lda  0x149C[i*2], g5     ; model 0x149C + 2i, PN_kenita00a to 07a
 *     st   g5, 0x54(r4)
 *     ldos 0x70(r6), g4        ; the spawner's life and window, copied
 *     ...                      ; x 1210.341, y -59.011
 *
 * for i 0 to 7, then closes its own task. The record's own place and turns
 * are not read, so the eight stand at the routine's places, unturned, and
 * close as the record's own prop would.
 */
function standRow(rom, rec, row, set, out) {
    const O = rom.game.objects;
    const dv = rom.mainCpuView;
    if (out.has(`${rec}:0`)) return;
    if (dv.getUint32(O.handlers + row.type * 4, true) !== O.prop) return;
    const scale = dv.getFloat32(O.table + row.type * O.stride + O.scale, true);
    for (let i = 0; i < row.count; i++) {
        const model = row.model + i * row.step;
        if (model >= rom.game.modelTable.count) continue;
        const z = Math.fround(Math.fround(dv.getFloat32(row.z + i * 4, true) - row.less) + row.plus);
        out.set(`${rec}:${i}`, {
            rec, type: row.type, model, set, scale: scale > 0 ? scale : 1,
            pos: [row.x, row.y, z], turn: [0, 0, 0],
        });
    }
}

/*
 * A spawn class that stands a room's furniture out of a table: class 0x8A
 * (0x39830 in the first revision, 0x2FDD0 in the prototype). Its record's
 * type picks a block of the table, 0x16C bytes from `at`, and each 28-byte
 * entry of the block opens a task on the plain prop handler:
 *
 *     ldis 0xCC(r6), g5        ; the record's type
 *     mulo 0x16C, g5, g5       ; picks the block
 *     ldos 0xAA378(g5)[i*28]   ; +0x00 the entry's own type
 *     call 0x417F0             ; that type's model and scale
 *     ld   0xAA37C(g4)[i*28]   ; +0x04, +0x08, +0x0C the place
 *     ld   0xAA388(g4)[i*28]   ; +0x10, +0x14, +0x18 the turns, to +0x2C..
 *     ld   0x2C(type), g4      ; y plus the type's own offset
 *     ldos 0x70(r6), g4        ; the record's life and window, copied
 *
 * until an entry's first word is -1; then it closes its own task. The record's
 * own place and turns are not read. All but types 2, 3, 34, 35 and 43 are
 * set bit 30, which takes them straight to the plain draw with no shot. The
 * rest break when shot, as a prop does, and the bookcases (type 43) at x
 * 82.9 and 97.3 also when event flag 35 or 36 is set: both left out. The plain draw also draws a second model for types 11 and 26
 * (0x13A0, and 0xD0D moved (0, 3.5, 2)), as it does for any prop of those
 * types: left out here as there.
 */
function standTable(rom, rec, table, set, out) {
    const O = rom.game.objects;
    const dv = rom.mainCpuView;
    if (out.has(`${rec}:0`)) return;
    const block = table.at + rom.maincpu[rec + O.type] * table.block;
    for (let i = 0; i < 256; i++) {
        const at = block + i * 28;
        if (!inRom(rom, at, 28) || (i > 0 && dv.getInt32(at, true) === -1)) break;
        const type = dv.getUint16(at, true);
        if (!(type > 0 && type < O.count)) continue;
        const entry = O.table + type * O.stride;
        const model = dv.getUint32(entry + O.model, true);
        if (!model || model >= rom.game.modelTable.count) continue;
        const scale = dv.getFloat32(entry + O.scale, true);
        out.set(`${rec}:${i}`, {
            rec, type, model, set, scale: scale > 0 ? scale : 1,
            pos: [dv.getFloat32(at + 4, true),
                Math.fround(dv.getFloat32(at + 8, true) + dv.getFloat32(entry + table.lift, true)),
                dv.getFloat32(at + 12, true)],
            turn: [16, 20, 24].map((o) => dv.getUint32(at + o, true) & 0xffff),
        });
    }
}

/*
 * Two spawn classes that stand a fixed group of props about their own place,
 * out of a table of 28-byte entries: classes 0x93 and 0x98 in the finished
 * game (0x394B0 and 0x395B0), whose fifteen and twelve entries are at 0xAED40
 * and 0xAF620. For each, the routine opens a task, on 0x3A9C0 or 0x3ACF0, and
 *
 *     ldos 0xAED40[i*28], g4   ; +0x00 the entry's own type
 *     call 0x417F0             ; that type's model and scale
 *     ldos 0x70(r6), g4        ; the spawner's life and window, copied
 *     ld   0x20(r6), g4        ; the spawner's place
 *     ld   0x4(r4), g5         ; plus the entry's +0x04, +0x08, +0x0C
 *     ld   0x2C(r6), g4        ; the spawner's turns
 *     ld   0x10(r4), g5        ; plus the entry's +0x10, +0x14, +0x18
 *
 * for i 0 to 14 (0 to 11 for 0x395B0), then closes its own task. The class
 * 0x93 routine also gives a child whose third turn comes out nonzero a third
 * turn of 0 and window row 28; five of the 0xAED40 entries carry a 1 there
 * for that. The two handlers draw as the plain prop draw does: the place at
 * +0x20, the three turns, the scale at +0x94, the model at +0x54, under
 * the same life and window closes. Neither adds the type's +0x2C offset.
 * Each also marks its child unbreakable (+0x58 bit 30) over a stretch of the
 * zone's clock, which only changes whether a shot breaks it. 0x3ACF0 draws a
 * second model over type 73 (0x1241 at twice the size), as the plain draw
 * does for types 11 and 26: left out here as there. Each class spawns once:
 * 0x93 at 0xE4980 (Stage 1 set 3, at (109.5, 0, 200)), a laid table —
 * PN_tabul_02a, six PN_isu_02a chairs, six PN_sara03a plates, PN_kabin_01a
 * and PN_honeatama — and 0x98 at 0xF27D0 (Stage 2 set 5, at the origin),
 * three PN_maru_01a tables (the middle one PN_fruit_01a instead), six
 * PN_sara03ab and three PN_syokudai01a.
 *
 * The prototype has one routine for both, class 0x93's 0x2FA20. It picks the
 * table by the chapter number (0x51E4C0): fifteen entries at 0x85E10 in
 * chapter 0 and twelve at 0x866F0 in chapter 1: the same places and types,
 * but a third type 73 where the finished game has its 85, and no third turn
 * set. Its records are 0xE4340 and 0xF11D0, in the same sets. Its
 * children run the plain prop handler (0x30670); in chapter 0 all but types
 * 3 and 4 get window row 26.
 */
function standGroup(rom, rec, group, set, out, chapter) {
    const O = rom.game.objects;
    const dv = rom.mainCpuView;
    if (out.has(`${rec}:0`)) return;
    const g = group.chapters ? group.chapters[chapter] : group;
    if (!g) return;
    const place = [8, 12, 16].map((o) => dv.getFloat32(rec + o, true));
    const turns = [20, 24, 28].map((o) => dv.getUint32(rec + o, true));
    for (let i = 0; i < g.count; i++) {
        const at = g.at + i * 28;
        if (!inRom(rom, at, 28)) break;
        const type = dv.getUint16(at, true);
        if (!(type > 0 && type < O.count)) continue;
        const entry = O.table + type * O.stride;
        const model = dv.getUint32(entry + O.model, true);
        if (!model || model >= rom.game.modelTable.count) continue;
        const scale = dv.getFloat32(entry + O.scale, true);
        const turn = [16, 20, 24].map((o, k) => (turns[k] + dv.getUint32(at + o, true)) >>> 0);
        const marked = g.marked != null && turn[2] !== 0;
        if (marked) turn[2] = 0;
        const window = marked ? g.marked : g.window != null && !g.keep.includes(type) ? g.window : null;
        out.set(`${rec}:${i}`, {
            rec, type, model, set, scale: scale > 0 ? scale : 1,
            pos: place.map((v, k) => Math.fround(v + dv.getFloat32(at + 4 + k * 4, true))),
            turn: turn.map((v) => v & 0xffff),
            /* A window row of its own, in place of the record's. */
            ...(window != null ? { window } : {}),
        });
    }
}

/*
 * A spawn class that stands models of its own at places of its own: class
 * 0x94 (0x38F50 in the first revision, 0x2F3B0 in the prototype). Its routine
 * opens four tasks, on 0x3C240 (the prototype's 0x32110), and for each
 *
 *     call 0x417F0             ; the record's type's model and scale, then
 *     ld   0xAEA30[i*28], g4   ; +0x00 a model, not a type: it replaces them
 *     st   g4, 0x54(r4)
 *     ldos 0x70(r6), g4        ; the spawner's life and window, copied
 *     st   1.0, 0x94(r4)       ; scale 1
 *     ld   0xAEA34[i*28], g6   ; +0x04, +0x08, +0x0C the place, to +0x20..
 *     ld   0xAEA40[i*28], g4   ; +0x10, +0x14, +0x18 the turns, to +0x2C..
 *
 * for i 0 to 3, then closes its own task. The record's own place and turns
 * are not read. The task closes as a prop does and, before it draws, works on
 * the model it holds: PN_haguuu and PN_haguuu01a (0x8C6, 0x8C7) add 0x80 to
 * the third turn (+0x34) every frame and PN_haguuu02a (0x8C8) takes 0x80 off
 * it; any other model steps one, back to PN_hagumizu00a (0x8A8) once the one
 * it stepped from is past 0x8C4, so 00a to 29a loop. The prototype's are the
 * same at its own models (0x83E, 0x83F, 0x840; 0x820 to 0x83D). The first
 * gear's turn is also stored for another object (0x53E4C0), and around the
 * water's draw the routine rescales a block of 32 words at 0x7A0 by 0xC8/256
 * and sends it to the coprocessor; neither is followed here. Chapter 1's
 * section 10 spawns the one record of the class, 0xE7030 (the prototype's
 * 0xE6660), in Stage 1 set 1.
 */
function standFixed(rom, rec, fixed, set, out) {
    const dv = rom.mainCpuView;
    if (out.has(`${rec}:0`)) return;
    for (let i = 0; i < fixed.count; i++) {
        const at = fixed.at + i * 28;
        if (!inRom(rom, at, 28)) break;
        const model = dv.getUint32(at, true);
        if (!model || model >= rom.game.modelTable.count) continue;
        const spin = fixed.spins[model];
        out.set(`${rec}:${i}`, {
            rec, type: rom.maincpu[rec + rom.game.objects.type], model, set, scale: 1,
            pos: [4, 8, 12].map((o) => dv.getFloat32(at + o, true)),
            turn: [16, 20, 24].map((o) => dv.getUint32(at + o, true) & 0xffff),
            ...(spin ? { spin, spinAxis: 2 } : {}),
            ...(!spin && model <= fixed.last ? {
                cycle: Array.from({ length: fixed.last - fixed.first + 1 }, (_, k) => fixed.first + k),
            } : {}),
        });
    }
}

/*
 * Class 0x13's moon (the finished game's task 0x2F740, the prototype's
 * 0x27D70), which turns one flat model to the camera every frame. It takes
 * the camera's place (0x51EBD0) less its own (+0x20) to the coprocessor's
 * 0xF0F, which hands back the vector's heading, kept at +0x30, and its pitch,
 * at +0x2C; a pitch past a right angle either way is taken from 0x8000 and
 * the heading turned half round. Then it draws its model (PN_moon22, 0x14AC;
 * the prototype's PN_moonc, 0x13A2) at its place, turned by the heading, by
 * the pitch less 0x4000, and by the record's own third angle (+0x34), and
 * scaled 5 (0x40A00000) on each axis. It never calls sub_33320, and closes
 * only once byte 0x51E3BD (0x51E5FD) is 1, which no store in the program
 * names, so it stays up to the chapter's end (`stays`).
 */
function standFacing(rom, rec, facing, set, out) {
    const dv = rom.mainCpuView;
    if (out.has(rec)) return;
    const pos = [8, 12, 16].map((o) => dv.getFloat32(rec + o, true));
    const third = dv.getUint32(rec + 0x1c, true) & 0xffff;
    const turn = (v) => Math.round((v * 0x10000) / (2 * Math.PI)) & 0xffff;
    const deg = (v) => (v * 360) / 0x10000;
    const scale = facing.scale;
    out.set(rec, {
        rec, type: rom.maincpu[rec + rom.game.objects.type], model: facing.model, set, scale,
        pos, turn: [0, 0, third], stays: true,
        live: (frame, cam) => {
            const d = [cam.x - pos[0], cam.y - pos[1], cam.z - pos[2]];
            let heading = turn(-Math.atan2(d[0], d[2]));
            let pitch = turn(Math.atan2(d[1], Math.hypot(d[0], d[2])));
            if (((pitch ^ (pitch << 1)) & 0x8000) !== 0) {
                pitch = (0x8000 - pitch) & 0xffff;
                heading = (heading + 0x8000) & 0xffff;
            }
            return {
                model: facing.model,
                ops: [['t', [pos[0], pos[1], -pos[2]]], ['r', deg(heading)],
                    ['rx', deg((pitch - 0x4000) & 0xffff)], ...(third ? [['rz', -deg(third)]] : []),
                    ['s', [scale, scale, scale]]],
            };
        },
    });
}

/*
 * Which zones each prop is drawn in, by running the board's clock over the
 * scripts.
 *
 * A prop does not belong to a zone. It is a task the spawn opcode opens, and
 * it stays up until it closes itself, which only sub_33320 makes it do — the
 * routine its handler (0x30670) calls each frame before it draws:
 *
 *     ldib 0x520089, g7        ; the section's script index
 *     ld   0x2E4(r4), g4       ; against the one the object last saw;
 *     ...                      ; a change is counted at obj+0x318,
 *     ldis 0x6C(r4), g6        ; and once past the record's halfword
 *     cmpible g5, g6, ...
 *     call sub_10D60           ; the task closes itself
 *
 * and then, for a record with a window row, flips obj+0x2E8 — the flag the
 * handler draws under — each time the camera frame (0x51E788) equals the
 * row's next entry, closing once the row ends with it hidden. So what decides
 * a prop's zones is time: how many scripts have gone by, and how far the
 * camera has played, when each opcode 20 runs. That is walked here the way
 * the interpreter runs it. Opcode 60's type-0 command queues a camera stretch
 * {start, end, path, flags}; 83 waits for the queue to play out, 84 for a
 * frame past its argument, 81 for that many frames; the rest take no time.
 * 93 moves to the next script, and the end of a section goes where the branch
 * table says, at script 1 (sub_51490; script 0 is the start the game takes
 * in its other mode). A prop is in a zone if it is drawn on a frame while
 * that zone is current. A choice between two sections takes both.
 *
 * Returns a Map from spawn record to a Set of zones, or null where the profile
 * does not say how a prop closes.
 */
const OP_WAIT_FRAMES = 81;
const OP_WAIT_CAMERA = 83;
const OP_WAIT_PAST = 84;
const WINDOW_END = 0xffff;

function propZones(rom, chapter, sections, props) {
    const O = rom.game.objects;
    const branches = rom.game.stageTable.placements.branches;
    if (!O?.spawns || branches == null) return null;
    const dv = rom.mainCpuView;
    const scripts = sections.map((section) => pointerList(rom, section).map((script) => {
        const ops = [];
        walkScript(rom, script, (op, p) => ops.push([op, p]));
        return ops;
    }));
    const table = dv.getUint32(branches + chapter * 4, true);
    /* The sections that can follow one, as sub_51490 picks them. A section
     * with no script 1 ends the chapter. */
    const after = (s) => {
        const at = table + s * 16;
        const kind = rom.maincpu[at];
        const next = [];
        if (kind === 0) next.push(rom.maincpu[at + 4]);
        else if (kind === 2) next.push(s + 1);
        else if (kind === 1) {
            for (let q = at + 4; q < at + 16 && dv.getUint32(q, true) !== END; q += 4) next.push(rom.maincpu[q]);
        }
        return next.filter((n) => scripts[n]?.length > 1);
    };
    const sweep = O.sweep?.chapter === chapter ? O.sweep : null;
    const out = new Map();

    /*
     * Run the interpreter from script `i`, instruction `e` of section `s`,
     * with `c` the camera and the current zone, and `t` the object, if one is
     * up yet. Without one it stops at `stop` = [script, instruction] and hands
     * back the state there; with one, it runs until the object closes or the
     * chapter ends, crediting zones as it goes.
     */
    function run(s, i, e, c, t, stop = null, seen = new Set()) {
        /* One frame of the object's task: sub_33320, in its order. */
        const frame = () => {
            if (!t) return true;
            /* One that counts its own frames from its spawn and closes past
             * `frames`. */
            if (t.frames != null) {
                if (++t.n > t.frames) return false;
                if (c.zone != null) out.get(t.rec).add(c.zone);
                return true;
            }
            /* One that never calls sub_33320 and has nothing the explorer
             * opens to close it: up to the chapter's end. */
            if (t.stays) {
                if (c.zone != null) out.get(t.rec).add(c.zone);
                return true;
            }
            /* A handler that never calls sub_33320 and closes once the
             * camera frame passes the number its spawn set by section. */
            if (t.until != null) {
                if (c.frame > t.until) return false;
                if (c.zone != null) out.get(t.rec).add(c.zone);
                return true;
            }
            if (sweep && s === sweep.section && i === sweep.script && t.type !== sweep.spare
                && c.frame > sweep.after) return false;
            if (i !== t.seen) {
                t.seen = i;
                if (++t.count > t.life) return false;
            }
            if (t.window) {
                if (c.frame === t.window[t.w]) { t.drawn = !t.drawn; t.w++; }
                if (!t.drawn && t.window[t.w] === WINDOW_END) return false;
            }
            if (t.drawn && c.zone != null) out.get(t.rec).add(c.zone);
            return true;
        };
        /* The camera's next frame, or the one it holds when nothing is queued. */
        const tick = () => {
            const q = c.queue[0];
            if (q) {
                c.frame = q[0]++;
                if (q[0] > q[1]) c.queue.shift();
            }
            return frame();
        };
        for (let sections = 0; sections < 64; sections++) {
            const list = scripts[s];
            for (; i < list.length; i++, e = 0) {
                for (; e < list[i].length; e++) {
                    if (stop && i === stop[0] && e === stop[1]) return c;
                    const [op, p] = list[i][e];
                    const arg = dv.getUint32(p + 4, true);
                    if (op === OP_ZONE) c.zone = arg;
                    else if (op === OP_CAMERA && (arg & 15) === 0 && arg >>> 4 >= 2) {
                        const start = dv.getUint32(p + 8, true);
                        const last = c.queue.length ? c.queue[c.queue.length - 1][1] : c.frame;
                        c.queue.push([start === END ? last + 1 : start, dv.getInt32(p + 12, true)]);
                    } else if (op === OP_WAIT_CAMERA) {
                        while (c.queue.length) if (!tick()) return null;
                    } else if (op === OP_WAIT_PAST && arg) {
                        while (c.queue.length && !(c.frame > arg)) if (!tick()) return null;
                    } else if (op === OP_WAIT_FRAMES) {
                        for (let k = 0; k < Math.min(arg, 3600); k++) if (!tick()) return null;
                    }
                }
            }
            if (stop) return c;
            /* The section is done: on to each that can follow, at script 1. A
             * branch already taken in the same state adds nothing. */
            const next = after(s).filter((n) => {
                const key = `${n}:${t.count}:${t.w}:${t.drawn}:${c.zone}:${c.frame}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
            if (!next.length) return null;
            for (const n of next.slice(1)) {
                run(n, 1, 0, { ...c, queue: c.queue.map((q) => [...q]) }, { ...t }, null, seen);
            }
            [s, i, e] = [next[0], 1, 0];
        }
        return null;
    }

    /* The props each record stands, one of each window row of their own (see
     * standGroup); the rest keep the record's. */
    const kinds = new Map();
    for (const [key, o] of props) {
        const rec = o.rec ?? key;
        if (!kinds.has(rec)) kinds.set(rec, new Map());
        if (!kinds.get(rec).has(o.window)) kinds.get(rec).set(o.window, o);
    }

    scripts.forEach((list, s) => list.forEach((ops, i) => ops.forEach(([op, p], e) => {
        const form = SPAWN_OPS.has(op) && O.spawns[op];
        if (!form) return;
        for (let q = p + 4; inRom(rom, q); q += 4) {
            const rec = dv.getUint32(q, true);
            if (rec === END) break;
            for (const [own, prop] of kinds.get(rec) ?? []) {
                const key = own == null ? rec : `${rec}@${own}`;
                if (!out.has(key)) out.set(key, new Set());
                const row = own ?? (form.window != null ? rom.maincpu[rec + form.window] : 0);
                const window = [];
                for (let k = 0; row && k < 8; k++) {
                    window.push(dv.getUint16(O.windows + row * 16 + k * 2, true));
                    if (window[k] === WINDOW_END) break;
                }
                /* The interpreter as it stands at the spawn, then the object. */
                const c = run(s, 0, 0, { zone: null, frame: 0, queue: [] }, null, [i, e]);
                run(s, i, e + 1, c, {
                    rec: key, type: prop.type, life: dv.getInt16(rec + form.life, true),
                    seen: i, count: 0, drawn: true, window: row ? window : null, w: 0,
                    ...(prop.frames ? { frames: prop.frames, n: 0 } : {}),
                    ...(prop.stays ? { stays: true } : {}),
                    ...(prop.until ? {
                        until: typeof prop.until === 'number' ? prop.until : prop.until[s] ?? 0,
                    } : {}),
                });
            }
        }
    })));
    return out;
}

/* A prop's three angles, in the order and the sign the scenery's single turn
 * already uses. Yaw is all but six of them carry. */
function propTurn([x, y, z]) {
    const deg = (v) => (v * 360) / 0x10000;
    const out = [];
    if (y) out.push(['r', deg(y)]);
    if (x) out.push(['rx', deg(x)]);
    if (z) out.push(['rz', -deg(z)]);
    return out;
}

/* Where a prop stands, turned, and its size; `spin` more of the turn its
 * `spinAxis` names, the second (+0x30, the yaw) unless it says otherwise. */
function propOps(o, spin = 0) {
    const turn = [...o.turn];
    const axis = o.spinAxis ?? 1;
    turn[axis] = (turn[axis] + spin) & 0xffff;
    return [['t', [o.pos[0], o.pos[1], -o.pos[2]]],
        ...propTurn(turn),
        ...(o.axes ? [['s', o.axes]] : o.scale === 1 ? [] : [['s', [o.scale, o.scale, o.scale]]])];
}

/*
 * Where type 14's fish is on each frame, and how it is turned (see
 * spawnProps): 0x3B550's own arithmetic, in single precision as the board
 * does it, which lands on MAME's places exactly. The turn is the step's
 * pitch and negated heading, held where t starts again; the board's first
 * frame has none yet. Two laps are worked, so that only the first carries
 * that unturned frame.
 */
function swimPath(rom, { points, segments, step }) {
    const dv = rom.mainCpuView;
    const F = Math.fround;
    const P = Array.from({ length: segments + 2 }, (_, i) => [0, 1, 2]
        .map((k) => dv.getFloat32(points + i * 12 + k * 4, true)));
    const turn = (v) => Math.round((v * 0x10000) / (2 * Math.PI)) & 0xffff;
    const frames = [];
    let t = 0, s = 0, prev = null, angles = [0, 0, 0], lap = 0;
    while (frames.length < 2 * lap || !lap) {
        const u = F(1 - t);
        const w = [F(F(u * 0.5) * u), F(F(u * t) + 0.5), F(F(t * t) * 0.5)];
        const pos = [0, 1, 2].map((k) => F(F(F(w[0] * P[s][k]) + F(w[1] * P[s + 1][k]))
            + F(w[2] * P[s + 2][k])));
        let next = F(t + F(step));
        if (next > 1) { next = 0; s = s + 1 < segments ? s + 1 : 0; }
        if (prev && next !== F(step)) {
            const d = pos.map((v, k) => v - prev[k]);
            angles = [turn(Math.atan2(d[1], Math.hypot(d[0], d[2]))), turn(-Math.atan2(d[0], d[2])), 0];
        }
        frames.push({ pos, turn: angles });
        t = next; prev = pos;
        if (!lap && t === 0 && s === 0) lap = frames.length;
        if (frames.length > 1 << 16) throw new Error('swimPath: the path does not close');
    }
    return (frame) => frames[frame < lap ? frame : lap + (frame % lap)];
}

/* A -1-terminated list of pointers, as the section and script tables are. */
function pointerList(rom, at) {
    const dv = rom.mainCpuView;
    const out = [];
    for (let p = at; inRom(rom, p) && out.length < 256; p += 4) {
        const v = dv.getUint32(p, true);
        if (!inRom(rom, v)) break;
        out.push(v);
    }
    return out;
}

/* Section numbers as runs: 0-4, 9-12. */
function runs(numbers) {
    const sorted = [...numbers].sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < sorted.length; i++) {
        let j = i;
        while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
        out.push(i === j ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`);
        i = j;
    }
    return out.join(', ');
}

function readPlacement(rom, map, index) {
    const dv = rom.mainCpuView;
    const at = map + index * PLACEMENT_BYTES;
    if (!inRom(rom, at, PLACEMENT_BYTES)) return null;
    /* A non-zero cycle pointer overrides the model: the loop draws the next
     * entry of that -1-terminated list each time, and goes back to the first
     * past the end. Which of the record's two tail words holds it moved between
     * the prototype and the finished game — 0x10 there, 0x14 here, with the
     * other word carrying something the viewer does not read — so the profile
     * says. Each game has exactly one placement that uses it, and it is the
     * same one: the rain in the mansion corridor's windows, cycling 32 frames.
     */
    const cycleAt = dv.getUint32(at + (rom.game.stageTable.placements.cycle ?? 0x10), true);
    const cycle = cycleAt ? modelList(rom, cycleAt) : null;
    return {
        index,
        model: dv.getUint32(at, true),
        pos: [dv.getFloat32(at + 4, true), dv.getFloat32(at + 8, true), dv.getFloat32(at + 12, true)],
        cycle: cycle?.length ? cycle : null,
        turn: rom.game.stageTable.placements.turns?.[index] ?? 0,
    };
}

/* A -1-terminated list of model numbers. */
function modelList(rom, at) {
    const dv = rom.mainCpuView;
    const out = [];
    for (let p = at; inRom(rom, p) && out.length < 256; p += 4) {
        const v = dv.getUint32(p, true);
        if (v === END) break;
        out.push(v);
    }
    return out;
}

/*
 * How many placements a chapter's table holds. The program never says — the
 * draw loop only ever reaches a record through a zone — but a table ends in a
 * record no zone names, and nothing is placed as model 0. The prototype's
 * chapters close on a zero model; the finished game's close on a -1 model and a
 * zero one behind it, so both words end the walk. Stopping only on zero there
 * would take the -1 for a placement and index the model tables with it.
 */
function placementCount(rom, map) {
    const dv = rom.mainCpuView;
    let n = 0;
    while (n < 256 && inRom(rom, map + n * PLACEMENT_BYTES, PLACEMENT_BYTES)) {
        const model = dv.getUint32(map + n * PLACEMENT_BYTES, true);
        if (model === 0 || model === END) break;
        n++;
    }
    return n;
}

/*
 * Which placements are standing while one zone is current.
 *
 * The chapter's tables are full of versions of one piece at one spot —
 * PN_niwa01_03a, 03b and 03c, PN_room_1b and 1bb, PN_hashi01_00a and 00b — and
 * each zone lists one: PN_niwa01_03c is the mansion with its doors shut, which
 * zone 1 lists in section 0, and 03a has the doorway standing open, which zones
 * 11 and 12 list in section 4, once the doors have opened in front of the
 * player. A stage made of every zone a set reaches stands them all in one place,
 * modelled on top of each other. The board never does: it draws the one zone
 * the section script last made current (opcode 20), and nothing else. So a stage
 * carries its zones in the order the scripts reach them, and the viewer draws
 * whichever one is picked, opening on the first. Every zone at once stays as a
 * view of its own, versions and all.
 */
function zoneViews(zones, zoneOrder, zoneSections, set = null, zoneSet = null) {
    return [...zones]
        .sort((a, b) => (zoneOrder.get(a) ?? Infinity) - (zoneOrder.get(b) ?? Infinity))
        .map((zone) => ({
            zone,
            set: set ?? zoneSet.get(zone),
            label: `zone ${zone} · section ${runs(zoneSections.get(zone) ?? [])}`,
        }));
}

/*
 * The two shells behind the arena, where the scripts turn the sky on: the dome
 * the index picks, lowered by its own float, and the cut-out band every sky
 * draws over it. The dome's drift is an angle per frame rather than a fixed
 * turn, which is what carrying `ops` as a function of the frame is for.
 */
function skyDraws(rom, sky) {
    const S = rom.game.sky;
    if (!S || !sky?.on || sky.index >= S.count) return null;
    const dv = rom.mainCpuView;
    /* The prototype keeps the model and the height in two arrays of their own
     * and the drift rate in the code; the finished game folds all three into a
     * record per sky, so the profile gives a stride and, where the rate is in
     * the data, where to read it. */
    const stride = S.stride ?? 4;
    const dome = dv.getUint32(S.models + sky.index * stride, true);
    const y = dv.getFloat32(S.heights + sky.index * stride, true);
    if (!dome) return null;
    /* Angle units of 65536 a frame, as the task's own counter counts. */
    const rate = S.spins != null ? dv.getUint32(S.spins + sky.index * stride, true) : S.spin;
    return {
        index: sky.index, dome, band: S.band, y,
        spin: sky.spin ? rate : 0,
    };
}

/* A stage entry in the shape the viewer's stage list takes. The set is the
 * atlas, the palette and the colour tables at once — sub_2B720 loads all three
 * from the one number. */
function placementStage(stages, lit, chapter, { name, set, draws, objects = [], sky = null, zones = [], song, meta, mixedSets = false }) {
    stages.push({
        slot: stages.length,
        placements: true,
        mixedSets,
        num: chapter + 1,
        name,
        chapter,
        draws,
        objects,
        sky,
        zones,
        /* The music the scripts have started by then (js/app.js plays it). */
        song,
        /* The view the stage opens in: its first zone, or every placement
         * where it has no zones to choose between. See zoneViews. */
        views: [...zones.map((z, i) => [`zone:${i}`, z.label]),
            ['all', zones.length ? 'Every zone at once' : 'Every placement']],
        view: zones.length ? 'zone:0' : 'all',
        union: 'all',
        texSets: [set],
        texSet: [set, set],
        tint: [1, 1, 1],
        bright: 1,
        light: lit.light,
        materials: lit.materials,
        colorCycles: [],
        flags: 0,
        floorSize: 0,
        meta: [['stage', chapter + 1], ...meta],
    });
}

/**
 * Every stage the placement tables make: one per chapter and texture set, and
 * one per chapter with every placement in its table.
 *
 * @param {object} rom loaded ROM set
 * @returns {object[]} stage objects in the shape the viewer's stage list takes
 */
export function readPlacementStages(rom) {
    const T = rom.game.stageTable.placements;
    const dv = rom.mainCpuView;
    const lit = gameLighting(rom);
    const stages = [];

    for (let chapter = 0; chapter < T.chapters; chapter++) {
        const map = dv.getUint32(T.maps + chapter * 4, true);
        const zoneTable = dv.getUint32(T.zones + chapter * 4, true);
        const sectionSets = dv.getUint32(T.sectionSets + chapter * 4, true);
        const sections = pointerList(rom, dv.getUint32(T.scripts + chapter * 4, true));

        /* Zones in the order the scripts reach them, each under the set loaded
         * when it is made current: the section's own set as it starts, then any
         * set a script loads part way through. That order is also what says
         * which zone the stage opens in — see zoneViews. */
        const groups = new Map();
        const zoneOrder = new Map();
        const zoneSet = new Map();
        const zoneSections = new Map();
        /* The sky is a pair of bytes the scripts write and the drawing task
         * reads, so it carries across sections exactly as it does on the
         * machine: a set's sky is what is standing when its first zone is made
         * current, and whatever its own sections then ask for. */
        const sky = { index: 0, on: 0, spin: false };
        /* The song, much the same way: what is playing when a set's first zone
         * is made current, or else the first one started while it is up — the
         * first section of a chapter makes its zone current and then starts
         * the chapter's song. */
        let song = 0;
        /* The props the chapter's scripts spawn, each under the set that was
         * loaded when its list ran — the same rule the zones are grouped by. */
        const props = new Map();
        sections.forEach((section, number) => {
            let set = dv.getUint32(sectionSets + number * 4, true);
            for (const script of pointerList(rom, section)) {
                walkScript(rom, script, (op, p) => {
                    if (op === OP_LOAD_SET) set = dv.getUint32(p + 4, true);
                    if (op === OP_SOUND && isSong(dv.getUint32(p + 4, true))) {
                        song = dv.getUint32(p + 4, true);
                        const g = groups.get(set);
                        if (g && !g.song) g.song = song;
                        return;
                    }
                    if (op === OP_SKY || op === OP_SKY_ON) {
                        if (op === OP_SKY) sky.index = rom.maincpu[p + 4];
                        else { sky.on = rom.maincpu[p + 4]; sky.spin = sky.spin || sky.on === 1; }
                        const g = groups.get(set);
                        if (g) {
                            g.sky.index = sky.index;
                            g.sky.on = g.sky.on || sky.on !== 0;
                            g.sky.spin = g.sky.spin || sky.on === 1;
                        }
                        return;
                    }
                    if (SPAWN_OPS.has(op)) { spawnProps(rom, p, set, props, number, chapter); return; }
                    if (op !== OP_ZONE) return;
                    if (!groups.has(set)) {
                        groups.set(set, {
                            zones: new Set(), sections: new Set(), zoneSections: new Map(),
                            sky: { index: sky.index, on: sky.on !== 0, spin: sky.on === 1 },
                            song,
                        });
                    }
                    const g = groups.get(set);
                    const zone = dv.getUint32(p + 4, true);
                    g.zones.add(zone);
                    g.sections.add(number);
                    for (const m of [g.zoneSections, zoneSections]) {
                        if (!m.has(zone)) m.set(zone, new Set());
                        m.get(zone).add(number);
                    }
                    if (!zoneOrder.has(zone)) { zoneOrder.set(zone, zoneOrder.size); zoneSet.set(zone, set); }
                });
            }
        });

        /* And which zones each prop is drawn in, for the zone picker. */
        const lives = propZones(rom, chapter, sections, props);
        if (lives) {
            for (const [rec, o] of props) {
                o.zones = lives.get(o.window == null ? o.rec ?? rec : `${o.rec}@${o.window}`) ?? new Set();
            }
        }

        /* Which zones list each placement, over every zone the chapter reaches. */
        const zonesOf = new Map();
        for (const g of groups.values()) {
            for (const zone of g.zones) {
                const at = zoneTable + zone * ZONE_BYTES;
                if (!inRom(rom, at, ZONE_BYTES)) continue;
                for (let i = 0; i < ZONE_BYTES && rom.maincpu[at + i] !== 0xff; i++) {
                    const p = rom.maincpu[at + i];
                    if (!zonesOf.has(p)) zonesOf.set(p, new Set());
                    zonesOf.get(p).add(zone);
                }
            }
        }

        /* And the set each placement is drawn under: the one loaded while the
         * first zone that lists it is current. A stage made of every zone the
         * chapter reaches needs it per placement, because it spans every set
         * the chapter loads. */
        const setOf = new Map();
        for (const [index, zones] of zonesOf) {
            const first = [...zones].reduce((a, b) =>
                ((zoneOrder.get(b) ?? Infinity) < (zoneOrder.get(a) ?? Infinity) ? b : a));
            if (zoneSet.has(first)) setOf.set(index, zoneSet.get(first));
        }

        const reached = new Set();
        let widest = null;
        for (const [set, g] of groups) {
            const indices = new Set();
            for (const zone of g.zones) {
                const at = zoneTable + zone * ZONE_BYTES;
                if (!inRom(rom, at, ZONE_BYTES)) continue;
                for (let i = 0; i < ZONE_BYTES && rom.maincpu[at + i] !== 0xff; i++) {
                    indices.add(rom.maincpu[at + i]);
                }
            }
            const listed = [...indices].sort((a, b) => a - b)
                .map((i) => readPlacement(rom, map, i))
                .filter((d) => d && (d.model || d.cycle));
            for (const d of listed) {
                reached.add(d.index);
                d.set = set;
                d.zones = zonesOf.get(d.index) ?? new Set();
            }
            const draws = listed;
            if (!widest || draws.length > widest.count) widest = { set, count: draws.length };

            const sky = skyDraws(rom, g.sky);
            const objects = [...props.values()].filter((o) => o.set === set);
            placementStage(stages, lit, chapter, {
                name: `Stage ${chapter + 1} · set ${set}`,
                set,
                draws,
                objects,
                sky,
                song: g.song,
                zones: zoneViews(g.zones, zoneOrder, g.zoneSections, set),
                meta: [
                    ['texture set', set],
                    ['sections', runs(g.sections)],
                    ['zones', g.zones.size],
                    ['placements', draws.length],
                    ...(objects.length ? [['props', objects.length]] : []),
                    ['sky', sky ? `${sky.dome}${sky.spin ? ', drifting' : ', held'}` : 'off'],
                ],
            });
        }

        /*
         * The whole table, including what no zone the scripts reach draws: a
         * few pieces no zone lists at all, and a few listed only in zones no
         * script makes current.
         *
         * It spans every set the chapter loads, and texture RAM holds one set
         * at a time, so each placement carries the set it is drawn under and
         * the viewer builds the sheets and colour tables of each — one material
         * per set (see materialForSet in js/app.js). A piece no reached zone
         * lists has no set to carry, and takes the one that draws the most of
         * the chapter. It stays out of the Models tab's answer to which scene
         * draws a model, which wants the one scene a model belongs to.
         */
        const count = placementCount(rom, map);
        const table = [];
        for (let i = 0; i < count; i++) {
            const d = readPlacement(rom, map, i);
            if (!d) continue;
            d.set = setOf.get(i) ?? widest?.set;
            d.zones = zonesOf.get(i) ?? new Set();
            table.push(d);
        }
        const all = table;
        if (all.length && widest) {
            placementStage(stages, lit, chapter, {
                name: `Stage ${chapter + 1} · all placements`,
                set: widest.set,
                draws: all,
                /* The sky of the set that draws most of the chapter, since that
                 * is the set this stage is framed as. */
                sky: skyDraws(rom, groups.get(widest.set)?.sky),
                song: groups.get(widest.set)?.song,
                objects: [...props.values()],
                /* Each zone under the set loaded when it is first made
                 * current, which is the set its pieces are drawn under. */
                zones: zoneViews(zoneOrder.keys(), zoneOrder, zoneSections, null, zoneSet),
                mixedSets: true,
                meta: [
                    ['texture set', `${[...new Set(all.map((d) => d.set))].sort((a, b) => a - b).join(', ')}, per part`],
                    ['placements', table.length],
                    ...(props.size ? [['props', props.size]] : []),
                    ['in no reached zone', table.filter((d) => !reached.has(d.index)).length],
                ],
            });
        }
    }
    return stages;
}

/*
 * The draw list: every placement where it stands, which is the whole of what
 * the draw loop does besides the cull. It pushes the placement's position as a
 * translate and draws the model, with no scale and a turn for the one placement
 * the loop singles out (see `turns` in the profile). A cycling placement walks
 * its list a model a frame.
 *
 * The board turns Y by the negated angle and its Z is the viewer's reversed,
 * which leaves a board turn of +a as an ordinary Y turn of +a here.
 */
export function buildPlacementDisplayList(stage, getModel = null, mode = undefined, view = stage.view) {
    const sky = [];
    if (stage.sky) {
        const { dome, band, y, spin } = stage.sky;
        const at = (turn) => [['t', [0, y, 0]], ...(turn ? [['r', turn]] : [])];
        /* The dome first and the band over it, the order the task draws them. */
        sky.push({
            model: dome,
            layer: 'sky',
            ops: spin ? (frame) => at(((frame * spin) % 0x10000) * (360 / 0x10000)) : at(0),
        });
        sky.push({ model: band, layer: 'sky', ops: at(0) });
    }
    /* The zone picked, if one is: only what it lists, under the set it is
     * drawn with (see zoneViews). */
    const zone = /^zone:/.test(view ?? '') ? stage.zones?.[+view.slice(5)] : null;
    /* The props go in under their own layer, so they can be turned off and so
     * the camera frames on the room rather than on them. Under a zone, only
     * those still standing while it is current (see propZones). */
    const objects = (stage.objects ?? [])
        .filter((o) => !zone || !o.zones || o.zones.has(zone.zone)).map((o) => ({
        model: o.model,
        /* A prop that steps its model a frame (types 104 and 108). */
        ...(o.cycle ? { anim: { frames: o.cycle, shift: 0, phase: 0 } } : {}),
        /* Virtua Cop's clouds are objects of the sky's (js/vcop.js). */
        layer: o.layer ?? 'objects',
        set: o.set,
        /* One that carries its own transform keeps it: a part of one of
         * Virtua Cop's objects, under its parents' (js/vcop.js). */
        ops: o.ops ?? (o.spin ? (frame) => propOps(o, frame * o.spin) : propOps(o)),
        /* And its own texture points, where it has them: a car window's,
         * slid live by the camera. */
        ...(o.points ? { points: o.points } : {}),
        ...(o.live ? { live: o.live, slides: true } : {}),
        /* Out of the face layering: Virtua Cop's enemies' joints. */
        ...(o.layered === false ? { layered: false } : {}),
    }));
    /* Objects a stage builds itself, already in the draw list's own shape —
     * Daytona USA's, whose routines are in js/daytona.js. */
    const built = (stage.objectDraws?.(getModel, mode, view) ?? [])
        .map((d) => ({ layer: 'objects', set: stage.texSets?.[0], ...d }));
    /* And a course left to the camera's window keeps every block, which the
     * window then hides and shows; otherwise only the ones a car reaches. */
    const draws = stage.draws.filter((d) => (zone ? d.zones?.has(zone.zone)
        : view === 'camera' || d.reach !== false));
    return sky.concat(objects, built, draws.map((d) => ({
        model: d.cycle ? d.cycle[0] : d.model,
        /* Or a model a frame chosen its own way (Virtua Fighter 2's storm). */
        anim: d.anim ?? (d.cycle ? { frames: d.cycle, shift: 0, phase: 0 } : null),
        /* Virtua Fighter 2 sorts its pieces into layers of its own (js/vf2.js). */
        layer: d.layer ?? 'scenery',
        /* Which texture set the piece is drawn under, for a stage that spans
         * several — see the all-placements stage in readPlacementStages. */
        set: zone ? zone.set : d.set,
        /* The segments or rooms that draw it, which tell pieces the game
         * never shows together apart (see `laterZone` in js/layers.js). */
        ...(d.zones ? { zones: d.zones } : {}),
        ...(d.block != null ? { block: d.block } : {}),
        /* A draw a switch shows or hides, and one the camera picks
         * (Virtua Fighter 2's effects, js/vf2fx.js). */
        ...(d.extra ? { extra: d.extra } : {}),
        ...(d.unless ? { unless: d.unless } : {}),
        ...(d.live ? { live: d.live } : {}),
        /* A draw that carries its own transform keeps it — Virtua Cop's,
         * three turns each (js/vcop.js). */
        ops: d.ops ?? [['t', [d.pos[0], d.pos[1], -d.pos[2]]],
            ...(d.turn ? [['r', (d.turn * 360) / 0x10000]] : [])],
    })));
}
