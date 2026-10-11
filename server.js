const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
if (!process.env.JWT_SECRET) console.warn('JWT_SECRET не задан: используется запасной ключ, так нельзя в продакшене');

// Railway Postgres: внутренний адрес без SSL, внешний требует SSL
const dbUrl = process.env.DATABASE_URL || '';
const pool = new Pool({
  connectionString: dbUrl,
  ssl: /railway\.internal/.test(dbUrl) ? false : { rejectUnauthorized: false },
});

app.use(express.json({ limit: '12mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const TABLES = {
  models:     { t: 'car_models', cols: ['name', 'slug', 'sort', 'active', 'image_id'], order: 'sort, id' },
  categories: { t: 'categories', cols: ['name_ru', 'name_uz', 'slug', 'sort', 'active', 'image_id'], order: 'sort, id' },
  products:   { t: 'products', cols: ['code', 'category_id', 'name_ru', 'name_uz', 'desc_ru', 'desc_uz', 'price', 'active'], order: 'id DESC' },
};
const PSQL = `SELECT p.*, COALESCE(array_agg(pf.model_id) FILTER (WHERE pf.model_id IS NOT NULL), '{}') AS fits,
  COALESCE((SELECT array_agg(pi.image_id ORDER BY pi.sort) FROM product_images pi WHERE pi.product_id = p.id), '{}') AS images
  FROM products p LEFT JOIN product_fits pf ON pf.product_id = p.id`;

const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  console.error(e);
  res.status(400).json({ error: e.message });
});
const auth = (req, res, next) => {
  try { req.admin = jwt.verify(req.cookies.adm, SECRET); next(); }
  catch { res.status(401).json({ error: 'unauthorized' }); }
};
const entity = (req, res, next) => {
  req.T = TABLES[req.params.e];
  if (!req.T) return res.status(404).json({ error: 'not found' });
  next();
};
const slugify = s => (s || '').toLowerCase().trim()
  .replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-+|-+$/g, '') || 'item';

function pick(T, body) {
  const out = {};
  for (const c of T.cols) {
    if (body[c] === undefined) continue;
    out[c] = body[c] === '' && c === 'category_id' ? null : body[c];
  }
  return out;
}

async function save(e, id, body) {
  const T = TABLES[e];
  const data = pick(T, body);
  if (!id && T.cols.includes('slug') && !data.slug)
    data.slug = slugify(data.name || data.name_ru) + '-' + Math.random().toString(36).slice(2, 6);
  if (T.cols.includes('slug') && data.slug === '') delete data.slug;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const keys = Object.keys(data), vals = Object.values(data);
    let rid = id;
    if (id) {
      if (keys.length) await client.query(
        `UPDATE ${T.t} SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(', ')} WHERE id=$${keys.length + 1}`,
        [...vals, id]);
    } else {
      const { rows } = await client.query(
        `INSERT INTO ${T.t} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, vals);
      rid = rows[0].id;
    }
    if (e === 'products' && Array.isArray(body.fits)) {
      await client.query('DELETE FROM product_fits WHERE product_id=$1', [rid]);
      if (body.fits.length) await client.query(
        'INSERT INTO product_fits(product_id, model_id) SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING',
        [rid, body.fits.map(Number)]);
    }
    if (e === 'products' && Array.isArray(body.images)) {
      await client.query('DELETE FROM product_images WHERE product_id=$1', [rid]);
      if (body.images.length) await client.query(
        'INSERT INTO product_images(product_id, image_id, sort) SELECT $1, x.id, x.ord FROM unnest($2::int[]) WITH ORDINALITY AS x(id, ord) ON CONFLICT DO NOTHING',
        [rid, body.images.map(Number)]);
    }
    await client.query('COMMIT');
    return rid;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---- auth ----
app.post('/api/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const { rows } = await pool.query('SELECT * FROM admins WHERE email=$1', [email]);
  const a = rows[0];
  if (!a || !(await bcrypt.compare(password || '', a.password_hash)))
    return res.status(401).json({ error: 'Неверный email или пароль' });
  const token = jwt.sign({ id: a.id, email: a.email }, SECRET, { expiresIn: '7d' });
  res.cookie('adm', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 864e5 });
  res.json({ ok: true, email: a.email });
}));
app.post('/api/logout', (req, res) => { res.clearCookie('adm'); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json({ email: req.admin.email }));

// ---- public catalog (для витрины) ----
app.get('/api/public/catalog', wrap(async (req, res) => {
  const [m, c, p] = await Promise.all([
    pool.query('SELECT id, name, slug, image_id FROM car_models WHERE active ORDER BY sort, id'),
    pool.query('SELECT id, name_ru, name_uz, slug, image_id FROM categories WHERE active ORDER BY sort, id'),
    pool.query(`${PSQL} WHERE p.active GROUP BY p.id ORDER BY p.id`),
  ]);
  res.json({ models: m.rows, categories: c.rows, products: p.rows });
}));

// ---- admin CRUD ----
app.get('/api/admin/:e', auth, entity, wrap(async (req, res) => {
  const q = req.params.e === 'products'
    ? `${PSQL} GROUP BY p.id ORDER BY p.id DESC`
    : `SELECT * FROM ${req.T.t} ORDER BY ${req.T.order}`;
  const { rows } = await pool.query(q);
  res.json(rows);
}));
app.post('/api/admin/:e', auth, entity, wrap(async (req, res) => {
  res.json({ id: await save(req.params.e, null, req.body || {}) });
}));
app.put('/api/admin/:e/:id', auth, entity, wrap(async (req, res) => {
  res.json({ id: await save(req.params.e, Number(req.params.id), req.body || {}) });
}));
app.delete('/api/admin/:e/:id', auth, entity, wrap(async (req, res) => {
  await pool.query(`DELETE FROM ${req.T.t} WHERE id=$1`, [Number(req.params.id)]);
  res.json({ ok: true });
}));

// ---- фото и тексты ----
app.post('/api/admin/upload', auth, wrap(async (req, res) => {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(req.body.data || '');
  if (!m) throw new Error('Нужна картинка JPEG, PNG или WebP');
  const { rows } = await pool.query('INSERT INTO images(mime, data) VALUES ($1, $2) RETURNING id', [m[1], Buffer.from(m[2], 'base64')]);
  res.json({ id: rows[0].id });
}));
app.get('/api/img/:id', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT mime, data FROM images WHERE id=$1', [Number(req.params.id)]);
  if (!rows[0]) return res.status(404).end();
  res.set('Content-Type', rows[0].mime);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.end(rows[0].data);
}));
async function textsObj() {
  const { rows } = await pool.query('SELECT key, ru, uz FROM site_texts ORDER BY key');
  return Object.fromEntries(rows.map(r => [r.key, { ru: r.ru, uz: r.uz }]));
}
app.get('/api/public/texts', wrap(async (req, res) => res.json(await textsObj())));
app.get('/api/admin/texts', auth, wrap(async (req, res) => res.json(await textsObj())));
app.put('/api/admin/texts/:key', auth, wrap(async (req, res) => {
  await pool.query('UPDATE site_texts SET ru=$2, uz=$3 WHERE key=$1', [req.params.key, req.body.ru ?? '', req.body.uz ?? '']);
  res.json({ ok: true });
}));

// ---- boot: миграции и первый админ из переменных окружения ----
async function boot() {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, 'texts-defaults.json'), 'utf8'));
  for (const [k, v] of Object.entries(defaults))
    await pool.query('INSERT INTO site_texts(key, ru, uz) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING', [k, v.ru, v.uz]);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM admins');
  if (rows[0].n === 0 && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    await pool.query('INSERT INTO admins(email, password_hash) VALUES ($1, $2)',
      [process.env.ADMIN_EMAIL, await bcrypt.hash(process.env.ADMIN_PASSWORD, 10)]);
    console.log('Создан администратор:', process.env.ADMIN_EMAIL);
  }
  app.listen(PORT, () => console.log('GoCase admin на порту', PORT, '→ /admin.html'));
}
boot().catch(e => { console.error('Ошибка запуска:', e); process.exit(1); });
