#!/bin/sh
# Build the sound boards' wasm:
#   js/sound/board.wasm   the Model 2 board, board.c over m2-hle2's sound board
#   js/sound/model1.wasm  the Model 1 board, model1.c and model1_chips.cpp over
#                         m2-hle2's 68000 and MAME's MultiPCM and ymfm
#
#   M2HLE2=../m2-hle2 MAME=../claude_mame/mame EMCC=emcc tools/sound/build.sh [model2|model1]
#
# The wasm is committed: the site has no build step, and the deploy copies js/
# as it is. Rebuild board.wasm when m2-hle2's src/board/sound.h, scsp.h or
# m68k*.h change, model1.wasm when m68k*.h or ymfm change, and say which
# commits it was built from in the commit message.
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
m2=${M2HLE2:-$root/../m2-hle2}
mame=${MAME:-$root/../claude_mame/mame}
emcc=${EMCC:-emcc}
src=$m2/src
exports=_snd_alloc,_snd_init,_snd_send,_snd_render,_snd_out
which=${1:-all}

if [ "$which" = all ] || [ "$which" = model2 ]; then
"$emcc" -O3 -flto -DNDEBUG \
    -I"$src/board" -I"$src/core" -I"$src/profiles" -I"$src" \
    -sSTANDALONE_WASM --no-entry \
    -sEXPORTED_FUNCTIONS=$exports \
    -sINITIAL_MEMORY=20mb -sALLOW_MEMORY_GROWTH=1 \
    -sFILESYSTEM=0 \
    -o "$root/js/sound/board.wasm" "$here/board.c"
echo "built js/sound/board.wasm from m2-hle2 $(git -C "$m2" rev-parse --short HEAD)"
fi

if [ "$which" = all ] || [ "$which" = model1 ]; then
ymfm=$mame/3rdparty/ymfm/src
em=$(dirname "$emcc")
tmp=$(mktemp -d)
"$emcc" -O3 -flto -DNDEBUG -I"$src/board" -I"$src/core" -c "$here/model1.c" -o "$tmp/model1.o"
for f in "$here/model1_chips.cpp" "$ymfm/ymfm_opn.cpp" "$ymfm/ymfm_adpcm.cpp" "$ymfm/ymfm_ssg.cpp"; do
    "$em/em++" -O3 -flto -DNDEBUG -std=c++17 -fno-exceptions -fno-rtti -I"$ymfm" -c "$f" -o "$tmp/$(basename "$f").o"
done
"$em/em++" -O3 -flto \
    -sSTANDALONE_WASM --no-entry \
    -sEXPORTED_FUNCTIONS=$exports,_snd_rate \
    -sINITIAL_MEMORY=20mb -sALLOW_MEMORY_GROWTH=1 \
    -sFILESYSTEM=0 \
    -o "$root/js/sound/model1.wasm" "$tmp"/*.o
rm "$tmp"/*.o
rmdir "$tmp"
echo "built js/sound/model1.wasm from m2-hle2 $(git -C "$m2" rev-parse --short HEAD), MAME $(git -C "$mame" rev-parse --short HEAD)"
fi
