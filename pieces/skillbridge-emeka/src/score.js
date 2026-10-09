  // SCORE BODY — sound effects only (to = 's'): the music is the user's Ai33 track, the voice is the Ai33 voice-over.
  // The picture's sound moments: clock ticks, a blip per n8n node and sheet row, a chime on the link, the payoff hit at 29.5.
  const T = TIMELINE, cu = T.cues;
  to = 's';
  for (let t = 1.5; t < 11.5; t += 1.0) noiseHit(t, 0.03, 'bandpass', 3000, 3, 0.16, 0);                                // the clock tick
  [cu.wire1, cu.wire2, cu.wire3].forEach((t) => blip(t - 0.5, 600, 1200, 0.12, 0.16));
  for (let r = 0; r < 5; r++) blip(cu.row + r * 0.5, 900, 1500, 0.08, 0.14);
  chime(cu.link, [nz('D5'), nz('A5')], 0.1);
  chime(29.5, [nz('D5'), nz('Fs5'), nz('A5')], 0.16); sub(29.5, 0.55);                                                   // the payoff, in the pause before "I saved"
  sweep(28.9, 29.45, 0.012, 600, 3200, 0);
  chime(38.8, [nz('D5'), nz('A5')], 0.08);
