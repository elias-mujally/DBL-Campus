import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dbl-production-test-'));
Object.assign(process.env, { NODE_ENV: 'production', DBL_SKIP_LISTEN: '1', DBL_ALLOW_DEMO: 'false',
  DBL_FORCE_HTTPS: 'false', TRUST_PROXY: 'loopback', DBL_DATA_DIR: directory,
  DBL_DB_PATH: path.join(directory, 'campus.sqlite'), DBL_RELEASES_DIR: path.join(directory, 'releases'),
  DBL_UPLOADS_DIR: path.join(directory, 'uploads') });
delete process.env.DBL_ADMIN_SETUP_CODE;

const { app } = await import('../../server.ts');
const { db, UPLOADS_DIR } = await import('./db.ts');
const { computeBackupChecksum } = await import('./security.ts');
const service = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => service.once('listening', resolve));
const url = 'http://127.0.0.1:' + (service.address() as { port: number }).port;
test.after(() => { service.close(); db.close(); fs.rmSync(directory, { force: true, recursive: true }); });

async function request(route: string, options: { method?: string; body?: object; token?: string; headers?: Record<string, string>; origin?: string } = {}) {
  const response = await fetch((options.origin ?? url) + route, {
    method: options.method ?? (options.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...options.headers, ...(options.token && { Authorization: 'Bearer ' + options.token }) },
    body: options.body ? JSON.stringify(options.body) : undefined,
    redirect: 'manual',
  });
  return { status: response.status, headers: response.headers, data: await response.json().catch(() => null) };
}

test('Production acceptance for bootstrap, roles, invitations, object access and portable restoration', async t => {
  const secret = 'integration-test-only-setup-code-sufficient-length';
  const repPassword = 'IntegrationRepresentative42';
  const studentPassword = 'IntegrationStudent42';
  const person = (name: string, role = 'student', responsibilities: string[] = []) =>
    ({ universityId: name, fullName: name, email: name + '@example.invalid', password: studentPassword, groupName: 'A', role, responsibilities });

  let representative: string;
  let representativeId: string;
  let delegated: string;
  let student: string;
  let studentId: string;
  let courseId: string;
  let fileId: string;

  await t.test('bootstrap requires a configured secret and creates only one representative', async () => {
    const details = { ...person('representative'), password: repPassword };
    assert.equal((await request('/api/auth/setup-production-rep', { body: details })).status, 503);
    process.env.DBL_ADMIN_SETUP_CODE = secret;
    assert.equal((await request('/api/auth/setup-production-rep', { body: { ...details, setupCode: 'different' } })).status, 403);
    const setup = await request('/api/auth/setup-production-rep', { body: { ...details, setupCode: secret } });
    assert.equal(setup.status, 201);
    representative = setup.data.token;
    representativeId = setup.data.user.id;
    assert.equal((await request('/api/auth/setup-production-rep', { body: { ...details, setupCode: secret } })).status, 403);
    assert.equal((await request('/api/auth/demo-login', { body: {} })).status, 403);
    assert.equal((await request('/api/admin/demo-reset', { token: representative, body: {} })).status, 403);
  });

  await t.test('delegated student managers cannot edit superior accounts or restore identity data', async () => {
    assert.equal((await request('/api/users', { token: representative, body: person('helper', 'deputy', ['students', 'backup']) })).status, 201);
    delegated = (await request('/api/auth/login', { body: { identifier: 'helper', password: studentPassword } })).data.token;
    assert.equal((await request('/api/users/' + representativeId, { method: 'PUT', token: delegated, body: { isActive: false } })).status, 403);
    assert.equal((await request('/api/users/' + representativeId, { method: 'PUT', token: delegated, body: { resetPassword: studentPassword } })).status, 403);
    assert.equal((await request('/api/users/' + representativeId, { method: 'PUT', token: representative, body: { isActive: false } })).status, 409);
    assert.equal((await request('/api/admin/backup', { token: delegated })).status, 403);
    assert.equal((await request('/api/admin/restore', { token: delegated, body: {} })).status, 403);
    assert.equal((await request('/api/auth/profile', { method: 'PUT', token: representative, body: {
      fullName: 'Representative', email: 'other@example.invalid', newPassword: studentPassword,
    } })).status, 403);
  });

  await t.test('CSV issues individual activation credentials and requires rotation before access', async () => {
    const csvText = 'csv1,"طالب, أول",csv1@example.invalid,A\ncsv2,طالب ثان,csv2@example.invalid,A';
    assert.equal((await request('/api/users/import-csv', { token: representative, body: { csvText, defaultPassword: studentPassword } })).status, 400);
    const imported = await request('/api/users/import-csv', { token: representative, body: { csvText } });
    assert.equal(imported.status, 200);
    const [first, second] = imported.data.invitations;
    assert.notEqual(first.initialPassword, second.initialPassword);
    assert.equal((await request('/api/auth/login', { body: { identifier: 'csv1', password: 'Student@2026' } })).status, 401);
    assert.equal((await request('/api/auth/login', { body: { identifier: 'csv2', password: first.initialPassword } })).status, 401);
    const result = await request('/api/auth/login', { body: { identifier: 'csv1', password: first.initialPassword } });
    student = result.data.token;
    studentId = result.data.user.id;
    assert.equal(result.data.user.fullName, 'طالب, أول');
    assert.equal(result.data.user.mustChangePassword, true);
    assert.equal((await request('/api/courses', { token: student })).status, 403);
    assert.equal((await request('/api/auth/profile', { method: 'PUT', token: student, body: {
      fullName: 'طالب', email: 'csv1@example.invalid', newPassword: studentPassword, currentPassword: first.initialPassword,
    } })).status, 200);
    assert.equal((await request('/api/courses', { token: student })).status, 200);
    assert.equal((await request('/api/auth/login', { body: { identifier: 'csv1', password: first.initialPassword } })).status, 401);
  });

  await t.test('writes obey visibility, schedule times are validated, and target changes require new endorsements', async () => {
    const create = (route: string, body: object) => request(route, { token: representative, body });
    courseId = (await create('/api/courses', { code: 'QA101', nameAr: 'مقرر', nameEn: 'QA', instructor: 'Staff', creditHours: 3 })).data.id;
    assert.equal((await create('/api/lectures', { courseId, dayOfWeek: 1, startTime: '11:00', endTime: '10:00', location: 'X', instructor: 'Staff' })).status, 400);
    const assignment = await create('/api/assignments', { courseId, title: 'Private assignment', description: 'Details', instructor: 'Staff', dueDate: '2030-01-01', targetGroup: 'B' });
    assert.equal(assignment.status, 201);
    assert.equal((await request('/api/assignments/' + assignment.data.id + '/progress', { method: 'PUT', token: student, body: { personalStatus: 'completed' } })).status, 404);
    const announcement = await create('/api/announcements', { title: 'Private', content: 'Details', targetGroup: 'B' });
    assert.equal(announcement.status, 201);
    assert.equal((await request('/api/announcements/' + announcement.data.id + '/read', { token: student, body: {} })).status, 404);
    const task = await create('/api/tasks', { title: 'Internal', dueDate: '2030-01-01', assignedTo: representativeId });
    assert.equal(task.status, 201);
    assert.equal((await request('/api/tasks/' + task.data.id + '/comments', { token: student, body: { content: 'Test comment' } })).status, 404);
    const petition = { targetAuthority: 'Department A', subject: 'Request', details: 'Text', isCollective: true };
    const initial = await create('/api/requests', petition);
    assert.equal(initial.status, 201);
    assert.equal((await request(`/api/requests/${initial.data.id}/endorse`, { token: student, body: {} })).status, 201);
    assert.equal((await request(`/api/requests/${initial.data.id}`, { method: 'PUT', token: representative, body: { ...petition, targetAuthority: 'Department B' } })).status, 409);
  });

  await t.test('backup rejects missing data and restores records and attachments into empty storage', async () => {
    const fileBytes = Buffer.from('Independent restore fixture\n');
    const uploaded = await request('/api/files', { token: representative, body: { courseId, title: 'Portable file', fileName: 'lecture.txt', base64Content: fileBytes.toString('base64') } });
    assert.equal(uploaded.status, 201);
    fileId = uploaded.data.id;
    const ticket = await request('/api/files/' + fileId + '/download-ticket', { token: student, body: {} });
    assert.equal(ticket.status, 200);
    const withAttachment = await request('/api/assignments', { token: representative, body:
      { courseId, title: 'With library file', dueDate: '2030-01-01', attachmentFileId: fileId } });
    assert.equal(withAttachment.status, 201);
    const assignment = (await request('/api/assignments', { token: student })).data.find((row: { id: string }) => row.id === withAttachment.data.id);
    assert.equal(assignment.attachmentFileId, fileId);
    const snapshot = await request('/api/admin/backup', { token: representative });
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.data.attachments.length, 1);
    const restore = (data: object) => request('/api/admin/restore', { token: representative, body: { ...data, currentPassword: repPassword } });
    const partial = { tables: snapshot.data.tables, attachments: [] };
    assert.equal((await restore({ ...snapshot.data, ...partial, checksumSha256: computeBackupChecksum(partial) })).status, 400);
    const badRelations = structuredClone(snapshot.data);
    badRelations.tables.lectures.push({
      id: 'bad-relation', course_id: 'missing', day_of_week: 0, start_time: '10:00', end_time: '11:00',
      location: 'A', instructor: 'A', target_group: 'ALL', lecture_type: 'lecture', status: 'official',
      notes: '', specific_date: null, created_by: representativeId, is_demo: 0,
    });
    badRelations.checksumSha256 = computeBackupChecksum({ tables: badRelations.tables, attachments: badRelations.attachments });
    assert.equal((await restore(badRelations)).status, 400);
    assert.equal((await request('/api/courses', { token: representative })).status, 200);
    assert.equal(fs.readdirSync(UPLOADS_DIR).length, 1);

    const target = path.join(directory, 'empty-server');
    const processScript = `
      const { app } = await import('./server.ts');
      const { closeDatabaseGracefully } = await import('./src/server/db.ts');
      const server = app.listen(0, '127.0.0.1', () => console.log(server.address().port));
      process.on('SIGTERM', () => server.close(() => closeDatabaseGracefully()));
    `;
    const runOnTarget = async (check: (origin: string) => Promise<void>) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', processScript], {
        env: {
          ...process.env, DBL_DATA_DIR: target, DBL_DB_PATH: path.join(target, 'new.sqlite'),
          DBL_UPLOADS_DIR: path.join(target, 'uploads'), DBL_RELEASES_DIR: path.join(target, 'releases'),
        },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      const stopped = once(child, 'close');
      try {
        const port = await Promise.race([once(child.stdout!, 'data').then(([data]) => Number(String(data).trim())),
          stopped.then(() => { throw new Error('Fresh test server failed to start'); })]);
        assert.ok(port > 0);
        await check('http://127.0.0.1:' + port);
      } finally {
        child.kill('SIGTERM');
        await stopped;
      }
    };
    assert.equal(fs.existsSync(target), false);
    await runOnTarget(async origin => {
      const setup = await request('/api/auth/setup-production-rep', { origin, body: {
        ...person('temporary-recovery'), password: repPassword, setupCode: secret,
      } });
      assert.equal(setup.status, 201);
      assert.deepEqual(fs.readdirSync(path.join(target, 'uploads')), []);
      assert.equal((await request('/api/admin/restore', { origin, token: setup.data.token,
        body: { ...snapshot.data, currentPassword: repPassword } })).status, 200);
      assert.equal((await request('/api/courses', { origin, token: setup.data.token })).status, 401);
    });
    await runOnTarget(async origin => {
      const login = await request('/api/auth/login', { origin, body: { identifier: 'csv1', password: studentPassword } });
      assert.equal(login.status, 200);
      assert.equal(login.data.user.id, studentId);
      const file = await fetch(origin + '/api/files/' + fileId + '/download', { headers: { Authorization: 'Bearer ' + login.data.token } });
      assert.equal(file.status, 200);
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), fileBytes);
      const rep = await request('/api/auth/login', { origin, body: { identifier: 'representative', password: repPassword } });
      const audit = await request('/api/admin/audit-logs', { origin, token: rep.data.token });
      assert.ok(audit.data.some((row: { action: string }) => row.action === 'ENDORSE_REQUEST'));
    });

    assert.equal((await restore(snapshot.data)).status, 200);
    assert.equal((await fetch(url + ticket.data.downloadUrl)).status, 401);
    assert.equal((await request('/api/courses', { token: representative })).status, 401);
    assert.equal((await request('/api/courses', { token: student })).status, 401);
    const login = await request('/api/auth/login', { body: { identifier: 'csv1', password: studentPassword } });
    assert.equal(login.status, 200);
    assert.equal(login.data.user.id, studentId);
    const file = await fetch(url + '/api/files/' + fileId + '/download', { headers: { Authorization: 'Bearer ' + login.data.token } });
    assert.equal(file.status, 200);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), fileBytes);
    assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'ENDORSE_REQUEST'").get());
  });

  await t.test('trusted proxy uses canonical HTTPS, while health remains available', async () => {
    process.env.DBL_FORCE_HTTPS = 'true';
    process.env.APP_URL = 'https://campus.example.invalid';
    try {
      const redirected = await request('/api/auth/status', { headers: { Host: 'alternate.example.invalid' } });
      assert.equal(redirected.status, 308);
      assert.equal(redirected.headers.get('location'), 'https://campus.example.invalid/api/auth/status');
      const secure = await request('/api/auth/status', { headers: { 'X-Forwarded-Proto': 'https' } });
      assert.equal(secure.status, 200);
      assert.ok(secure.headers.has('strict-transport-security'));
      assert.equal((await request('/api/health')).status, 200);
    } finally {
      process.env.DBL_FORCE_HTTPS = 'false';
      delete process.env.APP_URL;
    }
  });
});
