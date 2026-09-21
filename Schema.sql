-- 为了安全起见，先删除旧表
DROP TABLE IF EXISTS workouts;

-- 新建: 用户表
-- 存储通过 GitHub OAuth 登录的用户信息
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id INTEGER NOT NULL UNIQUE,
  username TEXT NOT NULL,
  avatar_url TEXT,
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

-- 新建: 会话表
-- 存储用户登录会话，支持长期保持登录
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

-- 公用动作表：所有用户可读，写入由管理员白名单控制
CREATE TABLE IF NOT EXISTS common_exercises (
  exercise_name TEXT PRIMARY KEY,
  updated_at TEXT DEFAULT (datetime('now')),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
);

-- 新建: 自定义动作表
-- 用于存储用户添加的动作，方便后续从下拉框选择
CREATE TABLE IF NOT EXISTS custom_exercises (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  muscle_group TEXT NOT NULL,
  exercise_name TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  uid TEXT,
  updated_at TEXT,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  UNIQUE (muscle_group, exercise_name, user_id)
);

-- 新建: 训练会话表
-- 这里的每一条记录都代表一次完整的训练，其中可以包含多个动作
CREATE TABLE IF NOT EXISTS workout_sessions (
  session_id INTEGER PRIMARY KEY AUTOINCREMENT,
  muscle_group TEXT NOT NULL,
  session_date TEXT NOT NULL,
  exercises_data TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  uid TEXT UNIQUE,
  updated_at TEXT,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

-- 公用动作种子数据，避免匿名 custom_exercises 记录被错误认领
INSERT OR IGNORE INTO common_exercises (exercise_name) VALUES
('平板卧推'), ('上斜卧推'), ('哑铃飞鸟'),
('引体向上'), ('高位下拉'), ('坐姿划船'),
('站姿推举'), ('侧平举'), ('深蹲'), ('腿举');

-- 查询性能索引（避免跨用户全表扫描，见 migrations/003_add_indexes.sql）
CREATE INDEX IF NOT EXISTS idx_ws_user_muscle_date ON workout_sessions(user_id, muscle_group, session_date, session_id);
CREATE INDEX IF NOT EXISTS idx_ws_user_updated ON workout_sessions(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_ce_user_muscle ON custom_exercises(user_id, muscle_group);
CREATE INDEX IF NOT EXISTS idx_common_ex_updated ON common_exercises(updated_at);
