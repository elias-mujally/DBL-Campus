import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import {
  db,
  hashPassword,
  logAudit,
  purgeDemoData,
  runMigrations,
  seedDemoEnvironment,
  UPLOADS_DIR,
  verifyPassword,
} from './src/server/db.ts';
import type {
  Lecture,
  RequestStatus,
  ResponsibilityKey,
  UserAccount,
  UserRole,
} from './src/types.ts';
import {
  canModifyEndorsement,
  computeRequestVersionHash,
  detectScheduleConflicts,
  doGroupsOverlap,
  hasPermission,
  requiresEndorsementResetOnEdit,
  validateRequestTransition,
} from './src/utils/domainLogic.ts';

runMigrations();
seedDemoEnvironment(false);

export const app = express();

// Scoped CORS for Capacitor Android/iOS native shells & LAN hosts (never wildcard '*' on authenticated endpoints)
function isAllowedMobileOrigin(origin: string): boolean {
  if (
    origin === 'capacitor://localhost' ||
    origin === 'ionic://localhost' ||
    origin === 'http://localhost' ||
    origin === 'https://localhost' ||
    /^http:\/\/localhost:\d+$/.test(origin) ||
    /^http:\/\/127\.0\.0\.1:\d+$/.test(origin) ||
    /^http:\/\/192\.168\.\d{1,3}\.\d{1,3}(:\d+)?$/.test(origin) ||
    /^http:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/.test(origin) ||
    /^http:\/\/172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}(:\d+)?$/.test(origin)
  ) {
    return true;
  }
  return false;
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedMobileOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(express.json({ limit: '12mb' }));

// Simple rate limiter for login attempts
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function checkLoginRateLimit(key: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= 10) {
    return false;
  }
  entry.count += 1;
  return true;
}

interface DbUserRow {
  id: string;
  university_id: string;
  full_name: string;
  email: string;
  password_hash: string;
  role: UserRole;
  group_name: string;
  responsibilities_json: string;
  is_active: number;
  is_demo: number;
  created_at: string;
}

function mapUserRow(row: DbUserRow): UserAccount {
  let responsibilities: ResponsibilityKey[] = [];
  try {
    responsibilities = JSON.parse(row.responsibilities_json || '[]');
  } catch {
    responsibilities = [];
  }
  return {
    id: row.id,
    universityId: row.university_id,
    fullName: row.full_name,
    email: row.email,
    role: row.role,
    groupName: row.group_name,
    responsibilities,
    isActive: row.is_active === 1,
    isDemo: row.is_demo === 1,
    createdAt: row.created_at,
  };
}

function createSessionToken(userId: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 7); // 7 days
  db.prepare(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(token, userId, now.toISOString(), expires.toISOString());
  return token;
}

function getAuthenticatedUser(req: express.Request): UserAccount | null {
  const authHeader = req.headers.authorization;
  let token = '';
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else if (typeof req.query.token === 'string') {
    token = req.query.token.trim();
  }
  if (!token) return null;

  const session = db
    .prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?')
    .get(token) as { user_id: string; expires_at: string } | undefined;

  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }

  const userRow = db
    .prepare('SELECT * FROM users WHERE id = ? AND is_active = 1')
    .get(session.user_id) as DbUserRow | undefined;

  if (!userRow) return null;
  return mapUserRow(userRow);
}

function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const user = getAuthenticatedUser(req);
  if (!user) {
    res.status(401).json({ error: 'يرجى تسجيل الدخول للوصول إلى هذه الخدمة.' });
    return;
  }
  (req as express.Request & { user: UserAccount }).user = user;
  next();
}

// ==========================================
// 1. AUTHENTICATION & BOOTSTRAP ROUTES
// ==========================================

app.get('/api/auth/status', (req, res) => {
  const user = getAuthenticatedUser(req);
  const prodRepCount = (
    db
      .prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'representative' AND is_demo = 0")
      .get() as { cnt: number }
  ).cnt;
  const demoAccounts = (
    db
      .prepare('SELECT * FROM users WHERE is_demo = 1 AND is_active = 1 ORDER BY created_at ASC')
      .all() as DbUserRow[]
  ).map(mapUserRow);

  res.json({
    user,
    hasProductionRepresentative: prodRepCount > 0,
    requiresSetupPasscode: Boolean(process.env.DBL_ADMIN_SETUP_CODE),
    demoAccounts,
  });
});

app.post('/api/auth/login', (req, res) => {
  const { identifier, password } = req.body || {};
  if (!identifier || !password) {
    res.status(400).json({ error: 'يرجى إدخال الرقم الجامعي أو البريد الإلكتروني وكلمة المرور.' });
    return;
  }

  const rateKey = `${req.ip || 'local'}:${String(identifier).trim().toLowerCase()}`;
  if (!checkLoginRateLimit(rateKey)) {
    res.status(429).json({
      error: 'تم تجاوز الحد المسموح لمحاولات تسجيل الدخول. يرجى الانتظار دقيقة واحدة.',
    });
    return;
  }

  const cleanId = String(identifier).trim();
  const userRow = db
    .prepare('SELECT * FROM users WHERE (LOWER(email) = LOWER(?) OR university_id = ?)')
    .get(cleanId, cleanId) as DbUserRow | undefined;

  if (!userRow || !verifyPassword(String(password), userRow.password_hash)) {
    res.status(401).json({ error: 'بيانات الدخول غير صحيحة.' });
    return;
  }

  if (userRow.is_active !== 1) {
    res.status(403).json({ error: 'هذا الحساب معطل حالياً. يرجى مراجعة مندوب الدفعة.' });
    return;
  }

  const user = mapUserRow(userRow);
  const token = createSessionToken(user.id);
  logAudit(user, 'LOGIN', 'user', user.id, 'تسجيل دخول ناجح');

  res.json({ token, user });
});

app.post('/api/auth/demo-login', (req, res) => {
  const { userId } = req.body || {};
  const userRow = db
    .prepare('SELECT * FROM users WHERE id = ? AND is_demo = 1 AND is_active = 1')
    .get(String(userId || '')) as DbUserRow | undefined;

  if (!userRow) {
    res.status(404).json({ error: 'الحساب التجريبي غير موجود.' });
    return;
  }

  const user = mapUserRow(userRow);
  const token = createSessionToken(user.id);
  res.json({ token, user });
});

app.post('/api/auth/setup-production-rep', (req, res) => {
  const prodRepCount = (
    db
      .prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'representative' AND is_demo = 0")
      .get() as { cnt: number }
  ).cnt;

  if (prodRepCount > 0) {
    res.status(403).json({ error: 'تم إعداد حساب مندوب الدفعة الفعلي مسبقاً.' });
    return;
  }

  const { universityId, fullName, email, password, groupName, setupCode } = req.body || {};
  if (process.env.DBL_ADMIN_SETUP_CODE) {
    if (String(setupCode || '') !== process.env.DBL_ADMIN_SETUP_CODE) {
      res.status(403).json({ error: 'رمز الإعداد الأولي غير صحيح.' });
      return;
    }
  }

  if (!universityId || !fullName || !email || !password || String(password).length < 6) {
    res.status(400).json({
      error: 'يرجى تعبئة جميع الحقول المطلوبة والتأكد من أن كلمة المرور لا تقل عن 6 أحرف.',
    });
    return;
  }

  const id = `u-rep-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const allResps: ResponsibilityKey[] = [
    'lectures',
    'assignments',
    'files',
    'announcements',
    'requests',
    'students',
    'permissions',
    'backup',
  ];

  try {
    db.prepare(
      `INSERT INTO users (id, university_id, full_name, email, password_hash, role, group_name, responsibilities_json, is_active, is_demo, created_at)
       VALUES (?, ?, ?, ?, ?, 'representative', ?, ?, 1, 0, ?)`
    ).run(
      id,
      String(universityId).trim(),
      String(fullName).trim(),
      String(email).trim(),
      hashPassword(String(password)),
      String(groupName || 'A').trim(),
      JSON.stringify(allResps),
      now
    );

    const createdRow = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as DbUserRow;
    const user = mapUserRow(createdRow);
    const token = createSessionToken(user.id);
    logAudit(user, 'SETUP_PRODUCTION_REP', 'user', user.id, 'إعداد حساب مندوب الدفعة الفعلي لأول مرة');
    res.status(201).json({ token, user });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    res.status(400).json({
      error: msg.includes('UNIQUE')
        ? 'الرقم الجامعي أو البريد الإلكتروني مسجل مسبقاً.'
        : 'تعذر إنشاء الحساب.',
    });
  }
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }
  res.json({ ok: true });
});

app.put('/api/auth/profile', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  const { fullName, email, newPassword } = req.body || {};
  if (!fullName || !email) {
    res.status(400).json({ error: 'الاسم الكامل والبريد الإلكتروني مطلوبان.' });
    return;
  }

  try {
    if (newPassword && String(newPassword).trim().length > 0) {
      if (String(newPassword).length < 6) {
        res.status(400).json({ error: 'كلمة المرور الجديدة يجب ألا تقل عن 6 أحرف.' });
        return;
      }
      db.prepare('UPDATE users SET full_name = ?, email = ?, password_hash = ? WHERE id = ?').run(
        String(fullName).trim(),
        String(email).trim(),
        hashPassword(String(newPassword)),
        user.id
      );
    } else {
      db.prepare('UPDATE users SET full_name = ?, email = ? WHERE id = ?').run(
        String(fullName).trim(),
        String(email).trim(),
        user.id
      );
    }

    const updated = mapUserRow(
      db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as DbUserRow
    );
    res.json({ user: updated });
  } catch {
    res.status(400).json({ error: 'تعذر تحديث الملف الشخصي (قد يكون البريد مستخدماً).' });
  }
});

// ==========================================
// 2. COURSES & SCHEDULE ROUTES
// ==========================================

app.get('/api/courses', requireAuth, (_req, res) => {
  const rows = db.prepare('SELECT * FROM courses ORDER BY code ASC').all() as Array<{
    id: string;
    code: string;
    name_ar: string;
    name_en: string;
    instructor: string;
    credit_hours: number;
    level: string;
    semester: string;
    is_demo: number;
  }>;

  res.json(
    rows.map((r) => ({
      id: r.id,
      code: r.code,
      nameAr: r.name_ar,
      nameEn: r.name_en,
      instructor: r.instructor,
      creditHours: r.credit_hours,
      level: r.level,
      semester: r.semester,
      isDemo: r.is_demo === 1,
    }))
  );
});

app.post('/api/courses', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  if (!hasPermission(user, 'lectures')) {
    res.status(403).json({ error: 'ليس لديك صلاحية إدارة المقررات الدراسية.' });
    return;
  }

  const { code, nameAr, nameEn, instructor, creditHours, level, semester } = req.body || {};
  if (!code || !nameAr || !instructor) {
    res.status(400).json({ error: 'رمز المقرر واسمه والمدرس حقول إلزامية.' });
    return;
  }

  const id = `c-${crypto.randomUUID().slice(0, 8)}`;
  try {
    db.prepare(
      `INSERT INTO courses (id, code, name_ar, name_en, instructor, credit_hours, level, semester, is_demo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      String(code).trim().toUpperCase(),
      String(nameAr).trim(),
      String(nameEn || nameAr).trim(),
      String(instructor).trim(),
      Number(creditHours) || 3,
      String(level || 'المستوى الأول').trim(),
      String(semester || 'الفصل الدراسي الثاني').trim(),
      user.isDemo ? 1 : 0
    );

    logAudit(user, 'CREATE_COURSE', 'course', id, `إضافة مقرر ${nameAr} (${code})`);
    res.status(201).json({ id });
  } catch {
    res.status(400).json({ error: 'رمز المقرر موجود مسبقاً.' });
  }
});

app.delete('/api/courses/:id', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  if (!hasPermission(user, 'lectures')) {
    res.status(403).json({ error: 'ليس لديك صلاحية حذف المقررات.' });
    return;
  }
  db.prepare('DELETE FROM courses WHERE id = ?').run(req.params.id);
  logAudit(user, 'DELETE_COURSE', 'course', req.params.id, 'حذف مقرر دراسي');
  res.json({ ok: true });
});

function getAllLectures(): Lecture[] {
  const rows = db
    .prepare(
      `SELECT l.*, c.name_ar as course_name_ar, c.name_en as course_name_en, c.code as course_code
       FROM lectures l
       LEFT JOIN courses c ON c.id = l.course_id
       ORDER BY l.day_of_week ASC, l.start_time ASC`
    )
    .all() as Array<{
    id: string;
    course_id: string;
    course_name_ar: string;
    course_name_en: string;
    course_code: string;
    day_of_week: number;
    start_time: string;
    end_time: string;
    location: string;
    instructor: string;
    target_group: string;
    lecture_type: 'lecture' | 'lab' | 'tutorial';
    status: 'official' | 'proposed' | 'confirmed_temp' | 'cancelled';
    notes: string;
    specific_date?: string;
    created_by: string;
    is_demo: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    courseId: r.course_id,
    courseNameAr: r.course_name_ar,
    courseNameEn: r.course_name_en,
    courseCode: r.course_code,
    dayOfWeek: r.day_of_week,
    startTime: r.start_time,
    endTime: r.end_time,
    location: r.location,
    instructor: r.instructor,
    targetGroup: r.target_group,
    lectureType: r.lecture_type,
    status: r.status,
    notes: r.notes,
    specificDate: r.specific_date,
    createdBy: r.created_by,
    isDemo: r.is_demo === 1,
  }));
}

app.get('/api/lectures', requireAuth, (_req, res) => {
  const lectures = getAllLectures();
  const conflicts = detectScheduleConflicts(lectures);
  res.json({ lectures, conflicts });
});

app.post('/api/lectures', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  if (!hasPermission(user, 'lectures')) {
    res.status(403).json({ error: 'ليس لديك صلاحية تعديل الجدول الدراسي.' });
    return;
  }

  const {
    courseId,
    dayOfWeek,
    startTime,
    endTime,
    location,
    instructor,
    targetGroup,
    lectureType,
    status,
    notes,
  } = req.body || {};

  if (!courseId || dayOfWeek === undefined || !startTime || !endTime || !location || !instructor) {
    res.status(400).json({ error: 'يرجى استكمال جميع بيانات المحاضرة (المادة، اليوم، الوقت، القاعة، المدرس).' });
    return;
  }

  const id = `lec-${crypto.randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO lectures (id, course_id, day_of_week, start_time, end_time, location, instructor, target_group, lecture_type, status, notes, created_by, is_demo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    String(courseId),
    Number(dayOfWeek),
    String(startTime),
    String(endTime),
    String(location).trim(),
    String(instructor).trim(),
    String(targetGroup || 'ALL').trim(),
    String(lectureType || 'lecture'),
    String(status || 'official'),
    String(notes || '').trim(),
    user.id,
    user.isDemo ? 1 : 0
  );

  logAudit(user, 'CREATE_LECTURE', 'lecture', id, `إضافة محاضرة في ${location} (${startTime}-${endTime})`);
  const lectures = getAllLectures();
  const conflicts = detectScheduleConflicts(lectures);
  res.status(201).json({ id, lectures, conflicts });
});

app.put('/api/lectures/:id', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  if (!hasPermission(user, 'lectures')) {
    res.status(403).json({ error: 'ليس لديك صلاحية تعديل المحاضرات.' });
    return;
  }

  const {
    courseId,
    dayOfWeek,
    startTime,
    endTime,
    location,
    instructor,
    targetGroup,
    lectureType,
    status,
    notes,
  } = req.body || {};

  db.prepare(
    `UPDATE lectures
     SET course_id = ?, day_of_week = ?, start_time = ?, end_time = ?, location = ?, instructor = ?, target_group = ?, lecture_type = ?, status = ?, notes = ?
     WHERE id = ?`
  ).run(
    String(courseId),
    Number(dayOfWeek),
    String(startTime),
    String(endTime),
    String(location).trim(),
    String(instructor).trim(),
    String(targetGroup || 'ALL').trim(),
    String(lectureType || 'lecture'),
    String(status || 'official'),
    String(notes || '').trim(),
    req.params.id
  );

  logAudit(user, 'UPDATE_LECTURE', 'lecture', req.params.id, `تحديث حالة/بيانات المحاضرة إلى ${status}`);
  const lectures = getAllLectures();
  const conflicts = detectScheduleConflicts(lectures);
  res.json({ lectures, conflicts });
});

app.delete('/api/lectures/:id', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  if (!hasPermission(user, 'lectures')) {
    res.status(403).json({ error: 'ليس لديك صلاحية حذف المحاضرات.' });
    return;
  }
  db.prepare('DELETE FROM lectures WHERE id = ?').run(req.params.id);
  logAudit(user, 'DELETE_LECTURE', 'lecture', req.params.id, 'حذف محاضرة من الجدول');
  const lectures = getAllLectures();
  const conflicts = detectScheduleConflicts(lectures);
  res.json({ lectures, conflicts });
});

// ==========================================
// 3. ASSIGNMENTS & STUDENT PROGRESS ROUTES
// ==========================================

app.get('/api/assignments', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  const rows = db
    .prepare(
      `SELECT a.*, c.name_ar as course_name_ar, c.code as course_code, u.full_name as creator_name,
              ap.personal_status
       FROM assignments a
       LEFT JOIN courses c ON c.id = a.course_id
       LEFT JOIN users u ON u.id = a.created_by
       LEFT JOIN assignment_progress ap ON ap.assignment_id = a.id AND ap.student_id = ?
       ORDER BY a.due_date ASC`
    )
    .all(user.id) as Array<{
    id: string;
    course_id: string;
    course_name_ar: string;
    course_code: string;
    title: string;
    description: string;
    instructor: string;
    published_at: string;
    due_date: string;
    target_group: string;
    general_status: 'active' | 'extended' | 'completed' | 'cancelled';
    confirmation_status: 'confirmed_instructor' | 'confirmed_rep' | 'unconfirmed_student';
    source_note: string;
    attachment_name?: string;
    created_by: string;
    creator_name?: string;
    personal_status?: 'not_started' | 'in_progress' | 'completed';
    is_demo: number;
  }>;

  const canManageAll = hasPermission(user, 'assignments') || user.role === 'representative';
  const filtered = rows.filter(
    (r) => canManageAll || doGroupsOverlap(r.target_group, user.groupName)
  );

  res.json(
    filtered.map((r) => ({
      id: r.id,
      courseId: r.course_id,
      courseNameAr: r.course_name_ar,
      courseCode: r.course_code,
      title: r.title,
      description: r.description,
      instructor: r.instructor,
      publishedAt: r.published_at,
      dueDate: r.due_date,
      targetGroup: r.target_group,
      generalStatus: r.general_status,
      confirmationStatus: r.confirmation_status,
      sourceNote: r.source_note,
      attachmentName: r.attachment_name,
      createdBy: r.created_by,
      creatorName: r.creator_name,
      personalStatus: r.personal_status || 'not_started',
      isDemo: r.is_demo === 1,
    }))
  );
});

app.post('/api/assignments', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  if (!hasPermission(user, 'assignments')) {
    res.status(403).json({ error: 'ليس لديك صلاحية نشر التكاليف الدراسية.' });
    return;
  }

  const {
    courseId,
    title,
    description,
    instructor,
    dueDate,
    targetGroup,
    generalStatus,
    confirmationStatus,
    sourceNote,
    attachmentName,
  } = req.body || {};

  if (!courseId || !title || !dueDate) {
    res.status(400).json({ error: 'يرجى تحديد المقرر وعنوان التكليف وموعد التسليم.' });
    return;
  }

  const id = `asg-${crypto.randomUUID().slice(0, 8)}`;
  const publishedAt = new Date().toISOString().slice(0, 10);

  db.prepare(
    `INSERT INTO assignments (id, course_id, title, description, instructor, published_at, due_date, target_group, general_status, confirmation_status, source_note, attachment_name, created_by, is_demo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    String(courseId),
    String(title).trim(),
    String(description || '').trim(),
    String(instructor || '').trim(),
    publishedAt,
    String(dueDate),
    String(targetGroup || 'ALL').trim(),
    String(generalStatus || 'active'),
    String(confirmationStatus || 'confirmed_rep'),
    String(sourceNote || '').trim(),
    attachmentName ? String(attachmentName).trim() : null,
    user.id,
    user.isDemo ? 1 : 0
  );

  logAudit(user, 'CREATE_ASSIGNMENT', 'assignment', id, `نشر تكليف: ${title}`);
  res.status(201).json({ id });
});

app.put('/api/assignments/:id/progress', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  const { personalStatus } = req.body || {};
  if (!['not_started', 'in_progress', 'completed'].includes(String(personalStatus))) {
    res.status(400).json({ error: 'حالة التقدم الشخصية غير صالحة.' });
    return;
  }

  db.prepare(
    `INSERT OR REPLACE INTO assignment_progress (assignment_id, student_id, personal_status, updated_at)
     VALUES (?, ?, ?, ?)`
  ).run(req.params.id, user.id, String(personalStatus), new Date().toISOString());

  res.json({ ok: true, personalStatus });
});

app.put('/api/assignments/:id/status', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  if (!hasPermission(user, 'assignments')) {
    res.status(403).json({ error: 'ليس لديك صلاحية تعديل الحالة العامة للتكليف.' });
    return;
  }
  const { generalStatus } = req.body || {};
  db.prepare('UPDATE assignments SET general_status = ? WHERE id = ?').run(
    String(generalStatus),
    req.params.id
  );
  logAudit(user, 'UPDATE_ASSIGNMENT', 'assignment', req.params.id, `تغيير حالة التكليف إلى ${generalStatus}`);
  res.json({ ok: true });
});

// ==========================================
// 4. ANNOUNCEMENTS & NOTIFICATIONS ROUTES
// ==========================================

app.get('/api/announcements', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  const rows = db
    .prepare(
      `SELECT a.*, u.full_name as publisher_name,
              CASE WHEN ar.user_id IS NOT NULL THEN 1 ELSE 0 END as is_read
       FROM announcements a
       LEFT JOIN users u ON u.id = a.created_by
       LEFT JOIN announcement_reads ar ON ar.announcement_id = a.id AND ar.user_id = ?
       ORDER BY a.is_pinned DESC, a.created_at DESC`
    )
    .all(user.id) as Array<{
    id: string;
    title: string;
    content: string;
    category: 'general' | 'lectures' | 'assignments' | 'exams' | 'administrative' | 'urgent';
    priority: 'normal' | 'important' | 'urgent';
    target_group: string;
    is_pinned: number;
    attachment_name?: string;
    created_by: string;
    publisher_name?: string;
    created_at: string;
    is_read: number;
    is_demo: number;
  }>;

  const canManageAll = hasPermission(user, 'announcements') || user.role === 'representative';
  const visible = rows.filter(
    (r) => canManageAll || doGroupsOverlap(r.target_group, user.groupName)
  );

  res.json(
    visible.map((r) => ({
      id: r.id,
      title: r.title,
      content: r.content,
      category: r.category,
      priority: r.priority,
      targetGroup: r.target_group,
      isPinned: r.is_pinned === 1,
      attachmentName: r.attachment_name,
      createdBy: r.created_by,
      publisherName: r.publisher_name || 'إدارة الدفعة',
      createdAt: r.created_at,
      isRead: r.is_read === 1,
      isDemo: r.is_demo === 1,
    }))
  );
});

app.post('/api/announcements', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  if (!hasPermission(user, 'announcements')) {
    res.status(403).json({ error: 'ليس لديك صلاحية نشر الإعلانات.' });
    return;
  }

  const { title, content, category, priority, targetGroup, isPinned, attachmentName } = req.body || {};
  if (!title || !content) {
    res.status(400).json({ error: 'عنوان الإعلان ومحتواه مطلوبان.' });
    return;
  }

  const id = `ann-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO announcements (id, title, content, category, priority, target_group, is_pinned, attachment_name, created_by, created_at, is_demo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    String(title).trim(),
    String(content).trim(),
    String(category || 'general'),
    String(priority || 'normal'),
    String(targetGroup || 'ALL').trim(),
    isPinned ? 1 : 0,
    attachmentName ? String(attachmentName).trim() : null,
    user.id,
    now,
    user.isDemo ? 1 : 0
  );

  logAudit(user, 'CREATE_ANNOUNCEMENT', 'announcement', id, `نشر إعلان: ${title}`);
  res.status(201).json({ id });
});

app.post('/api/announcements/:id/read', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  db.prepare(
    `INSERT OR REPLACE INTO announcement_reads (announcement_id, user_id, read_at)
     VALUES (?, ?, ?)`
  ).run(req.params.id, user.id, new Date().toISOString());
  res.json({ ok: true });
});

app.put('/api/announcements/:id/pin', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  if (!hasPermission(user, 'announcements')) {
    res.status(403).json({ error: 'ليس لديك صلاحية تثبيت الإعلانات.' });
    return;
  }
  const { isPinned } = req.body || {};
  db.prepare('UPDATE announcements SET is_pinned = ? WHERE id = ?').run(
    isPinned ? 1 : 0,
    req.params.id
  );
  res.json({ ok: true });
});

// ==========================================
// 5. REQUESTS, COMPLAINTS & ENDORSEMENTS
// ==========================================

app.get('/api/requests', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  const canManageRequests = hasPermission(user, 'requests');

  const rows = db
    .prepare(
      `SELECT r.*, u.full_name as creator_name, a.full_name as assignee_name,
              (SELECT COUNT(*) FROM request_endorsements re WHERE re.request_id = r.id) as endorsement_count,
              (SELECT COUNT(*) FROM request_endorsements re WHERE re.request_id = r.id AND re.student_id = ?) as user_has_endorsed
       FROM requests r
       LEFT JOIN users u ON u.id = r.created_by
       LEFT JOIN users a ON a.id = r.assigned_to
       ORDER BY r.created_at DESC`
    )
    .all(user.id) as Array<{
    id: string;
    reference_number: string;
    request_type: 'request' | 'complaint' | 'suggestion';
    is_collective: number;
    target_authority: string;
    subject: string;
    details: string;
    proposed_solution: string;
    attachment_name?: string;
    status: RequestStatus;
    created_by: string;
    creator_name?: string;
    assigned_to?: string;
    assignee_name?: string;
    authority_response?: string;
    version_hash: string;
    created_at: string;
    closed_at?: string;
    endorsement_count: number;
    user_has_endorsed: number;
    is_demo: number;
  }>;

  // Students only see collective requests (that are not someone else's private draft) or their own individual requests
  const visible = rows.filter((r) => {
    if (canManageRequests) return true;
    if (r.created_by === user.id) return true;
    if (r.is_collective === 1 && r.status !== 'draft') return true;
    return false;
  });

  const result = visible.map((r) => {
    const history = db
      .prepare('SELECT * FROM request_history WHERE request_id = ? ORDER BY created_at ASC')
      .all(r.id) as Array<{
      id: string;
      request_id: string;
      actor_id: string;
      actor_name: string;
      action: string;
      old_status?: string;
      new_status?: string;
      note: string;
      created_at: string;
    }>;

    // Only authorized request managers/representatives can view the full list of endorsers
    let endorsements = undefined;
    if (canManageRequests) {
      const endRows = db
        .prepare(
          `SELECT re.*, u.full_name as student_name, u.university_id, u.group_name
           FROM request_endorsements re
           JOIN users u ON u.id = re.student_id
           WHERE re.request_id = ?
           ORDER BY re.created_at ASC`
        )
        .all(r.id) as Array<{
        id: string;
        request_id: string;
        student_id: string;
        student_name: string;
        university_id: string;
        group_name: string;
        request_version_hash: string;
        created_at: string;
      }>;

      endorsements = endRows.map((e) => ({
        id: e.id,
        requestId: e.request_id,
        studentId: e.student_id,
        studentName: e.student_name,
        universityId: e.university_id,
        groupName: e.group_name,
        requestVersionHash: e.request_version_hash,
        createdAt: e.created_at,
      }));
    }

    return {
      id: r.id,
      referenceNumber: r.reference_number,
      requestType: r.request_type,
      isCollective: r.is_collective === 1,
      targetAuthority: r.target_authority,
      subject: r.subject,
      details: r.details,
      proposedSolution: r.proposed_solution,
      attachmentName: r.attachment_name,
      status: r.status,
      createdBy: r.created_by,
      creatorName: r.creator_name,
      assignedTo: r.assigned_to,
      assigneeName: r.assignee_name,
      authorityResponse: r.authority_response,
      versionHash: r.version_hash,
      createdAt: r.created_at,
      closedAt: r.closed_at,
      endorsementCount: r.endorsement_count,
      userHasEndorsed: r.user_has_endorsed > 0,
      endorsements,
      history: history.map((h) => ({
        id: h.id,
        requestId: h.request_id,
        actorId: h.actor_id,
        actorName: h.actor_name,
        action: h.action,
        oldStatus: h.old_status,
        newStatus: h.new_status,
        note: h.note,
        createdAt: h.created_at,
      })),
      isDemo: r.is_demo === 1,
    };
  });

  res.json(result);
});

app.post('/api/requests', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  const {
    requestType,
    isCollective,
    targetAuthority,
    subject,
    details,
    proposedSolution,
    attachmentName,
    initialStatus,
  } = req.body || {};

  if (!targetAuthority || !subject || !details) {
    res.status(400).json({ error: 'يرجى إدخال الجهة الموجه إليها الطلب، الموضوع، وتفاصيل المشكلة.' });
    return;
  }

  const id = `req-${crypto.randomUUID().slice(0, 8)}`;
  const count = (db.prepare('SELECT COUNT(*) as cnt FROM requests').get() as { cnt: number }).cnt + 1;
  const referenceNumber = `DBL-2026-${String(count).padStart(3, '0')}-${crypto
    .randomBytes(1)
    .toString('hex')
    .toUpperCase()}`;
  const now = new Date().toISOString();
  const versionHash = computeRequestVersionHash(
    String(subject),
    String(details),
    String(proposedSolution || '')
  );

  const status: RequestStatus =
    initialStatus === 'draft'
      ? 'draft'
      : isCollective
      ? 'open_for_endorsement'
      : 'submitted';

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO requests (id, reference_number, request_type, is_collective, target_authority, subject, details, proposed_solution, attachment_name, status, created_by, assigned_to, version_hash, created_at, is_demo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      referenceNumber,
      String(requestType || 'request'),
      isCollective ? 1 : 0,
      String(targetAuthority).trim(),
      String(subject).trim(),
      String(details).trim(),
      String(proposedSolution || '').trim(),
      attachmentName ? String(attachmentName).trim() : null,
      status,
      user.id,
      'u-rep-demo',
      versionHash,
      now,
      user.isDemo ? 1 : 0
    );

    db.prepare(
      `INSERT INTO request_history (id, request_id, actor_id, actor_name, action, old_status, new_status, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `rh-${crypto.randomUUID().slice(0, 8)}`,
      id,
      user.id,
      user.fullName,
      'إنشاء المعاملة',
      null,
      status,
      isCollective ? 'تم إنشاء معاملة جماعية' : 'تم تقديم معاملة فردية للمتابعة',
      now
    );

    // Creator automatically endorses if collective & open_for_endorsement
    if (isCollective && status === 'open_for_endorsement') {
      db.prepare(
        `INSERT INTO request_endorsements (id, request_id, student_id, request_version_hash, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(`end-${crypto.randomUUID().slice(0, 8)}`, id, user.id, versionHash, now);
    }
  });

  tx();
  logAudit(user, 'CREATE_REQUEST', 'request', id, `إنشاء معاملة رقم ${referenceNumber}: ${subject}`);
  res.status(201).json({ id, referenceNumber });
});

app.put('/api/requests/:id', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  const existing = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id) as
    | {
        id: string;
        created_by: string;
        status: RequestStatus;
        version_hash: string;
        subject: string;
      }
    | undefined;

  if (!existing) {
    res.status(404).json({ error: 'المعاملة غير موجودة.' });
    return;
  }

  const canManage = hasPermission(user, 'requests') || existing.created_by === user.id;
  if (!canManage) {
    res.status(403).json({ error: 'ليس لديك صلاحية تعديل نص هذا الطلب.' });
    return;
  }

  if (!['draft', 'open_for_endorsement'].includes(existing.status)) {
    res.status(400).json({ error: 'لا يمكن تعديل نص الطلب بعد إغلاق باب التأييد أو رفعه للجهة المختصة.' });
    return;
  }

  const { targetAuthority, subject, details, proposedSolution, confirmResetEndorsements } = req.body || {};
  const newHash = computeRequestVersionHash(
    String(subject || ''),
    String(details || ''),
    String(proposedSolution || '')
  );

  const endorsementCount = (
    db
      .prepare('SELECT COUNT(*) as cnt FROM request_endorsements WHERE request_id = ?')
      .get(existing.id) as { cnt: number }
  ).cnt;

  const needsReset = requiresEndorsementResetOnEdit(existing.version_hash, newHash, endorsementCount);
  if (needsReset && !confirmResetEndorsements) {
    res.status(409).json({
      requiresConfirmation: true,
      error:
        'تغيير نص الطلب الجوهري بعد بدء جمع التأييدات يتطلب إعادة تأكيد الموافقين وتصفير التأييدات السابقة. يرجى تأكيد الإجراء.',
    });
    return;
  }

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE requests SET target_authority = ?, subject = ?, details = ?, proposed_solution = ?, version_hash = ? WHERE id = ?`
    ).run(
      String(targetAuthority).trim(),
      String(subject).trim(),
      String(details).trim(),
      String(proposedSolution || '').trim(),
      newHash,
      existing.id
    );

    if (needsReset) {
      db.prepare('DELETE FROM request_endorsements WHERE request_id = ?').run(existing.id);
      db.prepare(
        `INSERT INTO request_history (id, request_id, actor_id, actor_name, action, old_status, new_status, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        `rh-${crypto.randomUUID().slice(0, 8)}`,
        existing.id,
        user.id,
        user.fullName,
        'تعديل جوهري لنص الطلب وإعادة فتح التأييد',
        existing.status,
        existing.status,
        `تم تعديل نص الطلب وتصفير ${endorsementCount} تأييد سابق لإعادة التأكيد على النص الجديد`,
        now
      );
    }
  });

  tx();
  logAudit(user, 'EDIT_REQUEST_TEXT', 'request', existing.id, `تعديل نص الطلب (إعادة تأكيد: ${needsReset})`);
  res.json({ ok: true, endorsementsReset: needsReset });
});

app.put('/api/requests/:id/status', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  const canManage = hasPermission(user, 'requests');
  const existing = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id) as
    | { id: string; status: RequestStatus; reference_number: string }
    | undefined;

  if (!existing) {
    res.status(404).json({ error: 'المعاملة غير موجودة.' });
    return;
  }

  const { nextStatus, authorityResponse, assignedTo, note } = req.body || {};
  const check = validateRequestTransition(existing.status, nextStatus as RequestStatus, canManage);
  if (!check.valid) {
    res.status(400).json({ error: check.errorAr });
    return;
  }

  const now = new Date().toISOString();
  const closedAt = nextStatus === 'closed' ? now : null;

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE requests
       SET status = ?,
           authority_response = COALESCE(?, authority_response),
           assigned_to = COALESCE(?, assigned_to),
           closed_at = COALESCE(?, closed_at)
       WHERE id = ?`
    ).run(
      String(nextStatus),
      authorityResponse !== undefined ? String(authorityResponse) : null,
      assignedTo !== undefined ? String(assignedTo) : null,
      closedAt,
      existing.id
    );

    db.prepare(
      `INSERT INTO request_history (id, request_id, actor_id, actor_name, action, old_status, new_status, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `rh-${crypto.randomUUID().slice(0, 8)}`,
      existing.id,
      user.id,
      user.fullName,
      'تحديث حالة المعاملة',
      existing.status,
      String(nextStatus),
      String(note || authorityResponse || 'تم تحديث حالة المعاملة إدارياً'),
      now
    );
  });

  tx();
  logAudit(
    user,
    'UPDATE_REQUEST_STATUS',
    'request',
    existing.id,
    `تحويل حالة المعاملة ${existing.reference_number} من ${existing.status} إلى ${nextStatus}`
  );
  res.json({ ok: true });
});

app.post('/api/requests/:id/endorse', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  const existing = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id) as
    | { id: string; status: RequestStatus; is_collective: number; version_hash: string }
    | undefined;

  if (!existing) {
    res.status(404).json({ error: 'الطلب غير موجود.' });
    return;
  }

  const modCheck = canModifyEndorsement(existing.status, existing.is_collective === 1);
  if (!modCheck.allowed) {
    res.status(400).json({ error: modCheck.errorAr });
    return;
  }

  const already = db
    .prepare('SELECT id FROM request_endorsements WHERE request_id = ? AND student_id = ?')
    .get(existing.id, user.id);

  if (already) {
    res.status(400).json({ error: 'لقد قمت بتأييد هذا الطلب مسبقاً (لا يُسمح بتكرار الأصوات).' });
    return;
  }

  db.prepare(
    `INSERT INTO request_endorsements (id, request_id, student_id, request_version_hash, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    `end-${crypto.randomUUID().slice(0, 8)}`,
    existing.id,
    user.id,
    existing.version_hash,
    new Date().toISOString()
  );

  res.status(201).json({ ok: true });
});

app.delete('/api/requests/:id/endorse', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  const existing = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id) as
    | { id: string; status: RequestStatus; is_collective: number }
    | undefined;

  if (!existing) {
    res.status(404).json({ error: 'الطلب غير موجود.' });
    return;
  }

  const modCheck = canModifyEndorsement(existing.status, existing.is_collective === 1);
  if (!modCheck.allowed) {
    res.status(400).json({ error: modCheck.errorAr });
    return;
  }

  db.prepare('DELETE FROM request_endorsements WHERE request_id = ? AND student_id = ?').run(
    existing.id,
    user.id
  );
  res.json({ ok: true });
});

// ==========================================
// 6. STUDENTS & COHORT MEMBERS MANAGEMENT
// ==========================================

app.get('/api/users', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  const canManageStudents = hasPermission(user, 'students') || hasPermission(user, 'permissions');

  const rows = db.prepare('SELECT * FROM users ORDER BY role ASC, full_name ASC').all() as DbUserRow[];
  if (!canManageStudents) {
    // Non-admin users only receive basic staff list for task/request assignment reference
    res.json(
      rows
        .filter((r) => r.role !== 'student' || r.id === user.id)
        .map(mapUserRow)
    );
    return;
  }

  res.json(rows.map(mapUserRow));
});

app.post('/api/users', requireAuth, (req, res) => {
  const actor = (req as express.Request & { user: UserAccount }).user;
  if (!hasPermission(actor, 'students')) {
    res.status(403).json({ error: 'ليس لديك صلاحية إضافة طلاب للدفعة.' });
    return;
  }

  const { universityId, fullName, email, password, groupName, role, responsibilities } = req.body || {};
  if (!universityId || !fullName || !email || !password) {
    res.status(400).json({ error: 'الرقم الجامعي والاسم والبريد وكلمة المرور الأولية حقول مطلوبة.' });
    return;
  }

  const targetRole: UserRole =
    actor.role === 'representative' && ['representative', 'deputy', 'coordinator', 'student'].includes(role)
      ? role
      : 'student';

  const id = `u-${crypto.randomUUID().slice(0, 8)}`;
  try {
    db.prepare(
      `INSERT INTO users (id, university_id, full_name, email, password_hash, role, group_name, responsibilities_json, is_active, is_demo, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(
      id,
      String(universityId).trim(),
      String(fullName).trim(),
      String(email).trim(),
      hashPassword(String(password)),
      targetRole,
      String(groupName || 'A').trim(),
      JSON.stringify(Array.isArray(responsibilities) ? responsibilities : []),
      actor.isDemo ? 1 : 0,
      new Date().toISOString()
    );

    logAudit(actor, 'CREATE_USER', 'user', id, `إضافة عضو دفعة: ${fullName} (${universityId})`);
    res.status(201).json({ id });
  } catch {
    res.status(400).json({ error: 'الرقم الجامعي أو البريد الإلكتروني مسجل مسبقاً.' });
  }
});

app.put('/api/users/:id', requireAuth, (req, res) => {
  const actor = (req as express.Request & { user: UserAccount }).user;
  if (!hasPermission(actor, 'students') && !hasPermission(actor, 'permissions')) {
    res.status(403).json({ error: 'ليس لديك صلاحية تعديل بيانات الأعضاء.' });
    return;
  }

  const { fullName, groupName, role, responsibilities, isActive, resetPassword } = req.body || {};
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as DbUserRow | undefined;
  if (!target) {
    res.status(404).json({ error: 'المستخدم غير موجود.' });
    return;
  }

  // Only Representative can change roles or permissions
  const nextRole =
    actor.role === 'representative' && role ? String(role) : target.role;
  const nextResps =
    actor.role === 'representative' && Array.isArray(responsibilities)
      ? JSON.stringify(responsibilities)
      : target.responsibilities_json;

  db.prepare(
    `UPDATE users
     SET full_name = ?, group_name = ?, role = ?, responsibilities_json = ?, is_active = ?
     WHERE id = ?`
  ).run(
    String(fullName || target.full_name).trim(),
    String(groupName || target.group_name).trim(),
    nextRole,
    nextResps,
    isActive === undefined ? target.is_active : isActive ? 1 : 0,
    target.id
  );

  if (resetPassword && String(resetPassword).trim().length >= 6) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
      hashPassword(String(resetPassword).trim()),
      target.id
    );
  }

  logAudit(
    actor,
    'UPDATE_USER',
    'user',
    target.id,
    `تحديث بيانات/صلاحيات العضو ${fullName || target.full_name} (الدور: ${nextRole})`
  );
  res.json({ ok: true });
});

app.post('/api/users/import-csv', requireAuth, (req, res) => {
  const actor = (req as express.Request & { user: UserAccount }).user;
  if (!hasPermission(actor, 'students')) {
    res.status(403).json({ error: 'ليس لديك صلاحية استيراد بيانات الطلاب.' });
    return;
  }

  const { csvText, defaultPassword } = req.body || {};
  if (!csvText || typeof csvText !== 'string') {
    res.status(400).json({ error: 'يرجى إدخال محتوى ملف CSV.' });
    return;
  }

  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let imported = 0;
  let skipped = 0;
  const passHash = hashPassword(String(defaultPassword || 'Student@2026'));
  const now = new Date().toISOString();

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO users (id, university_id, full_name, email, password_hash, role, group_name, responsibilities_json, is_active, is_demo, created_at)
     VALUES (?, ?, ?, ?, ?, 'student', ?, '[]', 1, ?, ?)`
  );

  const tx = db.transaction(() => {
    for (const line of lines) {
      const parts = line.split(',').map((p) => p.trim());
      if (parts.length < 3) continue;
      const [uniId, name, email, group = 'A'] = parts;
      if (uniId.toLowerCase() === 'university_id' || uniId === 'الرقم الجامعي') continue;
      const info = insertStmt.run(
        `u-${crypto.randomUUID().slice(0, 8)}`,
        uniId,
        name,
        email,
        passHash,
        group || 'A',
        actor.isDemo ? 1 : 0,
        now
      );
      if (info.changes > 0) imported++;
      else skipped++;
    }
  });

  tx();
  logAudit(actor, 'IMPORT_CSV_USERS', 'user', 'batch', `استيراد ${imported} طالب عبر CSV`);
  res.json({ imported, skipped });
});

// ==========================================
// 7. TASKS & DELEGATION ROUTES
// ==========================================

app.get('/api/tasks', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  const rows = db
    .prepare(
      `SELECT t.*, u.full_name as assignee_name, c.full_name as creator_name
       FROM tasks t
       LEFT JOIN users u ON u.id = t.assigned_to
       LEFT JOIN users c ON c.id = t.created_by
       ORDER BY t.due_date ASC`
    )
    .all() as Array<{
    id: string;
    title: string;
    description: string;
    assigned_to: string;
    assignee_name?: string;
    created_by: string;
    creator_name?: string;
    priority: 'low' | 'medium' | 'high' | 'urgent';
    status: 'new' | 'in_progress' | 'awaiting_review' | 'completed' | 'blocked';
    due_date: string;
    created_at: string;
    is_demo: number;
  }>;

  const visible =
    user.role === 'student' ? rows.filter((r) => r.assigned_to === user.id) : rows;

  const result = visible.map((r) => {
    const comments = db
      .prepare('SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC')
      .all(r.id) as Array<{
      id: string;
      task_id: string;
      author_id: string;
      author_name: string;
      content: string;
      created_at: string;
    }>;

    return {
      id: r.id,
      title: r.title,
      description: r.description,
      assignedTo: r.assigned_to,
      assigneeName: r.assignee_name,
      createdBy: r.created_by,
      creatorName: r.creator_name,
      priority: r.priority,
      status: r.status,
      dueDate: r.due_date,
      createdAt: r.created_at,
      comments: comments.map((c) => ({
        id: c.id,
        taskId: c.task_id,
        authorId: c.author_id,
        authorName: c.author_name,
        content: c.content,
        createdAt: c.created_at,
      })),
      isDemo: r.is_demo === 1,
    };
  });

  res.json(result);
});

app.post('/api/tasks', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  if (user.role !== 'representative' && user.role !== 'deputy') {
    res.status(403).json({ error: 'فقط مندوب الدفعة أو نائبه يمكنه إنشاء وتفويض المهام.' });
    return;
  }

  const { title, description, assignedTo, priority, dueDate } = req.body || {};
  if (!title || !assignedTo || !dueDate) {
    res.status(400).json({ error: 'عنوان المهمة، المسؤول، والموعد النهائي حقول مطلوبة.' });
    return;
  }

  const id = `tsk-${crypto.randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO tasks (id, title, description, assigned_to, created_by, priority, status, due_date, created_at, is_demo)
     VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)`
  ).run(
    id,
    String(title).trim(),
    String(description || '').trim(),
    String(assignedTo),
    user.id,
    String(priority || 'medium'),
    String(dueDate),
    new Date().toISOString(),
    user.isDemo ? 1 : 0
  );

  logAudit(user, 'CREATE_TASK', 'task', id, `تفويض مهمة: ${title}`);
  res.status(201).json({ id });
});

app.put('/api/tasks/:id', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) as
    | { id: string; assigned_to: string; title: string }
    | undefined;

  if (!existing) {
    res.status(404).json({ error: 'المهمة غير موجودة.' });
    return;
  }

  if (
    user.role !== 'representative' &&
    user.role !== 'deputy' &&
    existing.assigned_to !== user.id
  ) {
    res.status(403).json({ error: 'لا يمكنك تحديث مهمة غير مسندة إليك.' });
    return;
  }

  const { status, priority, assignedTo } = req.body || {};
  if (status) {
    db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(String(status), existing.id);
  }
  if (priority && (user.role === 'representative' || user.role === 'deputy')) {
    db.prepare('UPDATE tasks SET priority = ? WHERE id = ?').run(String(priority), existing.id);
  }
  if (assignedTo && (user.role === 'representative' || user.role === 'deputy')) {
    db.prepare('UPDATE tasks SET assigned_to = ? WHERE id = ?').run(String(assignedTo), existing.id);
  }

  logAudit(user, 'UPDATE_TASK', 'task', existing.id, `تحديث حالة المهمة (${existing.title}) إلى ${status}`);
  res.json({ ok: true });
});

app.post('/api/tasks/:id/comments', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  const { content } = req.body || {};
  if (!content || !String(content).trim()) {
    res.status(400).json({ error: 'يرجى كتابة التعليق.' });
    return;
  }

  const id = `tc-${crypto.randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO task_comments (id, task_id, author_id, author_name, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, req.params.id, user.id, user.fullName, String(content).trim(), new Date().toISOString());

  res.status(201).json({ id });
});

// ==========================================
// 8. LECTURE FILE LIBRARY (REAL DISK STORAGE)
// ==========================================

app.get('/api/files', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  const rows = db
    .prepare(
      `SELECT f.*, c.name_ar as course_name_ar, c.code as course_code, u.full_name as uploader_name
       FROM library_files f
       LEFT JOIN courses c ON c.id = f.course_id
       LEFT JOIN users u ON u.id = f.uploaded_by
       ORDER BY f.created_at DESC`
    )
    .all() as Array<{
    id: string;
    course_id: string;
    course_name_ar: string;
    course_code: string;
    level: string;
    category: 'lectures' | 'summaries' | 'assignments' | 'references' | 'labs' | 'other';
    title: string;
    description: string;
    file_name: string;
    mime_type: string;
    size_bytes: number;
    target_group: string;
    uploaded_by: string;
    uploader_name?: string;
    created_at: string;
    is_demo: number;
  }>;

  const canManageFiles = hasPermission(user, 'files');
  const visible = rows.filter(
    (r) => canManageFiles || doGroupsOverlap(r.target_group, user.groupName)
  );

  res.json(
    visible.map((r) => ({
      id: r.id,
      courseId: r.course_id,
      courseNameAr: r.course_name_ar,
      courseCode: r.course_code,
      level: r.level,
      category: r.category,
      title: r.title,
      description: r.description,
      fileName: r.file_name,
      mimeType: r.mime_type,
      sizeBytes: r.size_bytes,
      targetGroup: r.target_group,
      uploadedBy: r.uploaded_by,
      uploaderName: r.uploader_name,
      createdAt: r.created_at,
      isDemo: r.is_demo === 1,
    }))
  );
});

const ALLOWED_EXTENSIONS = new Set([
  '.pdf',
  '.txt',
  '.md',
  '.csv',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.xls',
  '.xlsx',
  '.zip',
  '.png',
  '.jpg',
  '.jpeg',
]);

app.post('/api/files', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  if (!hasPermission(user, 'files')) {
    res.status(403).json({ error: 'ليس لديك صلاحية رفع الملفات إلى مكتبة المحاضرات.' });
    return;
  }

  const {
    courseId,
    level,
    category,
    title,
    description,
    fileName,
    mimeType,
    base64Content,
    targetGroup,
  } = req.body || {};

  if (!courseId || !title || !fileName || !base64Content) {
    res.status(400).json({ error: 'يرجى اختيار المقرر، عنوان الملف، وإرفاق الملف.' });
    return;
  }

  const cleanOriginalName = path.basename(String(fileName)).replace(/[^a-zA-Z0-9._\-\u0600-\u06FF ]/g, '_');
  const ext = path.extname(cleanOriginalName).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    res.status(400).json({
      error: `نوع الملف (${ext || 'غير معروف'}) غير مسموح به. الأنواع المسموحة: PDF, TXT, DOCX, PPTX, ZIP, الصور.`,
    });
    return;
  }

  const buffer = Buffer.from(String(base64Content), 'base64');
  if (buffer.byteLength > 8 * 1024 * 1024) {
    res.status(400).json({ error: 'حجم الملف يتجاوز الحد الأقصى المسموح به (8 ميجابايت).' });
    return;
  }

  const id = `fil-${crypto.randomUUID().slice(0, 8)}`;
  const storedName = `${id}_${Date.now()}${ext}`;
  const resolvedPath = path.resolve(UPLOADS_DIR, storedName);
  if (!resolvedPath.startsWith(UPLOADS_DIR + path.sep)) {
    res.status(400).json({ error: 'مسار تخزين غير صالح.' });
    return;
  }

  fs.writeFileSync(resolvedPath, buffer);

  db.prepare(
    `INSERT INTO library_files (id, course_id, level, category, title, description, file_name, stored_name, mime_type, size_bytes, target_group, uploaded_by, created_at, is_demo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    String(courseId),
    String(level || 'المستوى الأول - تقنية معلومات'),
    String(category || 'lectures'),
    String(title).trim(),
    String(description || '').trim(),
    cleanOriginalName,
    storedName,
    String(mimeType || 'application/octet-stream'),
    buffer.byteLength,
    String(targetGroup || 'ALL').trim(),
    user.id,
    new Date().toISOString(),
    user.isDemo ? 1 : 0
  );

  logAudit(user, 'UPLOAD_FILE', 'file', id, `رفع ملف للمكتبة: ${cleanOriginalName}`);
  res.status(201).json({ id });
});

app.get('/api/files/:id/download', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  const row = db.prepare('SELECT * FROM library_files WHERE id = ?').get(req.params.id) as
    | {
        id: string;
        file_name: string;
        stored_name: string;
        mime_type: string;
        target_group: string;
      }
    | undefined;

  if (!row) {
    res.status(404).json({ error: 'الملف غير موجود.' });
    return;
  }

  const canManageFiles = hasPermission(user, 'files');
  if (!canManageFiles && !doGroupsOverlap(row.target_group, user.groupName)) {
    res.status(403).json({ error: 'ليس لديك صلاحية تنزيل ملفات مخصصة لمجموعة أخرى.' });
    return;
  }

  const resolvedPath = path.resolve(UPLOADS_DIR, path.basename(row.stored_name));
  if (!resolvedPath.startsWith(UPLOADS_DIR + path.sep) || !fs.existsSync(resolvedPath)) {
    res.status(404).json({ error: 'الملف الفعلي غير متوفر على الخادم.' });
    return;
  }

  res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(row.file_name)}"`
  );
  res.sendFile(resolvedPath);
});

app.delete('/api/files/:id', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  if (!hasPermission(user, 'files')) {
    res.status(403).json({ error: 'ليس لديك صلاحية حذف الملفات.' });
    return;
  }

  const row = db.prepare('SELECT stored_name, file_name FROM library_files WHERE id = ?').get(req.params.id) as
    | { stored_name: string; file_name: string }
    | undefined;

  if (row) {
    const resolvedPath = path.resolve(UPLOADS_DIR, path.basename(row.stored_name));
    if (resolvedPath.startsWith(UPLOADS_DIR + path.sep) && fs.existsSync(resolvedPath)) {
      fs.unlinkSync(resolvedPath);
    }
    db.prepare('DELETE FROM library_files WHERE id = ?').run(req.params.id);
    logAudit(user, 'DELETE_FILE', 'file', req.params.id, `حذف ملف: ${row.file_name}`);
  }
  res.json({ ok: true });
});

// ==========================================
// 9. GLOBAL PERMISSION-AWARE SEARCH
// ==========================================

app.get('/api/search', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  const q = String(req.query.q || '').trim();
  if (!q) {
    res.json({ results: [] });
    return;
  }

  const pattern = `%${q}%`;
  const results: Array<{
    id: string;
    type: 'course' | 'lecture' | 'assignment' | 'announcement' | 'file' | 'request';
    title: string;
    subtitle: string;
    tab: string;
  }> = [];

  const courses = db
    .prepare('SELECT id, code, name_ar, name_en, instructor FROM courses WHERE name_ar LIKE ? OR name_en LIKE ? OR code LIKE ? OR instructor LIKE ? LIMIT 5')
    .all(pattern, pattern, pattern, pattern) as Array<{ id: string; code: string; name_ar: string; name_en: string; instructor: string }>;
  for (const c of courses) {
    results.push({
      id: c.id,
      type: 'course',
      title: `${c.name_ar} (${c.code})`,
      subtitle: `${c.name_en} · ${c.instructor}`,
      tab: 'schedule',
    });
  }

  const assignments = db
    .prepare('SELECT id, title, instructor, target_group, due_date FROM assignments WHERE title LIKE ? OR description LIKE ? LIMIT 8')
    .all(pattern, pattern) as Array<{ id: string; title: string; instructor: string; target_group: string; due_date: string }>;
  for (const a of assignments) {
    if (hasPermission(user, 'assignments') || doGroupsOverlap(a.target_group, user.groupName)) {
      results.push({
        id: a.id,
        type: 'assignment',
        title: a.title,
        subtitle: `تكليف · موعد التسليم ${a.due_date}`,
        tab: 'assignments',
      });
    }
  }

  const announcements = db
    .prepare('SELECT id, title, category, target_group FROM announcements WHERE title LIKE ? OR content LIKE ? LIMIT 8')
    .all(pattern, pattern) as Array<{ id: string; title: string; category: string; target_group: string }>;
  for (const ann of announcements) {
    if (hasPermission(user, 'announcements') || doGroupsOverlap(ann.target_group, user.groupName)) {
      results.push({
        id: ann.id,
        type: 'announcement',
        title: ann.title,
        subtitle: `إعلان · المجموعة ${ann.target_group}`,
        tab: 'announcements',
      });
    }
  }

  const files = db
    .prepare('SELECT id, title, file_name, target_group FROM library_files WHERE title LIKE ? OR description LIKE ? OR file_name LIKE ? LIMIT 8')
    .all(pattern, pattern, pattern) as Array<{ id: string; title: string; file_name: string; target_group: string }>;
  for (const f of files) {
    if (hasPermission(user, 'files') || doGroupsOverlap(f.target_group, user.groupName)) {
      results.push({
        id: f.id,
        type: 'file',
        title: f.title,
        subtitle: `ملف · ${f.file_name}`,
        tab: 'library',
      });
    }
  }

  const requests = db
    .prepare('SELECT id, reference_number, subject, is_collective, status, created_by FROM requests WHERE subject LIKE ? OR details LIKE ? OR reference_number LIKE ? LIMIT 8')
    .all(pattern, pattern, pattern) as Array<{
    id: string;
    reference_number: string;
    subject: string;
    is_collective: number;
    status: string;
    created_by: string;
  }>;
  for (const r of requests) {
    const canSee =
      hasPermission(user, 'requests') ||
      r.created_by === user.id ||
      (r.is_collective === 1 && r.status !== 'draft');
    if (canSee) {
      results.push({
        id: r.id,
        type: 'request',
        title: `${r.reference_number}: ${r.subject}`,
        subtitle: `معاملة · الحالة: ${r.status}`,
        tab: 'requests',
      });
    }
  }

  res.json({ results });
});

// ==========================================
// 10. AUDIT LOGS, BACKUP & RESTORE, DEMO ENV
// ==========================================

app.get('/api/admin/audit-logs', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  if (user.role !== 'representative' && !hasPermission(user, 'permissions')) {
    res.status(403).json({ error: 'سجل العمليات متاح لمندوب الدفعة فقط.' });
    return;
  }

  const logs = db
    .prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 150')
    .all() as Array<{
    id: string;
    actor_id: string;
    actor_name: string;
    actor_role: string;
    action: string;
    entity_type: string;
    entity_id: string;
    details: string;
    created_at: string;
  }>;

  res.json(
    logs.map((l) => ({
      id: l.id,
      actorId: l.actor_id,
      actorName: l.actor_name,
      actorRole: l.actor_role,
      action: l.action,
      entityType: l.entity_type,
      entityId: l.entity_id,
      details: l.details,
      createdAt: l.created_at,
    }))
  );
});

app.get('/api/admin/backup', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  if (!hasPermission(user, 'backup')) {
    res.status(403).json({ error: 'ليس لديك صلاحية تصدير النسخ الاحتياطية.' });
    return;
  }

  const tables = [
    'users',
    'courses',
    'lectures',
    'assignments',
    'assignment_progress',
    'announcements',
    'announcement_reads',
    'requests',
    'request_endorsements',
    'request_history',
    'tasks',
    'task_comments',
    'library_files',
    'audit_logs',
  ] as const;

  const data: Record<string, unknown[]> = {};
  for (const t of tables) {
    data[t] = db.prepare(`SELECT * FROM ${t}`).all();
  }

  logAudit(user, 'EXPORT_BACKUP', 'system', 'backup', 'تصدير نسخة احتياطية شاملة لقاعدة البيانات');
  res.json({
    app: 'DBL Campus',
    version: '1.0.0',
    exportedAt: new Date().toISOString(),
    exportedBy: user.fullName,
    tables: data,
  });
});

app.post('/api/admin/restore', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  if (!hasPermission(user, 'backup')) {
    res.status(403).json({ error: 'ليس لديك صلاحية استعادة النسخ الاحتياطية.' });
    return;
  }

  const { tables } = req.body || {};
  if (!tables || typeof tables !== 'object') {
    res.status(400).json({ error: 'ملف النسخة الاحتياطية غير صالح.' });
    return;
  }

  try {
    db.pragma('foreign_keys = OFF');
    const tx = db.transaction(() => {
      const orderedTables = [
        'users',
        'courses',
        'lectures',
        'assignments',
        'assignment_progress',
        'announcements',
        'announcement_reads',
        'requests',
        'request_endorsements',
        'request_history',
        'tasks',
        'task_comments',
        'library_files',
      ];

      for (const tableName of orderedTables) {
        const rows = tables[tableName];
        if (!Array.isArray(rows)) continue;
        db.prepare(`DELETE FROM ${tableName}`).run();
        if (rows.length === 0) continue;

        const cols = Object.keys(rows[0]).filter((c) => /^[a-z_]+$/.test(c));
        const placeholders = cols.map(() => '?').join(', ');
        const stmt = db.prepare(
          `INSERT OR REPLACE INTO ${tableName} (${cols.join(', ')}) VALUES (${placeholders})`
        );
        for (const r of rows) {
          stmt.run(...cols.map((c) => r[c]));
        }
      }
    });
    tx();
    db.pragma('foreign_keys = ON');
    logAudit(user, 'RESTORE_BACKUP', 'system', 'restore', 'استعادة نسخة احتياطية لقاعدة البيانات بنجاح');
    res.json({ ok: true });
  } catch (err: unknown) {
    db.pragma('foreign_keys = ON');
    res.status(400).json({
      error: `تعذر استعادة النسخة الاحتياطية: ${err instanceof Error ? err.message : 'خطأ في البيانات'}`,
    });
  }
});

app.post('/api/admin/demo-reset', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  if (user.role !== 'representative') {
    res.status(403).json({ error: 'هذا الإجراء متاح لمندوب الدفعة فقط.' });
    return;
  }
  seedDemoEnvironment(true);
  logAudit(user, 'RESET_DEMO_DATA', 'system', 'demo', 'إعادة تهيئة البيانات التجريبية إلى حالتها الأصلية');
  res.json({ ok: true });
});

app.post('/api/admin/demo-purge', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  if (user.role !== 'representative') {
    res.status(403).json({ error: 'هذا الإجراء متاح لمندوب الدفعة فقط.' });
    return;
  }
  purgeDemoData();
  logAudit(user, 'PURGE_DEMO_DATA', 'system', 'demo', 'إزالة جميع البيانات التجريبية دون المساس بالبيانات الفعلية');
  res.json({ ok: true });
});

// ==========================================
// 11. MOBILE APP PACKAGES (ANDROID APK & IOS IPA)
// ==========================================

const RELEASES_DIR = path.resolve(process.cwd(), 'data', 'releases');
if (!fs.existsSync(RELEASES_DIR)) {
  fs.mkdirSync(RELEASES_DIR, { recursive: true });
}

const RELEASE_FILENAMES: Record<'apk' | 'ipa', { fileName: string; mimeType: string }> = {
  apk: {
    fileName: 'DBL-Campus-Android.apk',
    mimeType: 'application/vnd.android.package-archive',
  },
  ipa: {
    fileName: 'DBL-Campus-iOS.ipa',
    mimeType: 'application/octet-stream',
  },
};

function getLocalLanUrls(port: number): string[] {
  const urls: string[] = [];
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const info of entries) {
      if (info.family === 'IPv4' && !info.internal) {
        urls.push(`http://${info.address}:${port}`);
      }
    }
  }
  return urls;
}

function inspectMobileRelease(platform: 'apk' | 'ipa') {
  const meta = RELEASE_FILENAMES[platform];
  const filePath = path.resolve(RELEASES_DIR, meta.fileName);
  if (!filePath.startsWith(RELEASES_DIR + path.sep) || !fs.existsSync(filePath)) {
    return {
      platform,
      fileName: meta.fileName,
      available: false,
      sizeBytes: 0,
      updatedAt: null as string | null,
      sha256: null as string | null,
    };
  }
  const stat = fs.statSync(filePath);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  return {
    platform,
    fileName: meta.fileName,
    available: true,
    sizeBytes: stat.size,
    updatedAt: stat.mtime.toISOString(),
    sha256: hash,
  };
}

app.get('/api/mobile/releases', (_req, res) => {
  const port = Number(process.env.PORT) || 3000;
  res.json({
    apk: inspectMobileRelease('apk'),
    ipa: inspectMobileRelease('ipa'),
    lanUrls: getLocalLanUrls(port),
    workflowFile: '.github/workflows/build-mobile.yml',
  });
});

app.post(
  '/api/mobile/releases/upload',
  requireAuth,
  express.raw({ type: 'application/octet-stream', limit: '80mb' }),
  (req, res) => {
    const user = (req as express.Request & { user: UserAccount }).user;
    if (user.role !== 'representative') {
      res.status(403).json({ error: 'فقط مندوب الدفعة يمكنه رفع حزم تطبيق الهاتف (APK / IPA).' });
      return;
    }

    const platform = String(req.query.platform || '').toLowerCase();
    if (platform !== 'apk' && platform !== 'ipa') {
      res.status(400).json({ error: 'نوع الحزمة غير مدعوم. يُقبل فقط apk أو ipa.' });
      return;
    }

    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.byteLength < 64) {
      res.status(400).json({ error: 'الملف المرفوع فارغ أو غير صالح.' });
      return;
    }

    // Both Android APK and iOS IPA packages are ZIP archives starting with PK\x03\x04
    if (!(buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04)) {
      res.status(400).json({
        error: 'صيغة الملف غير صحيحة. يجب رفع ملف APK أو IPA حقيقي ومبني بشكل سليم (أرشيف ZIP قياسي).',
      });
      return;
    }

    const meta = RELEASE_FILENAMES[platform];
    const targetPath = path.resolve(RELEASES_DIR, meta.fileName);
    if (!targetPath.startsWith(RELEASES_DIR + path.sep)) {
      res.status(400).json({ error: 'مسار تخزين غير صالح.' });
      return;
    }

    fs.writeFileSync(targetPath, buf);
    logAudit(
      user,
      'UPLOAD_MOBILE_RELEASE',
      'mobile_release',
      platform,
      `رفع حزمة تطبيق الهاتف ${meta.fileName} (${buf.byteLength} بايت)`
    );
    res.status(201).json({ ok: true, release: inspectMobileRelease(platform) });
  }
);

app.get('/api/mobile/download/:platform', (req, res) => {
  const platform = String(req.params.platform || '').toLowerCase();
  if (platform !== 'apk' && platform !== 'ipa') {
    res.status(400).json({ error: 'نوع الحزمة المطلوب غير صالح.' });
    return;
  }

  const meta = RELEASE_FILENAMES[platform];
  const filePath = path.resolve(RELEASES_DIR, meta.fileName);
  if (!filePath.startsWith(RELEASES_DIR + path.sep) || !fs.existsSync(filePath)) {
    res.status(404).json({
      error: `لم يتم رفع ملف ${meta.fileName} على هذا الخادم بعد. قم ببنائه عبر GitHub Actions ثم رفعه من لوحة المندوب.`,
    });
    return;
  }

  res.setHeader('Content-Type', meta.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${meta.fileName}"`);
  res.sendFile(filePath);
});

app.delete('/api/mobile/releases/:platform', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  if (user.role !== 'representative') {
    res.status(403).json({ error: 'فقط مندوب الدفعة يمكنه حذف حزم التطبيق.' });
    return;
  }

  const platform = String(req.params.platform || '').toLowerCase();
  if (platform !== 'apk' && platform !== 'ipa') {
    res.status(400).json({ error: 'نوع الحزمة غير صالح.' });
    return;
  }

  const meta = RELEASE_FILENAMES[platform];
  const filePath = path.resolve(RELEASES_DIR, meta.fileName);
  if (filePath.startsWith(RELEASES_DIR + path.sep) && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    logAudit(user, 'DELETE_MOBILE_RELEASE', 'mobile_release', platform, `حذف حزمة ${meta.fileName}`);
  }
  res.json({ ok: true });
});

// ==========================================
// VITE MIDDLEWARE / STATIC ASSETS & SERVER
// ==========================================

async function startServer(): Promise<void> {
  const PORT = Number(process.env.PORT) || 3000;

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`DBL Campus Server listening on http://0.0.0.0:${PORT}`);
  });
}

if (process.env.DBL_SKIP_LISTEN !== '1') {
  startServer();
}
