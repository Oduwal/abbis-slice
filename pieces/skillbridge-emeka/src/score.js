  // SCORE BODY — SkillBridge / Emeka. Thin and tired -> lift at the academy -> blips -> near silence -> the loudest hit at 25.0 -> arpeggio -> resolve.
  const T = TIMELINE, cu = T.cues;
  to = 'm';
  pad(0.0, 10.0, ['D2', 'A2'], 0.025, { type: 'triangle', cut: 500, att: 1, rel: 0.5 });
  for (let t = 0.5; t < 10; t += 1.0) noiseHit(t, 0.03, 'bandpass', 3000, 3, 0.18, 0);                       // the clock tick
  pad(10.0, 22.5, ['D3', 'A3', 'Fs4', 'B3'], 0.04, { cut: 1400, att: 0.4, rel: 0.4, send: 0.3 });
  for (let b = 10.0; b < 22.0; b += 0.5) pluck(b, nz(['D4', 'Fs4', 'A4', 'B4'][Math.round(b * 2) % 4]), 0.12, 0, 0.3, 2800, 0.2);
  to = 's';
  [cu.wire1, cu.wire2, cu.wire3].forEach((t) => blip(t - 0.5, 600, 1200, 0.12, 0.16));
  for (let r = 0; r < 5; r++) blip(cu.row + r * 0.5, 900, 1500, 0.08, 0.14);
  chime(cu.link, [nz('D5'), nz('A5')], 0.1);
  to = 'm';
  // 23.5 -> 25.0: nothing but room tone (the silence), then the stab
  chime(25.0, [nz('D5'), nz('Fs5'), nz('A5')], 0.14); sub(25.0, 0.55);
  pad(25.05, 40.0, ['D3', 'A3', 'D4', 'Fs4'], 0.045, { cut: 1400, att: 0.25, rel: 0.4, send: 0.4 });
  for (let b = 32.0; b < 40.0; b += 0.5) pluck(b, nz(['D4', 'Fs4', 'A4', 'D5'][Math.round(b * 2) % 4]), 0.12, 0, 0.3, 3000, 0.25);
  chime(40.0, [nz('D5'), nz('A5')], 0.1);
  pad(40.0, 45.05, ['D3', 'A3', 'Fs4'], 0.035, { cut: 1100, att: 0.4, rel: 0.6, send: 0.4 });
