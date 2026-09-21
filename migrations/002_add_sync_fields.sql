-- 同步功能迁移：为所有数据表添加同步字段
-- 执行一次：wrangler d1 execute fitness-data --remote --file=migrations/002_add_sync_fields.sql

-- 旧环境可能从未执行过公用动作表初始化，先保证表存在
CREATE TABLE IF NOT EXISTS common_exercises (
  exercise_name TEXT PRIMARY KEY
);

-- 1. workout_sessions 添加同步字段
ALTER TABLE workout_sessions ADD COLUMN uid TEXT;
ALTER TABLE workout_sessions ADD COLUMN updated_at TEXT;
ALTER TABLE workout_sessions ADD COLUMN deleted INTEGER DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_workout_uid ON workout_sessions(uid);

-- 为已有记录填充 uid 和 updated_at
UPDATE workout_sessions SET uid = lower(hex(randomblob(8)) || '-' || hex(randomblob(4)) || '-4' || substr(hex(randomblob(3)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))), updated_at = datetime('now') WHERE uid IS NULL;
CREATE INDEX IF NOT EXISTS idx_workout_sync ON workout_sessions(updated_at);

-- 2. custom_exercises 添加同步字段
ALTER TABLE custom_exercises ADD COLUMN uid TEXT;
ALTER TABLE custom_exercises ADD COLUMN updated_at TEXT;
ALTER TABLE custom_exercises ADD COLUMN deleted INTEGER DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_ex_uid ON custom_exercises(uid);

UPDATE custom_exercises SET uid = lower(hex(randomblob(8)) || '-' || hex(randomblob(4)) || '-4' || substr(hex(randomblob(3)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))), updated_at = datetime('now') WHERE uid IS NULL;
CREATE INDEX IF NOT EXISTS idx_custom_ex_sync ON custom_exercises(updated_at);

-- 3. common_exercises 添加同步字段（以 exercise_name 为同步主键）
ALTER TABLE common_exercises ADD COLUMN updated_at TEXT;
ALTER TABLE common_exercises ADD COLUMN deleted INTEGER DEFAULT 0;
UPDATE common_exercises SET updated_at = datetime('now') WHERE updated_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_common_ex_sync ON common_exercises(updated_at);

-- 4. 用户元数据表（存计划计算器等单值配置）
CREATE TABLE IF NOT EXISTS user_meta (
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT,
  PRIMARY KEY (user_id, key)
);
