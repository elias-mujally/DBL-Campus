import crypto from 'node:crypto';

export interface CorsCheckOptions {
  appUrl?: string;
  allowedOrigins?: string;
  allowLanOrigins?: boolean;
  isProduction?: boolean;
}

const CAPACITOR_ORIGINS = new Set([
  'capacitor://localhost',
  'ionic://localhost',
  'https://localhost',
]);

function normalizeOrigin(raw: string, httpsOnly = false): string | null {
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== 'https:' && (httpsOnly || parsed.protocol !== 'http:')) {
      return null;
    }
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function isAllowedCorsOrigin(origin: string, opts: CorsCheckOptions = {}): boolean {
  if (!origin) return false;
  const trimmed = origin.trim();
  const lower = trimmed.toLowerCase();

  if (CAPACITOR_ORIGINS.has(lower)) {
    return true;
  }

  // Explicitly configured APP_URL (e.g. https://campus.example.edu)
  if (opts.appUrl) {
    const normalizedApp = normalizeOrigin(opts.appUrl, opts.isProduction);
    if (normalizedApp && normalizedApp === lower) {
      return true;
    }
  }

  // Explicitly configured comma-separated ALLOWED_ORIGINS
  if (opts.allowedOrigins) {
    const extras = opts.allowedOrigins
      .split(',')
      .map((s) => normalizeOrigin(s, opts.isProduction))
      .filter((s): s is string => Boolean(s));
    if (extras.includes(lower)) {
      return true;
    }
  }

  // Localhost dev origins (allowed in development, or if LAN origins explicitly enabled)
  const allowLocal = !opts.isProduction || Boolean(opts.allowLanOrigins);
  if (allowLocal) {
    if (
      /^https?:\/\/localhost(:\d+)?$/.test(lower) ||
      /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(lower) ||
      /^https?:\/\/192\.168\.\d{1,3}\.\d{1,3}(:\d+)?$/.test(lower) ||
      /^https?:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/.test(lower) ||
      /^https?:\/\/172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}(:\d+)?$/.test(lower)
    ) {
      return true;
    }
  }

  return false;
}

export function parseTrustProxy(raw?: string, isProduction = false): boolean | number | string {
  if (!raw || !raw.trim()) {
    // Behind a single reverse proxy (Caddy/Nginx/Cloudflare/Render/Fly) in production
    return isProduction ? 1 : false;
  }
  const val = raw.trim().toLowerCase();
  if (val === 'false' || val === '0') return false;
  if (val === 'true') return true;
  if (/^\d+$/.test(val)) return Number(val);
  return raw.trim();
}

export function hashSessionToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Compare against dummy buffer to avoid timing leak on length mismatch
    const dummy = Buffer.alloc(bufA.length);
    crypto.timingSafeEqual(bufA, dummy);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export interface DownloadTicketPayload {
  fileId: string;
  userId: string;
  exp: number;
  sessionHash?: string;
}

export function createSignedDownloadTicket(
  payload: DownloadTicketPayload,
  secret: string
): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', secret)
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifySignedDownloadTicket(
  ticket: string,
  expectedFileId: string,
  secret: string,
  nowMs = Date.now()
): { valid: boolean; userId?: string; sessionHash?: string } {
  const parts = String(ticket || '').split('.');
  if (parts.length !== 2) return { valid: false };
  const [encoded, providedSig] = parts;
  if (!encoded || !providedSig) return { valid: false };

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(encoded)
    .digest('base64url');

  if (!timingSafeStringEqual(providedSig, expectedSig)) {
    return { valid: false };
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8')
    ) as DownloadTicketPayload;
    if (
      !parsed ||
      parsed.fileId !== expectedFileId ||
      typeof parsed.userId !== 'string' ||
      typeof parsed.exp !== 'number' ||
      parsed.exp < nowMs
    ) {
      return { valid: false };
    }
    return { valid: true, userId: parsed.userId, ...(parsed.sessionHash && { sessionHash: parsed.sessionHash }) };
  } catch {
    return { valid: false };
  }
}

export function validateUploadedFileSignature(
  ext: string,
  buffer: Buffer
): { valid: boolean; reason?: string } {
  if (!Buffer.isBuffer(buffer) || buffer.byteLength === 0) {
    return { valid: false, reason: 'الملف المرفوع فارغ.' };
  }

  const lowerExt = ext.toLowerCase();

  if (lowerExt === '.pdf') {
    const header = buffer.subarray(0, 5).toString('ascii');
    if (header !== '%PDF-') {
      return { valid: false, reason: 'محتوى الملف لا يطابق صيغة PDF صالحة.' };
    }
    return { valid: true };
  }

  if (lowerExt === '.png') {
    const isPng =
      buffer.byteLength >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a;
    return isPng
      ? { valid: true }
      : { valid: false, reason: 'محتوى الملف لا يطابق صورة PNG صالحة.' };
  }

  if (lowerExt === '.jpg' || lowerExt === '.jpeg') {
    const isJpeg =
      buffer.byteLength >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff;
    return isJpeg
      ? { valid: true }
      : { valid: false, reason: 'محتوى الملف لا يطابق صورة JPEG صالحة.' };
  }

  if (
    lowerExt === '.zip' ||
    lowerExt === '.docx' ||
    lowerExt === '.pptx' ||
    lowerExt === '.xlsx'
  ) {
    const isZip =
      buffer.byteLength >= 4 &&
      buffer[0] === 0x50 &&
      buffer[1] === 0x4b &&
      (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07);
    return isZip
      ? { valid: true }
      : { valid: false, reason: 'محتوى الملف لا يطابق أرشيف Office/ZIP قياسي.' };
  }

  if (lowerExt === '.doc' || lowerExt === '.ppt' || lowerExt === '.xls') {
    // Legacy OLE2 Compound Document Binary Format (D0 CF 11 E0 A1 B1 1A E1)
    const isOle2 =
      buffer.byteLength >= 8 &&
      buffer[0] === 0xd0 &&
      buffer[1] === 0xcf &&
      buffer[2] === 0x11 &&
      buffer[3] === 0xe0;
    return isOle2
      ? { valid: true }
      : { valid: false, reason: 'محتوى الملف لا يطابق صيغة مستند Office صالحة.' };
  }

  if (lowerExt === '.txt' || lowerExt === '.md' || lowerExt === '.csv') {
    // Reject binary executables or null-byte payloads disguised as text
    const sample = buffer.subarray(0, Math.min(buffer.byteLength, 2048));
    if (sample.includes(0x00)) {
      return { valid: false, reason: 'الملف النصي يحتوي على بيانات ثنائية غير صالحة.' };
    }
    return { valid: true };
  }

  return { valid: false, reason: 'امتداد الملف غير مدعوم.' };
}

export function buildSafeContentDisposition(fileName: string): string {
  const base = fileName.replace(/[\r\n"\\]/g, '_').trim() || 'download';
  const asciiFallback = base.replace(/[^\x20-\x7E]/g, '_') || 'download';
  const encoded = encodeURIComponent(base);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

export function computeBackupChecksum(tables: Record<string, unknown>): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(tables), 'utf8')
    .digest('hex');
}

export interface RateLimiter {
  allow: (key: string) => boolean;
  size: () => number;
}

export function createRateLimiter(options: {
  windowMs: number;
  max: number;
  maxKeys?: number;
}): RateLimiter {
  const store = new Map<string, { count: number; resetAt: number }>();
  const maxKeys = options.maxKeys ?? 5000;

  function pruneExpired(now: number): void {
    for (const [k, v] of store.entries()) {
      if (now > v.resetAt) {
        store.delete(k);
      }
    }
    // Bound memory under high-cardinality internet flood
    if (store.size > maxKeys) {
      const toRemove = store.size - maxKeys;
      let removed = 0;
      for (const k of store.keys()) {
        store.delete(k);
        removed += 1;
        if (removed >= toRemove) break;
      }
    }
  }

  return {
    allow(key: string): boolean {
      const now = Date.now();
      if (store.size > maxKeys / 2) {
        pruneExpired(now);
      }
      const entry = store.get(key);
      if (!entry || now > entry.resetAt) {
        store.set(key, { count: 1, resetAt: now + options.windowMs });
        return true;
      }
      if (entry.count >= options.max) {
        return false;
      }
      entry.count += 1;
      return true;
    },
    size(): number {
      return store.size;
    },
  };
}
