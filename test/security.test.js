import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import app from '../src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

class FakeDB {
  constructor(username = 'member') {
    this.username = username;
  }

  prepare(sql) {
    const statement = {
      sql,
      args: [],
      bind: (...args) => { statement.args = args; return statement; },
      all: async () => {
        if (sql.includes('SELECT user_id FROM sessions')) return { results: [{ user_id: 7 }] };
        if (sql.includes('SELECT id, github_id, username FROM users')) {
          return { results: [{ id: 7, github_id: 123, username: this.username }] };
        }
        return { results: [] };
      },
      run: async () => ({ success: true, meta: { changes: 0, last_row_id: 0 } })
    };
    return statement;
  }
}

test('common exercise write endpoint rejects a non-admin session', async () => {
  const response = await app.request('https://fitness.example/api/common-exercises', {
    method: 'POST',
    headers: {
      Cookie: 'session_token=test-token',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ exercise_name: '恶意动作' })
  }, { DB: new FakeDB(), COMMON_EXERCISE_ADMIN_IDS: 'another-user' });
  assert.equal(response.status, 403);
});

test('common exercise write endpoint allows a configured admin session', async () => {
  const response = await app.request('https://fitness.example/api/common-exercises', {
    method: 'POST',
    headers: {
      Cookie: 'session_token=test-token',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ exercise_name: '管理员动作' })
  }, { DB: new FakeDB('admin-user'), COMMON_EXERCISE_ADMIN_IDS: 'admin-user' });
  assert.equal(response.status, 200);
});

test('schema defines the common exercises table', () => {
  const schema = read('Schema.sql');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS common_exercises/i);
  assert.match(schema, /(UNIQUE\s*\(exercise_name\)|exercise_name\s+TEXT\s+PRIMARY KEY)/i);
});

test('dependency lockfile is resolved and uses a patched Hono release', () => {
  const lockfile = read('package-lock.json');
  assert.doesNotThrow(() => JSON.parse(lockfile));
  assert.doesNotMatch(lockfile, /<<<<<<<|=======|>>>>>>>/);
  assert.match(lockfile, /"node_modules\/hono"[\s\S]*?"version": "4\.13\./);
});

test('sync updates are scoped to the authenticated owner', () => {
  const source = read('src/index.js');
  assert.match(source, /UPDATE workout_sessions SET[\s\S]*?WHERE uid=? ?\? AND user_id=? ?\?/);
  assert.match(source, /UPDATE custom_exercises SET[\s\S]*?WHERE uid=? ?\? AND user_id=? ?\?/);
  assert.doesNotMatch(source, /UPDATE workout_sessions SET user_id = \? WHERE user_id IS NULL/);
  assert.doesNotMatch(source, /UPDATE custom_exercises SET user_id = \? WHERE user_id IS NULL/);
});

test('common exercise writes require an admin guard', () => {
  const source = read('src/index.js');
  for (const route of ["app.post('/common-exercises'", "app.put('/common-exercises'", "app.delete('/common-exercises'"]) {
    assert.match(source, new RegExp(`${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, requireAuth, requireCommonExerciseAdmin`));
  }
});

test('exercise rendering does not interpolate untrusted names into HTML', () => {
  const html = read('public/index.html');
  assert.doesNotMatch(html, /commonExercises\.map\(exercise => `/);
  assert.doesNotMatch(html, /optionsHtml \+= `<option value="\$\{ex\}">\$\{ex\}<\/option>`/);
  assert.match(html, /userArea\.replaceChildren\(\)/);
  assert.match(html, /name\.textContent = currentUser\.offline/);
  assert.match(html, /data\.sets_data\.forEach\(\(set, i\) =>/);
  assert.match(html, /escapeHtml\(session\.session_date\)/);
  assert.match(html, /const weight = escapeHtml\(set\.weight\)/);
});

test('liquid glass visual system keeps motion and transparency accessible', () => {
  const html = read('public/index.html');
  assert.match(html, /backdrop-filter: blur\(/);
  assert.match(html, /prefers-reduced-motion/);
  assert.match(html, /prefers-reduced-transparency/);
  assert.match(html, /muscle-card-meta/);
});
