import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dbl-demo-test-'));
process.env.NODE_ENV = 'test';
process.env.DBL_ALLOW_DEMO = 'true';
process.env.DBL_FORCE_HTTPS = 'false';
process.env.DBL_DATA_DIR = directory;
process.env.DBL_DB_PATH = path.join(directory, 'integration.sqlite');
process.env.DBL_UPLOADS_DIR = path.join(directory, 'uploads');
process.env.DBL_RELEASES_DIR = path.join(directory, 'releases');

process.env.DBL_SKIP_LISTEN = '1';

const { app } = await import('../../server.ts');
const { db, seedDemoEnvironment } = await import('./db.ts');
const { hashSessionToken } = await import('./security.ts');

seedDemoEnvironment(true);

const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
test.after(() => { server.close(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
const address = server.address();
const port = typeof address === 'object' && address ? address.port : 3099;
const BASE = `http://127.0.0.1:${port}`;

async function api(
  path: string,
  method = 'GET',
  body?: unknown,
  token?: string
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

test('End-to-End Integration Suite covering Scenarios 1–25', async (t) => {
  let repToken = '';
  let newStudentToken = '';
  let stu2Token = '';
  let coordToken = '';
  let createdCourseId = '';
  let createdReqId = '';
  let createdTaskId = '';
  let uploadedFileId = '';

  await t.test('1. Representative Login & 2–3. Student Account Creation & Separate Session Login', async () => {
    const loginRep = await api('/api/auth/login', 'POST', {
      identifier: 'rep@demo.dbl.local',
      password: 'Demo@2026',
    });
    assert.equal(loginRep.status, 200);
    assert.ok(loginRep.data.token);
    repToken = loginRep.data.token;

    const createStu = await api(
      '/api/users',
      'POST',
      {
        universityId: '20259901',
        fullName: 'طالب اختبار تكاملي',
        email: 'test.stu@dbl.local',
        password: 'TestPass@2026',
        groupName: 'A',
        role: 'student',
      },
      repToken
    );
    assert.equal(createStu.status, 201);

    const loginStu = await api('/api/auth/login', 'POST', {
      identifier: '20259901',
      password: 'TestPass@2026',
    });
    assert.equal(loginStu.status, 200);
    newStudentToken = loginStu.data.token;

    const loginStu2 = await api('/api/auth/login', 'POST', {
      identifier: 'student3@demo.dbl.local', // Group B student
      password: 'Demo@2026',
    });
    assert.equal(loginStu2.status, 200);
    stu2Token = loginStu2.data.token;

    const loginCoord = await api('/api/auth/login', 'POST', {
      identifier: 'coord@demo.dbl.local',
      password: 'Demo@2026',
    });
    assert.equal(loginCoord.status, 200);
    coordToken = loginCoord.data.token;
  });

  await t.test('4–6. Course Creation, Lecture Addition, and Conflict Detection', async () => {
    const cRes = await api(
      '/api/courses',
      'POST',
      {
        code: 'CS299',
        nameAr: 'هندسة البرمجيات المتقدمة',
        nameEn: 'Advanced Software Engineering',
        instructor: 'د. مازن الحمادي',
        creditHours: 3,
      },
      repToken
    );
    assert.equal(cRes.status, 201);
    createdCourseId = cRes.data.id;

    // Add lecture on Saturday 08:00-10:00 in same room as CS102 ('مدرج الخوارزمي (101)') to trigger conflict
    const lRes = await api(
      '/api/lectures',
      'POST',
      {
        courseId: createdCourseId,
        dayOfWeek: 0,
        startTime: '08:30',
        endTime: '09:30',
        location: 'مدرج الخوارزمي (101)',
        instructor: 'د. مازن الحمادي',
        targetGroup: 'A',
        lectureType: 'lecture',
        status: 'proposed',
      },
      repToken
    );
    assert.equal(lRes.status, 201);
    assert.ok(Array.isArray(lRes.data.conflicts));
    assert.ok(lRes.data.conflicts.length >= 1, 'Expected time/room conflict to be detected');
  });

  await t.test('7–10. Assignment & Announcement Target Group Visibility', async () => {
    const asgRes = await api(
      '/api/assignments',
      'POST',
      {
        courseId: createdCourseId,
        title: 'تكليف خاص بالمجموعة A فقط',
        description: 'وصف التكليف',
        instructor: 'د. مازن الحمادي',
        dueDate: '2026-12-10',
        targetGroup: 'A',
      },
      coordToken
    );
    assert.equal(asgRes.status, 201);

    // Group A student sees it
    const listGroupA = await api('/api/assignments', 'GET', undefined, newStudentToken);
    assert.equal(
      listGroupA.data.some((a: any) => a.id === asgRes.data.id),
      true
    );

    // Group B student does NOT see Group A assignment
    const listGroupB = await api('/api/assignments', 'GET', undefined, stu2Token);
    assert.equal(
      listGroupB.data.some((a: any) => a.id === asgRes.data.id),
      false
    );

    const annRes = await api(
      '/api/announcements',
      'POST',
      {
        title: 'إعلان خاص بالمجموعة A',
        content: 'تفاصيل الإعلان',
        category: 'lectures',
        priority: 'important',
        targetGroup: 'A',
      },
      repToken
    );
    assert.equal(annRes.status, 201);

    const annA = await api('/api/announcements', 'GET', undefined, newStudentToken);
    assert.equal(
      annA.data.some((a: any) => a.id === annRes.data.id),
      true
    );

    const annB = await api('/api/announcements', 'GET', undefined, stu2Token);
    assert.equal(
      annB.data.some((a: any) => a.id === annRes.data.id),
      false
    );
  });

  await t.test('11–15. Collective Petition, Endorsement, Duplicate Block, Withdrawal & Text Edit Reset', async () => {
    const reqRes = await api(
      '/api/requests',
      'POST',
      {
        requestType: 'request',
        isCollective: true,
        targetAuthority: 'رئاسة القسم',
        subject: 'طلب فتح شعبة إضافية',
        details: 'تفاصيل الطلب الأصلية',
        proposedSolution: 'فتح شعبة ثالثة',
      },
      repToken
    );
    assert.equal(reqRes.status, 201);
    createdReqId = reqRes.data.id;

    // Student 1 endorses
    const end1 = await api(`/api/requests/${createdReqId}/endorse`, 'POST', {}, newStudentToken);
    assert.equal(end1.status, 201);

    // Prevent duplicate endorsement
    const endDup = await api(`/api/requests/${createdReqId}/endorse`, 'POST', {}, newStudentToken);
    assert.equal(endDup.status, 400);

    // Student 2 endorses
    const end2 = await api(`/api/requests/${createdReqId}/endorse`, 'POST', {}, stu2Token);
    assert.equal(end2.status, 201);

    // Withdraw endorsement by Student 2
    const withdraw2 = await api(`/api/requests/${createdReqId}/endorse`, 'DELETE', {}, stu2Token);
    assert.equal(withdraw2.status, 200);

    // Substantial edit without confirmation returns 409
    const editNoConfirm = await api(
      `/api/requests/${createdReqId}`,
      'PUT',
      {
        targetAuthority: 'رئاسة القسم',
        subject: 'طلب مختلف جوهرياً',
        details: 'تفاصيل جديدة كلياً',
        proposedSolution: 'حل جديد',
        confirmResetEndorsements: false,
      },
      repToken
    );
    assert.equal(editNoConfirm.status, 409);

    // Substantial edit with confirmation resets endorsements to 0
    const editWithConfirm = await api(
      `/api/requests/${createdReqId}`,
      'PUT',
      {
        targetAuthority: 'رئاسة القسم',
        subject: 'طلب مختلف جوهرياً',
        details: 'تفاصيل جديدة كلياً',
        proposedSolution: 'حل جديد',
        confirmResetEndorsements: true,
      },
      repToken
    );
    assert.equal(editWithConfirm.status, 200);
    assert.equal(editWithConfirm.data.endorsementsReset, true);
  });

  await t.test('18–23. Task Delegation, Real File Upload/Download & Unauthorized Access Blocking', async () => {
    const tsk = await api(
      '/api/tasks',
      'POST',
      {
        title: 'مهمة اختبارية للمنسق',
        description: 'رفع ملخص الأسبوع الخامس',
        assignedTo: 'u-coord-demo',
        priority: 'high',
        dueDate: '2026-12-05',
      },
      repToken
    );
    assert.equal(tsk.status, 201);
    createdTaskId = tsk.data.id;

    const updTsk = await api(
      `/api/tasks/${createdTaskId}`,
      'PUT',
      { status: 'completed' },
      coordToken
    );
    assert.equal(updTsk.status, 200);

    // Upload real file restricted to Group A
    const fileContentBase64 = Buffer.from('Real Lecture Notes Content', 'utf-8').toString('base64');
    const upFile = await api(
      '/api/files',
      'POST',
      {
        courseId: createdCourseId,
        category: 'lectures',
        title: 'ملف محاضرة المجموعة A',
        description: 'محتوى فعلي',
        fileName: 'groupA_notes.txt',
        mimeType: 'text/plain',
        base64Content: fileContentBase64,
        targetGroup: 'A',
      },
      coordToken
    );
    assert.equal(upFile.status, 201);
    uploadedFileId = upFile.data.id;

    // Raw ?token= query parameter MUST be rejected (401) to prevent URL/log token leaks
    const dlRawQuery = await fetch(
      `${BASE}/api/files/${uploadedFileId}/download?token=${encodeURIComponent(newStudentToken)}`
    );
    assert.equal(dlRawQuery.status, 401);

    // Group A student downloads successfully via Authorization Bearer header
    const dlA = await fetch(`${BASE}/api/files/${uploadedFileId}/download`, {
      headers: { Authorization: `Bearer ${newStudentToken}` },
    });
    assert.equal(dlA.status, 200);
    assert.equal(dlA.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.equal(dlA.headers.get('x-content-type-options'), 'nosniff');
    const dlText = await dlA.text();
    assert.equal(dlText, 'Real Lecture Notes Content');

    // Group A student can also request a 60s HMAC-signed download ticket and download with it
    const ticketRes = await api(
      `/api/files/${uploadedFileId}/download-ticket`,
      'POST',
      {},
      newStudentToken
    );
    assert.equal(ticketRes.status, 200);
    assert.ok(ticketRes.data.downloadUrl.includes('ticket='));
    const dlTicket = await fetch(`${BASE}${ticketRes.data.downloadUrl}`);
    assert.equal(dlTicket.status, 200);
    assert.equal(await dlTicket.text(), 'Real Lecture Notes Content');

    // Group B student is blocked (403) from downloading Group A restricted file
    const dlB = await fetch(`${BASE}/api/files/${uploadedFileId}/download`, {
      headers: { Authorization: `Bearer ${stu2Token}` },
    });
    assert.equal(dlB.status, 403);

    // Student blocked from Representative functions (e.g. creating course or exporting backup)
    const stuCourseAttempt = await api(
      '/api/courses',
      'POST',
      { code: 'HACK1', nameAr: 'محاولة', instructor: 'س' },
      newStudentToken
    );
    assert.equal(stuCourseAttempt.status, 403);

    const stuBackupAttempt = await api('/api/admin/backup', 'GET', undefined, newStudentToken);
    assert.equal(stuBackupAttempt.status, 403);
  });

  await t.test('24–25. Full Database Backup & Restore Persistence', async () => {
    const backupRes = await api('/api/admin/backup', 'GET', undefined, repToken);
    assert.equal(backupRes.status, 200);
    assert.ok(backupRes.data.tables);

    const restoreRes = await api('/api/admin/restore', 'POST', { ...backupRes.data, currentPassword: 'Demo@2026' }, repToken);
    assert.equal((await api('/api/courses', 'GET', undefined, repToken)).status, 401);
    repToken = (await api('/api/auth/login', 'POST', { identifier: 'rep@demo.dbl.local', password: 'Demo@2026' })).data.token;
    newStudentToken = (await api('/api/auth/login', 'POST', { identifier: '20259901', password: 'TestPass@2026' })).data.token;
    coordToken = (await api('/api/auth/login', 'POST', { identifier: 'coord@demo.dbl.local', password: 'Demo@2026' })).data.token;
    assert.equal(restoreRes.status, 200);
  });

  await t.test('26. Mobile APK/IPA Release Hosting, Magic-Bytes Validation, RBAC & Cleanup', async () => {
    const initial = await api('/api/mobile/releases', 'GET');
    assert.equal(initial.status, 200);
    assert.equal(initial.data.apk.platform, 'apk');
    assert.equal(initial.data.ipa.platform, 'ipa');
    assert.ok(Array.isArray(initial.data.lanUrls));

    // Minimal valid ZIP local file header magic bytes (PK\x03\x04) padded past 64-byte minimum size check
    const validZipBytes = Buffer.alloc(128, 0);
    validZipBytes.set([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00], 0);
    const invalidBytes = Buffer.from('not-a-valid-apk-archive-'.repeat(4), 'utf-8');

    // Student cannot upload mobile releases (403)
    const stuUpload = await fetch(`${BASE}/api/mobile/releases/upload?platform=apk`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${newStudentToken}`,
        'Content-Type': 'application/octet-stream',
      },
      body: validZipBytes,
    });
    assert.equal(stuUpload.status, 403);

    // Representative uploading invalid non-ZIP payload gets 400
    const badUpload = await fetch(`${BASE}/api/mobile/releases/upload?platform=apk`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${repToken}`,
        'Content-Type': 'application/octet-stream',
      },
      body: invalidBytes,
    });
    assert.equal(badUpload.status, 400);

    // Representative uploading valid ZIP-header APK succeeds (201)
    const okUpload = await fetch(`${BASE}/api/mobile/releases/upload?platform=apk`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${repToken}`,
        'Content-Type': 'application/octet-stream',
      },
      body: validZipBytes,
    });
    assert.equal(okUpload.status, 201);

    // Download endpoint serves APK binary with proper MIME type
    const dlApk = await fetch(`${BASE}/api/mobile/download/apk`);
    assert.equal(dlApk.status, 200);
    assert.equal(dlApk.headers.get('content-type'), 'application/vnd.android.package-archive');
    const dlBuf = Buffer.from(await dlApk.arrayBuffer());
    assert.deepEqual(dlBuf, validZipBytes);

    // Clean up test release binary so no dummy APK remains on disk
    const delApk = await api('/api/mobile/releases/apk', 'DELETE', undefined, repToken);
    assert.equal(delApk.status, 200);

    const afterDel = await api('/api/mobile/releases', 'GET');
    assert.equal(afterDel.data.apk.available, false);
  });

  await t.test('27. Public Internet Security: Health, Hashed Sessions, Magic-Bytes Upload, CORS, HTTPS Redirect, Demo Prod Gate & Backup Integrity', async () => {
    // 1. Health check endpoint returns 200 + storageWritable
    const health = await fetch(`${BASE}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(health.headers.get('cache-control'), 'no-store, private');
    const healthJson = await health.json();
    assert.equal(healthJson.status, 'ok');
    assert.equal(healthJson.database, 'ok');
    assert.equal(healthJson.storageWritable, true);

    // 2. Sessions are stored hashed (SHA-256) in SQLite, never raw bearer tokens
    const rawMatch = db.prepare('SELECT token FROM sessions WHERE token = ?').get(repToken);
    assert.equal(rawMatch, undefined);
    const hashedMatch = db
      .prepare('SELECT token FROM sessions WHERE token = ?')
      .get(hashSessionToken(repToken));
    assert.ok(hashedMatch);

    // 3. Disguised script uploaded as .pdf is rejected by magic-bytes validation (400)
    const fakePdf = await api(
      '/api/files',
      'POST',
      {
        courseId: createdCourseId,
        category: 'lectures',
        title: 'ملف مزيف',
        description: 'محاولة رفع سكربت كـ PDF',
        fileName: 'malicious.pdf',
        mimeType: 'application/pdf',
        base64Content: Buffer.from('<script>alert(1)</script>', 'utf8').toString('base64'),
        targetGroup: 'ALL',
      },
      coordToken
    );
    assert.equal(fakePdf.status, 400);

    // 4. Scoped CORS allows configured HTTPS APP_URL and blocks untrusted external origins
    const prevAppUrl = process.env.APP_URL;
    process.env.APP_URL = 'https://campus.university.edu';
    try {
      const okCors = await fetch(`${BASE}/api/health`, {
        headers: { Origin: 'https://campus.university.edu' },
      });
      assert.equal(okCors.headers.get('access-control-allow-origin'), 'https://campus.university.edu');

      const badCors = await fetch(`${BASE}/api/health`, {
        headers: { Origin: 'https://evil.attacker.example' },
      });
      assert.equal(badCors.headers.get('access-control-allow-origin'), null);
    } finally {
      if (prevAppUrl === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = prevAppUrl;
    }

    // 5. HTTPS redirect behind proxy when DBL_FORCE_HTTPS=true (exempting /api/health)
    const prevForceHttps = process.env.DBL_FORCE_HTTPS;
    const previousUrl = process.env.APP_URL;
    process.env.APP_URL = 'https://campus.university.edu';
    process.env.DBL_FORCE_HTTPS = 'true';
    try {
      const redirected = await fetch(`${BASE}/api/auth/status`, {
        headers: { 'X-Forwarded-Proto': 'http' },
        redirect: 'manual',
      });
      assert.equal(redirected.status, 308);
      assert.ok(redirected.headers.get('location')?.startsWith('https://'));

      const healthNoRedirect = await fetch(`${BASE}/api/health`, {
        headers: { 'X-Forwarded-Proto': 'http' },
        redirect: 'manual',
      });
      assert.equal(healthNoRedirect.status, 200);
    } finally {
      if (previousUrl === undefined) delete process.env.APP_URL; else process.env.APP_URL = previousUrl;
      if (prevForceHttps === undefined) delete process.env.DBL_FORCE_HTTPS;
      else process.env.DBL_FORCE_HTTPS = prevForceHttps;
    }

    // 6. Demo login blocked (403) when DBL_ALLOW_DEMO=false
    const prevAllowDemo = process.env.DBL_ALLOW_DEMO;
    process.env.DBL_ALLOW_DEMO = 'false';
    try {
      const blockedDemo = await api('/api/auth/demo-login', 'POST', { userId: 'u-rep-demo' });
      assert.equal(blockedDemo.status, 403);
      const statusNoDemo = await api('/api/auth/status', 'GET');
      assert.equal(statusNoDemo.data.demoEnabled, false);
      assert.equal(statusNoDemo.data.demoAccounts.length, 0);
    } finally {
      if (prevAllowDemo === undefined) delete process.env.DBL_ALLOW_DEMO;
      else process.env.DBL_ALLOW_DEMO = prevAllowDemo;
    }

    // 7. Backup checksum integrity & atomic SQLite binary download
    const backup = await api('/api/admin/backup', 'GET', undefined, repToken);
    assert.equal(backup.status, 200);
    assert.equal(typeof backup.data.checksumSha256, 'string');
    assert.equal(backup.data.checksumSha256.length, 64);
    assert.equal(backup.data.tables.sessions, undefined);

    const tamperedRestore = await api(
      '/api/admin/restore',
      'POST',
      { ...backup.data, currentPassword: 'Demo@2026', checksumSha256: '0'.repeat(64) },
      repToken
    );
    assert.equal(tamperedRestore.status, 400);

    const sqliteDl = await fetch(`${BASE}/api/admin/backup/sqlite`, {
      headers: { Authorization: `Bearer ${repToken}` },
    });
    assert.equal(sqliteDl.status, 200);
    const sqliteBuf = Buffer.from(await sqliteDl.arrayBuffer());
    assert.equal(sqliteBuf.subarray(0, 16).toString('ascii'), 'SQLite format 3\0');
  });

});
