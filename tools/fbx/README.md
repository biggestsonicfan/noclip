# tools/fbx — a fighter as an FBX file

```
node tools/fbx/export.mjs fvipers.zip --fighter Grace --motion 192 --frame 1 --out grace.fbx
```

This writes `grace.fbx` and `grace.png` beside it. The PNG is also embedded in
the FBX.

- `--fighter` takes a name from the Animation tab's list, or its index.
- `--motion` and `--frame` choose the pose. The motion ids are the ones in the
  tab's list. Without `--motion`, the parts stay on their rest offsets,
  which leaves the fighter crumpled. Fighting Vipers' motion 192, frame 1 is
  an upright fighting stance. Motion 73 stands too, but with the head bowed.
- `--stage` chooses the stage whose material table and colour set light
  the fighter. The default is 0. Every Fighting Vipers stage has the same
  table.

The file is binary FBX 7.4, the version Blender writes. Its units are metres,
it is Y-up, and the fighter faces +Z with its feet on the floor at the
origin.

- **Mesh:** one mesh skinned to a sixteen-bone skeleton (BODY, CHEST,
  HEAD, ... RFOOT; the slots in `js/pose.js`). Each part's points are wholly
  on its slot's bone, so the model can be posed again. L and R are the
  fighter's own left and right. `js/pose.js` names them the other way
  round, as the viewer sees them.
- **Bone directions:** the game's part frames point their axes wherever
  the art was modelled. Each bone gets a rest frame at the same pivot whose
  Y axis (Blender's bone axis) runs to its child. A bone with no child (head,
  hands, feet, chain ends) runs along its part and gets an unskinned
  `_end` bone at its tip, so that Blender draws it the length of its part.
- **Sway chains:** hair and earrings that swing (`js/osage.js`; Grace's
  dreadlocks and earrings) get a bone per segment, named after the bone they
  hang from: `HEAD_SWAY1_1` and so on.
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
- **Normals:** the model's normals point into the body. The file turns
  them round, so they point out and the faces are wound to match.
- **Hip armour:** Fighting Vipers draws more in the hip frame after slot 9
  (`rob_disp` at 0x19F10): a piece from the character record, and for
  characters 0, 1, 13 and 14 (Grace among them) four skirt plates, from
  the list at 0x6421DE0. These are skinned to PELVIS.
- **Two-sided faces:** faces the board draws from both sides (flag 0x80)
  are written once. Turn backface culling off where they matter.

Checked with three.js's `FBXLoader`, with `assimp info`, and in Blender 4.0
(File > Import > FBX, default settings), against MAME's render of Grace:
1 mesh, 2600 faces, an armature of 19 bones plus the `_end` bones, the
texture embedded and linked to the material, with its alpha.
