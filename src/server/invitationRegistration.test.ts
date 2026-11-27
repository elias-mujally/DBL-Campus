import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dbl-invite-test-'));
process.env.NODE_ENV = 'test';
process.env.DBL_ALLOW_DEMO = 'true';
process.env.DBL_FORCE_HTTPS = 'false';
process.env.DBL_DATA_DIR = directory;
process.env.DBL_DB_PATH = path.join(directory, 'invitation-test.sqlite');
process.env.DBL_UPLOADS_DIR = path.join(directory, 'uploads');
process.env.DBL_RELEASES_DIR = path.join(directory, 'releases');
process.env.DBL_SKIP_LISTEN = '1';

const { app } = await import('../../server.ts');
const { db, seedDemoEnvironment } = await import('./db.ts');
const { hashPassword } = await import('./db.ts');
const { hashSessionToken } = await import('./security.ts');

seedDemoEnvironment(true);

const HOST = '127.0.0.1';
const server = app.listen(0, HOST);
await new Promise<void>(resolve => server.once('listening', resolve));

test.after(() => {
  server.close();
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

const address = server.address();
const port = typeof address === 'object' && address ? address.port : 3099;
const BASE = `http://${HOST}:${port}`;
async function api(pathname: string, options: { method?: string; token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${pathname}`, {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, text };
}

async function loginAs(identifier: string, password: string) {
  const res = await api('/api/auth/login', { method: 'POST', body: { identifier, password } });
  assert.equal(res.status, 200);
  return res.json.token as string;
}

test('authorization: student and students-only coordinator receive 403 while representative and permissions coordinator succeed', async () => {
  const repToken = await loginAs('20251001', 'Demo@2026');

  const createStudent = await api('/api/users', {
    method: 'POST',
    token: repToken,
    body: {
      universityId: '20269001',
      fullName: 'Auth Student',
      email: 'auth.student@dbl.edu',
      password: 'Str0ngPass!2026',
      groupName: 'Group A',
      role: 'student',
      responsibilities: [],
    },
  });
  assert.equal(createStudent.status, 201);

  const createStudentsCoord = await api('/api/users', {
    method: 'POST',
    token: repToken,
    body: {
      universityId: '20269002',
      fullName: 'Students Only Coordinator',
      email: 'coord.students@dbl.edu',
      password: 'Str0ngPass!2026',
      groupName: 'Group A',
      role: 'coordinator',
      responsibilities: ['students'],
    },
  });
  assert.equal(createStudentsCoord.status, 201);

  const createPermsCoord = await api('/api/users', {
    method: 'POST',
    token: repToken,
    body: {
      universityId: '20269003',
      fullName: 'Permissions Coordinator',
      email: 'coord.perms@dbl.edu',
      password: 'Str0ngPass!2026',
      groupName: 'Group A',
      role: 'coordinator',
      responsibilities: ['permissions'],
    },
  });
  assert.equal(createPermsCoord.status, 201);

  const studentToken = await loginAs('20269001', 'Str0ngPass!2026');
  const studentsCoordToken = await loginAs('20269002', 'Str0ngPass!2026');
  const permsCoordToken = await loginAs('20269003', 'Str0ngPass!2026');

  for (const deniedToken of [studentToken, studentsCoordToken]) {
    assert.equal((await api('/api/admin/invitation-code', { token: deniedToken })).status, 403);
    assert.equal((await api('/api/admin/invitation-code', { method: 'POST', token: deniedToken, body: {} })).status, 403);
    assert.equal((await api('/api/admin/invitation-code', { method: 'PATCH', token: deniedToken, body: { isActive: false } })).status, 403);
  }

  for (const allowedToken of [repToken, permsCoordToken]) {
    const postRes = await api('/api/admin/invitation-code', { method: 'POST', token: allowedToken, body: {} });
    assert.equal(postRes.status, 201);
    assert.ok(postRes.json.invitation?.code);

    const getRes = await api('/api/admin/invitation-code', { token: allowedToken });
    assert.equal(getRes.status, 200);
    assert.equal(getRes.json.invitation?.isActive, true);

    const patchRes = await api('/api/admin/invitation-code', {
      method: 'PATCH',
      token: allowedToken,
      body: { isActive: false },
    });
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.json.invitation?.isActive, false);
  }
});

test('valid invitation code registers student (201) with empty responsibilities and allows immediate login', async () => {
  const repToken = await loginAs('20251001', 'Demo@2026');
  const created = await api('/api/admin/invitation-code', { method: 'POST', token: repToken, body: {} });
  assert.equal(created.status, 201);
  const code = created.json.invitation.code as string;

  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: {
      fullName: 'New Self Student',
      universityId: '20261001',
      password: 'Str0ngPass!2026',
      confirmPassword: 'Str0ngPass!2026',
      invitationCode: code,
      groupName: 'Group A',
    },
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.json.user?.role, 'student');
  assert.deepEqual(reg.json.user?.responsibilities, []);
  assert.ok(typeof reg.json.token === 'string' && reg.json.token.length > 0);

  const loginRes = await api('/api/auth/login', {
    method: 'POST',
    body: { identifier: '20261001', password: 'Str0ngPass!2026' },
  });
  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.json.user?.universityId, '20261001');
});

test('rejects invalid, disabled, and expired invitation codes with 400', async () => {
  const repToken = await loginAs('20251001', 'Demo@2026');

  const wrongRes = await api('/api/auth/register', {
    method: 'POST',
    body: {
      fullName: 'Wrong Code Student',
      universityId: '20261090',
      password: 'Str0ngPass!2026',
      confirmPassword: 'Str0ngPass!2026',
      invitationCode: 'INVALID-CODE-9999',
    },
  });
  assert.equal(wrongRes.status, 400);

  const created = await api('/api/admin/invitation-code', { method: 'POST', token: repToken, body: {} });
  assert.equal(created.status, 201);
  const disabledCode = created.json.invitation.code as string;

  const disableRes = await api('/api/admin/invitation-code', {
    method: 'PATCH',
    token: repToken,
    body: { isActive: false },
  });
  assert.equal(disableRes.status, 200);

  const disabledReg = await api('/api/auth/register', {
    method: 'POST',
    body: {
      fullName: 'Disabled Code Student',
      universityId: '20261091',
      password: 'Str0ngPass!2026',
      confirmPassword: 'Str0ngPass!2026',
      invitationCode: disabledCode,
    },
  });
  assert.equal(disabledReg.status, 400);

  const createdExp = await api('/api/admin/invitation-code', { method: 'POST', token: repToken, body: { expiresInDays: 1 } });
  assert.equal(createdExp.status, 201);
  const expiredCode = createdExp.json.invitation.code as string;
  db.prepare('UPDATE invitation_codes SET expires_at = ? WHERE is_active = 1').run(new Date(Date.now() - 60_000).toISOString());

  const expiredReg = await api('/api/auth/register', {
    method: 'POST',
    body: {
      fullName: 'Expired Code Student',
      universityId: '20261092',
      password: 'Str0ngPass!2026',
      confirmPassword: 'Str0ngPass!2026',
      invitationCode: expiredCode,
    },
  });
  assert.equal(expiredReg.status, 400);
});

test('rejects duplicate universityId sequentially and concurrently (409)', async () => {
  const repToken = await loginAs('20251001', 'Demo@2026');
  const created = await api('/api/admin/invitation-code', { method: 'POST', token: repToken, body: {} });
  assert.equal(created.status, 201);
  const code = created.json.invitation.code as string;

  const seqDup = await api('/api/auth/register', {
    method: 'POST',
    body: {
      fullName: 'Duplicate Student',
      universityId: '20261001',
      password: 'Str0ngPass!2026',
      confirmPassword: 'Str0ngPass!2026',
      invitationCode: code,
    },
  });
  assert.equal(seqDup.status, 409);

  const [r1, r2] = await Promise.all([
    api('/api/auth/register', {
      method: 'POST',
      body: {
        fullName: 'Concurrent Student 1',
        universityId: '20261002',
        password: 'Str0ngPass!2026',
        confirmPassword: 'Str0ngPass!2026',
        invitationCode: code,
      },
    }),
    api('/api/auth/register', {
      method: 'POST',
      body: {
        fullName: 'Concurrent Student 2',
        universityId: '20261002',
        password: 'Str0ngPass!2026',
        confirmPassword: 'Str0ngPass!2026',
        invitationCode: code,
      },
    }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort((a, b) => a - b), [201, 409]);
});

test('prevents privilege escalation when role or responsibilities are injected', async () => {
  const repToken = await loginAs('20251001', 'Demo@2026');
  const created = await api('/api/admin/invitation-code', { method: 'POST', token: repToken, body: {} });
  assert.equal(created.status, 201);
  const code = created.json.invitation.code as string;

  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: {
      fullName: 'Escalation Attempt',
      universityId: '20261003',
      password: 'Str0ngPass!2026',
      confirmPassword: 'Str0ngPass!2026',
      invitationCode: code,
      role: 'representative',
      responsibilities: ['permissions', 'students'],
    },
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.json.user?.role, 'student');
  assert.deepEqual(reg.json.user?.responsibilities, []);

  const row = db.prepare('SELECT role, responsibilities_json FROM users WHERE university_id = ?').get('20261003') as any;
  assert.equal(row.role, 'student');
  assert.equal(row.responsibilities_json, '[]');
});
test('invalidates previous code on rotation and handles concurrent rotation/deactivation safely', async () => {
  const repToken = await loginAs('20251001', 'Demo@2026');
  const first = await api('/api/admin/invitation-code', { method: 'POST', token: repToken, body: {} });
  assert.equal(first.status, 201);
  const codeA = first.json.invitation.code as string;

  const rotated = await api('/api/admin/invitation-code', { method: 'POST', token: repToken, body: {} });
  assert.equal(rotated.status, 201);
  const codeB = rotated.json.invitation.code as string;
  assert.notEqual(codeA, codeB);

  const oldReg = await api('/api/auth/register', {
    method: 'POST',
    body: {
      fullName: 'Old Code Student',
      universityId: '20261004',
      password: 'Str0ngPass!2026',
      confirmPassword: 'Str0ngPass!2026',
      invitationCode: codeA,
    },
  });
  assert.equal(oldReg.status, 400);

  const newReg = await api('/api/auth/register', {
    method: 'POST',
    body: {
      fullName: 'New Code Student',
      universityId: '20261004',
      password: 'Str0ngPass!2026',
      confirmPassword: 'Str0ngPass!2026',
      invitationCode: codeB,
    },
  });
  assert.equal(newReg.status, 201);

  const current = await api('/api/admin/invitation-code', { token: repToken });
  assert.equal(current.status, 200);
  assert.equal(current.json.invitation?.usesCount, 1);

  const [regRace, patchRace, rotateRace] = await Promise.all([
    api('/api/auth/register', {
      method: 'POST',
      body: {
        fullName: 'Race Student',
        universityId: '20261005',
        password: 'Str0ngPass!2026',
        confirmPassword: 'Str0ngPass!2026',
        invitationCode: codeB,
      },
    }),
    api('/api/admin/invitation-code', { method: 'PATCH', token: repToken, body: { isActive: false } }),
    api('/api/admin/invitation-code', { method: 'POST', token: repToken, body: {} }),
  ]);
  assert.ok([201, 400].includes(regRace.status));
  assert.equal(patchRace.status, 200);
  assert.equal(rotateRace.status, 201);
});

test('does not leak invitation code or password in audit_logs or /api/auth/status', async () => {
  const repToken = await loginAs('20251001', 'Demo@2026');
  const created = await api('/api/admin/invitation-code', { method: 'POST', token: repToken, body: {} });
  assert.equal(created.status, 201);
  const secretCode = created.json.invitation.code as string;
  const secretPassword = 'VerySecretPass!99';

  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: {
      fullName: 'Audit Check Student',
      universityId: '20261006',
      password: secretPassword,
      confirmPassword: secretPassword,
      invitationCode: secretCode,
    },
  });
  assert.equal(reg.status, 201);
  const studentToken = reg.json.token as string;

  const logs = db.prepare('SELECT action, details FROM audit_logs').all() as Array<{ action: string; details: string }>;
  assert.ok(logs.length > 0);
  for (const row of logs) {
    assert.ok(!String(row.details || '').includes(secretCode));
    assert.ok(!String(row.details || '').includes(secretPassword));
  }

  for (const token of [undefined, studentToken, repToken]) {
    const statusRes = await api('/api/auth/status', { token });
    assert.equal(statusRes.status, 200);
    assert.ok(!statusRes.text.includes(secretCode));
    assert.ok(!statusRes.text.includes(secretPassword));
  }
});

test('preserves backward compatibility for legacy accounts, sessions, /api/auth/login, and manual POST /api/users', async () => {
  const repToken = await loginAs('20251001', 'Demo@2026');
  const legacyPassHash = hashPassword('LegacyPass!2026');
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 86_400_000).toISOString();

  db.prepare(
    `INSERT INTO users (id, university_id, full_name, email, password_hash, role, group_name, responsibilities_json, is_active, is_demo, created_at)
     VALUES (?, ?, ?, ?, ?, 'student', 'Group A', '[]', 1, 1, ?)`
  ).run('u-legacy-1', '20240001', 'Legacy Student', 'legacy@dbl.edu', legacyPassHash, now);

  db.prepare(
    `INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`
  ).run(hashSessionToken('legacy-session-token-1'), 'u-legacy-1', now, future);

  const statusRes = await api('/api/auth/status', { token: 'legacy-session-token-1' });
  assert.equal(statusRes.status, 200);
  assert.equal(statusRes.json.user?.universityId, '20240001');

  const legacyLogin = await api('/api/auth/login', {
    method: 'POST',
    body: { identifier: '20240001', password: 'LegacyPass!2026' },
  });
  assert.equal(legacyLogin.status, 200);
  assert.ok(legacyLogin.json.token);

  const manualCreate = await api('/api/users', {
    method: 'POST',
    token: repToken,
    body: {
      universityId: '20269010',
      fullName: 'Manual Created Student',
      email: 'manual@dbl.edu',
      password: 'Str0ngPass!2026',
      groupName: 'Group B',
      role: 'student',
      responsibilities: [],
    },
  });
  assert.equal(manualCreate.status, 201);
  const manualToken = await loginAs('20269010', 'Str0ngPass!2026');
  assert.ok(manualToken);
});

test('enforces rate limiting (429) on repeated registration attempts', async () => {
  const statuses: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    const res = await api('/api/auth/register', {
      method: 'POST',
      body: {
        fullName: `Rate Limit ${i}`,
        universityId: `202680${String(i).padStart(2, '0')}`,
        password: 'Str0ngPass!2026',
        confirmPassword: 'Str0ngPass!2026',
        invitationCode: 'INVALID-RATE-CHECK',
      },
    });
    statuses.push(res.status);
    if (res.status === 429) break;
  }
  assert.ok(statuses.includes(429));
});

test('migrates a real SQLite database from PRAGMA user_version = 3 to 4 without losing users or sessions', () => {
  const v3Path = path.join(directory, 'legacy-v3.sqlite');
  const v3Db = new Database(v3Path);
  v3Db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      university_id TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      group_name TEXT,
      responsibilities_json TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 86_400_000).toISOString();
  v3Db.prepare(
    `INSERT INTO users (id, university_id, full_name, email, password_hash, role, group_name, responsibilities_json, is_active, is_demo, created_at)
     VALUES ('u-v3-1', '20230001', 'V3 User', 'v3@dbl.edu', 'hash-v3', 'student', 'Group A', '[]', 1, 0, ?)`
  ).run(now);
  v3Db.prepare(
    `INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES ('v3-sess-1', 'u-v3-1', ?, ?)`
  ).run(now, future);
  v3Db.pragma('user_version = 3');
  v3Db.close();

  execFileSync(
    process.execPath,
    ['--import', 'tsx', '-e', "import { db, runMigrations } from './src/server/db.ts'; runMigrations(); db.close();"],
    {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DBL_ALLOW_DEMO: 'false',
        DBL_SKIP_LISTEN: '1',
        DBL_DATA_DIR: directory,
        DBL_DB_PATH: v3Path,
      },
      stdio: 'pipe',
    }
  );

  const migrated = new Database(v3Path, { readonly: true });
  assert.equal(migrated.pragma('user_version', { simple: true }), 4);
  const invTable = migrated.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='invitation_codes'").get();
  assert.ok(invTable);
  const userRow = migrated.prepare('SELECT id, university_id, full_name FROM users WHERE id = ?').get('u-v3-1') as any;
  assert.equal(userRow?.university_id, '20230001');
  const sessRow = migrated.prepare('SELECT token, user_id FROM sessions WHERE token = ?').get('v3-sess-1') as any;
  assert.equal(sessRow?.user_id, 'u-v3-1');
  migrated.close();
});
