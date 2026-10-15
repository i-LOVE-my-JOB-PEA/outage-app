// API สำหรับ Vercel (serverless) — เก็บข้อมูลใน Supabase ผ่าน REST
// ตัวแปรที่ต้องตั้ง: SUPABASE_URL, SUPABASE_SERVICE_KEY, STAFF_PASSWORD (และ TOKEN_SECRET ถ้าต้องการ)
const crypto = require('node:crypto');

const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();
// ตัดช่องว่าง, "/" ท้าย และ "/rest/v1" ที่อาจติดมาตอนคัดลอก
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'admin1234';
const SECRET = process.env.TOKEN_SECRET || STAFF_PASSWORD;
const STATUSES = ['pending', 'in_progress', 'resolved'];
const TYPES = ['power_out', 'wire_down', 'transformer', 'pole', 'flicker', 'other'];
const TOKEN_TTL_MS = 12 * 3600 * 1000;

// ---- token แบบไม่ต้องเก็บสถานะบนเซิร์ฟเวอร์ (serverless จำค่าในหน่วยความจำไม่ได้) ----
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
function makeToken() {
  const exp = String(Date.now() + TOKEN_TTL_MS);
  return exp + '.' + sign(exp);
}
function isStaff(req) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  const [exp, sig] = t.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = Buffer.from(sign(exp));
  const got = Buffer.from(sig);
  return good.length === got.length && crypto.timingSafeEqual(good, got);
}

// ---- Supabase ----
async function sb(pathAndQuery, { method = 'GET', body } = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      // key รุ่นใหม่ (sb_secret_...) ไม่ใช่ JWT ห้ามส่งใน Authorization; key รุ่นเก่า (eyJ...) ต้องส่ง
      ...(SUPABASE_SERVICE_KEY.startsWith('eyJ') ? { Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY } : {}),
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error('database error: ' + text.slice(0, 200));
  return text ? JSON.parse(text) : [];
}

const fromRow = (r) => ({
  id: r.id, code: r.code, type: r.type, description: r.description, address: r.address,
  lat: r.lat, lng: r.lng, reporterName: r.reporter_name, reporterPhone: r.reporter_phone,
  status: r.status, crew: r.crew, createdAt: r.created_at, updatedAt: r.updated_at, history: r.history,
});

const clean = (v, n) => String(v ?? '').trim().slice(0, n);
const publicView = (o) => ({
  id: o.id, code: o.code, type: o.type, description: o.description, address: o.address,
  lat: o.lat, lng: o.lng, status: o.status, createdAt: o.createdAt, updatedAt: o.updatedAt,
  history: o.history.map((h) => ({ status: h.status, note: h.public ? h.note : '', at: h.at })),
});

function send(res, code, body) {
  res.status(code).setHeader('Content-Type', 'application/json; charset=utf-8').send(JSON.stringify(body));
}

module.exports = async (req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return send(res, 500, { error: 'ยังไม่ได้ตั้งค่า SUPABASE_URL / SUPABASE_SERVICE_KEY' });
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const m = req.method;
    let b = {};
    if (m !== 'GET' && m !== 'HEAD') { // GET ไม่มี body; การแตะ req.body อาจ throw ถ้า Content-Type เป็น JSON แต่ว่าง
      try { if (req.body && typeof req.body === 'object') b = req.body; } catch { return send(res, 400, { error: 'ข้อมูลไม่ถูกต้อง' }); }
    }

    if (m === 'POST' && parts[1] === 'login') {
      if (b.password !== STAFF_PASSWORD) return send(res, 401, { error: 'รหัสผ่านไม่ถูกต้อง' });
      return send(res, 200, { token: makeToken() });
    }

    if (parts[1] === 'outages') {
      if (m === 'GET' && !parts[2]) {
        const staff = isStaff(req);
        const list = (await sb('outages?select=*&order=id.desc&limit=500')).map(fromRow);
        return send(res, 200, staff ? list : list.map(publicView));
      }
      if (m === 'GET' && parts[2] === 'track') {
        const code = (url.searchParams.get('code') || '').toUpperCase();
        const rows = await sb(`outages?select=*&code=eq.${encodeURIComponent(code)}&limit=1`);
        return rows[0] ? send(res, 200, publicView(fromRow(rows[0]))) : send(res, 404, { error: 'ไม่พบรหัสนี้' });
      }
      if (m === 'POST' && !parts[2]) {
        const lat = Number(b.lat), lng = Number(b.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return send(res, 400, { error: 'กรุณาปักหมุดตำแหน่งบนแผนที่' });
        if (!TYPES.includes(b.type)) return send(res, 400, { error: 'ประเภทไม่ถูกต้อง' });
        const address = clean(b.address, 200);
        if (!address) return send(res, 400, { error: 'กรุณากรอกที่อยู่/จุดสังเกต' });
        const now = new Date().toISOString();
        const [row] = await sb('outages', { method: 'POST', body: {
          code: 'PW' + crypto.randomBytes(3).toString('hex').toUpperCase(),
          type: b.type, description: clean(b.description, 500), address, lat, lng,
          reporter_name: clean(b.reporterName, 100), reporter_phone: clean(b.reporterPhone, 20),
          status: 'pending', crew: '', created_at: now, updated_at: now,
          history: [{ status: 'pending', note: 'รับเรื่องแล้ว', public: true, at: now }],
        } });
        return send(res, 201, publicView(fromRow(row)));
      }
      if (m === 'PATCH' && parts[2]) {
        if (!isStaff(req)) return send(res, 401, { error: 'ต้องเข้าสู่ระบบเจ้าหน้าที่' });
        const id = Number(parts[2]);
        if (!Number.isInteger(id)) return send(res, 404, { error: 'ไม่พบรายการ' });
        const rows = await sb(`outages?select=*&id=eq.${id}&limit=1`);
        if (!rows[0]) return send(res, 404, { error: 'ไม่พบรายการ' });
        const o = fromRow(rows[0]);
        if (b.status !== undefined && !STATUSES.includes(b.status)) return send(res, 400, { error: 'สถานะไม่ถูกต้อง' });
        const now = new Date().toISOString();
        const statusChanged = b.status && b.status !== o.status;
        const patch = { updated_at: now };
        if (b.crew !== undefined) patch.crew = clean(b.crew, 100);
        if (statusChanged) patch.status = b.status;
        if (statusChanged || b.note) {
          patch.history = [...o.history, { status: patch.status || o.status, note: clean(b.note, 300), public: b.publicNote !== false, at: now }];
        }
        const [row] = await sb(`outages?id=eq.${id}`, { method: 'PATCH', body: patch });
        return send(res, 200, fromRow(row));
      }
    }

    send(res, 404, { error: 'ไม่พบ API' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'เกิดข้อผิดพลาดบนเซิร์ฟเวอร์' });
  }
};
