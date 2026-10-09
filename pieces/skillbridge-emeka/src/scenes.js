// =====================================================================
//  SCENES — SkillBridge Academy / Emeka. World 1080x1920. Orange (the spark) is reserved for the automation.
//  Emeka (skin3, blue shirt) is the constant the eye holds. Before the automation: navy night, grind.
//  After: warm daytime colours.
// =====================================================================
const WA = '#2fa866', WAL = '#d9f2d0', SHEET = '#3f9f6a';
const EM = { skin: PAL.skin3, shirt: PAL.blue, hair: '#1f1814' };

function phone(x, y, w, h, key, o = {}) {
  const dx = o.buzz ? Math.sin(B * 2.6) * 5 : 0, dy = o.buzz ? Math.cos(B * 3.1) * 3 : 0;
  ctx.save(); ctx.translate(x + dx, y + dy); if (o.rot) ctx.rotate(o.rot);
  cut(rect(-w / 2, -h / 2, w, h, 26), '#2d2a33', { key: key + 'b' });
  cut(rect(-w / 2 + 14, -h / 2 + 22, w - 28, h - 44, 12), o.screen ?? '#eef4ee', { key: key + 's', shadow: false, tear: 0.4 });
  ctx.restore();
}
function receipts(n, x0, y0, key) {
  const R = RNG(key);
  for (let i = 0; i < n; i++) {
    const x = x0 + R.n(40), y = y0 - i * 22, w = 150 + R.r(0, 40), h = 190;
    const P = rot(rect(x - w / 2, y - h, w, h, 3), x, y - h / 2, R.n(0.18));
    cut(P, PAL.paper, { key: key + i, sb: 5, sy: 3, pat: pat.lines('rgba(42,29,24,0.35)', 22, 30) });
  }
}
const rotP = (P, cx, cy, a) => rot(P, cx, cy, a);
function bubble(x, y, w, h, str, mine, size, key, k = 1) {
  if (k <= 0.01) return;
  ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
  cut(rect(-w / 2, -h / 2, w, h, 26), mine ? WAL : '#ffffff', { key: key + 'b', sb: 6, sy: 4 });
  handText(str, -w / 2 + 26, size * 0.35, size, PAL.ink, { key: key + 't' });
  ctx.restore();
}
function zzz(x, y) { for (let i = 0; i < 3; i++) { const k = ((TT * 0.5 + i / 3) % 1); handText('z', x + k * 50, y - k * 110 - i * 14, 40 + i * 14, 'rgba(255,255,255,' + (1 - k).toFixed(2) + ')', { key: 'z' + i }); } }

// ---- 1-2: the grind (late = the 2 AM close-up)
function sceneDesk(late) {
  cut(rect(-30, -30, W + 60, H + 60, 0), PAL.navy, { key: 'wallN', shadow: false, tear: 0, shade: false, pat: pat.dots('rgba(255,230,180,0.10)', 4, 70) });
  cut(rect(640, 300, 300, 340, 6), PAL.woodD, { key: 'win' });
  cut(rect(662, 322, 256, 296, 2), PAL.night, { key: 'glass', shadow: false, pat: (bb) => { const R = RNG('stars'); for (let i = 0; i < 24; i++) sparkle(R.r(bb.x0, bb.x1), R.r(bb.y0, bb.y1), R.r(3, 7) * (0.6 + 0.4 * ((B + i) % 2))); } });
  cut(ellipsePts(840, 440, 34, 34, 0, 30), '#f6ecc8', { key: 'moon' });
  clock(220, 440, 100, late ? 2 : 11, late ? 10 + Math.floor(TT) : 40 + Math.floor(TT * 2) % 15, 'clk');
  cat(800, 690, 0.8, PAL.charcoal, 'catN');
  const mood = late ? 'sad' : 'focus';
  person(500, 1000, 1.3, { ...EM, mood, key: 'em' });
  if (late && Math.floor(TT * 1.5) % 4 === 3) { zzz(470, 700); }
  cut(rect(-30, 1180, W + 60, 900, 0), PAL.wood, { key: 'desk', tear: 0, pat: pat.grainWood('rgba(120,60,20,0.18)'), sy: -6 });
  const n = Math.min(12, 3 + Math.floor((TT - (late ? 0 : 0)) * (late ? 0.5 : 1.5)) + (late ? 8 : 0));
  receipts(Math.min(n, 12), 170, 1330, 'rcL'); receipts(Math.min(n, 12), 880, 1350, 'rcR');
  phone(500, 1290, 230, 330, 'ph', { buzz: TT > TIMELINE.cues.buzz && Math.floor(TT * 2) % 2 === 0, rot: -0.05 });
  mug(300, 1260, 0.7, PAL.yellow, 'mugN');
  // typing hands
  hand(430, 1250, 0.55, -0.25, PAL.skin3, PAL.blue, { key: 'hl' }); hand(580, 1250, 0.55, Math.PI + 0.25, PAL.skin3, PAL.blue, { key: 'hr' });
  capStrip(late ? 'exhausted.' : '3 hours. Every night.');
  if (!late) yearTag('11 PM'); else yearTag('2 AM');
}

// ---- 3: the academy
function sceneAcademy() {
  cut(rect(-30, -30, W + 60, H + 60, 0), PAL.sky, { key: 'wallA', shadow: false, tear: 0, shade: false, pat: pat.stripes('rgba(255,255,255,0.35)', 36, 90) });
  [[220, 360], [760, 300]].forEach(([x, y], i) => cut(ellipsePts(x + Math.sin(TT + i) * 12, y, 90, 34, 0, 20), '#ffffff', { key: 'cl' + i, sb: 6 }));
  cut(rect(-30, 1280, W + 60, 700, 0), PAL.green, { key: 'grA', tear: 0, sy: -4 });
  const s = popS(TIMELINE.cues.enroll);
  person(380, 1040, 1.15, { ...EM, mood: 'happy', key: 'emA' });
  ctx.save(); ctx.translate(690, 880); ctx.rotate(-0.05); ctx.scale(Math.max(0.01, s), Math.max(0.01, s));
  cut(rect(-190, -230, 380, 460, 14), PAL.paper, { key: 'card', sb: 14, sy: 9, pat: pat.lines('rgba(42,29,24,0.18)', 40, 80) });
  cut(rect(-190, -230, 380, 90, 10), PAL.teal, { key: 'cardH', shadow: false });
  handText('SkillBridge', -150, -158, 54, '#fff', { key: 'sb1', weight: 700 });
  handText('Academy', -150, -40, 58, PAL.ink, { key: 'sb2', weight: 700 });
  handText('ENROLLED', -150, 70, 38, PAL.greenD, { key: 'sb3', weight: 700 });
  ink(arcPts(0, 160, 38, Math.PI * 1.05, Math.PI * 1.95, 12), { w: 8, color: PAL.greenD, key: 'chk' });
  ctx.restore();
  for (let i = 0; i < 6; i++) sparkle(120 + i * 150, 560 + (i % 2) * 90 + Math.sin(TT * 2 + i) * 8, 10 + (i % 3) * 4, '#fff8dc');
  plant(160, 1380, 1, PAL.blue, 'plA'); books(860, 1380, 1, 'bkA');
  capStrip('Then I enrolled.');
}

// ---- 4: the wiring (n8n): OpenAI -> WhatsApp -> Google Sheets, the orange spark carries the signal
function sceneFlow() {
  cut(rect(-30, -30, W + 60, H + 60, 0), PAL.mustard, { key: 'wallF', shadow: false, tear: 0, shade: false, pat: pat.gingham('rgba(255,255,255,0.14)', 28) });
  const nodes = [['OpenAI', 250, 640, PAL.mint, TIMELINE.cues.wire1], ['WhatsApp', 540, 900, WAL, TIMELINE.cues.wire2], ['Sheets', 790, 1160, '#bfe6c8', TIMELINE.cues.wire3]];
  for (let i = 0; i < 2; i++) {
    const [, x0, y0, , t0] = nodes[i], [, x1, y1, , t1] = nodes[i + 1], k = ev(t1 - 0.5, 0.5);
    if (k > 0) ink([[x0, y0], [x0 + (x1 - x0) * k, y0 + (y1 - y0) * k]], { w: 10, color: PAL.ink, key: 'wire' + i });
  }
  nodes.forEach(([name, x, y, c, t0], i) => {
    const k = popS(t0 - 0.5); if (k <= 0.01) return;
    ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
    cut(rect(-110, -90, 220, 180, 34), c, { key: 'nd' + i, sb: 12, sy: 8, crayon: 'rgba(42,29,24,0.2)' });
    tag(name, 0, 130, 48, { fill: PAL.paper, tape: false, rot: i % 2 ? 0.03 : -0.03 });
    ctx.restore();
  });
  // the spark rides the wires once all three are in
  const run = ev(TIMELINE.cues.wire3 + 0.3, 1.2);
  if (run > 0) {
    const seg = run * 2, i = Math.min(1, Math.floor(seg)), f = seg - i;
    const [, ax, ay] = nodes[i], [, bx, by] = nodes[i + 1];
    spark(ax + (bx - ax) * f, ay + (by - ay) * f - 10, 58, { rays: 8, mood: 'wow', key: 'sparkF' });
  }
  person(200, 1140, 0.8, { ...EM, mood: 'happy', key: 'emF' });
  capStrip('n8n connects it all.');
}

// ---- 5: the 2 AM order lands, the sheet fills
function sceneChat() {
  cut(rect(-30, -30, W + 60, H + 60, 0), PAL.night, { key: 'wallC', shadow: false, tear: 0, shade: false, pat: pat.dots('rgba(255,230,180,0.10)', 4, 70) });
  clock(190, 420, 90, 2, 0, 'clkC');
  phone(300, 940, 380, 780, 'phC', { screen: '#e9f3e6' });
  cut(rect(130, 590, 340, 70, 8), WA, { key: 'waH', shadow: false });
  handText('Customer', 150, 640, 38, '#fff', { key: 'waT' });
  bubble(300, 790, 300, 150, 'Order: 2 bags', false, 36, 'b1', popS(TIMELINE.cues.order));
  bubble(300, 1010, 300, 110, 'logged', true, 40, 'b2', popS(TIMELINE.cues.order + 0.9));
  // the sheet
  cut(rect(560, 620, 400, 640, 10), PAL.paper, { key: 'sheet', sb: 12, sy: 8 });
  cut(rect(560, 620, 400, 70, 10), SHEET, { key: 'sheetH', shadow: false });
  handText('Orders', 580, 668, 40, '#fff', { key: 'shT' });
  for (let r = 0; r < 5; r++) {
    const y = 720 + r * 100, k = ev(TIMELINE.cues.row + r * 0.5, 0.35);
    ink([[570, y + 80], [950, y + 80]], { w: 3, color: 'rgba(42,29,24,0.35)', key: 'sl' + r });
    if (k > 0) { cut(rect(580, y + 8, 120 * k, 54, 6), PAL.mint, { key: 'c1' + r, shadow: false }); cut(rect(730, y + 8, 200 * k, 54, 6), PAL.yellow, { key: 'c2' + r, shadow: false }); }
  }
  spark(790, 1420, 70, { rays: 8, mood: 'focus', key: 'sparkC' });
  capStrip('2 AM order. Logged.');
}

// ---- 6: the Paystack link goes out; Emeka sleeps (near silence)
function scenePay() {
  cut(rect(-30, -30, W + 60, H + 60, 0), PAL.navy, { key: 'wallP', shadow: false, tear: 0, shade: false, pat: pat.dots('rgba(255,230,180,0.10)', 4, 70) });
  cut(ellipsePts(840, 380, 60, 60, 0, 30), '#f6ecc8', { key: 'moonP' });
  for (let i = 0; i < 14; i++) { const R = RNG('sP', i); sparkle(R.r(80, 900), R.r(300, 700), R.r(3, 8) * (0.6 + 0.4 * ((B + i) % 2))); }
  cut(rect(160, 520, 760, 120, 40), WAL, { key: 'lk', sb: 10, sy: 6 });
  handText('paystack.com/pay/your-order', 190, 600, 42, PAL.ink, { key: 'lkT' });
  const p = popS(TIMELINE.cues.link);
  ctx.save(); ctx.translate(540, 790); ctx.scale(Math.max(0.01, p), Math.max(0.01, p));
  cut(rect(-190, -60, 380, 120, 60), PAL.teal, { key: 'pay', sb: 12, sy: 8 });
  handText('Pay now', -110, 18, 54, '#fff', { key: 'payT', weight: 700 });
  ctx.restore();
  cut(rect(-30, 1260, W + 60, 700, 0), PAL.wood, { key: 'bedP', tear: 0 });
  person(480, 1190, 1.0, { ...EM, mood: 'focus', key: 'emP' });
  cut(rect(180, 1230, 600, 300, 60), PAL.purple, { key: 'blk', pat: pat.stripes('rgba(255,255,255,0.18)', 22, 60) });
  zzz(640, 1010);
  capStrip('Paystack link. Sent.');
}

// ---- 7: the payoff: daylight, 3 hours back, sales up
function sceneMarket() {
  cut(rect(-30, -30, W + 60, H + 60, 0), PAL.yellow, { key: 'wallM', shadow: false, tear: 0, shade: false, pat: pat.stripes('rgba(255,255,255,0.20)', 30, 80) });
  cut(ellipsePts(800, 380, 80, 80, 0, 36), '#fff2a8', { key: 'sunM', crayon: '#e6b23a' });
  [[200, 340], [480, 280]].forEach(([x, y], i) => cut(ellipsePts(x + Math.sin(TT + i) * 10, y, 70, 28, 0, 20), '#ffffff', { key: 'cM' + i, sb: 6 }));
  cut(rect(130, 540, 820, 70, 6), PAL.orange, { key: 'awn', pat: pat.stripes('rgba(255,255,255,0.5)', 38, 76), sy: 8 });
  cut(rect(-30, 1260, W + 60, 700, 0), PAL.woodL, { key: 'flM', tear: 0, pat: pat.grainWood('rgba(120,60,20,0.18)') });
  person(300, 980, 1.15, { ...EM, mood: 'happy', key: 'emM' });
  // sales bars rise
  const bars = [0.35, 0.5, 0.65, 0.85, 1.0];
  bars.forEach((v, i) => { const k = ev(TIMELINE.cues.bars + i * 0.35, 0.5) * v; cut(rect(560 + i * 70, 1320 - 360 * k, 54, 360 * k + 4, 3), [PAL.teal, PAL.green][i % 2], { key: 'br' + i, sb: 5 }); });
  tag('-3 hrs / day', 760, 700, 62, { fill: PAL.paper, rot: 0.04, s: popS(TIMELINE.cues.tick) });
  mug(120, 1390, 0.8, PAL.pink, 'mugM');
  capStrip('3 hours saved. Daily.');
}

// ---- 8: other vendors get automations
function sceneVendors() {
  cut(rect(-30, -30, W + 60, H + 60, 0), PAL.mint, { key: 'wallV', shadow: false, tear: 0, shade: false, pat: pat.gingham('rgba(255,255,255,0.20)', 30) });
  const cols = [PAL.pink, PAL.purple, PAL.blue, PAL.teal];
  for (let i = 0; i < 4; i++) {
    const x = 70 + i * 220, on = TT > TIMELINE.cues.vend + i * 2.0, y = 600 + (i % 2) * 90;
    cut(rect(x, y, 190, 360, 8), PAL.paper, { key: 'st' + i, sb: 8, pat: pat.lines('rgba(42,29,24,0.14)', 30, 40) });
    cut(rect(x - 8, y - 70, 206, 74, 4), cols[i], { key: 'stA' + i, pat: pat.stripes('rgba(255,255,255,0.4)', 22, 44), sy: 6 });
    if (on) { const k = popS(TIMELINE.cues.vend + i * 2.0); spark(x + 95, y + 190, 54 * k, { rays: 8, mood: 'happy', key: 'spV' + i }); }
  }
  person(540, 1190, 0.7, { ...EM, mood: 'happy', key: 'emV' });
  tag('N80,000 / setup', 540, 400, 64, { fill: PAL.paper, rot: -0.03, s: popS(TIMELINE.cues.vend + 6.5) });
  capStrip('Setting up other vendors.');
}

// ---- 9: goodbye
function sceneEnd() {
  cut(rect(-30, -30, W + 60, H + 60, 0), PAL.teal, { key: 'wallE', shadow: false, tear: 0, shade: false, pat: pat.dots('rgba(255,255,255,0.14)', 5, 64) });
  person(540, 960, 1.4, { ...EM, mood: 'happy', key: 'emE' });
  spark(840, 560, 90, { rays: 10, mood: 'happy', key: 'spE' });
  tag('SkillBridge Academy', 540, 460, 72, { fill: PAL.paper, rot: -0.03, s: popS(40.2) });
  for (let i = 0; i < 14; i++) { const R = RNG('conf', i), k = ((TT - 40) * 0.22 + R.f()) % 1, cx = R.r(80, 1000) + Math.sin(TT * 2 + i) * 20, cy = 250 + k * 1150; cut(rotP(rect(cx - 12, cy - 8, 24, 16, 2), cx, cy, TT * 3 + i), [PAL.pink, PAL.yellow, PAL.mint, PAL.purple][i % 4], { key: 'cfT' + i, shadow: false, tear: 0.3 }); }
  for (let i = 0; i < 10; i++) { const R = RNG('cf', i); sparkle(R.r(80, 960), R.r(300, 900) + Math.sin(TT * 2 + i) * 10, R.r(6, 14), '#fff8dc'); }
  capStrip('It transformed my business.');
}
