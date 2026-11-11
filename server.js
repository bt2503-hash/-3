'use strict';
// ТехноДім — сервер (Node.js 18+). Єдина необов’язкова залежність: nodemailer (для реальної відправки email).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = __dirname, PUB = path.join(ROOT, 'public'), DATA = path.join(ROOT, 'data'), DBF = path.join(DATA, 'db.json'), OUT = path.join(ROOT, 'outbox');

// .env
try {
  for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !l.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}
const E = process.env, PORT = +E.PORT || 3000;
let nm = null; try { nm = require('nodemailer'); } catch {}

const CATS = ['Велика побутова техніка', 'Дрібна побутова техніка', 'Техніка для кухні'];
const DL = { np: ['Нова пошта', 80], up: ['Укрпошта', 55], pk: ['Самовивіз з магазину', 0] };
const PAY = ['Картка онлайн', 'Оплата при отриманні', 'Безготівковий розрахунок'];
const RATE = 0.05, FREE_FROM = 5000;
const money = n => Number(n).toLocaleString('uk-UA') + ' ₴';

fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(path.join(PUB, 'uploads'), { recursive: true });

// ---- база даних (JSON-файл) ----
const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
const check = (pw, h) => { const [s, x] = h.split(':'); const a = Buffer.from(hash(pw, s).split(':')[1], 'hex'), b = Buffer.from(x, 'hex'); return a.length === b.length && crypto.timingSafeEqual(a, b); };
let db;
try { db = JSON.parse(fs.readFileSync(DBF, 'utf8')); }
catch { db = { users: [], products: JSON.parse(fs.readFileSync(path.join(ROOT, 'seed.json'), 'utf8')), orders: [], sessions: {}, reviews: [], favorites: {}, nextOrder: 1001 }; }
db.reviews ||= []; db.favorites ||= {}; db.orders ||= []; db.sessions ||= {};
if (!db.users.some(u => u.role === 'admin'))
  db.users.push({ email: (E.ADMIN_EMAIL || 'admin@tekhnodim.ua').toLowerCase(), pass: hash(E.ADMIN_PASSWORD || 'admin123'), name: 'Адміністратор', phone: '', role: 'admin', bonus: 0 });
// Синхронізувати нові демонстраційні товари із seed.json, не перезаписуючи зміни адміністратора.
try {
  const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'seed.json'), 'utf8'));
  for (const sp of seed) {
    const p = db.products.find(x => x.id === sp.id);
    if (!p) db.products.push(sp);
    else if (!p.photo && sp.photo) { p.photo = sp.photo; p.photos = sp.photos; }
  }
} catch {}
const persist = () => { fs.writeFileSync(DBF + '.tmp', JSON.stringify(db)); fs.renameSync(DBF + '.tmp', DBF); };
persist();
const pub = u => ({ email: u.email, name: u.name, phone: u.phone, role: u.role, bonus: u.bonus });

// ---- email ----
async function sendMail(to, subject, text) {
  if (nm && E.SMTP_HOST) {
    try {
      const port = +E.SMTP_PORT || 587;
      const t = nm.createTransport({ host: E.SMTP_HOST, port, secure: port === 465, auth: { user: E.SMTP_USER, pass: E.SMTP_PASS } });
      await t.sendMail({ from: E.MAIL_FROM || E.SMTP_USER, to, subject, text });
      return true;
    } catch (e) { console.error('SMTP помилка:', e.message); }
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, Date.now() + '-' + to.replace(/[^\w.@-]/g, '_') + '.txt'), `Кому: ${to}\nТема: ${subject}\n\n${text}`);
  console.log('[email не надіслано — SMTP не налаштовано, збережено в outbox/]', to, subject);
  return false;
}
function rtext(o) {
  return `ЧЕК № ${o.id} — ТехноДім\nДата: ${o.date}\nКлієнт: ${o.contact.name}, ${o.contact.phone}\n\n` +
    o.items.map(i => `${i.name} × ${i.q} = ${money(i.price * i.q)}`).join('\n') +
    `\n\nТовари: ${money(o.goods)}\nСписано бонусів: −${o.spent} ₴\nДоставка (${o.delivery}): ${o.fee ? money(o.fee) : 'безкоштовно'}\nАдреса: ${o.addr}\nОплата: ${o.pay}\nРАЗОМ: ${money(o.total)}\nНараховано бонусів: +${o.earn}\n\nДякуємо за покупку!`;
}

// ---- допоміжне ----
class HE extends Error { constructor(c, m) { super(m); this.c = c; } }
const send = (res, c, o, h = {}) => { res.writeHead(c, { 'Content-Type': 'application/json; charset=utf-8', ...h }); res.end(JSON.stringify(o)); };
const body = r => new Promise((ok, no) => {
  let b = '', n = 0;
  r.on('data', d => { n += d.length; if (n > 8e6) { no(new HE(413, 'Завеликий запит')); r.destroy(); } else b += d; });
  r.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { no(new HE(400, 'Невірний JSON')); } });
});
const cookies = r => Object.fromEntries((r.headers.cookie || '').split(/;\s*/).filter(Boolean).map(c => { const i = c.indexOf('='); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
const authUser = r => { const t = cookies(r).sid, s = t && db.sessions[t]; if (!s || s.exp < Date.now()) return null; return db.users.find(u => u.email === s.email) || null; };
const need = (u, admin) => { if (!u) throw new HE(401, 'Потрібен вхід'); if (admin && u.role !== 'admin') throw new HE(403, 'Лише для адміністратора'); return u; };
function login(res, u) {
  const t = crypto.randomBytes(24).toString('hex');
  db.sessions[t] = { email: u.email, exp: Date.now() + 7 * 864e5 }; persist();
  send(res, 200, { user: pub(u) }, { 'Set-Cookie': `sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800` });
}
function savePhoto(d) {
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(d || '');
  if (!m) return String(d || '').startsWith('/uploads/') ? d : '';
  const f = '/uploads/' + Date.now() + '-' + crypto.randomBytes(3).toString('hex') + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
  fs.writeFileSync(path.join(PUB, f), Buffer.from(m[2], 'base64'));
  return f;
}
function prod(b, old) {
  const s = k => String(b[k] ?? '').trim().slice(0, 2000);
  if (!s('name') || !s('maker')) throw new HE(400, 'Вкажіть назву та виробника');
  if (!CATS.includes(b.cat)) throw new HE(400, 'Невірна категорія');
  const price = Number(b.price); if (!(price >= 0)) throw new HE(400, 'Невірна ціна');
  let photos = old ? (old.photos || (old.photo ? [old.photo] : [])) : [];
  if (Array.isArray(b.photos) && b.photos.length) photos = b.photos.slice(0, 6).map(savePhoto).filter(Boolean);
  return { name: s('name'), cat: b.cat, maker: s('maker'), model: s('model'), price, warranty: Math.max(0, +b.warranty || 0), emoji: s('emoji') || '📦', specs: String(b.specs || '').slice(0, 3000), desc: s('desc'), photos, photo: photos[0] || '' };
}

// ---- API ----
async function api(req, res, p) {
  const m = req.method, u = authUser(req);
  let r;
  if (m === 'GET' && p === '/me') return send(res, 200, { user: u ? pub(u) : null });
  if (m === 'GET' && p === '/products') return send(res, 200, db.products);
  if (m === 'GET' && p === '/favorites') { need(u); return send(res, 200, db.favorites[u.email] || []); }
  if (m === 'PUT' && p === '/favorites') {
    need(u); const b = await body(req), ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(Number).filter(id => db.products.some(x => x.id === id)))];
    db.favorites[u.email] = ids; persist(); return send(res, 200, ids);
  }
  if (m === 'GET' && p === '/reviews') {
    const id = +(new URL(req.url, 'http://x').searchParams.get('productId') || 0);
    return send(res, 200, db.reviews.filter(x => !id || x.productId === id).filter(x => x.status === 'Опубліковано' || (u && (u.role === 'admin' || x.email === u.email))));
  }
  if (m === 'POST' && p === '/reviews') {
    need(u); if (u.role === 'admin') throw new HE(403, 'Обліковий запис адміністратора призначений лише для керування магазином');
    const b = await body(req), productId = +b.productId, rating = +b.rating, product = db.products.find(x => x.id === productId);
    if (!product || !Number.isInteger(rating) || rating < 1 || rating > 5) throw new HE(400, 'Перевірте товар та оцінку');
    if (db.reviews.some(x => x.productId === productId && x.email === u.email)) throw new HE(409, 'Ви вже залишили відгук на цей товар');
    const review = { id: crypto.randomBytes(8).toString('hex'), productId, email: u.email, name: u.name, rating, text: String(b.text || '').trim().slice(0, 1200), date: new Date().toLocaleDateString('uk-UA'), status: 'На модерації' };
    if (!review.text) throw new HE(400, 'Напишіть текст відгуку');
    db.reviews.push(review); persist(); return send(res, 201, review);
  }
  if ((r = /^\/reviews\/([a-f0-9]+)\/moderate$/.exec(p)) && m === 'POST') {
    need(u, 1); const review = db.reviews.find(x => x.id === r[1]); if (!review) throw new HE(404, 'Відгук не знайдено');
    const b = await body(req); if (!['Опубліковано', 'Відхилено'].includes(b.status)) throw new HE(400, 'Невірний статус');
    review.status = b.status; persist(); return send(res, 200, review);
  }
  if (m === 'GET' && p === '/admin/users') { need(u, 1); return send(res, 200, db.users.filter(x => x.role !== 'admin').map(x => ({email:x.email,name:x.name,phone:x.phone,bonus:x.bonus,orders:db.orders.filter(o=>o.email===x.email).length}))); }
  if (m === 'GET' && p === '/admin/stats') { need(u, 1); return send(res, 200, {users:db.users.filter(x=>x.role!=='admin').length,orders:db.orders.length,newOrders:db.orders.filter(x=>x.status==='Нове').length,revenue:db.orders.filter(x=>x.status!=='Відхилено').reduce((a,o)=>a+o.total,0),reviews:db.reviews.filter(x=>x.status==='На модерації').length}); }

  if (m === 'POST' && p === '/register') {
    const b = await body(req), email = String(b.email || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new HE(400, 'Невірний email');
    if (String(b.password || '').length < 6) throw new HE(400, 'Пароль — щонайменше 6 символів');
    if (db.users.some(x => x.email === email)) throw new HE(409, 'Такий email уже зареєстровано');
    const nu = { email, pass: hash(b.password), name: String(b.name || '').trim().slice(0, 80) || email.split('@')[0], phone: '', role: 'user', bonus: 100 };
    db.users.push(nu); return login(res, nu);
  }
  if (m === 'POST' && p === '/login') {
    const b = await body(req), x = db.users.find(z => z.email === String(b.email || '').trim().toLowerCase());
    if (!x || !check(String(b.password || ''), x.pass)) throw new HE(401, 'Невірний email або пароль');
    return login(res, x);
  }
  if (m === 'POST' && p === '/logout') { const t = cookies(req).sid; if (t) { delete db.sessions[t]; persist(); } return send(res, 200, { ok: 1 }, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' }); }
  if (m === 'PUT' && p === '/me') {
    need(u); const b = await body(req);
    u.name = String(b.name || u.name).trim().slice(0, 80); u.phone = String(b.phone || '').trim().slice(0, 30); persist();
    return send(res, 200, { user: pub(u) });
  }

  // товари (адмін)
  if (m === 'POST' && p === '/products') {
    need(u, 1); const d = prod(await body(req));
    const np = { id: Math.max(0, ...db.products.map(x => x.id)) + 1, ...d }; db.products.push(np); persist(); return send(res, 201, np);
  }
  if ((r = /^\/products\/(\d+)$/.exec(p)) && (m === 'PUT' || m === 'DELETE')) {
    need(u, 1); const i = db.products.findIndex(x => x.id === +r[1]); if (i < 0) throw new HE(404, 'Товар не знайдено');
    if (m === 'DELETE') { db.products.splice(i, 1); persist(); return send(res, 200, { ok: 1 }); }
    const old = db.products[i], d = prod(await body(req), old);
    db.products[i] = { id: old.id, ...d }; persist(); return send(res, 200, db.products[i]);
  }

  // замовлення
  if (m === 'GET' && p === '/orders') { need(u); return send(res, 200, u.role === 'admin' ? db.orders : db.orders.filter(o => o.email === u.email)); }
  if (m === 'POST' && p === '/orders') {
    need(u); if (u.role === 'admin') throw new HE(403, 'Адміністратор не може оформлювати покупки з адміністративного акаунта'); const b = await body(req), c = b.contact || {};
    const items = (Array.isArray(b.items) ? b.items : []).map(i => {
      const pr = db.products.find(x => x.id === +i.id), q = Math.floor(+i.q);
      if (!pr || !(q >= 1 && q <= 99)) throw new HE(400, 'Невірний товар у замовленні');
      return { productId: pr.id, name: pr.name + ' ' + pr.model, price: pr.price, q };
    });
    if (!items.length) throw new HE(400, 'Кошик порожній');
    const name = String(c.name || '').trim(), phone = String(c.phone || '').trim(), email = String(c.email || '').trim();
    if (!name || !phone || !/^\S+@\S+\.\S+$/.test(email)) throw new HE(400, 'Вкажіть ім’я, телефон і коректний email');
    const d = DL[b.delivery]; if (!d) throw new HE(400, 'Невірний спосіб доставки');
    if (!PAY.includes(b.pay)) throw new HE(400, 'Невірний спосіб оплати');
    const addr = String(b.address || '').trim().slice(0, 200); if (!addr) throw new HE(400, 'Вкажіть адресу доставки або магазин');
    const goods = items.reduce((a, i) => a + i.price * i.q, 0), fee = b.delivery === 'pk' || goods >= FREE_FROM ? 0 : d[1];
    const spent = Math.max(0, Math.min(Math.floor(+b.bonus || 0), u.bonus || 0, Math.floor(goods / 2)));
    u.bonus -= spent;
    const o = { id: db.nextOrder++, email: u.email, contact: { name, phone, email }, items, goods, spent, fee, total: goods - spent + fee, earn: Math.floor((goods - spent) * RATE), delivery: d[0], addr, pay: b.pay, date: new Date().toLocaleDateString('uk-UA'), status: 'Нове' };
    db.orders.push(o); persist();
    const adm = db.users.find(x => x.role === 'admin');
    sendMail(E.ADMIN_NOTIFY_EMAIL || adm.email, `Нове замовлення № ${o.id}`, rtext(o)).catch(() => {});
    return send(res, 201, o);
  }
  if ((r = /^\/orders\/(\d+)\/(accept|reject|status)$/.exec(p)) && m === 'POST') {
    need(u, 1); const o = db.orders.find(x => x.id === +r[1]); if (!o) throw new HE(404, 'Замовлення не знайдено');
    const cu = db.users.find(x => x.email === o.email);
    if (r[2] === 'accept') {
      if (o.status !== 'Нове') throw new HE(400, 'Замовлення вже оброблено');
      o.status = 'Прийнято'; if (cu) cu.bonus = (cu.bonus || 0) + o.earn;
      persist(); o.receiptSent = await sendMail(o.contact.email, `Чек № ${o.id} — ТехноДім`, rtext(o)); persist();
      return send(res, 200, { order: o, emailed: o.receiptSent });
    }
    if (r[2] === 'reject') {
      if (o.status !== 'Нове') throw new HE(400, 'Замовлення вже оброблено');
      o.status = 'Відхилено'; if (cu) cu.bonus = (cu.bonus || 0) + o.spent; persist(); return send(res, 200, { order: o });
    }
    const b = await body(req);
    if (!['Відправлено', 'Виконано', 'Прийнято'].includes(b.status) || o.status === 'Нове' || o.status === 'Відхилено') throw new HE(400, 'Недопустимий статус');
    o.status = b.status; persist(); return send(res, 200, { order: o });
  }
  throw new HE(404, 'Не знайдено');
}

// ---- статика + запуск ----
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x'), p = decodeURIComponent(url.pathname);
    if (p.startsWith('/api/')) return await api(req, res, p.slice(4));
    const f = path.normalize(path.join(PUB, p === '/' ? 'index.html' : p));
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  } catch (e) {
    if (e instanceof HE) return send(res, e.c, { error: e.message });
    console.error(e); send(res, 500, { error: 'Внутрішня помилка сервера' });
  }
}).listen(PORT, () => console.log(`ТехноДім: http://localhost:${PORT}  (email: ${nm && E.SMTP_HOST ? 'SMTP' : 'режим outbox/'})`));
