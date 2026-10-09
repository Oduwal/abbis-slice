// Hard cuts only (BRIDGES = []); each shot's framing is a camera on its scene.
const ERA_BG = ERA_LIST.map((_, i) => ['#26315f', '#26315f', '#cfe2ee', '#e3b04b', '#141c40', '#26315f', '#f6cf55', '#a9d9c6', '#3f9f9a'][i]);
const CAMS = {
  wide: null,
  close: { z: 1.5, p: [500, 900], to: [500, 900] },
};
function pieceCam(era, t) { const c = CAMS[SHOT_LIST[era][2]]; return c ? camOf(c) : null; }
const BRIDGES = [];
