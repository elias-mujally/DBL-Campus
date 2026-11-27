import 'dotenv/config';
import { computeRequestVersionHash } from './src/server/requestVersion.ts';
import express from 'express';
import { backupBodyLimit, exportBackup, restoreBackup } from './src/server/backup.ts';
import { parseRosterCsv } from './src/utils/rosterCsv.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  BACKUPS_DIR,
  closeDatabaseGracefully,
  DATA_DIR,
  db,
  hashPassword,
  logAudit,
  purgeDemoData,
  RELEASES_DIR,
  runMigrations,
  seedDemoEnvironment,
  UPLOADS_DIR,
  verifyPassword,
} from './src/server/db.ts';
import {
  buildSafeContentDisposition,
  createRateLimiter,
  createSignedDownloadTicket,
  hashSessionToken,
  isAllowedCorsOrigin,
  parseTrustProxy,
  timingSafeStringEqual,
  validateUploadedFileSignature,
  verifySignedDownloadTicket,
} from './src/server/security.ts';
import type {
  Lecture,
  RequestStatus,
  ResponsibilityKey,
  UserAccount,
  UserRole,
} from './src/types.ts';
import {
  canModifyEndorsement,
  detectScheduleConflicts,
  doGroupsOverlap,
  hasPermission,
  requiresEndorsementResetOnEdit,
  validateRequestTransition,
  timeToMinutes,
} from './src/utils/domainLogic.ts';

function isProductionMode(): boolean {
  return process.env.NODE_ENV === 'production';
}

function isDemoModeEnabled(): boolean {
  if (process.env.DBL_ALLOW_DEMO === 'false') return false;
  if (process.env.DBL_ALLOW_DEMO === 'true') return true;
  // Safe default for public internet: demo accounts disabled in production unless explicitly enabled
  return !isProductionMode();
}

function isHttpsForceEnabled(): boolean {
  if (process.env.DBL_FORCE_HTTPS === 'false') return false;
  if (process.env.DBL_FORCE_HTTPS === 'true') return true;
  return isProductionMode();
}

const TICKET_SIGNING_SECRET =
  process.env.DBL_SESSION_SECRET || crypto.randomBytes(32).toString('hex');

runMigrations();
const hasDemoRecords = ['users', 'courses', 'lectures', 'assignments', 'announcements', 'requests', 'tasks', 'library_files']
  .some(table => db.prepare(`SELECT 1 FROM ${table} WHERE is_demo=1 LIMIT 1`).get());
const hasProductionUsers = Boolean(db.prepare('SELECT 1 FROM users WHERE is_demo=0 LIMIT 1').get());
if ((isDemoModeEnabled() && hasProductionUsers) || (!isDemoModeEnabled() && hasDemoRecords)) {
  throw new Error('Use a separate database for demo and production. Existing data was preserved.');
}
if (isDemoModeEnabled()) seedDemoEnvironment(false);

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY, isProductionMode()));

// Enforce HTTPS behind TLS-terminating reverse proxies in production (exempt /api/health)
app.use((req, res, next) => {
  if (isHttpsForceEnabled() && req.path !== '/api/health' && !req.secure) {
    const origin = process.env.APP_URL;
    if (origin && /^https:\/\/[^/?#]+\/?$/i.test(origin)) {
      return res.redirect(308, origin.replace(/\/$/, '') + '/' + req.originalUrl.replace(/^\/+/, ''));
    }
    return res.status(426).json({ error: 'يتطلب الخادم اتصال HTTPS.' });
  }
  next();
});

// Public-internet security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  if (isProductionMode()) {
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; " +
      "form-action 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; " +
      "img-src 'self' data: blob:; connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com");
  }

  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, private');
  }

  next();
});

// Scoped CORS for configured HTTPS APP_URL / ALLOWED_ORIGINS + Capacitor mobile shells (never wildcard '*')
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (
    origin &&
    isAllowedCorsOrigin(origin, {
      appUrl: process.env.APP_URL,
      allowedOrigins: process.env.ALLOWED_ORIGINS,
      allowLanOrigins: process.env.DBL_ALLOW_LAN_ORIGINS === 'true',
      isProduction: isProductionMode(),
    })
  ) {
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

const parseJson = express.json({ limit: '12mb' });
app.use((req, res, next) => {
  if (req.method === 'POST' && /^\/api\/admin\/restore\/?$/i.test(req.path)) return next();
  parseJson(req, res, next);
});

// Memory-bounded rate limiters for public internet protection
const loginIpLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
const loginRateLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });
const setupRateLimiter = createRateLimiter({ windowMs: 300_000, max: 5 });
const writeRateLimiter = createRateLimiter({ windowMs: 60_000, max: 180 });
const registerIpLimiter = createRateLimiter({ windowMs: 60_000, max: 15 });
const registerCodeLimiter = createRateLimiter({ windowMs: 300_000, max: 8 });

app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    if (!writeRateLimiter.allow(req.ip || 'unknown')) {
      res.status(429).json({
        error: 'تم تجاوز معدل الطلبات المسموح به. يرجى المحاولة بعد قليل.',
      });
      return;
    }
  }
  next();
});

interface DbUserRow {
  id: string;
  university_id: string;
  full_name: string;
  email: string;
  password_hash: string;
  must_change_password: number;
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
    mustChangePassword: row.must_change_password === 1,
    isDemo: row.is_demo === 1,
    createdAt: row.created_at,
  };
}

const userRoles = new Set(['representative', 'deputy', 'coordinator', 'student']);
const responsibilityKeys = new Set(['lectures', 'assignments', 'files', 'announcements', 'requests', 'students', 'permissions', 'backup']);
const isBlockedPassword = (value: unknown) =>
  typeof value === 'string' && /^(student|demo)@2026$/i.test(value.trim());
const isValidPassword = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length >= 8 && value.length <= 256 && !isBlockedPassword(value);
const validResponsibilities = (value: unknown) =>
  Array.isArray(value) && value.every(key => responsibilityKeys.has(key));

function createSessionToken(userId: string): string {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashSessionToken(rawToken);
  const now = new Date();
  const expires = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 7); // 7 days

  // Periodically prune expired sessions
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now.toISOString());
  db.prepare(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(tokenHash, userId, now.toISOString(), expires.toISOString());
  return rawToken;
}

function getAuthenticatedUser(req: express.Request): UserAccount | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const rawToken = authHeader.slice(7).trim();
  if (!rawToken) return null;

  const tokenHash = hashSessionToken(rawToken);
  const session = db
    .prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?')
    .get(tokenHash) as { user_id: string; expires_at: string } | undefined;

  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash);
    return null;
  }

  const userRow = db
    .prepare('SELECT * FROM users WHERE id = ? AND is_active = 1')
    .get(session.user_id) as DbUserRow | undefined;

  if (!userRow || Boolean(userRow.is_demo) !== isDemoModeEnabled()) return null;
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
  if (user.mustChangePassword && !['/api/auth/profile', '/api/auth/logout', '/api/auth/logout-all'].includes(req.path.toLowerCase().replace(/\/$/, ''))) {
    res.status(403).json({ error: 'غيّر كلمة المرور الأولية لمتابعة استخدام التطبيق.' });
    return;
  }
  (req as express.Request & { user: UserAccount }).user = user;
  next();
}

// ==========================================
// 0. HEALTH CHECK ENDPOINT (FOR PROXIES & CONTAINERS)
// ==========================================

app.get('/api/health', (_req, res) => {
  try {
    db.prepare('SELECT 1').get();
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
    res.json({
      status: 'ok',
      database: 'ok',
      storageWritable: true,
      environment: isProductionMode() ? 'production' : 'development',
      httpsEnforced: isHttpsForceEnabled(),
      demoEnabled: isDemoModeEnabled(),
      uptimeSeconds: Math.floor(process.uptime()),
    });
  } catch {
    res.status(503).json({
      status: 'degraded',
      database: 'error',
      storageWritable: false,
    });
  }
});

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
  const demoAllowed = isDemoModeEnabled();
  const demoAccounts = demoAllowed
    ? (
        db
          .prepare('SELECT * FROM users WHERE is_demo = 1 AND is_active = 1 ORDER BY created_at ASC')
          .all() as DbUserRow[]
      ).map(mapUserRow)
    : [];

  res.json({
    user,
    hasProductionRepresentative: prodRepCount > 0,
    requiresSetupPasscode: !demoAllowed && (process.env.DBL_ADMIN_SETUP_CODE?.trim().length ?? 0) >= 32,
    demoEnabled: demoAllowed,
    demoAccounts,
  });
});

app.post('/api/auth/login', (req, res) => {
  const { identifier, password } = req.body || {};
  if (typeof identifier !== 'string' || !identifier.trim() || identifier.length > 254 ||
      typeof password !== 'string' || !password || password.length > 256) {
    res.status(400).json({ error: 'يرجى إدخال الرقم الجامعي أو البريد الإلكتروني وكلمة المرور.' });
    return;
  }

  const rateKey = `${req.ip || 'local'}:${String(identifier).trim().toLowerCase()}`;
  if (!loginIpLimiter.allow(req.ip || 'unknown') || !loginRateLimiter.allow(rateKey)) {
    res.status(429).json({
      error: 'تم تجاوز الحد المسموح لمحاولات تسجيل الدخول. يرجى الانتظار دقيقة واحدة.',
    });
    return;
  }

  const cleanId = String(identifier).trim();
  const userRow = db
    .prepare('SELECT * FROM users WHERE (LOWER(email) = LOWER(?) OR university_id = ?)')
    .get(cleanId, cleanId) as DbUserRow | undefined;

  if (!userRow || (!userRow.is_demo && isBlockedPassword(password)) || !verifyPassword(String(password), userRow.password_hash)) {
    res.status(401).json({ error: 'بيانات الدخول غير صحيحة.' });
    return;
  }

  if (Boolean(userRow.is_demo) !== isDemoModeEnabled()) {
    res.status(403).json({ error: 'الحسابات التجريبية معطّلة في بيئة الإنتاج.' });
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
  if (!isDemoModeEnabled()) {
    res.status(403).json({ error: 'تم تعطيل الدخول التجريبي في بيئة الإنتاج العامة.' });
    return;
  }

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
  if (!setupRateLimiter.allow(req.ip || 'local')) {
    res.status(429).json({ error: 'تم تجاوز محاولات الإعداد الأولي. يرجى الانتظار 5 دقائق.' });
    return;
  }

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
  const configuredCode = process.env.DBL_ADMIN_SETUP_CODE?.trim();
  if (isDemoModeEnabled() || !configuredCode || configuredCode.length < 32) {
    res.status(503).json({ error: 'إعداد المندوب يتطلب بيئة فعلية ورمز إعداد سري بطول 32 حرفاً على الأقل.' });
    return;
  }
  if (!timingSafeStringEqual(String(setupCode || ''), configuredCode)) {
    res.status(403).json({ error: 'رمز الإعداد الأولي غير صحيح.' });
    return;
  }

  if (!universityId || !fullName || !email || !password || !isValidPassword(password)) {
    res.status(400).json({
      error: 'يرجى تعبئة جميع الحقول المطلوبة والتأكد من أن كلمة المرور لا تقل عن 8 أحرف.',
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

interface DbInvitationCodeRow {
  id: string;
  code_hash: string;
  code_display: string;
  is_active: number;
  expires_at: string | null;
  uses_count: number;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
}

function generateSecureInvitationCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let part1 = '';
  let part2 = '';
  for (let i = 0; i < 4; i++) {
    part1 += chars[bytes[i] % chars.length];
    part2 += chars[bytes[i + 4] % chars.length];
  }
  return `DBL-${part1}-${part2}`;
}

function mapInvitationRow(row: DbInvitationCodeRow | undefined) {
  if (!row) return null;
  const isExpired = Boolean(row.expires_at && new Date(row.expires_at).getTime() <= Date.now());
  return {
    id: row.id,
    code: row.code_display,
    isActive: Boolean(row.is_active),
    expiresAt: row.expires_at,
    isExpired,
    usesCount: row.uses_count,
    createdAt: row.created_at,
  };
}

app.get('/api/admin/invitation-code', requireAuth, (req, res) => {
  const actor = (req as express.Request & { user: UserAccount }).user;
  if (!(actor.role === 'representative' || hasPermission(actor, 'permissions'))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const activeRow = db
    .prepare('SELECT * FROM invitation_codes WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1')
    .get() as DbInvitationCodeRow | undefined;
  const row =
    activeRow ||
    (db
      .prepare('SELECT * FROM invitation_codes ORDER BY created_at DESC LIMIT 1')
      .get() as DbInvitationCodeRow | undefined);
  res.json({ invitation: mapInvitationRow(row) });
});

app.post('/api/admin/invitation-code', requireAuth, (req, res) => {
  const actor = (req as express.Request & { user: UserAccount }).user;
  if (!(actor.role === 'representative' || hasPermission(actor, 'permissions'))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const { expiresInDays } = (req.body || {}) as { expiresInDays?: number | null };
  let expiresAt: string | null = null;
  if (typeof expiresInDays === 'number' && Number.isFinite(expiresInDays) && expiresInDays > 0) {
    expiresAt = new Date(Date.now() + expiresInDays * 86_400_000).toISOString();
  }

  const id = `inv-${crypto.randomUUID().slice(0, 12)}`;
  const code = generateSecureInvitationCode();
  const codeHash = hashSessionToken(code);
  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare(
      "UPDATE invitation_codes SET is_active = 0, revoked_at = ?, code_display = '' WHERE is_active = 1"
    ).run(now);
    db.prepare(
      `INSERT INTO invitation_codes (id, code_hash, code_display, is_active, expires_at, uses_count, created_by, created_at, revoked_at)
       VALUES (?, ?, ?, 1, ?, 0, ?, ?, NULL)`
    ).run(id, codeHash, code, expiresAt, actor.id, now);
  })();

  logAudit(actor, 'ROTATE_INVITATION_CODE', 'invitation_code', id, 'Rotated student invitation code');
  const created = db.prepare('SELECT * FROM invitation_codes WHERE id = ?').get(id) as DbInvitationCodeRow;
  res.status(201).json({ invitation: mapInvitationRow(created) });
});

app.patch('/api/admin/invitation-code', requireAuth, (req, res) => {
  const actor = (req as express.Request & { user: UserAccount }).user;
  if (!(actor.role === 'representative' || hasPermission(actor, 'permissions'))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const current =
    (db
      .prepare('SELECT * FROM invitation_codes WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1')
      .get() as DbInvitationCodeRow | undefined) ||
    (db
      .prepare('SELECT * FROM invitation_codes ORDER BY created_at DESC LIMIT 1')
      .get() as DbInvitationCodeRow | undefined);

  if (!current) {
    res.status(404).json({ error: 'No invitation code found.' });
    return;
  }

  const { isActive, expiresInDays, expiresAt } = (req.body || {}) as {
    isActive?: boolean;
    expiresInDays?: number | null;
    expiresAt?: string | null;
  };

  let nextActive = current.is_active;
  let nextRevokedAt = current.revoked_at;
  if (typeof isActive === 'boolean') {
    nextActive = isActive ? 1 : 0;
    nextRevokedAt = isActive ? null : new Date().toISOString();
  }

  let nextExpiresAt = current.expires_at;
  if (expiresInDays !== undefined) {
    if (expiresInDays === null) {
      nextExpiresAt = null;
    } else if (typeof expiresInDays === 'number' && Number.isFinite(expiresInDays) && expiresInDays > 0) {
      nextExpiresAt = new Date(Date.now() + expiresInDays * 86_400_000).toISOString();
    }
  } else if (expiresAt !== undefined) {
    nextExpiresAt = expiresAt ? String(expiresAt) : null;
  }

  db.prepare(
    'UPDATE invitation_codes SET is_active = ?, expires_at = ?, revoked_at = ? WHERE id = ?'
  ).run(nextActive, nextExpiresAt, nextRevokedAt, current.id);

  logAudit(actor, 'UPDATE_INVITATION_CODE', 'invitation_code', current.id, 'Updated student invitation code status or expiry');
  const updated = db.prepare('SELECT * FROM invitation_codes WHERE id = ?').get(current.id) as DbInvitationCodeRow;
  res.json({ invitation: mapInvitationRow(updated) });
});

app.post('/api/auth/register', (req, res) => {
  const clientIp = req.ip || 'local';
  if (!registerIpLimiter.allow(clientIp)) {
    res.status(429).json({ error: 'Too many registration attempts. Please try again later.' });
    return;
  }

  const { fullName, universityId, password, confirmPassword, invitationCode, groupName } = (req.body || {}) as {
    fullName?: string;
    universityId?: string;
    password?: string;
    confirmPassword?: string;
    invitationCode?: string;
    groupName?: string;
  };

  const normalizedCode = String(invitationCode || '').trim().toUpperCase();
  if (!registerCodeLimiter.allow(`${clientIp}:${normalizedCode || 'empty'}`)) {
    res.status(429).json({ error: 'Too many registration attempts for this code. Please try again later.' });
    return;
  }

  const cleanFullName = String(fullName || '').trim();
  const cleanUniId = String(universityId || '').trim();
  const rawPassword = String(password || '');
  const rawConfirm = String(confirmPassword || '');

  if (!cleanFullName || !cleanUniId || !rawPassword || !isValidPassword(rawPassword)) {
    res.status(400).json({ error: 'Invalid registration details or password.' });
    return;
  }
  if (rawPassword !== rawConfirm) {
    res.status(400).json({ error: 'Passwords do not match.' });
    return;
  }
  if (!normalizedCode) {
    res.status(400).json({ error: 'Invitation code is required.' });
    return;
  }

  const providedHash = hashSessionToken(normalizedCode);
  const activeInv = db
    .prepare('SELECT * FROM invitation_codes WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1')
    .get() as DbInvitationCodeRow | undefined;

  const isExpired = Boolean(activeInv?.expires_at && new Date(activeInv.expires_at).getTime() <= Date.now());
  if (
    !activeInv ||
    activeInv.revoked_at !== null ||
    isExpired ||
    !timingSafeStringEqual(providedHash, activeInv.code_hash)
  ) {
    res.status(400).json({ error: 'Invalid, inactive, or expired invitation code.' });
    return;
  }

  const id = `u-stu-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const derivedEmail = `${cleanUniId.toLowerCase().replace(/[^a-z0-9._-]/g, '') || id}@student.campus.local`;
  const cleanGroup = String(groupName || 'A').trim() || 'A';

  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO users (id, university_id, full_name, email, password_hash, role, group_name, responsibilities_json, is_active, is_demo, must_change_password, created_at)
         VALUES (?, ?, ?, ?, ?, 'student', ?, '[]', 1, 0, 0, ?)`
      ).run(id, cleanUniId, cleanFullName, derivedEmail, hashPassword(rawPassword), cleanGroup, now);

      db.prepare('UPDATE invitation_codes SET uses_count = uses_count + 1 WHERE id = ?').run(activeInv.id);
    })();

    const createdRow = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as DbUserRow;
    const user = mapUserRow(createdRow);
    const token = createSessionToken(user.id);
    logAudit(user, 'SELF_REGISTER_STUDENT', 'user', user.id, 'Student self-registered with invitation code');
    res.status(201).json({ token, user });
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    const msg = err instanceof Error ? err.message : '';
    if (code === 'SQLITE_CONSTRAINT_UNIQUE' || msg.includes('UNIQUE')) {
      res.status(409).json({ error: 'University ID or email is already registered.' });
      return;
    }
    res.status(400).json({ error: 'Registration failed.' });
  }
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const tokenHash = hashSessionToken(authHeader.slice(7).trim());
    db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash);
  }
  res.json({ ok: true });
});

app.post('/api/auth/logout-all', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  logAudit(user, 'LOGOUT_ALL_SESSIONS', 'user', user.id, 'إنهاء جميع الجلسات النشطة لهذا الحساب');
  res.json({ ok: true });
});

app.put('/api/auth/profile', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  const { fullName, email, newPassword, currentPassword } = req.body || {};
  if (!fullName || !email) {
    res.status(400).json({ error: 'الاسم الكامل والبريد الإلكتروني مطلوبان.' });
    return;
  }

  const row = db.prepare('SELECT * FROM users WHERE id=?').get(user.id) as DbUserRow;
  const changesCredentials = Boolean(newPassword) || String(email).trim() !== row.email;
  if (changesCredentials && (typeof currentPassword !== 'string' || currentPassword.length > 256 ||
      !verifyPassword(currentPassword, row.password_hash))) {
    res.status(403).json({ error: 'أدخل كلمة المرور الحالية لتغيير بيانات الدخول.' });
    return;
  }
  if (user.mustChangePassword && (!newPassword || currentPassword === newPassword)) {
    res.status(400).json({ error: 'اختر كلمة مرور مختلفة عن الرمز الأولي.' });
    return;
  }

  try {
    if (newPassword) {
      if (!isValidPassword(newPassword)) {
        res.status(400).json({ error: 'كلمة المرور الجديدة يجب ألا تقل عن 8 أحرف.' });
        return;
      }
      db.prepare('UPDATE users SET full_name = ?, email = ?, password_hash = ?, must_change_password = 0 WHERE id = ?').run(
        String(fullName).trim(),
        String(email).trim(),
        hashPassword(String(newPassword)),
        user.id
      );
      // Revoke all other sessions for this user after password change
      const authHeader = req.headers.authorization || '';
      const currentHash = authHeader.startsWith('Bearer ')
        ? hashSessionToken(authHeader.slice(7).trim())
        : '';
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(user.id, currentHash);
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
    logAudit(user, 'UPDATE_PROFILE', 'user', user.id, 'تحديث الملف الشخصي');
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

function validLectureInput(course: unknown, day: unknown, start: unknown, end: unknown,
  location: unknown, instructor: unknown, type: unknown, status: unknown): boolean {
  return typeof course === 'string' && Boolean(db.prepare('SELECT 1 FROM courses WHERE id=?').get(course)) &&
    typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 5 &&
    typeof start === 'string' && typeof end === 'string' && /^\d{2}:\d{2}$/.test(start) && /^\d{2}:\d{2}$/.test(end) &&
    timeToMinutes(start) >= 0 && timeToMinutes(end) > timeToMinutes(start) &&
    typeof location === 'string' && Boolean(location.trim()) && typeof instructor === 'string' && Boolean(instructor.trim()) &&
    (type === undefined || ['lecture', 'lab', 'tutorial'].includes(String(type))) &&
    (status === undefined || ['official', 'proposed', 'confirmed_temp', 'cancelled'].includes(String(status)));
}

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

  if (!validLectureInput(courseId, dayOfWeek, startTime, endTime, location, instructor, lectureType, status)) {
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

  if (!validLectureInput(courseId, dayOfWeek, startTime, endTime, location, instructor, lectureType, status)) {
    return res.status(400).json({ error: 'تحقق من المادة واليوم ووقتي بداية المحاضرة ونهايتها.' });
  }

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
    attachment_file_id?: string;
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
      attachmentFileId: r.attachment_file_id,
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
    attachmentFileId,
  } = req.body || {};

  if (!courseId || !title || !dueDate) {
    res.status(400).json({ error: 'يرجى تحديد المقرر وعنوان التكليف وموعد التسليم.' });
    return;
  }

  const group = String(targetGroup || 'ALL').trim();
  const attachment = attachmentFileId && typeof attachmentFileId === 'string'
    ? db.prepare('SELECT * FROM library_files WHERE id=? AND course_id=?').get(attachmentFileId, String(courseId)) as
      { id: string; file_name: string; target_group: string } | undefined
    : undefined;
  const attachmentIsPublic = ['ALL', 'عام'].includes(attachment?.target_group.trim().toUpperCase() ?? '');
  if (attachmentFileId && (!attachment ||
      (!attachmentIsPublic && attachment.target_group.trim().toUpperCase() !== group.toUpperCase()))) {
    return res.status(400).json({ error: 'اختر مرفقاً من مكتبة المقرر متاحاً لمجموعة التكليف.' });
  }
  const id = `asg-${crypto.randomUUID().slice(0, 8)}`;
  const publishedAt = new Date().toISOString().slice(0, 10);

  db.prepare(
    `INSERT INTO assignments (id, course_id, title, description, instructor, published_at, due_date, target_group, general_status, confirmation_status, source_note, attachment_name, created_by, is_demo, attachment_file_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    attachment?.file_name ?? (attachmentName ? String(attachmentName).trim() : null),
    user.id,
    user.isDemo ? 1 : 0,
    attachment?.id ?? null
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

  const target = db.prepare('SELECT target_group FROM assignments WHERE id=?').get(req.params.id) as { target_group: string } | undefined;
  if (!target || !(hasPermission(user, 'assignments') || doGroupsOverlap(target.target_group, user.groupName))) {
    return res.status(404).json({ error: 'السجل غير متاح لهذا الحساب.' });
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
  const target = db.prepare('SELECT target_group FROM announcements WHERE id=?').get(req.params.id) as { target_group: string } | undefined;
  if (!target || !(hasPermission(user, 'announcements') || doGroupsOverlap(target.target_group, user.groupName))) {
    return res.status(404).json({ error: 'السجل غير متاح لهذا الحساب.' });
  }
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

  const visibleIds = JSON.stringify(visible.map(row => row.id));
    const historyRows = db
      .prepare('SELECT * FROM request_history WHERE request_id IN (SELECT value FROM json_each(?)) ORDER BY created_at ASC')
      .all(visibleIds) as Array<{
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

    const endorsementRows = canManageRequests ? db
        .prepare(
          `SELECT re.*, u.full_name as student_name, u.university_id, u.group_name
           FROM request_endorsements re
           JOIN users u ON u.id = re.student_id
           WHERE re.request_id IN (SELECT value FROM json_each(?))
           ORDER BY re.created_at ASC`
        )
        .all(visibleIds) as Array<{
        id: string;
        request_id: string;
        student_id: string;
        student_name: string;
        university_id: string;
        group_name: string;
        request_version_hash: string;
        created_at: string;
      }> : [];


  const historiesByRequest = Map.groupBy(historyRows, row => row.request_id);
  const endorsementsByRequest = Map.groupBy(endorsementRows, row => row.request_id);
  const result = visible.map((r) => {
    const history = historiesByRequest.get(r.id) ?? [];
    let endorsements = undefined;
    if (canManageRequests) {
      const endRows = endorsementsByRequest.get(r.id) ?? [];
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
  const referenceNumber = `DBL-${new Date().getUTCFullYear()}-${String(count).padStart(3, '0')}-${crypto
    .randomBytes(4)
    .toString('hex')
    .toUpperCase()}`;
  const now = new Date().toISOString();
  const versionHash = computeRequestVersionHash(
    String(subject),
    String(details),
    String(proposedSolution || ''),
    String(targetAuthority)
  );

  const status: RequestStatus =
    initialStatus === 'draft'
      ? 'draft'
      : isCollective
      ? 'open_for_endorsement'
      : 'submitted';

  const representative = db.prepare(`
    SELECT id FROM users WHERE role='representative' AND is_active=1 AND is_demo=?
    ORDER BY (id = ?) DESC, created_at ASC, id ASC LIMIT 1
  `).get(Number(user.isDemo), user.id) as { id: string } | undefined;

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
      representative?.id ?? null,
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
  if (![targetAuthority, subject, details].every(value => typeof value === 'string' && value.trim())) {
    return res.status(400).json({ error: 'الجهة والموضوع والتفاصيل مطلوبة.' });
  }
  const newHash = computeRequestVersionHash(
    String(subject || ''),
    String(details || ''),
    String(proposedSolution || ''),
    String(targetAuthority)
  );

  const endorsementCount = (
    db
      .prepare('SELECT COUNT(*) as cnt FROM request_endorsements WHERE request_id = ?')
      .get(existing.id) as { cnt: number }
  ).cnt;

  const needsReset = requiresEndorsementResetOnEdit(existing.version_hash, newHash, endorsementCount);
  if (needsReset && confirmResetEndorsements !== true) {
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

  logAudit(user, 'ENDORSE_REQUEST', 'request', existing.id, 'تأييد الطلب');
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

  db.transaction(() => {
    if (db.prepare('DELETE FROM request_endorsements WHERE request_id = ? AND student_id = ?').run(existing.id, user.id).changes) {
      logAudit(user, 'WITHDRAW_ENDORSEMENT', 'request', existing.id, 'سحب تأييد الطلب');
    }
  })();
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
        .map(row => {
          const member = mapUserRow(row);
          return row.id === user.id ? member : { ...member, email: '', universityId: '', responsibilities: [] };
        })
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
  if (!universityId || !fullName || !email || !isValidPassword(password) ||
      (role !== undefined && !userRoles.has(role)) ||
      (responsibilities !== undefined && !validResponsibilities(responsibilities))) {
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
      JSON.stringify(actor.role === 'representative' && targetRole !== 'student' && Array.isArray(responsibilities) ? responsibilities : []),
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

  if (actor.isDemo !== Boolean(target.is_demo) || (actor.role !== 'representative' &&
      (target.role !== 'student' || !hasPermission(actor, 'students') || resetPassword !== undefined))) {
    res.status(403).json({ error: 'لا تملك صلاحية تعديل هذا الحساب أو بيانات دخوله.' });
    return;
  }
  if ((role !== undefined && !userRoles.has(role)) ||
      (responsibilities !== undefined && !validResponsibilities(responsibilities)) ||
      (isActive !== undefined && typeof isActive !== 'boolean') ||
      (resetPassword !== undefined && resetPassword !== true && !isValidPassword(resetPassword))) {
    res.status(400).json({ error: 'قيمة غير صالحة في بيانات العضو.' });
    return;
  }

  const nextRole =
    actor.role === 'representative' && role ? String(role) : target.role;
  const nextResps =
    actor.role === 'representative' && Array.isArray(responsibilities)
      ? JSON.stringify(responsibilities)
      : target.responsibilities_json;

  const nextActive = isActive ?? Boolean(target.is_active);
  if (target.role === 'representative' && target.is_active && (nextRole !== 'representative' || !nextActive) &&
      !db.prepare("SELECT 1 FROM users WHERE id != ? AND role='representative' AND is_active=1 AND is_demo=? LIMIT 1").get(target.id, target.is_demo)) {
    res.status(409).json({ error: 'يجب أن يبقى مندوب نشط في الدفعة.' });
    return;
  }

  const initialPassword = resetPassword === true ? crypto.randomBytes(18).toString('base64url') : resetPassword;
  db.transaction(() => {
    db.prepare(
      `UPDATE users SET full_name=?, group_name=?, role=?, responsibilities_json=?, is_active=? WHERE id=?`
    ).run(
      String(fullName || target.full_name).trim(),
      String(groupName || target.group_name).trim(),
      nextRole,
      nextResps,
      Number(nextActive),
      target.id
    );
    if (initialPassword) {
      db.prepare('UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?')
        .run(hashPassword(initialPassword), target.id);
    }
    if (!nextActive || initialPassword || nextRole !== target.role || nextResps !== target.responsibilities_json) {
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
    }
    logAudit(actor, 'UPDATE_USER', 'user', target.id, `تحديث بيانات العضو (الدور: ${nextRole})`);
  })();
  res.json({ ok: true, ...(resetPassword === true && { initialPassword }) });
});

app.post('/api/users/import-csv', requireAuth, (req, res) => {
  const actor = (req as express.Request & { user: UserAccount }).user;
  if (!hasPermission(actor, 'students')) {
    res.status(403).json({ error: 'ليس لديك صلاحية استيراد بيانات الطلاب.' });
    return;
  }

  const { csvText, defaultPassword } = req.body || {};
  if (typeof csvText !== 'string' || !csvText || csvText.length > 100_000 || defaultPassword !== undefined) {
    res.status(400).json({ error: 'أدخل قائمة CSV دون كلمة مرور مشتركة.' });
    return;
  }
  const rows = parseRosterCsv(csvText);
  if (!rows || rows.length > 250 || rows.some(([id, name, email]) => !id || !name || !email)) {
    res.status(400).json({ error: 'صيغة CSV غير صالحة أو يتجاوز العدد 250 طالباً.' });
    return;
  }
  const invitations: { universityId: string; initialPassword: string }[] = [];
  const insert = db.prepare(
    `INSERT OR IGNORE INTO users (id, university_id, full_name, email, password_hash, role, group_name, responsibilities_json, is_active, is_demo, created_at, must_change_password)
     VALUES (?, ?, ?, ?, ?, 'student', ?, '[]', 1, ?, ?, 1)`
  );
  const existing = db.prepare('SELECT 1 FROM users WHERE university_id=? OR LOWER(email)=LOWER(?)');
  db.transaction(() => {
    for (const [universityId, name, email, group] of rows) {
      if (existing.get(universityId, email)) continue;
      const initialPassword = crypto.randomBytes(18).toString('base64url');
      const info = insert.run(crypto.randomUUID(), universityId, name, email, hashPassword(initialPassword), group || 'A',
        Number(actor.isDemo), new Date().toISOString());
      if (info.changes) invitations.push({ universityId, initialPassword });
    }
    logAudit(actor, 'IMPORT_CSV_USERS', 'user', 'batch', `استيراد ${invitations.length} طالب عبر CSV`);
  })();
  res.json({ imported: invitations.length, skipped: rows.length - invitations.length, invitations });
});

// ==========================================
// 7. TASKS & DELEGATION ROUTES
// ==========================================

function canSeeTask(user: UserAccount, assignee: string): boolean {
  return user.role === 'representative' || user.role === 'deputy' || user.id === assignee;
}

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

  const visible = rows.filter(row => canSeeTask(user, row.assigned_to));

    const commentRows = db
      .prepare('SELECT * FROM task_comments WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY created_at ASC')
      .all(JSON.stringify(visible.map(row => row.id))) as Array<{
      id: string;
      task_id: string;
      author_id: string;
      author_name: string;
      content: string;
      created_at: string;
    }>;

  const commentsByTask = Map.groupBy(commentRows, row => row.task_id);
  const result = visible.map((r) => {
    const comments = commentsByTask.get(r.id) ?? [];
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
  if (!title || !assignedTo || !dueDate ||
      !db.prepare('SELECT 1 FROM users WHERE id=? AND is_active=1').get(String(assignedTo)) ||
      (priority && !['low', 'medium', 'high', 'urgent'].includes(priority))) {
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
  if ((status && !['new', 'in_progress', 'awaiting_review', 'completed', 'blocked'].includes(status)) ||
      (priority && !['low', 'medium', 'high', 'urgent'].includes(priority)) ||
      (assignedTo && !db.prepare('SELECT 1 FROM users WHERE id=? AND is_active=1').get(String(assignedTo)))) {
    return res.status(400).json({ error: 'حالة المهمة أو المسؤول غير صالح.' });
  }
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

  const task = db.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(req.params.id) as { assigned_to: string } | undefined;
  if (!task || !canSeeTask(user, task.assigned_to)) return res.sendStatus(404);
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

  const sigCheck = validateUploadedFileSignature(ext, buffer);
  if (!sigCheck.valid) {
    res.status(400).json({
      error: sigCheck.reason || 'محتوى الملف لا يطابق الامتداد المعلن عنه.',
    });
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

app.post('/api/files/:id/download-ticket', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  const row = db
    .prepare('SELECT id, target_group FROM library_files WHERE id = ?')
    .get(req.params.id) as { id: string; target_group: string } | undefined;

  if (!row) {
    res.status(404).json({ error: 'الملف غير موجود.' });
    return;
  }

  const canManageFiles = hasPermission(user, 'files');
  if (!canManageFiles && !doGroupsOverlap(row.target_group, user.groupName)) {
    res.status(403).json({ error: 'ليس لديك صلاحية تنزيل ملفات مخصصة لمجموعة أخرى.' });
    return;
  }

  const expiresInSeconds = 60;
  const ticket = createSignedDownloadTicket(
    {
      fileId: row.id,
      userId: user.id,
      exp: Date.now() + expiresInSeconds * 1000,
      sessionHash: hashSessionToken(req.headers.authorization!.slice(7).trim()),
    },
    TICKET_SIGNING_SECRET
  );

  res.json({
    ticket,
    expiresInSeconds,
    downloadUrl: `/api/files/${encodeURIComponent(row.id)}/download?ticket=${encodeURIComponent(ticket)}`,
  });
});

app.get('/api/files/:id/download', (req, res) => {
  let user = getAuthenticatedUser(req);

  // Allow short-lived HMAC-signed single-file ticket (never raw session token in query string)
  if (!user && typeof req.query.ticket === 'string') {
    const verified = verifySignedDownloadTicket(
      req.query.ticket,
      req.params.id,
      TICKET_SIGNING_SECRET
    );
    if (verified.valid && verified.userId && verified.sessionHash &&
        db.prepare('SELECT 1 FROM sessions WHERE token=? AND user_id=? AND expires_at > ?')
          .get(verified.sessionHash, verified.userId, new Date().toISOString())) {
      const userRow = db
        .prepare('SELECT * FROM users WHERE id = ? AND is_active = 1')
        .get(verified.userId) as DbUserRow | undefined;
      if (userRow && !userRow.must_change_password && Boolean(userRow.is_demo) === isDemoModeEnabled()) {
        user = mapUserRow(userRow);
      }
    }
  }

  if (!user || user.mustChangePassword) {
    res.status(401).json({ error: 'يرجى تسجيل الدخول أو استخدام تذكرة تنزيل صالحة.' });
    return;
  }

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

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Content-Disposition', buildSafeContentDisposition(row.file_name));
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
  const q = String(req.query.q || '').trim().slice(0, 160);
  if (!q) {
    res.json({ results: [] });
    return;
  }

  const pattern = '%' + q + '%';
  const group = user.groupName.trim().toUpperCase();
  const groups = "(? OR UPPER(TRIM(target_group)) IN ('ALL', 'عام', ?) OR ? IN ('ALL', 'عام'))";
  type SearchRow = { id: string; title: string; subtitle: string };
  const find = (type: string, tab: string, select: string, params: (number | string)[]) =>
    (db.prepare(select + ' ORDER BY title, id LIMIT 8').all(...params) as SearchRow[])
      .map(row => ({ ...row, type, tab }));
  const results = [
    ...find('course', 'schedule', `SELECT id, name_ar || ' (' || code || ')' title, instructor subtitle
      FROM courses WHERE name_ar LIKE ? OR name_en LIKE ? OR code LIKE ? OR instructor LIKE ?`,
      [pattern, pattern, pattern, pattern]),
    ...find('lecture', 'schedule', `SELECT l.id, c.name_ar || ' · ' || l.instructor title, l.location subtitle
      FROM lectures l JOIN courses c ON c.id=l.course_id
      WHERE c.name_ar LIKE ? OR l.instructor LIKE ? OR l.location LIKE ?`, [pattern, pattern, pattern]),
    ...find('assignment', 'assignments', `SELECT id, title, due_date subtitle FROM assignments
      WHERE (title LIKE ? OR description LIKE ?) AND ${groups}`, [pattern, pattern, Number(hasPermission(user, 'assignments')), group, group]),
    ...find('announcement', 'announcements', `SELECT id, title, category subtitle FROM announcements
      WHERE (title LIKE ? OR content LIKE ?) AND ${groups}`, [pattern, pattern, Number(hasPermission(user, 'announcements')), group, group]),
    ...find('file', 'library', `SELECT id, title, file_name subtitle FROM library_files
      WHERE (title LIKE ? OR description LIKE ? OR file_name LIKE ?) AND ${groups}`, [pattern, pattern, pattern, Number(hasPermission(user, 'files')), group, group]),
    ...find('request', 'requests', `SELECT id, reference_number || ': ' || subject title, target_authority subtitle FROM requests
      WHERE (subject LIKE ? OR details LIKE ? OR reference_number LIKE ?)
      AND (? OR created_by=? OR (is_collective=1 AND status!='draft'))`,
      [pattern, pattern, pattern, Number(hasPermission(user, 'requests')), user.id]),
    ...find('task', 'tasks', `SELECT id, title, due_date subtitle FROM tasks
      WHERE (title LIKE ? OR description LIKE ?) AND (? OR assigned_to=?)`,
      [pattern, pattern, Number(user.role === 'representative' || user.role === 'deputy'), user.id]),
  ];

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

  const offset = Number(req.query.offset ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0) return res.sendStatus(400);
  const logs = db
    .prepare('SELECT * FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT 150 OFFSET ?')
    .all(offset) as Array<{
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

function requireRepresentative(req: express.Request, res: express.Response, next: express.NextFunction) {
  const user = (req as express.Request & { user: UserAccount }).user;
  if (user.role !== 'representative') {
    return res.status(403).json({ error: 'هذه العملية متاحة لمندوب الدفعة فقط.' });
  }
  next();
}

app.get('/api/admin/backup', requireAuth, requireRepresentative, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  try {
    const backup = exportBackup();
    logAudit(user, 'EXPORT_BACKUP', 'system', 'backup', 'تصدير نسخة احتياطية شاملة مع المرفقات');
    res.json(backup);
  } catch {
    res.status(409).json({ error: 'تعذر التصدير: راجع المرفقات المفقودة أو حجم النسخة.' });
  }
});

app.get('/api/admin/backup/sqlite', requireAuth, requireRepresentative, async (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  const snapshotName = `dbl_campus_backup_${crypto.randomUUID()}.sqlite`;
  const snapshotPath = path.resolve(BACKUPS_DIR, snapshotName);
  if (!snapshotPath.startsWith(BACKUPS_DIR + path.sep)) {
    res.status(400).json({ error: 'مسار النسخ الاحتياطي غير صالح.' });
    return;
  }

  try {
    await db.backup(snapshotPath);
    logAudit(user, 'EXPORT_SQLITE_BACKUP', 'system', 'backup', 'تصدير نسخة SQLite ثنائية ذرية');
    res.setHeader('Content-Type', 'application/x-sqlite3');
    res.setHeader('Content-Disposition', buildSafeContentDisposition(snapshotName));
    res.sendFile(snapshotPath, () => {
      try {
        if (fs.existsSync(snapshotPath)) fs.unlinkSync(snapshotPath);
      } catch {
        // ignore temp cleanup error
      }
    });
  } catch {
    res.status(500).json({ error: 'تعذر إنشاء النسخة الاحتياطية الثنائية لقاعدة البيانات.' });
  }
});

app.post('/api/admin/restore', requireAuth, requireRepresentative, express.json({ limit: backupBodyLimit }), (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  const row = db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id) as { password_hash: string };
  const { currentPassword, ...backup } = req.body || {};
  if (typeof currentPassword !== 'string' || currentPassword.length > 256 || !verifyPassword(currentPassword, row.password_hash)) {
    res.status(403).json({ error: 'أدخل كلمة المرور الحالية لاستعادة النسخة.' });
    return;
  }
  try {
    restoreBackup(backup, user.isDemo, () =>
      logAudit(user, 'RESTORE_BACKUP', 'system', 'restore', 'استعادة قاعدة البيانات والمرفقات'));
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: 'تعذر الاستعادة. تحقق من إصدار النسخة وبصمتها وعلاقات البيانات والمرفقات.' });
  }
});

app.post('/api/admin/demo-reset', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: UserAccount }).user;
  if (user.role !== 'representative') {
    res.status(403).json({ error: 'هذا الإجراء متاح لمندوب الدفعة فقط.' });
    return;
  }
  if (!isDemoModeEnabled() || !user.isDemo) return res.sendStatus(403);
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
  if (!isDemoModeEnabled() || !user.isDemo) return res.sendStatus(403);
  purgeDemoData();
  logAudit(user, 'PURGE_DEMO_DATA', 'system', 'demo', 'إزالة جميع البيانات التجريبية دون المساس بالبيانات الفعلية');
  res.json({ ok: true });
});

// ==========================================
// 11. MOBILE APP PACKAGES (ANDROID APK & IOS IPA)
// ==========================================

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

function getSuggestedServerUrls(port: number): string[] {
  const urls: string[] = [];
  const configuredAppUrl = String(process.env.APP_URL || '').trim();
  if (configuredAppUrl && /^https?:\/\//i.test(configuredAppUrl) && !configuredAppUrl.includes('MY_APP_URL')) {
    urls.push(configuredAppUrl.replace(/\/+$/, ''));
  }

  // Only expose local LAN interfaces outside strict internet-only production deployments
  if (!isProductionMode() || process.env.DBL_ALLOW_LAN_ORIGINS === 'true') {
    let nets: ReturnType<typeof os.networkInterfaces>;
    try { nets = os.networkInterfaces(); } catch { return urls; }
    for (const entries of Object.values(nets)) {
      if (!entries) continue;
      for (const info of entries) {
        if (info.family === 'IPv4' && !info.internal) {
          urls.push(`http://${info.address}:${port}`);
        }
      }
    }
  }
  return Array.from(new Set(urls));
}

const releaseHashCache = new Map<string, { stamp: string; hash: string }>();
function isApprovedMobileHash(platform: 'apk' | 'ipa', digest: string): boolean {
  if (!isProductionMode()) return true;
  const allowed = (platform === 'apk' ? process.env.DBL_ANDROID_RELEASE_SHA256 : process.env.DBL_IOS_RELEASE_SHA256)?.trim().toLowerCase();
  return Boolean(allowed && /^[a-f0-9]{64}$/.test(allowed) && timingSafeStringEqual(allowed, digest));
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
  const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const cached = releaseHashCache.get(filePath);
  const hash = cached?.stamp === stamp ? cached.hash : crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  releaseHashCache.set(filePath, { stamp, hash });
  return {
    platform,
    fileName: meta.fileName,
    available: isApprovedMobileHash(platform, hash),
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
    lanUrls: getSuggestedServerUrls(port),
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

    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    if (!isApprovedMobileHash(platform, hash)) {
      return res.status(403).json({ error: 'بصمة الحزمة ليست معتمدة للنشر.' });
    }
    const temporary = targetPath + '.' + crypto.randomUUID();
    try {
      fs.writeFileSync(temporary, buf, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, targetPath);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
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

  if (!inspectMobileRelease(platform).available) return res.sendStatus(404);
  const meta = RELEASE_FILENAMES[platform];
  const filePath = path.resolve(RELEASES_DIR, meta.fileName);
  if (!filePath.startsWith(RELEASES_DIR + path.sep) || !fs.existsSync(filePath)) {
    res.status(404).json({
      error: `لم يتم رفع ملف ${meta.fileName} على هذا الخادم بعد. قم ببنائه عبر GitHub Actions ثم رفعه من لوحة المندوب.`,
    });
    return;
  }

  res.setHeader('Content-Type', meta.mimeType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', buildSafeContentDisposition(meta.fileName));
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
  const httpServer = http.createServer(app);

  if (!isProductionMode()) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');

    // Service Worker & PWA Manifest must revalidate immediately over HTTPS
    app.get('/sw.js', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Service-Worker-Allowed', '/');
      res.sendFile(path.join(distPath, 'sw.js'));
    });

    app.get('/manifest.webmanifest', (_req, res) => {
      res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(distPath, 'manifest.webmanifest'));
    });

    app.use(
      express.static(distPath, {
        setHeaders(res, filePath) {
          const baseName = path.basename(filePath);
          if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else if (filePath.endsWith('index.html') || filePath.endsWith('registerSW.js')) {
            res.setHeader('Cache-Control', 'no-cache');
          } else if (
            baseName === 'aurora-logo.png' ||
            baseName === 'favicon.ico' ||
            baseName === 'favicon-32x32.png' ||
            baseName === 'icon.svg' ||
            baseName === 'apple-touch-icon.png' ||
            /^pwa-.*\.png$/.test(baseName)
          ) {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      })
    );

    app.get('*', (req, res) => {
      if (req.path.startsWith('/api/')) {
        res.status(404).json({ error: 'المسار المطلوب غير موجود.' });
        return;
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(
      `DBL Campus Server listening on port ${PORT} (mode=${isProductionMode() ? 'production' : 'development'}, demo=${isDemoModeEnabled()})`
    );
  });

  const handleShutdown = (signal: string) => {
    console.log(`Received ${signal}. Closing HTTP server and checkpointing SQLite WAL...`);
    httpServer.close(() => {
      closeDatabaseGracefully();
      process.exit(0);
    });
    setTimeout(() => {
      closeDatabaseGracefully();
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));
}

app.use((error: { status?: number }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(error);
  const status = error.status === 413 || error.status === 400 ? error.status : 500;
  if (status === 500) console.error(error);
  res.status(status).json({ error: status === 413 ? 'حجم الطلب يتجاوز الحد المسموح.' : 'تعذر معالجة الطلب.' });
});

if (process.env.DBL_SKIP_LISTEN !== '1') {
  startServer().catch(error => { console.error(error); process.exitCode = 1; });
}
