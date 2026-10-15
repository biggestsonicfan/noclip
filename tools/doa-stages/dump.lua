-- Dead or Alive (doab): dump the board's RAM 300, 301 and 600 frames into each
-- stage of the attract, for grade.mjs. On the shared MAME build:
--
--   M2_GEO_SHARC_OFF=1 DOA_DUMP=/dev/shm/doa mame doab -rompath ROMS \
--       -video none -sound none -nothrottle -seconds_to_run 560 \
--       -autoboot_script tools/doa-stages/dump.lua
--
-- M2_GEO_SHARC_OFF keeps the real geometry SHARC halted (it stops the attract
-- about 95 seconds in otherwise). The attract plays stages 1 4 3 2 1 5 3 8;
-- DOA_SWAP="1=0,4=11" plays stage 0 for the first 1 and 11 for the first 4
-- (and "4=10,3=6,2=7" the rest; 9 is not reached in 560 seconds).
local sp = manager.machine.devices[":maincpu"].spaces["program"]
local dir = os.getenv("DOA_DUMP") or "."
local swap = {}
for a, b in (os.getenv("DOA_SWAP") or ""):gmatch("(%d+)=(%d+)") do swap[tonumber(a)] = tonumber(b) end
local STAGE, CLOCK = 0x5555be, 0x54b158
local marks = { [300] = true, [301] = true, [600] = true }
local n, last, start, done = 0, -1, 0, {}
local booted = false   -- the stage byte is 0 through boot

emu.register_frame_done(function()
  n = n + 1
  local s = sp:read_u8(STAGE)
  if s ~= last then
    -- before the round start (about 60 frames in) runs the stage's setup
    local to = swap[s]
    if to then swap[s] = nil; sp:write_u8(STAGE, to); s = to end
    last, start = s, n
  end
  booted = booted or s == 255
  local k = n - start + 1
  if not booted or s == 255 or done[s] or not marks[k] then return end
  local t = {}
  for a = 0x500000, 0x5ffffc, 4 do t[#t + 1] = string.pack("<I4", sp:read_u32(a)) end
  local f = io.open(string.format("%s/s%d_k%d_c%x.bin", dir, s, k, sp:read_u32(CLOCK)), "wb")
  f:write(table.concat(t))
  f:close()
  if k == 600 then done[s] = true end
end)
