// Donor app: see who needs your blood type, pick where to donate, book a slot.
// Maps: Google Maps JavaScript API when the deployment configures a key,
// otherwise OpenStreetMap via Leaflet. "Directions" always opens Google Maps,
// which needs no key and works on any phone.

const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ls = {
  get(k) {
    try {
      return JSON.parse(localStorage.getItem(k));
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* private mode: stay signed in for this tab only */
    }
  },
};

const S = { cfg: null, token: ls.get('donorToken'), me: null, appeals: [], current: null, coords: null };

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (S.token) headers.authorization = `Bearer ${S.token}`;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    banner('You are offline. Showing what was last loaded.');
    const cached = method === 'GET' ? ls.get('dcache:' + path) : null;
    if (cached) return cached;
    throw new Error('offline');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  if (method === 'GET') ls.set('dcache:' + path, data);
  banner(null);
  return data;
}

function banner(msg) {
  $('#dBanner').textContent = msg ?? '';
  $('#dBanner').classList.toggle('hidden', !msg);
}

// ---------- navigation ----------

function go(view) {
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('hidden', v.id !== 'v-' + view);
  for (const b of document.querySelectorAll('.d-nav button')) b.classList.toggle('active', b.dataset.go === view);
  window.scrollTo(0, 0);
  ({ requests: loadRequests, near: loadNear, me: loadMe })[view]?.();
}
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-go]');
  if (t) go(t.dataset.go);
});

// ---------- maps ----------

const dirUrl = (lat, lon) =>
  `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}` + (S.coords ? `&origin=${S.coords.lat},${S.coords.lon}` : '');

function loadScript(src) {
  return new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = ok;
    s.onerror = fail;
    document.head.appendChild(s);
  });
}
let mapLib = null;
async function ensureMapLib() {
  if (mapLib) return mapLib;
  if (S.cfg.googleMapsApiKey) {
    await loadScript(`https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(S.cfg.googleMapsApiKey)}`);
    mapLib = 'google';
  } else {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);
    await loadScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js');
    mapLib = 'leaflet';
  }
  return mapLib;
}

const COLORS = { me: '#1d4f91', requester: '#b3122d', site: '#1f5f37' };

/** points: [{lat, lon, label, kind: 'me'|'requester'|'site'}] */
async function drawMap(el, points) {
  el.innerHTML = '';
  try {
    const lib = await ensureMapLib();
    if (lib === 'google') {
      const map = new google.maps.Map(el, { disableDefaultUI: true, zoomControl: true });
      const bounds = new google.maps.LatLngBounds();
      for (const p of points) {
        const pos = { lat: p.lat, lng: p.lon };
        new google.maps.Marker({
          position: pos,
          map,
          title: p.label,
          icon: { path: google.maps.SymbolPath.CIRCLE, scale: p.kind === 'me' ? 7 : 9, fillColor: COLORS[p.kind], fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 },
        });
        bounds.extend(pos);
      }
      map.fitBounds(bounds, 40);
      if (points.length === 1) map.setZoom(13);
    } else {
      const map = L.map(el, { scrollWheelZoom: false });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(map);
      const ll = points.map((p) => [p.lat, p.lon]);
      for (const p of points)
        L.circleMarker([p.lat, p.lon], { radius: p.kind === 'me' ? 7 : 9, color: '#fff', weight: 2, fillColor: COLORS[p.kind], fillOpacity: 1 })
          .addTo(map)
          .bindPopup(esc(p.label));
      if (ll.length > 1) map.fitBounds(ll, { padding: [30, 30] });
      else map.setView(ll[0], 13);
    }
  } catch {
    el.innerHTML = `<div class="fallback">Map unavailable offline. ${points
      .filter((p) => p.kind !== 'me')
      .map((p) => `<a class="dir" href="${dirUrl(p.lat, p.lon)}" target="_blank" rel="noopener">${esc(p.label)} ↗</a>`)
      .join(' · ')}</div>`;
  }
}

// ---------- location ----------

function locate() {
  return new Promise((ok) => {
    if (!navigator.geolocation) return ok(null);
    navigator.geolocation.getCurrentPosition(
      (p) => ok({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => ok(null),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 },
    );
  });
}

$('#locBtn').addEventListener('click', async () => {
  $('#locStatus').textContent = 'Finding you…';
  S.coords = await locate();
  $('#locStatus').textContent = S.coords
    ? 'Location found. We will show distances from here.'
    : 'Could not get your location. You can still register; distances will be hidden.';
});

// ---------- sign up / in ----------

$('#regForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const r = await api('/api/donor/register', {
      method: 'POST',
      body: {
        name: f.get('name'),
        bloodGroup: f.get('bloodGroup'),
        lastDonationAt: f.get('lastDonationAt') || null,
        smsConsent: f.get('smsConsent') === 'on',
        lat: S.coords?.lat,
        lon: S.coords?.lon,
      },
    });
    signedIn(r);
  } catch (err) {
    alert(err.message);
  }
});

async function demoLogin(id) {
  const r = await api('/api/donor/login', { method: 'POST', body: { donorId: id } });
  signedIn(r);
}

function signedIn(r) {
  S.token = r.token;
  ls.set('donorToken', r.token);
  start();
}

$('#signOut').addEventListener('click', () => {
  S.token = null;
  ls.set('donorToken', null);
  location.reload();
});

// ---------- requests ----------

const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const fmtTime = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function matchText(a, group) {
  if (a.match === 'exact') return `<div class="match exact">Your type ${esc(group)} is needed</div>`;
  if (a.match === 'compatible') return `<div class="match">Your ${esc(group)} is compatible: you can help</div>`;
  return `<div class="match">We'll test your blood type when you donate</div>`;
}

function nearestText(a) {
  const o = a.donationOptions.filter((x) => x.distanceKm !== null).sort((p, q) => p.distanceKm - q.distanceKm)[0];
  if (!o || o.id === a.siteId || (a.distanceKm ?? 0) - o.distanceKm < 20) return '';
  return `<div class="small muted">Give near you at <b>${esc(o.name)}</b> (${o.distanceKm} km): the unit is sent on to ${esc(a.siteName)}.</div>`;
}

function progress(a) {
  const pct = (n) => Math.min(100, (n / a.unitsNeeded) * 100);
  return `<div class="progress"><span class="done" style="width:${pct(a.donated)}%"></span><span class="pledged" style="width:${pct(a.pledged)}%"></span></div>
    <small class="muted">${a.donated} donated · ${a.pledged} on the way · ${a.unitsNeeded} needed by ${fmtDate(a.neededBy)}</small>`;
}

async function refreshMe() {
  S.me = await api('/api/donor/me');
  const g = S.me.donor.bloodGroup;
  $('#dGroup').textContent = g === 'unknown' ? '?' : g;
  $('#dGroup').classList.remove('hidden');
  S.coords ??= S.me.donor.lat !== null ? { lat: S.me.donor.lat, lon: S.me.donor.lon } : null;
}

async function loadRequests() {
  await refreshMe();
  const { donor, eligibility, pledges } = S.me;
  $('#eligCard').className = 'card ' + (eligibility.eligible ? 'ok-card' : '');
  $('#eligCard').innerHTML = eligibility.eligible
    ? `<strong>Hi ${esc(donor.name.split(' ')[0])}, you can donate.</strong><div class="muted small">${esc(eligibility.reason)}</div>`
    : `<strong>Thank you for your last donation.</strong><div class="muted small">${esc(eligibility.reason)} You can give again from <b>${fmtDate(eligibility.nextEligibleAt)}</b>.</div>`;
  const next = pledges.find((p) => p.status === 'pledged');
  $('#upcoming').innerHTML = next
    ? `<div class="card" style="margin-top:10px"><strong>Your donation</strong>
        <div>${esc(next.siteName)} · ${fmtTime(next.slot)}</div>
        <div class="row" style="margin-top:8px"><a class="dir" href="${dirUrl(next.lat, next.lon)}" target="_blank" rel="noopener">Directions in Google Maps ↗</a>
        <button class="ghost" id="cancelPledge">Cancel</button></div></div>`
    : '';
  if (next)
    $('#cancelPledge').addEventListener('click', async () => {
      if (!confirm('Cancel this donation? The hospital will see one fewer donor on the way.')) return;
      await api(`/api/donor/pledges/${next.id}/cancel`, { method: 'POST' });
      loadRequests();
    });

  S.appeals = await api('/api/donor/appeals');
  $('#reqHint').textContent = donor.bloodGroup === 'unknown'
    ? 'Showing all requests. Your blood type will be tested at your first donation.'
    : `Requests your ${donor.bloodGroup} blood can answer, most urgent and nearest first.`;
  $('#reqList').innerHTML =
    S.appeals
      .map(
        (a, i) => `<button class="req" data-i="${i}">
      <div class="top-line"><h4>${esc(a.siteName)}</h4><span class="chip urg-${a.urgency}">${esc(a.urgency)}</span></div>
      <div class="groups">${a.bloodGroups.map((g) => `<span class="bg">${esc(g)}</span>`).join('')}
        ${a.distanceKm !== null ? `<span class="muted small">· ${a.distanceKm} km away</span>` : ''}</div>
      ${matchText(a, donor.bloodGroup)}
      ${a.note ? `<div class="small">${esc(a.note)}</div>` : ''}
      ${nearestText(a)}
      ${progress(a)}
    </button>`,
      )
      .join('') || '<p class="muted">No open requests match your blood type right now. You can still donate at any site under "Near me".</p>';
  for (const b of document.querySelectorAll('#reqList .req')) b.addEventListener('click', () => openAppeal(S.appeals[Number(b.dataset.i)]));
}

// ---------- one appeal ----------

function slotOptions() {
  const days = [];
  const now = new Date();
  for (let d = 0; d < 7; d++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
    if (day.getDay() === 0) continue; // sites closed on Sunday in this demo
    if (new Date(day.getFullYear(), day.getMonth(), day.getDate(), 16) <= now) continue; // no slots left today
    days.push(day);
  }
  $('#apDay').innerHTML = days
    .map((d) => `<option value="${d.toISOString()}">${d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })}</option>`)
    .join('');
  const times = () => {
    const day = new Date($('#apDay').value);
    const opts = [];
    for (let h = 8; h <= 16; h++) {
      const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h);
      if (t > new Date()) opts.push(t);
    }
    $('#apTime').innerHTML = opts.map((t) => `<option value="${t.toISOString()}">${t.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</option>`).join('') || '<option value="">No slots left today</option>';
  };
  $('#apDay').onchange = times;
  times();
}

function openAppeal(a) {
  S.current = a;
  go('appeal');
  $('#apHead').innerHTML = `<h2>${esc(a.siteName)}</h2>
    <div class="groups">${a.bloodGroups.map((g) => `<span class="bg">${esc(g)}</span>`).join('')} <span class="chip urg-${a.urgency}">${esc(a.urgency)}</span></div>
    ${matchText(a, S.me.donor.bloodGroup)}
    ${a.note ? `<p>${esc(a.note)}</p>` : ''}${progress(a)}`;
  $('#apSites').innerHTML = a.donationOptions
    .map(
      (s, i) => `<div class="card site-opt"><label><input type="radio" name="site" value="${esc(s.id)}" ${i === 0 ? 'checked' : ''}>
        <span><strong>${esc(s.name)}</strong>${s.isRequester ? ' <span class="chip st-ok">requesting site</span>' : ''}<br>
        <small class="muted">${s.distanceKm !== null ? `${s.distanceKm} km from you` : ''}</small></span></label>
        <a class="dir" href="${dirUrl(s.lat, s.lon)}" target="_blank" rel="noopener">Directions ↗</a></div>`,
    )
    .join('');
  const pts = a.donationOptions.map((s) => ({ lat: s.lat, lon: s.lon, label: s.name, kind: s.isRequester ? 'requester' : 'site' }));
  if (!a.donationOptions.some((s) => s.isRequester)) pts.push({ lat: a.lat, lon: a.lon, label: `${a.siteName} (requesting)`, kind: 'requester' });
  if (S.coords) pts.push({ lat: S.coords.lat, lon: S.coords.lon, label: 'You', kind: 'me' });
  drawMap($('#apMap'), pts);
  slotOptions();
  const el = S.me.eligibility;
  $('#apPledge').disabled = !el.eligible;
  $('#apPledge').textContent = el.eligible ? "I'll donate" : `You can donate again from ${fmtDate(el.nextEligibleAt)}`;
}

$('#apPledge').addEventListener('click', async () => {
  const siteId = document.querySelector('#apSites input[name=site]:checked')?.value;
  const slot = $('#apTime').value;
  if (!siteId || !slot) return alert('Choose a site and a time.');
  try {
    await api('/api/donor/pledges', { method: 'POST', body: { appealId: S.current.id, siteId, slot } });
    alert('Thank you! The team at the site will expect you. Eat well and drink water before you come.');
    go('requests');
  } catch (err) {
    alert(err.message);
  }
});

// ---------- near me ----------

async function loadNear() {
  await refreshMe();
  const sites = await api('/api/donor/sites');
  $('#nearList').innerHTML = sites
    .map(
      (s) => `<div class="card site-opt"><span><strong>${esc(s.name)}</strong><br><small class="muted">${s.distanceKm !== null ? `${s.distanceKm} km` : ''} · walk-ins 8am–5pm, Mon–Sat</small></span>
      <a class="dir" href="${dirUrl(s.lat, s.lon)}" target="_blank" rel="noopener">Directions ↗</a></div>`,
    )
    .join('');
  const pts = sites.map((s) => ({ lat: s.lat, lon: s.lon, label: s.name, kind: 'site' }));
  if (S.coords) pts.push({ lat: S.coords.lat, lon: S.coords.lon, label: 'You', kind: 'me' });
  drawMap($('#nearMap'), pts);
}

// ---------- me ----------

async function loadMe() {
  await refreshMe();
  const { donor, eligibility, pledges } = S.me;
  $('#meName').textContent = donor.name;
  $('#meCard').innerHTML = `<div>Blood type: <strong>${esc(donor.bloodGroup)}</strong> ${donor.groupVerified ? '<span class="chip st-ok">lab-confirmed</span>' : '<span class="chip">self-reported</span>'}</div>
    <div>Last donation: ${donor.lastDonationAt ? fmtDate(donor.lastDonationAt) : 'none recorded'}</div>
    <div>${eligibility.eligible ? 'You can donate now.' : `Next donation from ${fmtDate(eligibility.nextEligibleAt)}.`}</div>
    <label class="check" style="margin-top:8px;display:flex;gap:8px;align-items:center"><input type="checkbox" id="smsToggle" ${donor.smsConsent ? 'checked' : ''}> SMS me when my type is needed nearby</label>
    <button class="ghost" id="updLoc" style="margin-top:8px">Update my location</button>`;
  $('#smsToggle').addEventListener('change', (e) => api('/api/donor/me', { method: 'PUT', body: { smsConsent: e.target.checked } }));
  $('#updLoc').addEventListener('click', async () => {
    const c = await locate();
    if (!c) return alert('Could not get your location.');
    S.coords = c;
    await api('/api/donor/me', { method: 'PUT', body: c });
    alert('Location updated.');
  });
  $('#history').innerHTML =
    pledges
      .slice()
      .reverse()
      .map((p) => `<div class="card"><strong>${esc(p.siteName)}</strong> · ${fmtTime(p.slot)} <span class="chip ${p.status === 'donated' ? 'st-ok' : ''}">${esc(p.status)}</span>
        ${p.din ? `<div class="muted small">Your unit: ${esc(p.din)}. It is traced until it reaches a patient.</div>` : ''}</div>`)
      .join('') || '<p class="muted">No donations booked yet.</p>';
}

// ---------- boot ----------

async function start() {
  try {
    await refreshMe();
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      S.token = null;
      ls.set('donorToken', null);
      return welcome();
    }
    throw err;
  }
  $('#dNav').classList.remove('hidden');
  go('requests');
}

async function welcome() {
  go('welcome');
  if (S.cfg.demo) {
    const demo = await api('/api/donor/demo-accounts');
    $('#demoBox').classList.remove('hidden');
    $('#demoList').innerHTML = demo.map((d) => `<button data-id="${esc(d.id)}">${esc(d.bloodGroup)} · ${esc(d.name)}</button>`).join('');
    for (const b of document.querySelectorAll('#demoList button')) b.addEventListener('click', () => demoLogin(b.dataset.id));
  }
}

(async () => {
  S.cfg = await api('/api/config');
  if (S.token) start();
  else welcome();
})().catch((e) => banner(e.message));
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
