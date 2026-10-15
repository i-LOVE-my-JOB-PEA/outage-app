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
