// เซิร์ฟเวอร์แจ้งและจัดการไฟฟ้าขัดข้อง — ไม่ต้องติดตั้งแพ็กเกจเพิ่ม (Node 18+)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = process.env.PORT || 3000;
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'admin1234';
const DB_FILE = path.join(__dirname, '..', 'data', 'outages.json');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STATUSES = ['pending', 'in_progress', 'resolved'];
const TYPES = ['power_out', 'wire_down', 'transformer', 'pole', 'flicker', 'other'];

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
let db = { seq: 0, outages: [] };
if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

const tokens = new Set();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e5) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('bad json')); } });
  });
}

const isStaff = (req) => tokens.has((req.headers.authorization || '').replace('Bearer ', ''));
const clean = (v, n) => String(v ?? '').trim().slice(0, n);

// ข้อมูลที่ประชาชนเห็นได้ (ซ่อนเบอร์โทร/ชื่อผู้แจ้ง)
const publicView = (o) => ({
  id: o.id, code: o.code, type: o.type, description: o.description, address: o.address,
  lat: o.lat, lng: o.lng, status: o.status, createdAt: o.createdAt, updatedAt: o.updatedAt,
  history: o.history.map((h) => ({ status: h.status, note: h.public ? h.note : '', at: h.at })),
});

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const m = req.method;

  if (m === 'POST' && parts[1] === 'login') {
    const { password } = await readBody(req);
    if (password !== STAFF_PASSWORD) return send(res, 401, { error: 'รหัสผ่านไม่ถูกต้อง' });
    const t = crypto.randomUUID();
    tokens.add(t);
    return send(res, 200, { token: t });
  }

  if (parts[1] === 'outages') {
    if (m === 'GET' && !parts[2]) {
      const staff = isStaff(req);
      const list = [...db.outages].reverse().map((o) => (staff ? o : publicView(o)));
      return send(res, 200, list);
    }
    if (m === 'GET' && parts[2] === 'track') {
      const o = db.outages.find((x) => x.code === (url.searchParams.get('code') || '').toUpperCase());
      return o ? send(res, 200, publicView(o)) : send(res, 404, { error: 'ไม่พบรหัสนี้' });
    }
    if (m === 'POST' && !parts[2]) {
      const b = await readBody(req);
      const lat = Number(b.lat), lng = Number(b.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return send(res, 400, { error: 'กรุณาปักหมุดตำแหน่งบนแผนที่' });
      if (!TYPES.includes(b.type)) return send(res, 400, { error: 'ประเภทไม่ถูกต้อง' });
      const address = clean(b.address, 200);
      if (!address) return send(res, 400, { error: 'กรุณากรอกที่อยู่/จุดสังเกต' });
      const now = new Date().toISOString();
      db.seq += 1;
      const o = {
        id: db.seq,
        code: 'PW' + crypto.randomBytes(3).toString('hex').toUpperCase(),
        type: b.type, description: clean(b.description, 500), address, lat, lng,
        reporterName: clean(b.reporterName, 100), reporterPhone: clean(b.reporterPhone, 20),
        status: 'pending', crew: '', createdAt: now, updatedAt: now,
        history: [{ status: 'pending', note: 'รับเรื่องแล้ว', public: true, at: now }],
      };
      db.outages.push(o);
      save();
      return send(res, 201, publicView(o));
    }
    if (m === 'PATCH' && parts[2]) {
      if (!isStaff(req)) return send(res, 401, { error: 'ต้องเข้าสู่ระบบเจ้าหน้าที่' });
      const o = db.outages.find((x) => x.id === Number(parts[2]));
      if (!o) return send(res, 404, { error: 'ไม่พบรายการ' });
      const b = await readBody(req);
      if (b.status !== undefined && !STATUSES.includes(b.status)) return send(res, 400, { error: 'สถานะไม่ถูกต้อง' });
      const now = new Date().toISOString();
      const statusChanged = b.status && b.status !== o.status;
      if (b.crew !== undefined) o.crew = clean(b.crew, 100);
      if (statusChanged) o.status = b.status;
      if (statusChanged || b.note) {
        o.history.push({ status: o.status, note: clean(b.note, 300) || (statusChanged ? '' : ''), public: b.publicNote !== false, at: now });
      }
      o.updatedAt = now;
      save();
      return send(res, 200, o);
    }
  }

  send(res, 404, { error: 'ไม่พบ API' });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    let file = url.pathname === '/' ? '/index.html' : url.pathname === '/staff' ? '/staff.html' : url.pathname === '/track' ? '/track.html' : url.pathname;
    const full = path.normalize(path.join(PUBLIC_DIR, file));
    if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404); return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    send(res, 400, { error: e.message });
  }
}).listen(PORT, () => {
  console.log(`ประชาชน:    http://localhost:${PORT}/`);
  console.log(`เจ้าหน้าที่: http://localhost:${PORT}/staff  (รหัสผ่านเริ่มต้น: ${STAFF_PASSWORD})`);
});
