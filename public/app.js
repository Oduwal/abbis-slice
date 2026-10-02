// ABBIS slice dashboard. Plain JS, no build step, so it runs on any device and
// keeps working on a bad connection: reads fall back to the last good copy,
// writes go to a local outbox with a client-generated id and are replayed
// (idempotently) when the network returns.

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const store = {
  get(k, fallback = null) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* storage unavailable: run without persistence */
    }
  },
};

const state = {
  cfg: null,
  users: [],
  token: store.get('token'),
  user: store.get('user'),
  sites: [],
  component: 'RBC',
  lang: store.get('lang', 'en'),
};

// ---------- network ----------

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (err) {
    setOnline(false);
    if (method === 'GET') {
      const cached = store.get('cache:' + path);
      if (cached) return { ...cached, __stale: true };
    }
    throw Object.assign(new Error('offline'), { offline: true });
  }
  setOnline(true);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  if (method === 'GET' && data && typeof data === 'object' && !Array.isArray(data)) store.set('cache:' + path, data);
  if (method === 'GET' && Array.isArray(data)) store.set('cache:' + path, { list: data });
  return data;
}

const list = (d) => (Array.isArray(d) ? d : d.list || []);

function setOnline(on) {
  const el = $('#net');
  el.textContent = on ? 'online' : 'offline';
  el.classList.toggle('off', !on);
  $('#banner').classList.toggle('hidden', on);
  if (!on) $('#banner').textContent = t('offline');
}

// ---------- outbox ----------

function outbox() {
  return store.get('outbox', []);
}
function setOutbox(items) {
  store.set('outbox', items);
  const el = $('#outbox');
  el.classList.toggle('hidden', !items.length);
  el.classList.add('queue');
  el.textContent = `${items.length} queued`;
}

async function flushOutbox() {
  const items = outbox();
  if (!items.length) return;
  const left = [];
  for (const item of items) {
    try {
      await api('/api/events', { method: 'POST', body: item });
    } catch (err) {
      if (err.offline) left.push(item);
      else console.warn('dropped invalid queued event', item, err.message); // server refused it: keep a record in the console
    }
  }
  setOutbox(left);
}

window.addEventListener('online', flushOutbox);
setInterval(flushOutbox, 15000);

// ---------- i18n ----------

function t(key) {
  return state.cfg?.locales?.[state.lang]?.[key] ?? state.cfg?.locales?.en?.[key] ?? key;
}
function applyLang() {
  document.documentElement.lang = state.lang;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
}

// ---------- tabs ----------

const loaders = {};
function showTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const s of document.querySelectorAll('.tab')) s.classList.toggle('active', s.id === 'tab-' + name);
  store.set('tab', name);
  loaders[name]?.();
}
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));

const siteName = (id) => state.sites.find((s) => s.id === id)?.name ?? id;

// ---------- inventory ----------

loaders.inventory = async () => {
  const data = await api('/api/inventory').catch(showError);
  if (!data) return;
  const comp = state.component;
  const groups = state.cfg.bloodGroups;
  const assess = new Map(data.assessments.map((a) => [`${a.siteId}|${a.component}|${a.bloodGroup}`, a]));
  const counts = new Map();
  for (const r of data.summary) {
    if (r.status !== 'available') continue;
    counts.set(`${r.siteId}|${r.component}|${r.bloodGroup}`, r.n);
  }
  let html = `<thead><tr><th>Site</th>${groups.map((g) => `<th>${esc(g)}</th>`).join('')}</tr></thead><tbody>`;
  for (const s of state.sites) {
    html += `<tr><td>${esc(s.name)}<br><small class="muted">${s.type === 'blood_centre' ? 'blood centre' : 'hospital'}</small></td>`;
    for (const g of groups) {
      const k = `${s.id}|${comp}|${g}`;
      const a = assess.get(k);
      const n = counts.get(k) ?? 0;
      if (!a) {
        html += `<td class="st-none"><b>${n}</b><small>${s.type === 'blood_centre' ? 'supply' : ''}</small></td>`;
        continue;
      }
      const cover = a.daysOfCover === null ? '–' : `${a.daysOfCover}d`;
      html += `<td class="cell st-${a.status}" data-site="${esc(s.id)}" data-group="${esc(g)}" title="${esc(a.forecast.reason)}">
        <b>${a.available}${a.incoming ? `<small> +${a.incoming}</small>` : ''}</b><small>${cover}${a.atRisk.length ? ` · ${a.atRisk.length} exp.` : ''}</small></td>`;
    }
    html += '</tr>';
  }
  $('#invTable').innerHTML = html + '</tbody>';
  for (const td of document.querySelectorAll('#invTable td.cell'))
    td.addEventListener('click', () => {
      $('#fSite').value = td.dataset.site;
      $('#fGroup').value = td.dataset.group;
      $('#fComp').value = comp;
      showTab('forecast');
    });
};

function renderCompSeg() {
  $('#compSeg').innerHTML = Object.entries(state.cfg.components)
    .map(([k, v]) => `<button data-c="${k}" class="${k === state.component ? 'active' : ''}">${esc(v.label)}</button>`)
    .join('');
  for (const b of document.querySelectorAll('#compSeg button'))
    b.addEventListener('click', () => {
      state.component = b.dataset.c;
      renderCompSeg();
      loaders.inventory();
    });
}

// ---------- advisor ----------

loaders.advisor = async () => {
  const [adv, mon] = await Promise.all([api('/api/advisor'), api('/api/ai/monitor')]).catch(showError) ?? [];
  if (!adv) return;
  $('#advAsOf').textContent = `as of ${new Date(adv.asOf).toLocaleString()}${adv.__stale ? ' (cached)' : ''}`;
  const bt = mon.backtest;
  $('#monitor').innerHTML = [
    ['Series forecast', mon.series, `${mon.models.holt_winters ?? 0} Holt-Winters · ${mon.models.moving_average ?? 0} average`],
    ['Beat "same day last week"', bt.share_beating_naive === null ? '–' : `${Math.round(bt.share_beating_naive * 100)}%`, 'of series, on a 14-day holdout'],
    ['Confidence', `${mon.confidence.high ?? 0} / ${mon.confidence.medium ?? 0} / ${mon.confidence.low ?? 0}`, 'high / medium / low'],
    ['Decisions', `${mon.decisions.approved ?? 0} ✓ ${mon.decisions.rejected ?? 0} ✗`, `${mon.decisions.open ?? 0} open`],
  ]
    .map(([k, v, s]) => `<div class="stat"><small>${esc(k)}</small><b>${esc(v)}</b><small>${esc(s)}</small></div>`)
    .join('');

  const canDecide = (s) => state.user && (state.user.role === 'admin' || (state.user.role === 'inventory_officer' && state.user.siteId === s.fromSiteId));
  const rankConf = { high: 0, medium: 1, low: 2 };
  const sorted = [...adv.suggestions].sort(
    (a, b) =>
      (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) ||
      b.dins.length - a.dins.length ||
      rankConf[a.confidence] - rankConf[b.confidence],
  );
  $('#suggestions').innerHTML =
    sorted
      .map(
        (s) => `<article class="card ${s.status !== 'open' ? 'decided' : ''}" data-id="${esc(s.id)}">
      <h4>${s.dins.length} × ${esc(s.bloodGroup)} ${esc(state.cfg.components[s.component].label)}</h4>
      <div>${esc(siteName(s.fromSiteId))} → <strong>${esc(siteName(s.toSiteId))}</strong> <span class="muted">(${s.distanceKm} km)</span></div>
      <div class="meta">
        <span class="chip ${s.kind === 'avoid_expiry' ? 'st-expiry_risk' : 'st-low'}">${s.kind === 'avoid_expiry' ? 'avoid expiry' : 'cover shortage'}</span>
        <span class="chip conf-${s.confidence}">forecast confidence: ${s.confidence}</span>
        ${s.impact.expiriesAvoided ? `<span class="chip st-ok">${s.impact.expiriesAvoided} discard(s) avoided</span>` : ''}
      </div>
      <ul>${s.explanation.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
      <div class="dins">${s.dins.map(esc).join(' · ')}</div>
      ${
        s.status === 'open'
          ? canDecide(s)
            ? `<div class="actions"><button data-act="approve">${esc(t('approve'))}</button><button class="ghost" data-act="reject">${esc(t('reject'))}</button></div>`
            : `<p class="muted">Needs an inventory officer at ${esc(siteName(s.fromSiteId))}.</p>`
          : `<p class="muted">${esc(s.status)} by ${esc(s.decidedBy)}${s.decisionNote ? `: “${esc(s.decisionNote)}”` : ''}</p>`
      }
    </article>`,
      )
      .join('') || '<p class="muted">No transfers needed right now.</p>';

  for (const btn of document.querySelectorAll('#suggestions button[data-act]'))
    btn.addEventListener('click', async () => {
      const id = btn.closest('.card').dataset.id;
      const act = btn.dataset.act;
      let note = null;
      if (act === 'reject') {
        note = prompt('Why reject? (e.g. "courier unavailable", "clinician expects lower use")');
        if (!note) return;
      }
      btn.disabled = true;
      try {
        const r = await api(`/api/suggestions/${id}/${act}`, { method: 'POST', body: { note } });
        if (r.skipped?.length) alert(`Dispatched ${r.dispatched.length}. Skipped ${r.skipped.length}: stock changed since the suggestion was made.`);
      } catch (err) {
        alert(err.offline ? 'Approvals need a connection: the sending site must confirm the units are still on the shelf.' : err.message);
      }
      loaders.advisor();
    });

  $('#alerts').innerHTML =
    adv.alerts.map((a) => `<li class="${a.severity}">${esc(a.message)}</li>`).join('') || '<li class="muted">None.</li>';
};

// ---------- appeals ----------

loaders.appeals = async () => {
  const [drafts, appeals] = (await Promise.all([api('/api/appeals/drafts'), api('/api/appeals')]).catch(showError)) ?? [];
  if (!appeals) return;
  const canManage = (siteId) => state.user && ['inventory_officer', 'clinician', 'admin'].includes(state.user.role) && (!state.user.siteId || state.user.siteId === siteId);
  const reach = (r) => `${r.exact} matching + ${r.compatible} compatible eligible donors within reach`;
  $('#drafts').innerHTML =
    list(drafts)
      .slice(0, 9)
      .map(
        (d, i) => `<article class="card"><h4>${esc(d.siteName)}: ${d.unitsNeeded} × ${esc(d.bloodGroups.join(', '))}</h4>
        <div class="meta"><span class="chip ${d.urgency === 'urgent' ? 'st-low' : 'st-expiry_risk'}">${esc(d.urgency)}</span><span class="chip">AI draft</span></div>
        <p class="muted">${esc(d.note)}</p><p>${esc(reach(d.reach))}</p>
        ${canManage(d.siteId) ? `<div class="actions"><button data-draft="${i}">Publish to donors</button></div>` : `<p class="muted">Staff at ${esc(d.siteName)} can publish.</p>`}</article>`,
      )
      .join('') || '<p class="muted">No unresolved shortfalls.</p>';
  for (const b of document.querySelectorAll('#drafts [data-draft]'))
    b.addEventListener('click', async () => {
      const d = list(drafts)[Number(b.dataset.draft)];
      try {
        await api('/api/appeals', { method: 'POST', body: { ...d, source: 'ai_draft', note: `${d.bloodGroups.join('/')} donors needed at ${d.siteName}.` } });
      } catch (err) {
        alert(err.message);
      }
      loaders.appeals();
    });

  $('#appealList').innerHTML = list(appeals)
    .map(
      (a) => `<article class="card ${a.status !== 'open' ? 'decided' : ''}"><h4>${esc(a.siteName)}: ${esc(a.bloodGroups.join(', '))}</h4>
      <div class="meta"><span class="chip ${a.urgency === 'emergency' ? 'st-critical' : a.urgency === 'urgent' ? 'st-low' : 'st-expiry_risk'}">${esc(a.urgency)}</span>
      <span class="chip">${esc(a.status)}</span>${a.source === 'ai_draft' ? '<span class="chip">from AI draft</span>' : ''}</div>
      <p><strong>${a.donated}</strong> donated · <strong>${a.pledged}</strong> on the way · ${a.unitsNeeded} needed by ${new Date(a.neededBy).toLocaleDateString()}</p>
      <p class="muted">${esc(a.note)}</p><p class="muted">${esc(reach(a.reach))}</p>
      ${a.status === 'open' && canManage(a.siteId) ? `<div class="actions"><button class="ghost" data-close="${esc(a.id)}">Close appeal</button></div>` : ''}</article>`,
    )
    .join('');
  for (const b of document.querySelectorAll('#appealList [data-close]'))
    b.addEventListener('click', async () => {
      await api(`/api/appeals/${b.dataset.close}/close`, { method: 'POST' }).catch((e) => alert(e.message));
      loaders.appeals();
    });

  const siteId = state.user?.siteId;
  const pledges = siteId ? list(await api('/api/pledges?siteId=' + encodeURIComponent(siteId))) : [];
  const canCheckin = state.user && ['lab_tech', 'inventory_officer', 'admin'].includes(state.user.role);
  $('#pledgeList').innerHTML = !siteId
    ? '<p class="muted">Sign in as staff at a site to see expected donors.</p>'
    : pledges
        .map(
          (p) => `<article class="card" data-id="${esc(p.id)}"><h4>${esc(p.donorName)} · ${esc(p.donorBloodGroup)}${p.groupVerified ? '' : ' (self-reported)'}</h4>
        <p>${new Date(p.slot).toLocaleString()}</p>
        ${canCheckin ? `<div class="actions"><button data-checkin="donated">Donated</button><button class="ghost" data-checkin="deferred">Deferred</button></div>` : ''}</article>`,
        )
        .join('') || '<p class="muted">No donors booked at this site yet.</p>';
  for (const b of document.querySelectorAll('#pledgeList [data-checkin]'))
    b.addEventListener('click', async () => {
      const id = b.closest('.card').dataset.id;
      const body = { outcome: b.dataset.checkin };
      if (body.outcome === 'donated') {
        const g = prompt('Blood group as typed at the site (leave empty to keep the donor-reported group):');
        if (g) body.bloodGroup = g.trim().toUpperCase();
      }
      try {
        const r = await api(`/api/pledges/${id}/checkin`, { method: 'POST', body });
        if (r.din) alert(`Collected as ${r.din}. It is now traceable from vein to vein.`);
      } catch (err) {
        alert(err.message);
      }
      loaders.appeals();
    });
};

$('#appealForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const r = await api('/api/appeals', {
      method: 'POST',
      body: {
        siteId: f.get('siteId'),
        bloodGroups: String(f.get('bloodGroups')).split(',').map((g) => g.trim().toUpperCase()).filter(Boolean),
        unitsNeeded: Number(f.get('unitsNeeded')),
        urgency: f.get('urgency'),
        note: f.get('note'),
      },
    });
    alert(`Published. It reaches ${r.reach.exact} matching and ${r.reach.compatible} compatible eligible donors nearby.`);
  } catch (err) {
    alert(err.message);
  }
  loaders.appeals();
});

// ---------- forecast ----------

function fillSelect(el, items) {
  el.innerHTML = items.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
}

loaders.forecast = async () => {
  const q = new URLSearchParams({ siteId: $('#fSite').value, bloodGroup: $('#fGroup').value, component: $('#fComp').value });
  const f = await api('/api/forecast?' + q).catch(showError);
  if (!f) return;
  $('#fChart').innerHTML = chart(f);
  const bt = f.backtest;
  const effects = Object.entries(f.explanation.weekdayEffect || {});
  $('#fInfo').innerHTML = `
    <div class="card"><h4>Model: ${esc(f.model.replaceAll('_', ' '))} <span class="chip conf-${f.confidence}">${f.confidence}</span></h4>
      <p>${esc(f.reason)}</p>
      <p class="muted">Next 7 days: ${f.horizonTotal.mean} expected, up to ${f.horizonTotal.high} (P90).</p></div>
    <div class="card"><h4>Backtest (last ${bt ? bt.holdoutDays : '–'} days, unseen)</h4>
      ${
        bt
          ? `<table class="mini"><tr><td>This model</td><td>MAE ${bt.maeModel}</td></tr>
             <tr><td>28-day average</td><td>MAE ${bt.maeMovingAverage}</td></tr>
             <tr><td>Same day last week</td><td>MAE ${bt.maeSeasonalNaive}</td></tr>
             <tr><td>Skill vs naive</td><td>${Math.round(bt.skill * 100)}%</td></tr></table>`
          : '<p class="muted">Not enough history to test.</p>'
      }</div>
    <div class="card"><h4>Why this number</h4>
      <ul><li>Average last 28 days: ${f.explanation.meanDailyLast28}/day</li>
      <li>Last 14 vs previous 14 days: ${f.explanation.trendPct > 0 ? '+' : ''}${f.explanation.trendPct}%</li>
      ${f.explanation.trendPerDay !== undefined ? `<li>Fitted trend: ${f.explanation.trendPerDay}/day (damped)</li>` : ''}
      ${effects.length ? `<li>Weekday effect: ${effects.map(([d, v]) => `${d} ${v > 0 ? '+' : ''}${v}`).join(', ')}</li>` : ''}
      </ul><p class="muted">Demand = units requested, including requests that could not be filled, so past stock-outs do not teach the model that demand was low.</p></div>`;
};

function chart(f) {
  const W = 760, H = 240, P = { l: 34, r: 10, t: 10, b: 24 };
  const hist = f.history.slice(-56);
  const pts = f.points;
  const n = hist.length + pts.length;
  const max = Math.max(1, ...hist.map((h) => h.value), ...pts.map((p) => p.high)) * 1.1;
  const x = (i) => P.l + (i + 0.5) * ((W - P.l - P.r) / n);
  const y = (v) => H - P.b - (v / max) * (H - P.t - P.b);
  const bw = Math.max(2, ((W - P.l - P.r) / n) * 0.7);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Demand history and forecast">`;
  for (let k = 0; k <= 4; k++) {
    const v = (max / 4) * k;
    s += `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="4" y="${y(v) + 4}">${v.toFixed(v < 4 ? 1 : 0)}</text>`;
  }
  hist.forEach((h, i) => {
    s += `<rect x="${x(i) - bw / 2}" y="${y(h.value)}" width="${bw}" height="${y(0) - y(h.value)}" fill="var(--chart-hist)"><title>${h.day}: ${h.value} requested, ${h.fulfilled} filled</title></rect>`;
    if (h.fulfilled < h.value) s += `<rect x="${x(i) - bw / 2}" y="${y(h.value)}" width="${bw}" height="${y(h.fulfilled) - y(h.value)}" fill="var(--bad-text)" opacity="0.7"/>`;
  });
  const off = hist.length;
  const band = pts.map((p, i) => `${x(off + i)},${y(p.high)}`).concat([...pts].reverse().map((p, j) => `${x(off + pts.length - 1 - j)},${y(p.low)}`));
  s += `<polygon points="${band.join(' ')}" fill="var(--chart-band)"/>`;
  s += `<polyline points="${pts.map((p, i) => `${x(off + i)},${y(p.mean)}`).join(' ')}" fill="none" stroke="var(--chart-line)" stroke-width="2.5"/>`;
  pts.forEach((p, i) => (s += `<circle cx="${x(off + i)}" cy="${y(p.mean)}" r="3" fill="var(--chart-line)"><title>${p.day}: ${p.mean} (P10–P90 ${p.low}–${p.high})</title></circle>`));
  s += `<line x1="${x(off) - bw}" x2="${x(off) - bw}" y1="${P.t}" y2="${H - P.b}" stroke="var(--muted)" stroke-dasharray="3 3"/>`;
  s += `<text x="${P.l}" y="${H - 6}">${hist[0]?.day ?? ''}</text><text x="${x(off) - bw + 4}" y="${P.t + 10}">forecast</text><text x="${W - P.r - 70}" y="${H - 6}">${pts.at(-1)?.day ?? ''}</text>`;
  return s + `</svg><p class="muted" style="margin:4px 8px">Grey: units requested per day. Red top: requests that could not be filled. Line and band: forecast with P10–P90 range.</p>`;
}

for (const id of ['#fSite', '#fGroup', '#fComp']) $(id).addEventListener('change', () => loaders.forecast());

// ---------- trace ----------

async function trace(din) {
  const out = $('#traceOut');
  out.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const d = await api('/api/units/' + encodeURIComponent(din));
    const u = d.unit;
    const rejected = new Set(d.conflicts.map((c) => c.eventId));
    out.innerHTML = `
      <div class="card"><h4>${esc(u.din)}: ${esc(u.bloodGroup)} ${esc(state.cfg.components[u.component].label)}</h4>
        <div class="meta"><span class="chip st-ok">${esc(u.status)}</span><span class="chip">at ${esc(siteName(u.siteId))}</span>
        <span class="chip">expires ${new Date(u.expiresAt).toLocaleString()}</span></div>
        <ol class="timeline">${d.events
          .map(
            (e) => `<li class="${rejected.has(e.id) ? 'rejected' : ''}"><strong>${esc(e.type)}</strong> at ${esc(siteName(e.siteId))}
              <div class="when">${new Date(e.at).toLocaleString()} · ${esc(e.actor)} · node ${esc(e.origin)}</div>
              ${Object.keys(e.payload).length ? `<div class="dins">${esc(JSON.stringify(e.payload))}</div>` : ''}
              ${rejected.has(e.id) ? `<div class="muted">Held as conflict: ${esc(d.conflicts.find((c) => c.eventId === e.id).reason)}</div>` : ''}</li>`,
          )
          .join('')}</ol>
        <button class="ghost" id="showFhir">Show as HL7 FHIR</button><pre id="fhirOut" class="out hidden"></pre>
      </div>`;
    $('#showFhir').addEventListener('click', async () => {
      const r = await api('/fhir/BiologicallyDerivedProduct/' + encodeURIComponent(din));
      $('#fhirOut').textContent = JSON.stringify(r, null, 2);
      $('#fhirOut').classList.remove('hidden');
    });
  } catch (err) {
    out.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}

$('#traceForm').addEventListener('submit', (e) => {
  e.preventDefault();
  trace($('#traceDin').value.trim());
});
$('#traceRandom').addEventListener('click', async () => {
  const units = list(await api('/api/units?status=transfused&limit=50'));
  if (!units.length) return;
  const u = units[Math.floor(Math.random() * units.length)];
  $('#traceDin').value = u.din;
  trace(u.din);
});

// ---------- record ----------

const EXTRA = {
  COLLECTED: [
    ['component', 'select', ['RBC', 'PLT', 'FFP']],
    ['bloodGroup', 'select', ['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-']],
  ],
  TESTED: [['result', 'select', ['negative', 'reactive']]],
  RESERVED: [['patientRef', 'text']],
  DISPATCHED: [['toSiteId', 'site']],
  ISSUED: [['patientRef', 'text']],
  RETURNED: [['coldChainOk', 'select', ['true', 'false']]],
  DISCARDED: [['reason', 'text']],
};

function renderExtra() {
  const fields = EXTRA[$('#recType').value] ?? [];
  $('#recExtra').innerHTML = fields
    .map(([name, kind, opts]) => {
      if (kind === 'text') return `<label>${name} <input name="${name}" required></label>`;
      const options = kind === 'site' ? state.sites.map((s) => [s.id, s.name]) : opts.map((o) => [o, o]);
      return `<label>${name} <select name="${name}">${options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select></label>`;
    })
    .join('');
}
$('#recType').addEventListener('change', renderExtra);

$('#recForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {};
  for (const el of $('#recExtra').querySelectorAll('[name]')) payload[el.name] = el.value === 'true' ? true : el.value === 'false' ? false : el.value;
  const event = { id: crypto.randomUUID(), type: $('#recType').value, siteId: $('#recSite').value, din: $('#recDin').value.trim(), at: new Date().toISOString(), payload };
  try {
    const r = await api('/api/events', { method: 'POST', body: event });
    $('#recOut').textContent = 'Recorded:\n' + JSON.stringify(r, null, 2);
  } catch (err) {
    if (err.offline) {
      setOutbox([...outbox(), event]);
      $('#recOut').textContent = `Offline: queued on this device with id ${event.id}. It will be sent automatically.`;
    } else $('#recOut').textContent = 'Refused: ' + err.message;
  }
});

// ---------- sync ----------

loaders.sync = async () => {
  const [s, c] = await Promise.all([api('/api/sync/status'), api('/api/conflicts')]).catch(showError) ?? [];
  if (!s) return;
  $('#syncOut').textContent = JSON.stringify(s, null, 2);
  const items = list(c);
  $('#conflicts').innerHTML =
    items
      .map(
        (x) => `<article class="card" data-id="${esc(x.eventId)}"><h4>${esc(x.din)}</h4><p>${esc(x.reason)}</p>
        <div class="actions"><button class="ghost" data-trace="${esc(x.din)}">Trace</button><button data-resolve>Mark resolved</button></div></article>`,
      )
      .join('') || '<p class="muted">No open conflicts.</p>';
  for (const b of document.querySelectorAll('#conflicts [data-trace]'))
    b.addEventListener('click', () => {
      $('#traceDin').value = b.dataset.trace;
      showTab('trace');
      trace(b.dataset.trace);
    });
  for (const b of document.querySelectorAll('#conflicts [data-resolve]'))
    b.addEventListener('click', async () => {
      const note = prompt('What was done? (e.g. "unit confirmed transfused at Hospital Alpha; Beta record voided")');
      if (!note) return;
      try {
        await api(`/api/conflicts/${encodeURIComponent(b.closest('.card').dataset.id)}/resolve`, { method: 'POST', body: { resolution: note } });
      } catch (err) {
        alert(err.message);
      }
      loaders.sync();
    });
};

$('#syncNow').addEventListener('click', async () => {
  try {
    $('#syncOut').textContent = JSON.stringify(await api('/api/sync/now', { method: 'POST' }), null, 2);
  } catch (err) {
    $('#syncOut').textContent = err.message;
  }
});

// ---------- auth + boot ----------

function showError(err) {
  if (err.status === 401) {
    state.token = null;
    store.set('token', null);
  }
  const banner = $('#banner');
  banner.textContent = err.offline ? t('offline') : err.message;
  banner.classList.remove('hidden');
  return null;
}

async function login(userId) {
  const r = await api('/api/login', { method: 'POST', body: { userId } });
  state.token = r.token;
  state.user = r.user;
  store.set('token', r.token);
  store.set('user', r.user);
}

async function boot() {
  state.cfg = await api('/api/config');
  $('#nodeLabel').textContent = `node: ${state.cfg.node}${state.cfg.siteScope ? ` · ${state.cfg.siteScope}` : ''}`;
  $('#lang').value = state.lang;
  applyLang();
  $('#lang').addEventListener('change', () => {
    state.lang = $('#lang').value;
    store.set('lang', state.lang);
    applyLang();
    loaders[store.get('tab', 'inventory')]?.();
  });

  state.users = list(await api('/api/demo-users'));
  fillSelect($('#user'), state.users.map((u) => [u.id, u.name]));
  const preferred = state.user?.id ?? (state.cfg.siteScope ? `inv-${state.cfg.siteScope}` : 'inv-CENTRE-1');
  $('#user').value = state.users.some((u) => u.id === preferred) ? preferred : state.users[0].id;
  if (!state.token || state.user?.id !== $('#user').value) await login($('#user').value);
  $('#user').addEventListener('change', async () => {
    await login($('#user').value);
    loaders[store.get('tab', 'inventory')]?.();
  });

  state.sites = list(await api('/api/sites'));
  fillSelect($('#fSite'), state.sites.filter((s) => s.type === 'hospital').map((s) => [s.id, s.name]));
  fillSelect($('#fGroup'), state.cfg.bloodGroups.map((g) => [g, g]));
  fillSelect($('#fComp'), Object.entries(state.cfg.components).map(([k, v]) => [k, v.label]));
  fillSelect($('#recSite'), state.sites.map((s) => [s.id, s.name]));
  fillSelect($('#apSite'), state.sites.map((s) => [s.id, s.name]));
  if (state.user?.siteId) $('#apSite').value = state.user.siteId;
  fillSelect($('#recType'), Object.keys(EXTRA).concat(['RECEIVED', 'TRANSFUSED']).map((k) => [k, k]));
  if (state.user?.siteId) $('#recSite').value = state.user.siteId;
  renderExtra();
  renderCompSeg();
  setOutbox(outbox());
  showTab(store.get('tab', 'inventory'));
  flushOutbox();
}


boot().catch(showError);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
