import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { computeRequestVersionHash } from '../utils/domainLogic.ts';

export const DATA_DIR = process.env.DBL_DATA_DIR
  ? path.resolve(process.cwd(), process.env.DBL_DATA_DIR)
  : path.resolve(process.cwd(), 'data');

export const DB_PATH = process.env.DBL_DB_PATH
  ? path.resolve(process.cwd(), process.env.DBL_DB_PATH)
  : path.join(DATA_DIR, 'dbl_campus.sqlite');

export const UPLOADS_DIR = process.env.DBL_UPLOADS_DIR
  ? path.resolve(process.cwd(), process.env.DBL_UPLOADS_DIR)
  : path.join(DATA_DIR, 'uploads');

export const RELEASES_DIR = process.env.DBL_RELEASES_DIR
  ? path.resolve(process.cwd(), process.env.DBL_RELEASES_DIR)
  : path.join(DATA_DIR, 'releases');

export const BACKUPS_DIR = path.join(DATA_DIR, 'backups');

for (const dir of [path.dirname(DB_PATH), UPLOADS_DIR, RELEASES_DIR, BACKUPS_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

export function closeDatabaseGracefully(): void {
  try {
    if (db.open) {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    }
  } catch {
    // ignore close error on shutdown
  }
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  const keyBuffer = Buffer.from(keyHex, 'hex');
  const derivedBuffer = crypto.scryptSync(password, salt, 64);
  if (keyBuffer.length !== derivedBuffer.length) return false;
  return crypto.timingSafeEqual(keyBuffer, derivedBuffer);
}

export function runMigrations(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      university_id TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('representative', 'deputy', 'coordinator', 'student')),
      group_name TEXT NOT NULL DEFAULT 'A',
      responsibilities_json TEXT NOT NULL DEFAULT '[]',
      is_active INTEGER NOT NULL DEFAULT 1,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS courses (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name_ar TEXT NOT NULL,
      name_en TEXT NOT NULL,
      instructor TEXT NOT NULL,
      credit_hours INTEGER NOT NULL DEFAULT 3,
      level TEXT NOT NULL DEFAULT 'المستوى الثاني',
      semester TEXT NOT NULL DEFAULT 'الفصل الدراسي الثاني',
      is_demo INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS lectures (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL,
      day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      location TEXT NOT NULL,
      instructor TEXT NOT NULL,
      target_group TEXT NOT NULL DEFAULT 'ALL',
      lecture_type TEXT NOT NULL DEFAULT 'lecture',
      status TEXT NOT NULL DEFAULT 'official' CHECK(status IN ('official', 'proposed', 'confirmed_temp', 'cancelled')),
      notes TEXT NOT NULL DEFAULT '',
      specific_date TEXT,
      created_by TEXT NOT NULL,
      is_demo INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(course_id) REFERENCES courses(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS assignments (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      instructor TEXT NOT NULL,
      published_at TEXT NOT NULL,
      due_date TEXT NOT NULL,
      target_group TEXT NOT NULL DEFAULT 'ALL',
      general_status TEXT NOT NULL DEFAULT 'active' CHECK(general_status IN ('active', 'extended', 'completed', 'cancelled')),
      confirmation_status TEXT NOT NULL DEFAULT 'confirmed_rep',
      source_note TEXT NOT NULL DEFAULT '',
      attachment_name TEXT,
      attachment_url TEXT,
      created_by TEXT NOT NULL,
      is_demo INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(course_id) REFERENCES courses(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS assignment_progress (
      assignment_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      personal_status TEXT NOT NULL CHECK(personal_status IN ('not_started', 'in_progress', 'completed')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY(assignment_id, student_id),
      FOREIGN KEY(assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
      FOREIGN KEY(student_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      target_group TEXT NOT NULL DEFAULT 'ALL',
      is_pinned INTEGER NOT NULL DEFAULT 0,
      attachment_name TEXT,
      attachment_url TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      is_demo INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS announcement_reads (
      announcement_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      read_at TEXT NOT NULL,
      PRIMARY KEY(announcement_id, user_id),
      FOREIGN KEY(announcement_id) REFERENCES announcements(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      reference_number TEXT UNIQUE NOT NULL,
      request_type TEXT NOT NULL CHECK(request_type IN ('request', 'complaint', 'suggestion')),
      is_collective INTEGER NOT NULL DEFAULT 1,
      target_authority TEXT NOT NULL,
      subject TEXT NOT NULL,
      details TEXT NOT NULL,
      proposed_solution TEXT NOT NULL,
      attachment_name TEXT,
      status TEXT NOT NULL,
      created_by TEXT NOT NULL,
      assigned_to TEXT,
      authority_response TEXT,
      version_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      closed_at TEXT,
      is_demo INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS request_endorsements (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      request_version_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(request_id, student_id),
      FOREIGN KEY(request_id) REFERENCES requests(id) ON DELETE CASCADE,
      FOREIGN KEY(student_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS request_history (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_name TEXT NOT NULL,
      action TEXT NOT NULL,
      old_status TEXT,
      new_status TEXT,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(request_id) REFERENCES requests(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      assigned_to TEXT NOT NULL,
      created_by TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'new',
      due_date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      is_demo INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS task_comments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS library_files (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL,
      level TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      file_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      target_group TEXT NOT NULL DEFAULT 'ALL',
      uploaded_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      is_demo INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      actor_name TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      details TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

export function logAudit(
  actor: { id: string; fullName: string; role: string },
  action: string,
  entityType: string,
  entityId: string,
  details: string
): void {
  db.prepare(
    `INSERT INTO audit_logs (id, actor_id, actor_name, actor_role, action, entity_type, entity_id, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `aud-${crypto.randomUUID().slice(0, 8)}`,
    actor.id,
    actor.fullName,
    actor.role,
    action,
    entityType,
    entityId,
    details,
    new Date().toISOString()
  );
}

export function seedDemoEnvironment(forceReset = false): void {
  const existingUsers = db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number };
  if (existingUsers.cnt > 0 && !forceReset) {
    return;
  }

  const tx = db.transaction(() => {
    if (forceReset) {
      db.prepare('DELETE FROM request_endorsements WHERE request_id IN (SELECT id FROM requests WHERE is_demo = 1)').run();
      db.prepare('DELETE FROM request_history WHERE request_id IN (SELECT id FROM requests WHERE is_demo = 1)').run();
      db.prepare('DELETE FROM requests WHERE is_demo = 1').run();
      db.prepare('DELETE FROM task_comments WHERE task_id IN (SELECT id FROM tasks WHERE is_demo = 1)').run();
      db.prepare('DELETE FROM tasks WHERE is_demo = 1').run();
      db.prepare('DELETE FROM assignment_progress WHERE assignment_id IN (SELECT id FROM assignments WHERE is_demo = 1)').run();
      db.prepare('DELETE FROM assignments WHERE is_demo = 1').run();
      db.prepare('DELETE FROM announcement_reads WHERE announcement_id IN (SELECT id FROM announcements WHERE is_demo = 1)').run();
      db.prepare('DELETE FROM announcements WHERE is_demo = 1').run();
      db.prepare('DELETE FROM lectures WHERE is_demo = 1').run();
      db.prepare('DELETE FROM library_files WHERE is_demo = 1').run();
      db.prepare('DELETE FROM courses WHERE is_demo = 1').run();
      db.prepare('DELETE FROM users WHERE is_demo = 1').run();
    }

    const now = new Date().toISOString();
    const demoPassHash = hashPassword('Demo@2026');

    const demoUsers = [
      {
        id: 'u-rep-demo',
        university_id: '20251001',
        full_name: 'عمار الحكيمي (مندوب الدفعة - تجريبي)',
        email: 'rep@demo.dbl.local',
        role: 'representative',
        group_name: 'A',
        responsibilities: ['lectures', 'assignments', 'files', 'announcements', 'requests', 'students', 'permissions', 'backup'],
      },
      {
        id: 'u-dep-demo',
        university_id: '20251002',
        full_name: 'ريان المقطري (نائب المندوب - تجريبي)',
        email: 'deputy@demo.dbl.local',
        role: 'deputy',
        group_name: 'B',
        responsibilities: ['lectures', 'announcements', 'requests', 'students'],
      },
      {
        id: 'u-coord-demo',
        university_id: '20251003',
        full_name: 'سارة الأغبري (منسقة المحاضرات والملفات - تجريبي)',
        email: 'coord@demo.dbl.local',
        role: 'coordinator',
        group_name: 'A',
        responsibilities: ['lectures', 'assignments', 'files'],
      },
      {
        id: 'u-stu1-demo',
        university_id: '20251010',
        full_name: 'طارق الحميري (طالب - تجريبي)',
        email: 'student1@demo.dbl.local',
        role: 'student',
        group_name: 'A',
        responsibilities: [],
      },
      {
        id: 'u-stu2-demo',
        university_id: '20251011',
        full_name: 'بلقيس الشرعبي (طالبة - تجريبي)',
        email: 'student2@demo.dbl.local',
        role: 'student',
        group_name: 'A',
        responsibilities: [],
      },
      {
        id: 'u-stu3-demo',
        university_id: '20251012',
        full_name: 'ياسر العولقي (طالب - تجريبي)',
        email: 'student3@demo.dbl.local',
        role: 'student',
        group_name: 'B',
        responsibilities: [],
      },
      {
        id: 'u-stu4-demo',
        university_id: '20251013',
        full_name: 'مريم السقاف (طالبة - تجريبي)',
        email: 'student4@demo.dbl.local',
        role: 'student',
        group_name: 'B',
        responsibilities: [],
      },
    ];

    const insertUser = db.prepare(`
      INSERT OR REPLACE INTO users (id, university_id, full_name, email, password_hash, role, group_name, responsibilities_json, is_active, is_demo, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)
    `);

    for (const u of demoUsers) {
      insertUser.run(
        u.id,
        u.university_id,
        u.full_name,
        u.email,
        demoPassHash,
        u.role,
        u.group_name,
        JSON.stringify(u.responsibilities),
        now
      );
    }

    const demoCourses = [
      { id: 'c-cp2', code: 'CS102', name_ar: 'برمجة الحاسوب 2', name_en: 'Computer Programming 2', instructor: 'د. عبد الرحمن السماوي', credit_hours: 4 },
      { id: 'c-web', code: 'CS105', name_ar: 'تصميم الويب', name_en: 'Web Design', instructor: 'د. هدى الكحلاني', credit_hours: 3 },
      { id: 'c-dld', code: 'CE103', name_ar: 'تصميم المنطق الرقمي', name_en: 'Digital Logic Design', instructor: 'د. نبيل شمسان', credit_hours: 3 },
      { id: 'c-math2', code: 'MATH102', name_ar: 'الرياضيات 2', name_en: 'Mathematics 2', instructor: 'د. كمال الهمداني', credit_hours: 3 },
      { id: 'c-stat', code: 'STAT101', name_ar: 'الاحتمالات والإحصاء', name_en: 'Probability and Statistics', instructor: 'د. منى الجند', credit_hours: 3 },
      { id: 'c-eng2', code: 'ENG102', name_ar: 'مهارات اللغة الإنجليزية 2', name_en: 'English Language Skills 2', instructor: 'أ. سامي العريقي', credit_hours: 2 },
      { id: 'c-arab2', code: 'ARAB102', name_ar: 'مهارات اللغة العربية 2', name_en: 'Arabic Language Skills 2', instructor: 'د. يحيى الشامي', credit_hours: 2 },
      { id: 'c-cult2', code: 'CULT102', name_ar: 'الثقافة الإسلامية 2', name_en: 'Culture 2', instructor: 'د. صادق المعمري', credit_hours: 2 },
    ];

    const insertCourse = db.prepare(`
      INSERT OR REPLACE INTO courses (id, code, name_ar, name_en, instructor, credit_hours, level, semester, is_demo)
      VALUES (?, ?, ?, ?, ?, ?, 'المستوى الأول - تقنية معلومات', 'الفصل الدراسي الثاني', 1)
    `);
    for (const c of demoCourses) {
      insertCourse.run(c.id, c.code, c.name_ar, c.name_en, c.instructor, c.credit_hours);
    }

    const demoLectures = [
      { id: 'lec-1', course_id: 'c-cp2', day_of_week: 0, start_time: '08:00', end_time: '10:00', location: 'مدرج الخوارزمي (101)', instructor: 'د. عبد الرحمن السماوي', target_group: 'ALL', lecture_type: 'lecture', status: 'official', notes: 'محاضرة نظرية في البرمجة الكائنية OOP' },
      { id: 'lec-2', course_id: 'c-cp2', day_of_week: 0, start_time: '10:00', end_time: '12:00', location: 'معمل البرمجة B2', instructor: 'م. وليد الحداد', target_group: 'A', lecture_type: 'lab', status: 'official', notes: 'تطبيق عملي C++ Classes & Inheritance' },
      { id: 'lec-3', course_id: 'c-web', day_of_week: 0, start_time: '10:00', end_time: '12:00', location: 'معمل الشبكات والويب A1', instructor: 'م. ريم القاضي', target_group: 'B', lecture_type: 'lab', status: 'official', notes: 'تطبيق عملي CSS Grid & Responsive RTL' },
      { id: 'lec-4', course_id: 'c-dld', day_of_week: 1, start_time: '08:00', end_time: '10:00', location: 'قاعة 204', instructor: 'د. نبيل شمسان', target_group: 'ALL', lecture_type: 'lecture', status: 'official', notes: 'البوابات المنطقية وخرائط كارنوف K-Maps' },
      { id: 'lec-5', course_id: 'c-math2', day_of_week: 1, start_time: '10:30', end_time: '12:30', location: 'مدرج ابن الهيثم (102)', instructor: 'د. كمال الهمداني', target_group: 'ALL', lecture_type: 'lecture', status: 'confirmed_temp', notes: 'تم نقل المحاضرة مؤقتاً من قاعة 105 إلى مدرج 102 هذا الأسبوع' },
      { id: 'lec-6', course_id: 'c-web', day_of_week: 2, start_time: '08:00', end_time: '10:00', location: 'مدرج الخوارزمي (101)', instructor: 'د. هدى الكحلاني', target_group: 'ALL', lecture_type: 'lecture', status: 'official', notes: 'معمارية تطبيقات الويب الحديثة' },
      { id: 'lec-7', course_id: 'c-stat', day_of_week: 2, start_time: '10:30', end_time: '12:30', location: 'قاعة 204', instructor: 'د. منى الجند', target_group: 'ALL', lecture_type: 'lecture', status: 'proposed', notes: 'مقترح تقديم موعد المحاضرة نصف ساعة بالتنسيق مع المدرس' },
      { id: 'lec-8', course_id: 'c-eng2', day_of_week: 3, start_time: '08:00', end_time: '10:00', location: 'قاعة اللغات 301', instructor: 'أ. سامي العريقي', target_group: 'A', lecture_type: 'lecture', status: 'official', notes: 'Academic Writing & Technical Terminology' },
      { id: 'lec-9', course_id: 'c-arab2', day_of_week: 3, start_time: '10:00', end_time: '12:00', location: 'قاعة 201', instructor: 'د. يحيى الشامي', target_group: 'ALL', lecture_type: 'lecture', status: 'official', notes: 'تحرير المراسلات والتقارير الرسمية' },
      { id: 'lec-10', course_id: 'c-cult2', day_of_week: 4, start_time: '09:00', end_time: '11:00', location: 'مدرج الخوارزمي (101)', instructor: 'د. صادق المعمري', target_group: 'ALL', lecture_type: 'lecture', status: 'official', notes: 'أخلاقيات المهنة والمسؤولية المجتمعية' },
    ];

    const insertLecture = db.prepare(`
      INSERT OR REPLACE INTO lectures (id, course_id, day_of_week, start_time, end_time, location, instructor, target_group, lecture_type, status, notes, created_by, is_demo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'u-rep-demo', 1)
    `);
    for (const l of demoLectures) {
      insertLecture.run(
        l.id,
        l.course_id,
        l.day_of_week,
        l.start_time,
        l.end_time,
        l.location,
        l.instructor,
        l.target_group,
        l.lecture_type,
        l.status,
        l.notes
      );
    }

    const insertAssignment = db.prepare(`
      INSERT OR REPLACE INTO assignments (id, course_id, title, description, instructor, published_at, due_date, target_group, general_status, confirmation_status, source_note, attachment_name, created_by, is_demo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);

    const demoAssignments = [
      {
        id: 'asg-1',
        course_id: 'c-cp2',
        title: 'مشروع نظام إدارة المكتبة بلغة C++ (OOP)',
        description: 'تصميم وتنفيذ فئات Book وMember وLoan مع تطبيق الوراثة وتعدد الأشكال Polymorphism وتسليم الكود المصدري مع تقرير توضيحي.',
        instructor: 'د. عبد الرحمن السماوي',
        published_at: '2026-11-15',
        due_date: '2026-11-28',
        target_group: 'ALL',
        general_status: 'active',
        confirmation_status: 'confirmed_instructor',
        source_note: 'مؤكد رسمياً من أستاذ المقرر خلال محاضرة السبت',
        attachment_name: 'CP2_OOP_Project_Spec.txt',
        created_by: 'u-coord-demo',
      },
      {
        id: 'asg-2',
        course_id: 'c-web',
        title: 'التكليف العملي الثاني: بناء صفحة لوحة تحكم متجاوبة RTL',
        description: 'بناء واجهة عربية متجاوبة باستخدام HTML5 الدلالي وCSS Grid/Flexbox مع دعم الوضع الداكن ومعايير الوصول.',
        instructor: 'د. هدى الكحلاني',
        published_at: '2026-11-18',
        due_date: '2026-11-25',
        target_group: 'ALL',
        general_status: 'active',
        confirmation_status: 'confirmed_rep',
        source_note: 'تم التأكيد عبر منسقة المعمل م. ريم القاضي',
        attachment_name: 'Web_Design_RTL_Rubric.txt',
        created_by: 'u-coord-demo',
      },
      {
        id: 'asg-3',
        course_id: 'c-dld',
        title: 'سلسلة تمارين تبسيط الدوائر المنطقية (Karnaugh Maps)',
        description: 'حل التمارين من 1 إلى 12 في الفصل الثالث مع رسم المخططات المنطقية النهائية وتسليمها ورقياً في بداية المحاضرة.',
        instructor: 'د. نبيل شمسان',
        published_at: '2026-11-16',
        due_date: '2026-11-24',
        target_group: 'A',
        general_status: 'extended',
        confirmation_status: 'confirmed_instructor',
        source_note: 'تم تمديد التسليم 48 ساعة للمجموعة A بسبب عطلة المعمل',
        attachment_name: 'DLD_Sheet3_Exercises.txt',
        created_by: 'u-rep-demo',
      },
      {
        id: 'asg-4',
        course_id: 'c-stat',
        title: 'ورقة عمل التوزيعات الاحتمالية المتقطعة والمتصلة',
        description: 'تحليل بيانات العينة الإحصائية وحساب التوقع الرياضي والتباين وتوزيع بواسون.',
        instructor: 'د. منى الجند',
        published_at: '2026-11-19',
        due_date: '2026-12-02',
        target_group: 'ALL',
        general_status: 'active',
        confirmation_status: 'confirmed_rep',
        source_note: 'منشور في قناة المقرر وموثق لدى المندوب',
        attachment_name: undefined,
        created_by: 'u-rep-demo',
      },
    ];

    for (const a of demoAssignments) {
      insertAssignment.run(
        a.id,
        a.course_id,
        a.title,
        a.description,
        a.instructor,
        a.published_at,
        a.due_date,
        a.target_group,
        a.general_status,
        a.confirmation_status,
        a.source_note,
        a.attachment_name || null,
        a.created_by
      );
    }

    db.prepare(`
      INSERT OR REPLACE INTO assignment_progress (assignment_id, student_id, personal_status, updated_at)
      VALUES ('asg-1', 'u-stu1-demo', 'in_progress', ?),
             ('asg-2', 'u-stu1-demo', 'completed', ?),
             ('asg-1', 'u-rep-demo', 'in_progress', ?)
    `).run(now, now, now);

    const demoAnnouncements = [
      {
        id: 'ann-1',
        title: 'هام: نقل محاضرة الرياضيات 2 يوم الأحد إلى مدرج ابن الهيثم (102)',
        content: 'يرجى من جميع طلاب الدفعة (المجموعتين A وB) الانتباه إلى أنه تم نقل محاضرة الرياضيات 2 للدكتور كمال الهمداني يوم الأحد القادم إلى مدرج ابن الهيثم (102) بدلاً من قاعة 105 نظراً لأعمال الصيانة.',
        category: 'urgent',
        priority: 'urgent',
        target_group: 'ALL',
        is_pinned: 1,
        created_by: 'u-rep-demo',
        created_at: '2026-11-21T08:30:00.000Z',
      },
      {
        id: 'ann-2',
        title: 'فتح باب التأييد الإلكتروني لطلب جدولة الاختبارات النصفية',
        content: 'تم طرح مسودة الطلب الجماعي الموجه إلى رئاسة القسم بخصوص توزيع الاختبارات النصفية بحيث لا يتجاوز عدد الاختبارات اختبارين في الأسبوع الواحد. يرجى مراجعة الطلب في قسم (الطلبات والشكاوى) وتأييده قبل يوم الثلاثاء.',
        category: 'exams',
        priority: 'important',
        target_group: 'ALL',
        is_pinned: 1,
        created_by: 'u-rep-demo',
        created_at: '2026-11-20T14:15:00.000Z',
      },
      {
        id: 'ann-3',
        title: 'رفع ملخصات الفصل الرابع لمقرر تصميم المنطق الرقمي DLD',
        content: 'قامت منسقة الملفات سارة الأغبري برفع ملخص شامل للبوابات المنطقية التوافقية مع حلول نماذج الأعوام السابقة في مكتبة المحاضرات.',
        category: 'lectures',
        priority: 'normal',
        target_group: 'ALL',
        is_pinned: 0,
        created_by: 'u-coord-demo',
        created_at: '2026-11-19T17:00:00.000Z',
      },
      {
        id: 'ann-4',
        title: 'تذكير لطلاب المجموعة A: موعد تسليم تمارين المنطق الرقمي',
        content: 'نذكركم بأن الموعد النهائي بعد التمديد لتسليم سلسلة تمارين خرائط كارنوف للمجموعة A هو يوم الثلاثاء الموافق 24 نوفمبر.',
        category: 'assignments',
        priority: 'normal',
        target_group: 'A',
        is_pinned: 0,
        created_by: 'u-dep-demo',
        created_at: '2026-11-18T11:00:00.000Z',
      },
    ];

    const insertAnnouncement = db.prepare(`
      INSERT OR REPLACE INTO announcements (id, title, content, category, priority, target_group, is_pinned, created_by, created_at, is_demo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);
    for (const ann of demoAnnouncements) {
      insertAnnouncement.run(
        ann.id,
        ann.title,
        ann.content,
        ann.category,
        ann.priority,
        ann.target_group,
        ann.is_pinned,
        ann.created_by,
        ann.created_at
      );
    }

    const req1Subject = 'طلب جدولة الاختبارات النصفية بفاصل زمني لا يقل عن يومين بين كل اختبار';
    const req1Details = 'يعاني طلاب المستوى الأول من تكدس مواعيد الاختبارات النصفية للمقررات البرمجية والرياضية في أسبوع واحد (برمجة الحاسوب 2، الرياضيات 2، وتصميم المنطق الرقمي)، مما يؤثر سلباً على التحصيل الأكاديمي وجودة الأداء.';
    const req1Solution = 'توزيع جدول الاختبارات النصفية على أسبوعين دراسيين بحيث لا يزيد عدد الاختبارات عن اختبارين في الأسبوع الواحد، مع ترك فاصل يومين على الأقل قبل مقرري البرمجة والرياضيات.';
    const req1Hash = computeRequestVersionHash(req1Subject, req1Details, req1Solution);

    const req2Subject = 'توفير ساعات إضافية مفتوحة في معمل البرمجة B2 للتدريب العملي';
    const req2Details = 'الوقت المخصص للمعمل الأسبوعي (ساعتان) غير كافٍ لإنجاز المشاريع البرمجية لمقرري برمجة الحاسوب 2 وتصميم الويب للطلاب الذين لا يمتلكون حواسيب محمولة.';
    const req2Solution = 'فتح معمل البرمجة B2 يومي الإثنين والأربعاء من الساعة 12:30 ظهراً حتى 02:30 عصراً بإشراف فني المعمل.';
    const req2Hash = computeRequestVersionHash(req2Subject, req2Details, req2Solution);

    const req3Subject = 'شكوى بخصوص تعطل جهاز العرض الضوئي (Projector) في قاعة 204';
    const req3Details = 'جهاز العرض الضوئي في قاعة 204 يعاني من ضعف الإضاءة وانقطاع الإشارة المتكرر أثناء محاضرتي المنطق الرقمي والإحصاء.';
    const req3Solution = 'صيانة جهاز العرض أو استبدال كابل التوصيل HDMI وتوفير جهاز احتياطي.';
    const req3Hash = computeRequestVersionHash(req3Subject, req3Details, req3Solution);

    const insertRequest = db.prepare(`
      INSERT OR REPLACE INTO requests (id, reference_number, request_type, is_collective, target_authority, subject, details, proposed_solution, status, created_by, assigned_to, authority_response, version_hash, created_at, is_demo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);

    insertRequest.run(
      'req-1',
      'DBL-2026-001',
      'request',
      1,
      'الأخ/ رئيس قسم تقنية المعلومات وعلوم الحاسوب المحترم',
      req1Subject,
      req1Details,
      req1Solution,
      'open_for_endorsement',
      'u-rep-demo',
      'u-rep-demo',
      null,
      req1Hash,
      '2026-11-20T10:00:00.000Z'
    );

    insertRequest.run(
      'req-2',
      'DBL-2026-002',
      'suggestion',
      1,
      'الأخ/ مدير المعامل الحاسوبية في الكلية المحترم',
      req2Subject,
      req2Details,
      req2Solution,
      'approved_with_modifications',
      'u-stu1-demo',
      'u-dep-demo',
      'تمت الموافقة من إدارة المعامل على فتح معمل B2 يوم الإثنين من 12:30 إلى 2:30 عصراً، ويوم الخميس من 11:00 إلى 1:00 ظهراً.',
      req2Hash,
      '2026-11-14T09:00:00.000Z'
    );

    insertRequest.run(
      'req-3',
      'DBL-2026-003',
      'complaint',
      0,
      'الأخ/ مسؤول الشؤون الفنية والصيانة بالكلية المحترم',
      req3Subject,
      req3Details,
      req3Solution,
      'under_review',
      'u-coord-demo',
      'u-rep-demo',
      'تم استلام البلاغ وتكليف مهندس الصيانة بفحص القاعة قبل محاضرات يوم الأحد.',
      req3Hash,
      '2026-11-18T12:00:00.000Z'
    );

    const insertEndorsement = db.prepare(`
      INSERT OR REPLACE INTO request_endorsements (id, request_id, student_id, request_version_hash, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const endorsersReq1 = ['u-rep-demo', 'u-dep-demo', 'u-coord-demo', 'u-stu1-demo', 'u-stu2-demo', 'u-stu3-demo'];
    endorsersReq1.forEach((uid, idx) => {
      insertEndorsement.run(`end-1-${idx}`, 'req-1', uid, req1Hash, '2026-11-20T15:00:00.000Z');
    });
    const endorsersReq2 = ['u-rep-demo', 'u-stu1-demo', 'u-stu2-demo', 'u-stu3-demo', 'u-stu4-demo'];
    endorsersReq2.forEach((uid, idx) => {
      insertEndorsement.run(`end-2-${idx}`, 'req-2', uid, req2Hash, '2026-11-15T11:00:00.000Z');
    });

    const insertHistory = db.prepare(`
      INSERT OR REPLACE INTO request_history (id, request_id, actor_id, actor_name, action, old_status, new_status, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertHistory.run('rh-1', 'req-1', 'u-rep-demo', 'عمار الحكيمي', 'إنشاء الطلب وفتحه للتأييد', 'draft', 'open_for_endorsement', 'طرح الطلب لتأييد طلاب الدفعة قبل رفعه لرئاسة القسم', '2026-11-20T10:00:00.000Z');
    insertHistory.run('rh-2', 'req-2', 'u-stu1-demo', 'طارق الحميري', 'تقديم المقترح', null, 'open_for_endorsement', 'تم إنشاء المقترح وفتحه لتأييد الطلاب', '2026-11-14T09:00:00.000Z');
    insertHistory.run('rh-3', 'req-2', 'u-dep-demo', 'ريان المقطري', 'رفع الطلب للجهة المختصة', 'open_for_endorsement', 'submitted', 'اكتمل النصاب وتم تسليم النموذج الرسمي لإدارة المعامل', '2026-11-16T10:00:00.000Z');
    insertHistory.run('rh-4', 'req-2', 'u-rep-demo', 'عمار الحكيمي', 'تسجيل قرار الجهة المختصة', 'submitted', 'approved_with_modifications', 'تمت الموافقة مع تعديل يوم الأربعاء إلى الخميس', '2026-11-19T13:30:00.000Z');

    const insertTask = db.prepare(`
      INSERT OR REPLACE INTO tasks (id, title, description, assigned_to, created_by, priority, status, due_date, created_at, is_demo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);
    insertTask.run('tsk-1', 'تجميع شرائح محاضرات الأسبوع الرابع ورفعها للمكتبة', 'التنسيق مع د. عبد الرحمن السماوي ود. هدى الكحلاني لاستلام ملفات PDF الخاصة بالأسبوع الرابع.', 'u-coord-demo', 'u-rep-demo', 'high', 'in_progress', '2026-11-24', '2026-11-19T09:00:00.000Z');
    insertTask.run('tsk-2', 'متابعة صيانة جهاز العرض في قاعة 204 مع الشؤون الفنية', 'التأكد من إصلاح كابل HDMI وتجربة الجهاز قبل محاضرة المنطق الرقمي يوم الأحد.', 'u-dep-demo', 'u-rep-demo', 'urgent', 'awaiting_review', '2026-11-22', '2026-11-18T14:00:00.000Z');
    insertTask.run('tsk-3', 'مراجعة قائمة الطلاب الجدد في المجموعة B وتحديث أرقامهم الأكاديمية', 'مطابقة كشف القبول والتسجيل مع حسابات الطلاب في المنصة.', 'u-dep-demo', 'u-rep-demo', 'medium', 'completed', '2026-11-20', '2026-11-15T10:00:00.000Z');

    db.prepare(`
      INSERT OR REPLACE INTO task_comments (id, task_id, author_id, author_name, content, created_at)
      VALUES ('tc-1', 'tsk-1', 'u-coord-demo', 'سارة الأغبري', 'تم استلام ورفع ملفات برمجة الحاسوب 2 وتصميم المنطق الرقمي، وبانتظار ملف تصميم الويب.', '2026-11-20T16:00:00.000Z')
    `).run();

    // Create real demo files on disk in UPLOADS_DIR
    const demoFiles = [
      {
        id: 'fil-1',
        course_id: 'c-cp2',
        level: 'المستوى الأول - تقنية معلومات',
        category: 'lectures',
        title: 'المحاضرة الرابعة: البرمجة الكائنية والفئات في C++ (Classes & Objects)',
        description: 'شرح مفصل لمنشئات الفئات Constructors، المدمرات Destructors، ومحددات الوصول.',
        file_name: 'CS102_Lecture04_OOP_Classes.txt',
        stored_name: 'demo_CS102_Lecture04_OOP_Classes.txt',
        content: 'DBL Campus - Computer Programming 2 (CS102)\nLecture 04: Object-Oriented Programming in C++\n1. Encapsulation & Access Specifiers (public, private, protected)\n2. Constructors & Destructors\n3. Member Functions & const correctness\n',
      },
      {
        id: 'fil-2',
        course_id: 'c-dld',
        level: 'المستوى الأول - تقنية معلومات',
        category: 'summaries',
        title: 'ملخص شامل: خرائط كارنوف وتبسيط الدوال المنطقية (K-Maps)',
        description: 'ملخص منظم مع أمثلة محلولة لتبسيط التعبيرات البوليانية بـ 3 و4 متغيرات.',
        file_name: 'CE103_Summary_Karnaugh_Maps.txt',
        stored_name: 'demo_CE103_Summary_Karnaugh_Maps.txt',
        content: 'DBL Campus - Digital Logic Design (CE103)\nSummary: Karnaugh Maps (3 & 4 Variables)\n- SOP (Sum of Products) & POS (Product of Sums)\n- Don\'t Care Conditions (X)\n',
      },
      {
        id: 'fil-3',
        course_id: 'c-web',
        level: 'المستوى الأول - تقنية معلومات',
        category: 'labs',
        title: 'دليل المعمل الثالث: تصميم الواجهات العربية المتجاوبة RTL باستخدام CSS Grid',
        description: 'خطوات عملية لبناء تخطيطات مرنة تدعم اتجاه القراءة من اليمين إلى اليسار.',
        file_name: 'CS105_Lab03_RTL_Grid_Guide.txt',
        stored_name: 'demo_CS105_Lab03_RTL_Grid_Guide.txt',
        content: 'DBL Campus - Web Design (CS105)\nLab 03: Responsive RTL Layouts with CSS Grid & Logical Properties\n- margin-inline-start / padding-inline-end\n- dir="rtl" best practices\n',
      },
    ];

    const insertLibraryFile = db.prepare(`
      INSERT OR REPLACE INTO library_files (id, course_id, level, category, title, description, file_name, stored_name, mime_type, size_bytes, target_group, uploaded_by, created_at, is_demo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'text/plain; charset=utf-8', ?, 'ALL', 'u-coord-demo', ?, 1)
    `);

    for (const f of demoFiles) {
      const diskPath = path.join(UPLOADS_DIR, f.stored_name);
      fs.writeFileSync(diskPath, f.content, 'utf-8');
      const sizeBytes = Buffer.byteLength(f.content, 'utf-8');
      insertLibraryFile.run(
        f.id,
        f.course_id,
        f.level,
        f.category,
        f.title,
        f.description,
        f.file_name,
        f.stored_name,
        sizeBytes,
        now
      );
    }

    logAudit(
      { id: 'u-rep-demo', fullName: 'عمار الحكيمي', role: 'representative' },
      'SEED_DEMO',
      'system',
      'demo-env',
      'تم تهيئة بيئة التجربة المستقلة ببيانات الدفعة والمقررات والطلبات التجريبية'
    );
  });

  tx();
}

export function purgeDemoData(): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM request_endorsements WHERE request_id IN (SELECT id FROM requests WHERE is_demo = 1)').run();
    db.prepare('DELETE FROM request_history WHERE request_id IN (SELECT id FROM requests WHERE is_demo = 1)').run();
    db.prepare('DELETE FROM requests WHERE is_demo = 1').run();
    db.prepare('DELETE FROM task_comments WHERE task_id IN (SELECT id FROM tasks WHERE is_demo = 1)').run();
    db.prepare('DELETE FROM tasks WHERE is_demo = 1').run();
    db.prepare('DELETE FROM assignment_progress WHERE assignment_id IN (SELECT id FROM assignments WHERE is_demo = 1)').run();
    db.prepare('DELETE FROM assignments WHERE is_demo = 1').run();
    db.prepare('DELETE FROM announcement_reads WHERE announcement_id IN (SELECT id FROM announcements WHERE is_demo = 1)').run();
    db.prepare('DELETE FROM announcements WHERE is_demo = 1').run();
    db.prepare('DELETE FROM lectures WHERE is_demo = 1').run();
    db.prepare('DELETE FROM library_files WHERE is_demo = 1').run();
    db.prepare('DELETE FROM courses WHERE is_demo = 1').run();
    db.prepare('DELETE FROM users WHERE is_demo = 1').run();
  });
  tx();
}
