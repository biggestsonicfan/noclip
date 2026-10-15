# tools/fbx — a fighter as an FBX file

```
node tools/fbx/export.mjs fvipers.zip --fighter Grace --motion 73 --frame 1 --out grace.fbx
```

This writes `grace.fbx` and `grace.png` beside it. The PNG is also embedded in
the FBX.

- `--fighter` takes a name from the Animation tab's list, or its index.
- `--motion` and `--frame` choose the pose. The motion ids are the ones in the
  tab's list. Without `--motion`, the parts stay on their rest offsets,
  which leaves the fighter crumpled. Fighting Vipers' motion 73, frame 1 is
  a plain standing pose.
- `--stage` chooses the stage whose material table and colour set light
  the fighter. The default is 0. Every Fighting Vipers stage has the same
  table.

The file is binary FBX 7.4, the version Blender writes. Its units are metres,
it is Y-up, and the fighter faces +Z with its feet on the floor at the
origin.

- **Mesh:** one mesh skinned to a sixteen-bone skeleton (BODY, CHEST,
  HEAD, ... RFOOT; the slots in `js/pose.js`). Each part's points are wholly
  on its slot's bone, so the model can be posed again.
- **Material:** one material with one texture.

## How it is built

- **Pose:** `poseFighter` (`js/vf2fighters.js`) places the parts, the same
  call the Animation tab makes. The motion is played from frame 1 up to the
  frame asked for, so the head turn and the blend settle as they do in the
  viewer.
- **Colour:** it is baked, not left to a shader. Each run of faces that
  share a tile, luma base, palette colour and material brightness gets its
  own block in the atlas. Each block is put through the viewer's own lookup:
  luma RAM, then the colour tables, then the output curve. The faces are
  lit flat (`luminance` 1), so the shading is up to whatever renders the
  file.
- **Transparency:** texel 15 on a transparent face comes out with alpha 0.
  Checker faces get alpha 128.
- **Decals:** a polygon drawn again on top of its own surface (a logo, a
  stripe) is lifted 0.5 mm along its normal for each layer. This stops
  z-fighting.
- **Two-sided faces:** faces the board draws from both sides (flag 0x80)
  are written once. Turn backface culling off where they matter.

Checked with three.js's `FBXLoader`, against the Animation tab's render of
the same motion, and with `assimp info`: 1 mesh, 2460 faces, 16 bones, the
texture embedded. It has not been opened in Blender here.
