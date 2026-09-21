/**
 * Fitness Tracker Worker - Upgraded Version
 * - GitHub OAuth single sign-on
 * - User-scoped data isolation
 * - Session management with 1-year cookie
 * - Manages custom exercises with a dropdown.
 * - Saves workouts as sessions (multiple exercises per session).
 * - Allows deleting workout sessions.
 * - Manages common exercises (shared across all muscle groups).
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

const app = new Hono().basePath('/api');

const FRONTEND_URL = 'https://fitness-dpa.pages.dev';
const SESSION_COOKIE_NAME = 'session_token';
const SESSION_MAX_AGE = 365 * 24 * 60 * 60; // 1 year in seconds
const COMMON_EXERCISE_ADMIN_ENV = 'COMMON_EXERCISE_ADMIN_IDS';

function generateToken() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

// 生成UUID v4（用于同步记录的唯一标识）
function generateUUID() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  array[6] = (array[6] & 0x0f) | 0x40;
  array[8] = (array[8] & 0x3f) | 0x80;
  const hex = Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// --- Lazy Migration: 同步字段迁移（幂等；每个 Worker 隔离实例只执行一次，避免每次请求全表回填浪费 D1 读取） ---
let syncSchemaReady = false;
const UUID_SQL = "lower(hex(randomblob(8)) || '-' || hex(randomblob(4)) || '-4' || substr(hex(randomblob(3)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))";
async function ensureSyncColumns(env) {
  if (syncSchemaReady) return;
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS common_exercises (
      exercise_name TEXT PRIMARY KEY
    )`).run();
  } catch (e) {
    console.error('common exercises schema initialization error:', e);
  }
  const alters = [
    "ALTER TABLE workout_sessions ADD COLUMN uid TEXT",
    "ALTER TABLE workout_sessions ADD COLUMN updated_at TEXT",
    "ALTER TABLE workout_sessions ADD COLUMN deleted INTEGER DEFAULT 0",
    "ALTER TABLE custom_exercises ADD COLUMN uid TEXT",
    "ALTER TABLE custom_exercises ADD COLUMN updated_at TEXT",
    "ALTER TABLE custom_exercises ADD COLUMN deleted INTEGER DEFAULT 0",
    "ALTER TABLE common_exercises ADD COLUMN updated_at TEXT",
    "ALTER TABLE common_exercises ADD COLUMN deleted INTEGER DEFAULT 0",
  ];
  for (const sql of alters) {
    try { await env.DB.prepare(sql).run(); } catch (e) { /* duplicate column 忽略 */ }
  }
  // 先回填uid（SQL端randomblob每行独立生成），再建唯一索引
  try {
    await env.DB.prepare(`UPDATE workout_sessions SET uid = ${UUID_SQL}, updated_at = ? WHERE uid IS NULL`).bind(now).run();
    await env.DB.prepare(`UPDATE custom_exercises SET uid = ${UUID_SQL}, updated_at = ? WHERE uid IS NULL`).bind(now).run();
    await env.DB.prepare("UPDATE common_exercises SET updated_at = ? WHERE updated_at IS NULL").bind(now).run();
    await env.DB.prepare("UPDATE workout_sessions SET deleted = 0 WHERE deleted IS NULL").run();
    await env.DB.prepare("UPDATE custom_exercises SET deleted = 0 WHERE deleted IS NULL").run();
    await env.DB.prepare("UPDATE common_exercises SET deleted = 0 WHERE deleted IS NULL").run();
  } catch (e) {
    console.error('migration backfill error:', e);
  }
  try { await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_workout_uid ON workout_sessions(uid)").run(); } catch (e) {}
  try { await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_ex_uid ON custom_exercises(uid)").run(); } catch (e) {}
  // 公共动作种子数据：幂等入库（入库后管理页可见可编辑，/sync 会同步到客户端）
  try {
    const seedCommon = ['卷腹', '平板支撑', '俄罗斯转体', '悬垂举腿', '仰卧抬腿'];
    for (const name of seedCommon) {
      await env.DB.prepare(
        `INSERT INTO common_exercises (exercise_name, updated_at, deleted) VALUES (?,?,0)
         ON CONFLICT(exercise_name) DO UPDATE SET deleted = 0, updated_at = excluded.updated_at`
      ).bind(name, now).run();
    }
  } catch (e) {
    console.error('seed common exercises error:', e);
  }
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS user_meta (
      user_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT,
      PRIMARY KEY (user_id, key)
    )`).run();
  } catch (e) {}
  syncSchemaReady = true;
}

// CORS with credentials support
app.use('*', cors({
  origin: [
    FRONTEND_URL,
    'https://fitness-dpa.pages.dev',
    'http://localhost:8788',
  ],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
}));

// --- Auth Middleware (optional, sets userId) ---
app.use('*', async (c, next) => {
  const sessionToken = getCookie(c, SESSION_COOKIE_NAME);
  let userId = null;

  if (sessionToken) {
    try {
      const now = new Date().toISOString();
      const { results } = await c.env.DB.prepare(
        "SELECT user_id FROM sessions WHERE token = ? AND expires_at > ?"
      ).bind(sessionToken, now).all();

      if (results.length > 0) {
        userId = results[0].user_id;
      }
    } catch (e) {
      console.error('Session lookup error:', e);
    }
  }

  c.set('userId', userId);
  await next();
});

// --- Require Auth Middleware (blocks unauthenticated requests) ---
const requireAuth = async (c, next) => {
  const userId = c.get('userId');
  if (!userId) {
    return c.json({ error: 'Authentication required' }, 401);
  }
  await next();
};

function configuredAdminIds(env) {
  return new Set(
    String(env?.[COMMON_EXERCISE_ADMIN_ENV] || '')
      .split(',')
      .map(value => value.trim().toLowerCase())
      .filter(Boolean)
  );
}

async function isCommonExerciseAdmin(c) {
  const allowed = configuredAdminIds(c.env);
  if (allowed.size === 0) return false;
  const userId = c.get('userId');
  if (!userId) return false;

  const { results } = await c.env.DB.prepare(
    'SELECT id, github_id, username FROM users WHERE id = ? LIMIT 1'
  ).bind(userId).all();
  const user = results[0];
  if (!user) return false;
  return [user.id, user.github_id, user.username]
    .filter(value => value !== null && typeof value !== 'undefined')
    .some(value => allowed.has(String(value).toLowerCase()));
}

const requireCommonExerciseAdmin = async (c, next) => {
  if (!(await isCommonExerciseAdmin(c))) {
    return c.json({ error: 'Common exercise administration requires an approved administrator.' }, 403);
  }
  await next();
};

// --- Auth Routes ---

// GitHub OAuth: redirect to GitHub
app.get('/auth/github', (c) => {
  const clientId = c.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return c.json({ error: 'GitHub OAuth not configured' }, 500);
  }

  const redirectUri = `${new URL(c.req.url).origin}/api/auth/callback`;
  const state = generateToken();

  const githubAuthUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=read:user&state=${state}`;

  // Store state in a short-lived cookie for CSRF protection
  setCookie(c, 'oauth_state', state, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    maxAge: 600, // 10 minutes
    path: '/',
  });

  return c.redirect(githubAuthUrl);
});

// GitHub OAuth callback
app.get('/auth/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const savedState = getCookie(c, 'oauth_state');

  if (!code || !state || state !== savedState) {
    return c.redirect(`${FRONTEND_URL}?auth=error`);
  }

  // Clear state cookie
  deleteCookie(c, 'oauth_state', { path: '/' });

  try {
    const clientId = c.env.GITHUB_CLIENT_ID;
    const clientSecret = c.env.GITHUB_CLIENT_SECRET;

    // Exchange code for access token
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });

    const tokenData = await tokenResponse.json();
    if (tokenData.error) {
      console.error('GitHub token error:', tokenData.error);
      return c.redirect(`${FRONTEND_URL}?auth=error`);
    }

    const accessToken = tokenData.access_token;

    // Get user info from GitHub
    const userResponse = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
        'User-Agent': 'Fitness-Tracker',
      },
    });

    const githubUser = await userResponse.json();
    if (!githubUser.id) {
      console.error('GitHub user fetch error:', githubUser);
      return c.redirect(`${FRONTEND_URL}?auth=error`);
    }

    // Create or update user in DB
    const { results: existingUsers } = await c.env.DB.prepare(
      "SELECT id FROM users WHERE github_id = ?"
    ).bind(githubUser.id).all();

    let userId;
    if (existingUsers.length > 0) {
      userId = existingUsers[0].id;
      await c.env.DB.prepare(
        "UPDATE users SET username = ?, avatar_url = ? WHERE github_id = ?"
      ).bind(githubUser.login, githubUser.avatar_url, githubUser.id).run();
    } else {
      const result = await c.env.DB.prepare(
        "INSERT INTO users (github_id, username, avatar_url) VALUES (?, ?, ?)"
      ).bind(githubUser.id, githubUser.login, githubUser.avatar_url).run();
      userId = result.meta.last_row_id;

      // 历史匿名记录保持未归属状态，不能在首次登录时自动转给新用户。
    }

    // Create session
    const sessionToken = generateToken();
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE * 1000).toISOString();

    await c.env.DB.prepare(
      "INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)"
    ).bind(userId, sessionToken, expiresAt).run();

    // Set session cookie
    setCookie(c, SESSION_COOKIE_NAME, sessionToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'None',
      maxAge: SESSION_MAX_AGE,
      path: '/',
    });

    return c.redirect(`${FRONTEND_URL}?auth=success`);
  } catch (e) {
    console.error('OAuth callback error:', e);
    return c.redirect(`${FRONTEND_URL}?auth=error`);
  }
});

// Get current user info
app.get('/auth/me', async (c) => {
  const userId = c.get('userId');
  if (!userId) {
    return c.json({ user: null });
  }

  try {
    const { results } = await c.env.DB.prepare(
      "SELECT id, github_id, username, avatar_url FROM users WHERE id = ?"
    ).bind(userId).all();

    if (results.length > 0) {
      const { github_id: _githubId, ...user } = results[0];
      user.is_common_exercise_admin = await isCommonExerciseAdmin(c);
      return c.json({ user });
    }
    return c.json({ user: null });
  } catch (e) {
    console.error(e);
    return c.json({ user: null });
  }
});

// Logout
app.post('/auth/logout', async (c) => {
  const sessionToken = getCookie(c, SESSION_COOKIE_NAME);

  if (sessionToken) {
    try {
      await c.env.DB.prepare(
        "DELETE FROM sessions WHERE token = ?"
      ).bind(sessionToken).run();
    } catch (e) {
      console.error(e);
    }
  }

  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/', secure: true, sameSite: 'None' });
  return c.json({ success: true });
});

// --- API Endpoints for Custom Exercises ---

// 1. Get all exercises for a specific muscle group (custom + common) with frequency
app.get('/exercises/:muscle', requireAuth, async (c) => {
  const muscle = c.req.param('muscle');
  const userId = c.get('userId');
  if (!muscle) {
    return c.json({ error: 'Muscle group is required' }, 400);
  }
  try {
    const { results: customResults } = await c.env.DB.prepare(
      "SELECT exercise_name FROM custom_exercises WHERE muscle_group = ? AND user_id = ? AND IFNULL(deleted,0) = 0 ORDER BY exercise_name"
    ).bind(muscle, userId).all();

    const { results: commonResults } = await c.env.DB.prepare(
      "SELECT exercise_name FROM common_exercises WHERE IFNULL(deleted,0) = 0 ORDER BY exercise_name"
    ).all();

    // 频率统计：用 json_each 在 D1 端聚合计数，避免把整表 exercises_data 大 JSON 拉到 Worker 再解析
    const { results: freqResults } = await c.env.DB.prepare(
      `SELECT je.value->>'$.exercise_name' AS name, COUNT(*) AS cnt
       FROM workout_sessions ws, json_each(ws.exercises_data) je
       WHERE ws.muscle_group = ? AND ws.user_id = ? AND IFNULL(ws.deleted,0) = 0
       GROUP BY name`
    ).bind(muscle, userId).all();
    const frequency = {};
    freqResults.forEach(r => { if (r.name) frequency[r.name] = r.cnt; });

    const custom = customResults.map(r => r.exercise_name);
    const common = commonResults.map(r => r.exercise_name);

    // Sort by frequency (descending), then alphabetically
    const sortByFrequency = (a, b) => {
      const freqA = frequency[a] || 0;
      const freqB = frequency[b] || 0;
      if (freqA !== freqB) return freqB - freqA;
      return a.localeCompare(b);
    };

    const customSorted = [...custom].sort(sortByFrequency);
    const commonSorted = [...common].sort(sortByFrequency);
    const allSorted = [...customSorted, ...commonSorted];

    return c.json({
      custom: customSorted,
      common: commonSorted,
      all: allSorted,
      frequency
    });
  } catch (e) {
    console.error(e);
    return c.json({ error: e.message }, 500);
  }
});

// 2. Add a new custom exercise
app.post('/exercises', requireAuth, async (c) => {
  try {
    await ensureSyncColumns(c.env);
    const userId = c.get('userId');
    const { muscle_group, exercise_name, uid } = await c.req.json();
    if (!muscle_group || !exercise_name) {
      return c.json({ error: 'Missing required fields' }, 400);
    }
    const now = new Date().toISOString();
    const recordUid = uid || generateUUID();
    // 若存在同名记录（含软删除的）则复活并更新时间戳，否则插入
    await c.env.DB.prepare(
      `INSERT INTO custom_exercises (uid, muscle_group, exercise_name, updated_at, deleted, user_id) VALUES (?,?,?,?,0,?)
       ON CONFLICT(muscle_group, exercise_name, user_id) DO UPDATE SET deleted = 0, updated_at = excluded.updated_at`
    ).bind(recordUid, muscle_group, exercise_name.trim(), now, userId).run();

    return c.json({ success: true, message: 'Exercise added successfully.', uid: recordUid });
  } catch (e) {
    console.error(e);
    return c.json({ error: e.message }, 500);
  }
});

// 3. Update exercise name (for both custom and common exercises)
app.put('/exercises', requireAuth, async (c) => {
  try {
    await ensureSyncColumns(c.env);
    const userId = c.get('userId');
    const { muscle_group, old_name, new_name } = await c.req.json();
    if (!old_name || !new_name) {
      return c.json({ error: 'Missing required fields' }, 400);
    }

    const trimmedNewName = new_name.trim();
    const now = new Date().toISOString();

    if (muscle_group) {
      const customResult = await c.env.DB.prepare(
        "UPDATE custom_exercises SET exercise_name = ?, updated_at = ? WHERE muscle_group = ? AND exercise_name = ? AND user_id = ? AND IFNULL(deleted,0) = 0"
      ).bind(trimmedNewName, now, muscle_group, old_name, userId).run();

      if (customResult.success && customResult.meta.changes > 0) {
        return c.json({ success: true, message: 'Custom exercise updated successfully.' });
      }
    }

    if (!(await isCommonExerciseAdmin(c))) {
      return c.json({ error: 'Common exercise administration requires an approved administrator.' }, 403);
    }
    const commonResult = await c.env.DB.prepare(
      "UPDATE common_exercises SET exercise_name = ?, updated_at = ? WHERE exercise_name = ? AND IFNULL(deleted,0) = 0"
    ).bind(trimmedNewName, now, old_name).run();

    if (commonResult.success && commonResult.meta.changes > 0) {
      return c.json({ success: true, message: 'Common exercise updated successfully.' });
    }

    return c.json({ error: 'Exercise not found' }, 404);
  } catch (e) {
    console.error(e);
    return c.json({ error: e.message }, 500);
  }
});

// 4. Delete a custom exercise（软删除，支持同步）
app.delete('/exercises', requireAuth, async (c) => {
  try {
    await ensureSyncColumns(c.env);
    const userId = c.get('userId');
    const { muscle_group, exercise_name, uid } = await c.req.json();
    if (!muscle_group || !exercise_name) {
      return c.json({ error: 'Missing required fields' }, 400);
    }

    const now = new Date().toISOString();
    const { success } = await c.env.DB.prepare(
      uid
        ? "UPDATE custom_exercises SET deleted = 1, updated_at = ? WHERE (uid = ? OR (muscle_group = ? AND exercise_name = ?)) AND user_id = ?"
        : "UPDATE custom_exercises SET deleted = 1, updated_at = ? WHERE muscle_group = ? AND exercise_name = ? AND user_id = ?"
    ).bind(...(uid ? [now, uid, muscle_group, exercise_name, userId] : [now, muscle_group, exercise_name, userId])).run();

    if (success) {
      return c.json({ success: true, message: 'Exercise deleted successfully.' });
    } else {
      return c.json({ error: 'Failed to delete exercise' }, 500);
    }
  } catch (e) {
    console.error(e);
    return c.json({ error: e.message }, 500);
  }
});

// --- API Endpoints for Common Exercises ---

// 5. Get all common exercises
app.get('/common-exercises', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      "SELECT exercise_name FROM common_exercises WHERE IFNULL(deleted,0) = 0 ORDER BY exercise_name"
    ).all();

    return c.json(results.map(r => r.exercise_name));
  } catch (e) {
    console.error(e);
    return c.json({ error: e.message }, 500);
  }
});

// 6. Add a new common exercise
app.post('/common-exercises', requireAuth, requireCommonExerciseAdmin, async (c) => {
  try {
    await ensureSyncColumns(c.env);
    const { exercise_name } = await c.req.json();
    if (!exercise_name) {
      return c.json({ error: 'Exercise name is required' }, 400);
    }

    const now = new Date().toISOString();
    await c.env.DB.prepare(
      `INSERT INTO common_exercises (exercise_name, updated_at, deleted) VALUES (?,?,0)
       ON CONFLICT(exercise_name) DO UPDATE SET deleted = 0, updated_at = excluded.updated_at`
    ).bind(exercise_name.trim(), now).run();

    return c.json({ success: true, message: 'Common exercise added successfully.' });
  } catch (e) {
    console.error(e);
    return c.json({ error: e.message }, 500);
  }
});

// 7. Update a common exercise
app.put('/common-exercises', requireAuth, requireCommonExerciseAdmin, async (c) => {
  try {
    await ensureSyncColumns(c.env);
    const { old_name, new_name } = await c.req.json();
    if (!old_name || !new_name) {
      return c.json({ error: 'Missing required fields' }, 400);
    }

    const now = new Date().toISOString();
    const { success, meta } = await c.env.DB.prepare(
      "UPDATE common_exercises SET exercise_name = ?, updated_at = ? WHERE exercise_name = ? AND IFNULL(deleted,0) = 0"
    ).bind(new_name.trim(), now, old_name).run();

    if (success && meta.changes > 0) {
      return c.json({ success: true, message: 'Common exercise updated successfully.' });
    } else {
      return c.json({ error: 'Exercise not found or no changes made' }, 404);
    }
  } catch (e) {
    console.error(e);
    return c.json({ error: e.message }, 500);
  }
});

// 8. Delete a common exercise（软删除，支持同步）
app.delete('/common-exercises', requireAuth, requireCommonExerciseAdmin, async (c) => {
  try {
    await ensureSyncColumns(c.env);
    const { exercise_name } = await c.req.json();
    if (!exercise_name) {
      return c.json({ error: 'Exercise name is required' }, 400);
    }

    const now = new Date().toISOString();
    const { success, meta } = await c.env.DB.prepare(
      "UPDATE common_exercises SET deleted = 1, updated_at = ? WHERE exercise_name = ?"
    ).bind(now, exercise_name).run();

    if (success && meta.changes > 0) {
      return c.json({ success: true, message: 'Common exercise deleted successfully.' });
    } else {
      return c.json({ error: 'Exercise not found' }, 404);
    }
  } catch (e) {
    console.error(e);
    return c.json({ error: e.message }, 500);
  }
});

// --- API Endpoints for Workout Sessions ---

// === 双向同步接口 ===
// 客户端推送本地全部记录，服务器逐条按uid对比updated_at（新者胜），返回需要客户端更新的记录
app.post('/sync', requireAuth, async (c) => {
  const userId = c.get('userId');
  try {
    await ensureSyncColumns(c.env);
    const body = await c.req.json();
    const clientWorkouts = Array.isArray(body.workouts) ? body.workouts : [];
    const clientCustom = Array.isArray(body.customExercises) ? body.customExercises : [];
    const clientCommon = Array.isArray(body.commonExercises) ? body.commonExercises : [];
    const clientMeta = body.meta || {}; // { key: {value, updated_at} }
    const now = new Date().toISOString();
    // 增量同步水位：客户端携带 since 时，拉取只返回 updated_at > since 的变更行，
    // 推送按 uid 逐条走唯一索引比对，避免每次同步全表读取浪费 D1 配额；不携带则保持旧全量行为
    const since = typeof body.since === 'string' && body.since ? body.since : null;

    const pullWorkouts = [];
    const pullCustom = [];
    const pullCommon = [];
    const pullMeta = {};

    // --- 1. 同步 workout_sessions ---
    // serverWorkouts：全量模式下是全表，增量模式下只有变更行（用于 pull）
    // serverWMap：仅全量模式构建（用于 push 比对；增量模式 push 改为逐条按 uid 查询）
    let serverWorkouts = [];
    const serverWMap = new Map();
    if (since) {
      const { results } = await c.env.DB.prepare(
        "SELECT uid, muscle_group, session_date, exercises_data, updated_at, deleted FROM workout_sessions WHERE user_id = ? AND updated_at > ?"
      ).bind(userId, since).all();
      serverWorkouts = results;
    } else {
      const { results } = await c.env.DB.prepare(
        "SELECT uid, muscle_group, session_date, exercises_data, updated_at, deleted FROM workout_sessions WHERE user_id = ?"
      ).bind(userId).all();
      serverWorkouts = results;
      results.forEach(w => serverWMap.set(w.uid, w));
    }
    const clientWMap = new Map(clientWorkouts.filter(w => w.uid).map(w => [w.uid, w]));

    for (const cw of clientWorkouts) {
      if (!cw.uid || !cw.muscle_group || !Array.isArray(cw.exercises_data)) continue;
      let sw = serverWMap.get(cw.uid);
      if (!sw && since) {
        // 增量模式：按 uid 精确查询（唯一索引，单行读取）
        const { results: swRows } = await c.env.DB.prepare(
          "SELECT uid, muscle_group, session_date, exercises_data, updated_at, deleted FROM workout_sessions WHERE uid = ? AND user_id = ? LIMIT 1"
        ).bind(cw.uid, userId).all();
        sw = swRows[0];
      }
      const clientUpdatedAt = cw.updated_at || '';
      const clientDeleted = cw.deleted ? 1 : 0;
      if (!sw) {
        // 服务器没有 → 插入
        try {
          await c.env.DB.prepare(
            "INSERT OR IGNORE INTO workout_sessions (uid, muscle_group, session_date, exercises_data, updated_at, deleted, user_id) VALUES (?,?,?,?,?,?,?)"
          ).bind(cw.uid, cw.muscle_group, cw.session_date || now.slice(0, 10), JSON.stringify(cw.exercises_data), clientUpdatedAt, clientDeleted, userId).run();
        } catch (e) { console.error('sync insert workout:', e); }
      } else if (clientUpdatedAt > (sw.updated_at || '')) {
        // 客户端新 → 更新服务器
        try {
          await c.env.DB.prepare(
            "UPDATE workout_sessions SET muscle_group=?, session_date=?, exercises_data=?, updated_at=?, deleted=? WHERE uid=? AND user_id=?"
          ).bind(cw.muscle_group, cw.session_date || sw.session_date, JSON.stringify(cw.exercises_data), clientUpdatedAt, clientDeleted, cw.uid, userId).run();
        } catch (e) { console.error('sync update workout:', e); }
      }
    }
    // pull：客户端缺失的 或 服务器新的
    for (const sw of serverWorkouts) {
      if (!sw.uid) continue;
      const cw = clientWMap.get(sw.uid);
      try { sw.exercises_data = JSON.parse(sw.exercises_data); } catch (e) { sw.exercises_data = []; }
      if (!cw || (sw.updated_at || '') > (cw.updated_at || '')) {
        pullWorkouts.push(sw);
      }
    }

    // --- 2. 同步 custom_exercises（按uid） ---
    let serverCustom = [];
    const serverCMap = new Map();
    if (since) {
      const { results } = await c.env.DB.prepare(
        "SELECT uid, muscle_group, exercise_name, updated_at, deleted FROM custom_exercises WHERE user_id = ? AND updated_at > ?"
      ).bind(userId, since).all();
      serverCustom = results;
    } else {
      const { results } = await c.env.DB.prepare(
        "SELECT uid, muscle_group, exercise_name, updated_at, deleted FROM custom_exercises WHERE user_id = ?"
      ).bind(userId).all();
      serverCustom = results;
      results.filter(x => x.uid).forEach(x => serverCMap.set(x.uid, x));
    }
    const clientCMap = new Map(clientCustom.filter(x => x.uid).map(x => [x.uid, x]));

    for (const cc of clientCustom) {
      if (!cc.uid || !cc.muscle_group || !cc.exercise_name) continue;
      let sc = serverCMap.get(cc.uid);
      if (!sc && since) {
        // 增量模式：按 uid 精确查询（唯一索引，单行读取）
        const { results: scRows } = await c.env.DB.prepare(
          "SELECT uid, muscle_group, exercise_name, updated_at, deleted FROM custom_exercises WHERE uid = ? AND user_id = ? LIMIT 1"
        ).bind(cc.uid, userId).all();
        sc = scRows[0];
      }
      const clientUpdatedAt = cc.updated_at || '';
      const clientDeleted = cc.deleted ? 1 : 0;
      if (!sc) {
        // 可能两端各自创建了同 (muscle,name) 的记录 → 按 (muscle,name,user) 查找合并
        const { results: dupRows } = await c.env.DB.prepare(
          "SELECT uid, updated_at FROM custom_exercises WHERE muscle_group=? AND exercise_name=? AND user_id=? AND uid IS NOT NULL LIMIT 1"
        ).bind(cc.muscle_group, cc.exercise_name, userId).all();
        if (dupRows.length > 0) {
          // 已存在同义记录：比较时间戳，客户端新则覆盖该行（沿用服务器uid，返回给客户端合并）
          if (clientUpdatedAt > (dupRows[0].updated_at || '')) {
            try {
              await c.env.DB.prepare(
                "UPDATE custom_exercises SET updated_at=?, deleted=? WHERE uid=? AND user_id=?"
              ).bind(clientUpdatedAt, clientDeleted, dupRows[0].uid, userId).run();
            } catch (e) {}
          }
          continue; // 该记录会在pull阶段按服务器uid返回
        }
        try {
          await c.env.DB.prepare(
            "INSERT OR IGNORE INTO custom_exercises (uid, muscle_group, exercise_name, updated_at, deleted, user_id) VALUES (?,?,?,?,?,?)"
          ).bind(cc.uid, cc.muscle_group, cc.exercise_name, clientUpdatedAt, clientDeleted, userId).run();
        } catch (e) { console.error('sync insert custom:', e); }
      } else if (clientUpdatedAt > (sc.updated_at || '')) {
        try {
          await c.env.DB.prepare(
            "UPDATE custom_exercises SET muscle_group=?, exercise_name=?, updated_at=?, deleted=? WHERE uid=? AND user_id=?"
          ).bind(cc.muscle_group, cc.exercise_name, clientUpdatedAt, clientDeleted, cc.uid, userId).run();
        } catch (e) { console.error('sync update custom:', e); }
      }
    }
    for (const sc of serverCustom) {
      if (!sc.uid) continue;
      const cc = clientCMap.get(sc.uid);
      if (!cc || (sc.updated_at || '') > (cc.updated_at || '')) {
        pullCustom.push(sc);
      }
    }

    // --- 3. 同步 common_exercises（全局共享，按 exercise_name 为键） ---
    const { results: serverCommon } = await c.env.DB.prepare(
      "SELECT exercise_name, updated_at, deleted FROM common_exercises"
    ).all();
    const serverCommonMap = new Map(serverCommon.map(x => [x.exercise_name, x]));
    const clientCommonMap = new Map(clientCommon.map(x => [x.exercise_name, x]));

    if (await isCommonExerciseAdmin(c)) {
      for (const cce of clientCommon) {
        if (!cce.exercise_name) continue;
        const sce = serverCommonMap.get(cce.exercise_name);
        const clientUpdatedAt = cce.updated_at || '';
        const clientDeleted = cce.deleted ? 1 : 0;
        if (!sce) {
          try {
            await c.env.DB.prepare(
              "INSERT OR IGNORE INTO common_exercises (exercise_name, updated_at, deleted) VALUES (?,?,?)"
            ).bind(cce.exercise_name, clientUpdatedAt, clientDeleted).run();
          } catch (e) { console.error('sync insert common:', e); }
        } else if (clientUpdatedAt > (sce.updated_at || '')) {
          try {
            await c.env.DB.prepare(
              "UPDATE common_exercises SET updated_at=?, deleted=? WHERE exercise_name=?"
            ).bind(clientUpdatedAt, clientDeleted, cce.exercise_name).run();
          } catch (e) { console.error('sync update common:', e); }
        }
      }
    }
    for (const sce of serverCommon) {
      const cce = clientCommonMap.get(sce.exercise_name);
      if (!cce || (sce.updated_at || '') > (cce.updated_at || '')) {
        pullCommon.push(sce);
      }
    }

    // --- 4. 同步 user_meta（计划计算器等配置） ---
    const { results: serverMetaRows } = await c.env.DB.prepare(
      "SELECT key, value, updated_at FROM user_meta WHERE user_id = ?"
    ).bind(userId).all();
    const serverMetaMap = new Map(serverMetaRows.map(m => [m.key, m]));

    for (const key of Object.keys(clientMeta)) {
      const cm = clientMeta[key];
      if (!cm || typeof cm.value === 'undefined') continue;
      const sm = serverMetaMap.get(key);
      const clientUpdatedAt = cm.updated_at || '';
      if (!sm) {
        try {
          await c.env.DB.prepare(
            "INSERT OR IGNORE INTO user_meta (user_id, key, value, updated_at) VALUES (?,?,?,?)"
          ).bind(userId, key, JSON.stringify(cm.value), clientUpdatedAt).run();
        } catch (e) {}
      } else if (clientUpdatedAt > (sm.updated_at || '')) {
        try {
          await c.env.DB.prepare(
            "UPDATE user_meta SET value=?, updated_at=? WHERE user_id=? AND key=?"
          ).bind(JSON.stringify(cm.value), clientUpdatedAt, userId, key).run();
        } catch (e) {}
      }
    }
    for (const sm of serverMetaRows) {
      const cm = clientMeta[sm.key];
      if (!cm || (sm.updated_at || '') > (cm.updated_at || '')) {
        let val = sm.value;
        try { val = JSON.parse(sm.value); } catch (e) {}
        pullMeta[sm.key] = { value: val, updated_at: sm.updated_at };
      }
    }

    return c.json({
      workouts: pullWorkouts,
      customExercises: pullCustom,
      commonExercises: pullCommon,
      meta: pullMeta,
      serverTime: now
    });
  } catch (e) {
    console.error('sync error:', e);
    return c.json({ error: e.message }, 500);
  }
});

// 9. Get last workout data for a specific exercise in a muscle group
app.get('/last-workout/:muscle/:exercise', requireAuth, async (c) => {
  const muscle = c.req.param('muscle');
  const exercise = c.req.param('exercise');
  const userId = c.get('userId');
  if (!muscle || !exercise) {
    return c.json({ error: 'Muscle group and exercise are required' }, 400);
  }
  try {
    // 优化1: 使用 SQL LIKE 直接过滤包含该动作的训练记录，避免取所有再遍历
    // 优化2: 增大查询范围到 LIMIT 50，避免最近几次训练没有该动作时返回 null
    // 优化3: 使用 ESCAPE 转义动作名中的 % 和 _ 字符，防止 SQL LIKE 误匹配
    const escapedExercise = exercise.replace(/[%_\\]/g, '\\$&');
    const likePattern = `%"exercise_name"%${escapedExercise}"%`;

    const { results } = await c.env.DB.prepare(
      "SELECT exercises_data, session_date FROM workout_sessions WHERE muscle_group = ? AND user_id = ? AND IFNULL(deleted,0) = 0 AND exercises_data LIKE ? ESCAPE '\\' ORDER BY session_date DESC, session_id DESC LIMIT 50"
    ).bind(muscle, userId, likePattern).all();

    // 在结果中精确查找该动作（容错：trim + 大小写不敏感）
    const exerciseTrimmed = exercise.trim().toLowerCase();
    for (const session of results) {
      try {
        const exercises = JSON.parse(session.exercises_data);
        // 优先精确匹配
        let found = exercises.find(ex => ex.exercise_name === exercise);
        // 容错：trim + 大小写不敏感匹配
        if (!found) {
          found = exercises.find(ex =>
            ex.exercise_name && ex.exercise_name.trim().toLowerCase() === exerciseTrimmed
          );
        }
        if (found && found.sets_data && found.sets_data.length > 0) {
          return c.json({
            sets_data: found.sets_data,
            session_date: session.session_date
          });
        }
      } catch (e) {
        // Skip invalid data
      }
    }

    return c.json({ sets_data: null, session_date: null });
  } catch (e) {
    console.error(e);
    return c.json({ error: e.message }, 500);
  }
});

// 10. Get workout history (all sessions) for a muscle group
app.get('/history/:muscle', requireAuth, async (c) => {
  const muscle = c.req.param('muscle');
  const userId = c.get('userId');
  if (!muscle) {
    return c.json({ error: 'Muscle group is required' }, 400);
  }
  try {
    const { results } = await c.env.DB.prepare(
      "SELECT session_id, uid, session_date, exercises_data FROM workout_sessions WHERE muscle_group = ? AND user_id = ? AND IFNULL(deleted,0) = 0 ORDER BY session_date DESC, session_id DESC"
    ).bind(muscle, userId).all();

    // Before sending the data, parse the JSON string in 'exercises_data' back into an object
    results.forEach(session => {
      try {
        session.exercises_data = JSON.parse(session.exercises_data);
      } catch (jsonError) {
        console.error(`Failed to parse exercises_data for session ${session.session_id}:`, jsonError);
        session.exercises_data = []; // Provide a fallback
      }
    });

    return c.json(results);
  } catch (e) {
    console.error(e);
    return c.json({ error: e.message }, 500);
  }
});

// 11. Save a new workout session
app.post('/session', requireAuth, async (c) => {
  try {
    await ensureSyncColumns(c.env);
    const userId = c.get('userId');
    const { muscle_group, exercises_data, uid, session_date } = await c.req.json();
    if (!muscle_group || !exercises_data || exercises_data.length === 0) {
      return c.json({ error: 'Session data is incomplete' }, 400);
    }
    const today = session_date || new Date().toISOString().slice(0, 10); // Format as YYYY-MM-DD
    const now = new Date().toISOString();

    // Serialize the exercises array into a JSON string for storage
    const exercisesJson = JSON.stringify(exercises_data);
    const recordUid = uid || generateUUID();

    await c.env.DB.prepare(
      "INSERT INTO workout_sessions (muscle_group, session_date, exercises_data, user_id, uid, updated_at, deleted) VALUES (?,?,?,?,?,?,0)"
    )
    .bind(muscle_group, today, exercisesJson, userId, recordUid, now)
    .run();

    return c.json({ success: true, message: 'Session recorded successfully!', uid: recordUid });
  } catch (e) {
    console.error(e);
    return c.json({ error: e.message }, 500);
  }
});

// 12. Delete a specific workout session（软删除，支持同步，id可为session_id或uid）
app.delete('/session/:id', requireAuth, async (c) => {
  const sessionId = c.req.param('id');
  const userId = c.get('userId');
  if (!sessionId) {
    return c.json({ error: 'Session ID is required' }, 400);
  }
  try {
    await ensureSyncColumns(c.env);
    const now = new Date().toISOString();
    const { success } = await c.env.DB.prepare(
      "UPDATE workout_sessions SET deleted = 1, updated_at = ? WHERE (session_id = ? OR uid = ?) AND user_id = ?"
    ).bind(now, sessionId, sessionId, userId).run();

    if (success) {
      return c.json({ success: true, message: 'Session deleted successfully!' });
    } else {
      return c.json({ success: true, message: 'Session already deleted or not found.' });
    }
  } catch (e) {
    console.error(e);
    return c.json({ error: e.message }, 500);
  }
});

export default app;
