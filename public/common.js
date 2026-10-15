const TYPE_LABEL = {
  power_out: 'ไฟดับ', wire_down: 'สายไฟขาด/ตก', transformer: 'หม้อแปลงชำรุด',
  pole: 'เสาไฟล้ม/เอียง', flicker: 'ไฟตกไฟกระชาก', other: 'อื่น ๆ',
};
const CAUSE_LABEL = {
  tree: 'ต้นไม้/กิ่งไม้ทับสาย', lightning: 'ฟ้าผ่า/พายุ', aging: 'อุปกรณ์เสื่อมสภาพ', accident: 'อุบัติเหตุ/รถชน',
  animal: 'สัตว์', overload: 'โหลดเกิน', planned: 'ดับไฟตามแผนงาน', other: 'อื่น ๆ',
};
const STATUS_LABEL = { pending: 'รอรับเรื่อง', in_progress: 'กำลังซ่อม', resolved: 'แก้ไขแล้ว' };
const STATUS_COLOR = { pending: '#d97706', in_progress: '#2563eb', resolved: '#16a34a' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (iso) => new Date(iso).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });

async function api(path, opts = {}, token) {
  const r = await fetch(path, {
    ...opts,
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error((data.error || 'เกิดข้อผิดพลาด') + (data.detail ? ' [' + data.detail + ']' : ''));
  return data;
}

// ล็อกอินเจ้าหน้าที่ที่ใช้ร่วมกันทุกหน้า (ต้องมี #loginBox #loginForm #pw #loginErr #app #logout ในหน้า)
function staffGate(onReady) {
  const el = (id) => document.getElementById(id);
  let token = sessionStorage.getItem('staffToken');
  const gate = {
    token: () => token,
    expire() { sessionStorage.removeItem('staffToken'); token = null; location.reload(); },
  };
  const show = (on) => {
    el('loginBox').classList.toggle('hidden', on);
    el('app').classList.toggle('hidden', !on);
    el('logout').classList.toggle('hidden', !on);
  };
  el('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      token = (await api('/api/login', { method: 'POST', body: { password: el('pw').value } })).token;
      sessionStorage.setItem('staffToken', token);
      show(true); onReady();
    } catch (err) { el('loginErr').textContent = err.message; el('loginErr').classList.remove('hidden'); }
  };
  el('logout').onclick = (e) => { e.preventDefault(); gate.expire(); };
  if (token) { show(true); setTimeout(onReady, 0); } // รอให้ผู้เรียกกำหนดตัวแปร gate เสร็จก่อน
  return gate;
}

function makeMap(id) {
  const map = L.map(id).setView([13.7563, 100.5018], 11); // กรุงเทพฯ
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap',
  }).addTo(map);
  return map;
}

function pin(o) {
  return L.circleMarker([o.lat, o.lng], {
    radius: 9, color: '#fff', weight: 2, fillColor: STATUS_COLOR[o.status], fillOpacity: 0.95,
  });
}

function badge(s) { return `<span class="badge" style="background:${STATUS_COLOR[s]}">${STATUS_LABEL[s]}</span>`; }
function timeline(o) {
  return '<ul class="timeline">' + o.history.map((h) =>
    `<li>${fmt(h.at)} — ${STATUS_LABEL[h.status]}${h.note ? ': ' + esc(h.note) : ''}</li>`).join('') + '</ul>';
}

// ---- วางแผนและนำทาง ----
const PRIORITY_LABEL = { urgent: 'เร่งด่วนมาก', high: 'สูง', normal: 'ปกติ', low: 'ต่ำ' };
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };

// เปิด Google Maps นำทางไปจุดเกิดเหตุ (เริ่มจากตำแหน่งปัจจุบันของเครื่อง)
const navUrl = (o) => `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${o.lat},${o.lng}`;
// เส้นทางหลายจุด: จุดสุดท้ายเป็นปลายทาง ที่เหลือเป็นจุดแวะ (รองรับสูงสุด 10 จุด)
// origin (ไม่บังคับ) = จุดเริ่ม ถ้าไม่ใส่ Google Maps จะเริ่มจากตำแหน่งปัจจุบันของเครื่อง
function routeUrl(list, origin) {
  const stops = list.slice(0, 10).map((o) => `${o.lat},${o.lng}`);
  const dest = stops.pop();
  return 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + dest +
    (origin ? `&origin=${origin.lat},${origin.lng}` : '') +
    (stops.length ? '&waypoints=' + encodeURIComponent(stops.join('|')) : '');
}

// ---- จัดเส้นทางซ่อม ----
const ROAD_FACTOR = 1.3;   // ระยะถนนโดยประมาณ = ระยะตรง x 1.3
const AVG_KMH = 30;        // ความเร็วเฉลี่ยในเมืองโดยประมาณ
function haversineKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
const roadKm = (a, b) => haversineKm(a, b) * ROAD_FACTOR;
const etaMin = (km) => Math.round((km / AVG_KMH) * 60);
function pathKm(order, origin) {
  let km = 0, cur = origin || order[0];
  for (const o of order) { km += roadKm(cur, o); cur = o; }
  return km;
}
function nearestFrom(cur, pool) {            // เรียงแบบใกล้ที่สุดก่อนต่อเนื่อง
  const rem = pool.slice(), out = [];
  while (rem.length) {
    let bi = 0;
    rem.forEach((o, i) => { if (haversineKm(cur, o) < haversineKm(cur, rem[bi])) bi = i; });
    cur = rem.splice(bi, 1)[0];
    out.push(cur);
  }
  return out;
}
function twoOpt(arr, origin) {               // ปรับเส้นทางให้สั้นลง (จุดเริ่มคงที่ ปลายทางเปิด)
  const d = (a, b) => haversineKm(a, b);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < arr.length - 1; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = i === 0 ? origin : arr[i - 1], b = arr[i], c = arr[j], e = arr[j + 1];
        const before = d(a, b) + (e ? d(c, e) : 0), after = d(a, c) + (e ? d(b, e) : 0);
        if (after < before - 1e-9) { arr.splice(i, j - i + 1, ...arr.slice(i, j + 1).reverse()); improved = true; }
      }
    }
  }
  return arr;
}
const ageOrder = (a, b) => new Date(a.createdAt) - new Date(b.createdAt);
const urgencyOrder = (a, b) => (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]) || ageOrder(a, b);
// mode: 'distance' = ใกล้ที่สุดก่อน (สั้นที่สุด) | 'priority' = เรียงตามความเร่งด่วน แล้วใกล้ที่สุดภายในระดับเดียวกัน
// start = {lat,lng} หรือ null (ถ้าไม่มี จะเริ่มที่งานเร่งด่วนที่สุด)
function planRoute(jobs, mode, start) {
  const rem = jobs.slice(), order = [];
  let origin = start;
  if (!origin && rem.length) { rem.sort(urgencyOrder); origin = rem.shift(); order.push(origin); }
  if (mode === 'priority') {
    let cur = origin;
    [0, 1, 2, 3].forEach((rank) => {
      const tier = nearestFrom(cur, rem.filter((o) => PRIORITY_RANK[o.priority] === rank));
      if (tier.length) { order.push(...tier); cur = tier[tier.length - 1]; }
    });
  } else {
    order.push(...twoOpt(nearestFrom(origin, rem), origin));
  }
  return order;
}
// ISO -> ค่าสำหรับ <input type="datetime-local"> ตามเวลาของเครื่อง
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

// รหัสติดตามที่เคยแจ้งจากเครื่องนี้ (เก็บในเบราว์เซอร์เท่านั้น)
const MY_KEY = 'myReports';
function myCodes() {
  try { return JSON.parse(localStorage.getItem(MY_KEY)) || []; } catch { return []; }
}
function saveMyCode(code) {
  try {
    const list = [code, ...myCodes().filter((c) => c !== code)].slice(0, 20);
    localStorage.setItem(MY_KEY, JSON.stringify(list));
  } catch { /* โหมดส่วนตัว/ปิดการเก็บข้อมูล: ข้ามไป */ }
}
