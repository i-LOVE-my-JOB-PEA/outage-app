const TYPE_LABEL = {
  power_out: 'ไฟดับ', wire_down: 'สายไฟขาด/ตก', transformer: 'หม้อแปลงชำรุด',
  pole: 'เสาไฟล้ม/เอียง', flicker: 'ไฟตกไฟกระชาก', other: 'อื่น ๆ',
};
const STATUS_LABEL = { pending: 'รอรับเรื่อง', in_progress: 'กำลังซ่อม', resolved: 'แก้ไขแล้ว' };
const STATUS_COLOR = { pending: '#d97706', in_progress: '#2563eb', resolved: '#16a34a' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (iso) => new Date(iso).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });

async function api(path, opts = {}, token) {
  const r = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'เกิดข้อผิดพลาด');
  return data;
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
