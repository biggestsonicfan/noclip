#!/bin/sh
# Build js/sound/board.wasm from board.c and m2-hle2's sound board.
#
#   M2HLE2=../m2-hle2 EMCC=emcc tools/sound/build.sh
#
# The wasm is committed: the site has no build step, and the deploy copies js/
# as it is. Rebuild it when m2-hle2's src/board/sound.h, scsp.h or m68k*.h
# change, and say which m2-hle2 commit it was built from in the commit message.
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
m2=${M2HLE2:-$root/../m2-hle2}
emcc=${EMCC:-emcc}
src=$m2/src
"$emcc" -O3 -flto -DNDEBUG \
    -I"$src/board" -I"$src/core" -I"$src/profiles" -I"$src" \
    -sSTANDALONE_WASM --no-entry \
    -sEXPORTED_FUNCTIONS=_snd_alloc,_snd_init,_snd_send,_snd_render,_snd_out \
    -sINITIAL_MEMORY=20mb -sALLOW_MEMORY_GROWTH=1 \
    -sFILESYSTEM=0 \
    -o "$root/js/sound/board.wasm" "$here/board.c"
echo "built js/sound/board.wasm from m2-hle2 $(git -C "$m2" rev-parse --short HEAD)"
