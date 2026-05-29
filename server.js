// server.js
// Single-file Node.js + Express + SQLite leaderboard API
// Run: node server.js
// Or:  pm2 start server.js --name leaderboard-api
//
// Endpoints:
// POST /api/register
// POST /api/score
// GET  /api/leaderboard?limit=10
// GET  /api/health

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3001);
const DATABASE_FILE = process.env.DATABASE_FILE || path.join(__dirname, 'leaderboard.db');
const ADMIN_PASSWORD_FILE = process.env.ADMIN_PASSWORD_FILE || path.join(__dirname, '.admin-password');
const MAX_LAP_SECONDS = Number(process.env.MAX_LAP_SECONDS || 200000); // 약 55시간 33분
const DEFAULT_LIMIT = Number(process.env.DEFAULT_LIMIT || 10);

const app = express();

// Nginx Proxy Manager 뒤에서 동작할 때 필요
//app.set('trust proxy', 'loopback');
// 127.0.0.1(자기자신)과 로컬 사설망 대역을 신뢰함
app.set('trust proxy', ['127.0.0.1', '100.64.0.0/10']);


app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '64kb' }));

app.use('/api/', rateLimit({
  windowMs: 10 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
}));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.ip} ${req.method} ${req.originalUrl}`);
  next();
});

// DB 파일 경로 디렉터리 보장
const dbDir = path.dirname(DATABASE_FILE);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(DATABASE_FILE, (err) => {
  if (err) {
    console.error('[DB] open failed:', err.message);
    process.exit(1);
  }
  console.log(`[DB] opened: ${DATABASE_FILE}`);
});

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function jsonError(res, status, message) {
  return res.status(status).json({ status: 'error', message });
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readAdminPassword() {
  try {
    if (!fs.existsSync(ADMIN_PASSWORD_FILE)) {
      console.warn(`[AUTH] admin password file not found: ${ADMIN_PASSWORD_FILE}`);
      return null;
    }

    const password = fs.readFileSync(ADMIN_PASSWORD_FILE, 'utf8').trim();
    if (!password) {
      console.warn(`[AUTH] admin password file is empty: ${ADMIN_PASSWORD_FILE}`);
      return null;
    }

    return password;
  } catch (err) {
    console.error('[AUTH] failed to read admin password file:', err.message);
    return null;
  }
}

function extractBasicAuthPassword(req) {
  const header = normalizeString(req.headers.authorization);
  if (!header.startsWith('Basic ')) return '';

  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex === -1) return '';
    return decoded.slice(separatorIndex + 1);
  } catch {
    return '';
  }
}

function requireAdminPassword(req, res, next) {
  const adminPassword = readAdminPassword();
  if (!adminPassword) {
    return jsonError(res, 503, 'admin password is not configured');
  }

  const requestPassword = extractBasicAuthPassword(req);
  if (!requestPassword || requestPassword !== adminPassword) {
    res.setHeader('WWW-Authenticate', 'Basic realm="pyeong leaderboard admin"');
    return jsonError(res, 401, 'admin authentication required');
  }

  return next();
}

function validateRegisterBody(body) {
  const deviceId = normalizeString(body?.device_id);
  const userName = normalizeString(body?.user_name);

  if (!deviceId) {
    return { ok: false, message: 'device_id is required' };
  }
  if (!userName) {
    return { ok: false, message: 'user_name is required' };
  }
  if (userName.length < 2 || userName.length > 32) {
    return { ok: false, message: 'user_name must be 2..32 characters' };
  }

  return { ok: true, deviceId, userName };
}

function validateNickname(value) {
  const nickname = normalizeString(value);

  if (!nickname) {
    return { ok: false, message: 'nickname is required' };
  }
  if (nickname.length < 2 || nickname.length > 32) {
    return { ok: false, message: 'nickname must be 2..32 characters' };
  }

  return { ok: true, nickname };
}

function validateScoreBody(body) {
  const deviceId = normalizeString(body?.device_id);
  const rawLapSeconds = body?.lap_seconds;
  const lapTimeText = normalizeString(body?.lap_time_text);

  if (!deviceId) {
    return { ok: false, message: 'device_id is required' };
  }

  const lapSeconds = Number(rawLapSeconds);
  if (!Number.isFinite(lapSeconds)) {
    return { ok: false, message: 'lap_seconds must be a number' };
  }
  if (lapSeconds <= 0) {
    return { ok: false, message: 'lap_seconds must be greater than 0' };
  }
  if (lapSeconds > MAX_LAP_SECONDS) {
    return { ok: false, message: `lap_seconds is too large (max ${MAX_LAP_SECONDS})` };
  }

  return {
    ok: true,
    deviceId,
    lapSeconds,
    lapTimeText: lapTimeText || null,
  };
}

async function initDb() {
  await dbRun('PRAGMA foreign_keys = ON;');

  await dbRun(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL UNIQUE,
      user_name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      lap_seconds REAL NOT NULL,
      lap_time_text TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  await dbRun(`CREATE INDEX IF NOT EXISTS idx_users_device_id ON users(device_id);`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_scores_user_lap ON scores(user_id, lap_seconds);`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_scores_lap_seconds ON scores(lap_seconds);`);

  console.log('[DB] schema ready');
}

// Healthcheck
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'leaderboard-api',
    ts: new Date().toISOString(),
  });
});

app.get('/admin', (req, res) => {
  const adminPassword = readAdminPassword();
  if (!adminPassword) {
    return jsonError(res, 503, 'admin password is not configured');
  }

  const requestPassword = extractBasicAuthPassword(req);
  if (!requestPassword || requestPassword !== adminPassword) {
    res.setHeader('WWW-Authenticate', 'Basic realm="pyeong leaderboard admin"');
    return jsonError(res, 401, 'admin authentication required');
  }

  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self';"
  );
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// 유저 등록/업데이트 (UPSERT)
app.post('/api/register', async (req, res) => {
  try {
    const v = validateRegisterBody(req.body);
    if (!v.ok) return jsonError(res, 400, v.message);

    await dbRun(
      `
      INSERT INTO users (device_id, user_name)
      VALUES (?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        user_name = excluded.user_name,
        updated_at = CURRENT_TIMESTAMP
      `,
      [v.deviceId, v.userName]
    );

    const user = await dbGet(
      `SELECT id, device_id, user_name, created_at, updated_at FROM users WHERE device_id = ?`,
      [v.deviceId]
    );

    return res.json({
      status: 'ok',
      user_id: user.id,
      device_id: user.device_id,
      user_name: user.user_name,
    });
  } catch (err) {
    console.error('[POST /register] error:', err);
    return jsonError(res, 500, 'internal server error');
  }
});

// 점수 제출
app.post('/api/score', async (req, res) => {
  try {
    const v = validateScoreBody(req.body);
    if (!v.ok) return jsonError(res, 400, v.message);

    const user = await dbGet(
      `SELECT id, device_id, user_name FROM users WHERE device_id = ?`,
      [v.deviceId]
    );

    if (!user) {
      return jsonError(res, 404, 'user not found. please register first.');
    }

    const inserted = await dbRun(
      `INSERT INTO scores (user_id, lap_seconds, lap_time_text) VALUES (?, ?, ?)`,
      [user.id, v.lapSeconds, v.lapTimeText]
    );

    return res.json({
      status: 'ok',
      saved: true,
      score_id: inserted.lastID,
      user_id: user.id,
      device_id: user.device_id,
    });
  } catch (err) {
    console.error('[POST /score] error:', err);
    return jsonError(res, 500, 'internal server error');
  }
});

// 리더보드 조회: 유저별 개인 최고기록(Personal Best) 기준 상위 limit개
app.get('/api/leaderboard', async (req, res) => {
  try {
    const limitRaw = Number(req.query.limit || DEFAULT_LIMIT);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 100) : DEFAULT_LIMIT;

    const rows = await dbAll(
      `
      WITH best_scores AS (
        SELECT
          s.user_id,
          s.lap_seconds,
          s.lap_time_text,
          s.created_at,
          ROW_NUMBER() OVER (
            PARTITION BY s.user_id
            ORDER BY s.lap_seconds ASC, s.id ASC
          ) AS rn
        FROM scores s
      )
      SELECT
        u.user_name AS player_name,
        bs.lap_seconds,
        bs.lap_time_text
      FROM best_scores bs
      JOIN users u ON u.id = bs.user_id
      WHERE bs.rn = 1
      ORDER BY bs.lap_seconds ASC, u.user_name ASC
      LIMIT ?
      `,
      [limit]
    );

    const result = rows.map((row, index) => ({
      rank: index + 1,
      player_name: row.player_name,
      lap_seconds: row.lap_seconds,
      lap_time_text: row.lap_time_text,
    }));

    return res.json(result);
  } catch (err) {
    console.error('[GET /leaderboard] error:', err);
    return jsonError(res, 500, 'internal server error');
  }
});

app.get('/api/admin/users', requireAdminPassword, async (req, res) => {
  try {
    const query = normalizeString(req.query.query);
    const limitRaw = Number(req.query.limit || 100);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 200) : 100;
    const likeQuery = query ? `%${query}%` : null;

    const rows = await dbAll(
      `
      SELECT id, device_id, user_name, created_at, updated_at
      FROM users
      WHERE (? IS NULL OR user_name LIKE ? OR device_id LIKE ? OR CAST(id AS TEXT) LIKE ?)
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
      `,
      [likeQuery, likeQuery, likeQuery, likeQuery, limit]
    );

    return res.json({
      status: 'ok',
      count: rows.length,
      users: rows,
    });
  } catch (err) {
    console.error('[GET /api/admin/users] error:', err);
    return jsonError(res, 500, 'internal server error');
  }
});

app.put('/api/admin/users/:id', requireAdminPassword, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return jsonError(res, 400, 'invalid user id');
    }

    const v = validateNickname(req.body?.nickname ?? req.body?.user_name);
    if (!v.ok) return jsonError(res, 400, v.message);

    const updated = await dbRun(
      `
      UPDATE users
      SET user_name = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
      `,
      [v.nickname, userId]
    );

    if (!updated.changes) {
      return jsonError(res, 404, 'user not found');
    }

    const user = await dbGet(
      `SELECT id, device_id, user_name, created_at, updated_at FROM users WHERE id = ?`,
      [userId]
    );

    return res.json({
      status: 'ok',
      user,
    });
  } catch (err) {
    console.error('[PUT /api/admin/users/:id] error:', err);
    return jsonError(res, 500, 'internal server error');
  }
});

// Generic error handler
app.use((err, req, res, next) => {
  console.error('[Unhandled error]', err);
  return jsonError(res, 500, 'internal server error');
});

(async () => {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`[HTTP] listening on ${PORT}`);
      console.log(`[HTTP] behind NPM, proxy https://api.pyeong.p-e.kr/api -> http://127.0.0.1:${PORT}/api`);
    });
  } catch (err) {
    console.error('[BOOT] failed:', err);
    process.exit(1);
  }
})();
