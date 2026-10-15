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
  cause: r.cause || '', materials: r.materials || '', startedAt: r.started_at, resolvedAt: r.resolved_at,
  duplicateOf: r.duplicate_of, consent: !!r.consent,
});

const CAUSES = ['', 'tree', 'lightning', 'aging', 'accident', 'animal', 'overload', 'planned', 'other'];
const DUP_RADIUS_M = 150;      // เหตุชนิดเดียวกันที่ยังไม่ปิด ภายในระยะนี้ถือว่าซ้ำ
const DUP_WINDOW_MS = 24 * 3600 * 1000;
const RATE_LIMIT = 5;          // แจ้งได้สูงสุดกี่ครั้ง ต่อ IP ในช่วงเวลา
const RATE_WINDOW_MS = 10 * 60 * 1000;

const distM = (a, b) => {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const clientIpHash = (req) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  return crypto.createHash('sha256').update(ip + SECRET).digest('hex').slice(0, 16); // ไม่เก็บ IP จริง
};
const minutesBetween = (a, b) => (new Date(b) - new Date(a)) / 60000;
const avg = (xs) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null);

function buildStats(rows) {
  const unique = rows.filter((o) => !o.duplicateOf);
  const count = (arr, key) => arr.reduce((m, o) => { const k = key(o); if (k) m[k] = (m[k] || 0) + 1; return m; }, {});
  const dayKey = (iso) => new Date(new Date(iso).getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10); // เวลาไทย
  const daily = {};
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  rows.forEach((o) => { if (new Date(o.createdAt) >= cutoff) { const k = dayKey(o.createdAt); daily[k] = (daily[k] || 0) + 1; } });
  // พื้นที่ดับบ่อย: นับเฉพาะเหตุจริง (ไม่นับแจ้งซ้ำ) ในช่องตารางประมาณ 1.1 กม.
  const cells = {};
  unique.forEach((o) => {
    const k = o.lat.toFixed(2) + ',' + o.lng.toFixed(2);
    if (!cells[k]) cells[k] = { lat: +o.lat.toFixed(2) + 0.005, lng: +o.lng.toFixed(2) + 0.005, count: 0, address: o.address, causes: {}, types: {} };
    const c = cells[k];
    c.count++;
    if (o.cause) c.causes[o.cause] = (c.causes[o.cause] || 0) + 1;
    c.types[o.type] = (c.types[o.type] || 0) + 1;
  });
  const top = (m) => Object.entries(m).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  // ช่วงเวลาที่เกิดเหตุ (เวลาไทย)
  const byHour = Array(24).fill(0), byWeekday = Array(7).fill(0);
  unique.forEach((o) => {
    const t = new Date(new Date(o.createdAt).getTime() + 7 * 3600 * 1000);
    byHour[t.getUTCHours()]++;
    byWeekday[t.getUTCDay()]++;
  });
  return {
    total: rows.length,
    uniqueIncidents: unique.length,
    duplicates: rows.length - unique.length,
    byStatus: count(unique, (o) => o.status),
    byType: count(unique, (o) => o.type),
    byCause: count(unique, (o) => o.cause),
    avgResponseMin: avg(unique.filter((o) => o.startedAt).map((o) => minutesBetween(o.createdAt, o.startedAt))),
    avgRepairMin: avg(unique.filter((o) => o.resolvedAt).map((o) => minutesBetween(o.createdAt, o.resolvedAt))),
    daily, byHour, byWeekday,
    hotspots: Object.values(cells).sort((a, b) => b.count - a.count).slice(0, 15)
      .map((c) => ({ lat: c.lat, lng: c.lng, count: c.count, address: c.address, topCause: top(c.causes), topType: top(c.types) })),
  };
}

const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // กันสูตร Excel
  return '"' + s.replace(/"/g, '""') + '"';
};
function buildCsv(rows) {
  const head = ['รหัส', 'ประเภท', 'สถานะ', 'ที่อยู่', 'ละติจูด', 'ลองจิจูด', 'สาเหตุ', 'ทีมช่าง', 'วัสดุที่ใช้', 'ซ้ำกับ id',
    'แจ้งเมื่อ', 'เริ่มซ่อมเมื่อ', 'ซ่อมเสร็จเมื่อ', 'นาทีถึงเริ่มซ่อม', 'นาทีรวมจนเสร็จ', 'ผู้แจ้ง', 'เบอร์โทร', 'รายละเอียด'];
  const lines = rows.map((o) => [
    o.code, o.type, o.status, o.address, o.lat, o.lng, o.cause, o.crew, o.materials, o.duplicateOf ?? '',
    o.createdAt, o.startedAt ?? '', o.resolvedAt ?? '',
    o.startedAt ? Math.round(minutesBetween(o.createdAt, o.startedAt)) : '',
    o.resolvedAt ? Math.round(minutesBetween(o.createdAt, o.resolvedAt)) : '',
    o.reporterName, o.reporterPhone, o.description,
  ].map(csvCell).join(','));
  return '﻿' + [head.map(csvCell).join(','), ...lines].join('\r\n');
}

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

    if (m === 'GET' && (parts[1] === 'stats' || parts[1] === 'export')) {
      if (!isStaff(req)) return send(res, 401, { error: 'ต้องเข้าสู่ระบบเจ้าหน้าที่' });
      const rows = (await sb('outages?select=*&order=id.desc&limit=5000')).map(fromRow);
      if (parts[1] === 'stats') return send(res, 200, buildStats(rows));
      res.status(200).setHeader('Content-Type', 'text/csv; charset=utf-8').send(buildCsv(rows));
      return;
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
        const reporterName = clean(b.reporterName, 100), reporterPhone = clean(b.reporterPhone, 20);
        if (!reporterName) return send(res, 400, { error: 'กรุณากรอกชื่อเล่น' });
        if (!/^[0-9+\-\s]{9,20}$/.test(reporterPhone)) return send(res, 400, { error: 'กรุณากรอกเบอร์โทรให้ถูกต้อง (ตัวเลข 9–20 หลัก)' });
        if (b.consent !== true) return send(res, 400, { error: 'กรุณากดยินยอมให้เก็บชื่อเล่นและเบอร์โทร' });
        const now = new Date().toISOString();

        // กันสแปม: จำกัดจำนวนการแจ้งต่อ IP (เก็บเฉพาะค่าแฮช)
        const ipHash = clientIpHash(req);
        const since = encodeURIComponent(new Date(Date.now() - RATE_WINDOW_MS).toISOString());
        const recent = await sb(`outages?select=id&ip_hash=eq.${ipHash}&created_at=gte.${since}&limit=${RATE_LIMIT}`);
        if (recent.length >= RATE_LIMIT) return send(res, 429, { error: 'แจ้งถี่เกินไป กรุณารอสักครู่แล้วลองใหม่' });

        // ตรวจเหตุซ้ำ: ชนิดเดียวกัน ยังไม่ปิด ภายใน 150 ม. / 24 ชม.
        const dupSince = encodeURIComponent(new Date(Date.now() - DUP_WINDOW_MS).toISOString());
        const open = await sb(`outages?select=id,code,lat,lng&type=eq.${b.type}&status=neq.resolved&duplicate_of=is.null&created_at=gte.${dupSince}&limit=200`);
        const near = open.find((o) => distM({ lat, lng }, o) <= DUP_RADIUS_M);

        const [row] = await sb('outages', { method: 'POST', body: {
          code: 'PW' + crypto.randomBytes(3).toString('hex').toUpperCase(),
          type: b.type, description: clean(b.description, 500), address, lat, lng,
          reporter_name: reporterName, reporter_phone: reporterPhone, consent: true,
          ip_hash: ipHash, duplicate_of: near ? near.id : null,
          status: 'pending', crew: '', created_at: now, updated_at: now,
          history: [{ status: 'pending', note: 'รับเรื่องแล้ว', public: true, at: now }],
        } });
        return send(res, 201, { ...publicView(fromRow(row)), alreadyReported: !!near });
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
        if (b.materials !== undefined) patch.materials = clean(b.materials, 300);
        if (b.cause !== undefined) {
          if (!CAUSES.includes(b.cause)) return send(res, 400, { error: 'สาเหตุไม่ถูกต้อง' });
          patch.cause = b.cause;
        }
        // ปิดงานต้องระบุสาเหตุ (ใช้ค่าใหม่ที่ส่งมา หรือค่าที่เคยบันทึกไว้)
        if (b.status === 'resolved' && !(patch.cause ?? o.cause)) {
          return send(res, 400, { error: 'กรุณาระบุสาเหตุก่อนปิดงาน (สถานะ "แก้ไขแล้ว")' });
        }
        if (b.unmerge === true) patch.duplicate_of = null;
        if (statusChanged) {
          patch.status = b.status;
          if (b.status === 'in_progress' && !o.startedAt) patch.started_at = now;
          if (b.status === 'resolved') { patch.resolved_at = now; if (!o.startedAt) patch.started_at = now; }
          if (b.status !== 'resolved') patch.resolved_at = null; // เปิดงานใหม่
        }
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
