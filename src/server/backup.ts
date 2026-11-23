import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, UPLOADS_DIR } from './db.ts';
import { computeBackupChecksum, timingSafeStringEqual } from './security.ts';

const tables = [
  'system_settings', 'users', 'courses', 'lectures', 'assignments', 'assignment_progress',
  'announcements', 'announcement_reads', 'requests', 'request_endorsements', 'request_history',
  'tasks', 'task_comments', 'library_files', 'audit_logs',
] as const;
export const backupBodyLimit = 64 * 1024 * 1024;
const maxFileSize = 8 * 1024 * 1024;
type Row = Record<string, string | number | null>;
type Attachment = { name: string; base64: string; sha256: string };

const hashBytes = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
const validName = (name: unknown): name is string =>
  typeof name === 'string' && /^(?:demo_|fil-|restore-)[\w.-]+$/.test(name) && name.length < 180;
const columns = (table: string) => (db.pragma(`table_info(${table})`) as { name: string }[]).map(column => column.name);

export function exportBackup() {
  const records = Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table}`).all() as Row[]]));
  let bytes = 0;
  const attachments = records.library_files.map((file): Attachment => {
    if (!validName(file.stored_name)) throw new Error('Invalid stored filename');
    const location = path.join(UPLOADS_DIR, file.stored_name);
    const stat = fs.lstatSync(location);
    if (!stat.isFile() || stat.size !== file.size_bytes || stat.size > maxFileSize) throw new Error('Invalid attachment');
    bytes += stat.size;
    if (bytes > backupBodyLimit * 0.65) throw new Error('Backup exceeds limit');
    const buffer = fs.readFileSync(location);
    return { name: file.stored_name, base64: buffer.toString('base64'), sha256: hashBytes(buffer) };
  });
  const payload = { tables: records, attachments };
  const backup = { app: 'DBL Campus', version: '2.0.0', ...payload, checksumSha256: computeBackupChecksum(payload) };
  if (Buffer.byteLength(JSON.stringify(backup)) > backupBodyLimit) throw new Error('Backup exceeds limit');
  return backup;
}

export function restoreBackup(value: unknown, demo: boolean, finalize: () => void): void {
  const backup = value as ReturnType<typeof exportBackup> | null;
  if (!backup || backup.app !== 'DBL Campus' || backup.version !== '2.0.0' ||
      typeof backup.checksumSha256 !== 'string' || !backup.tables || !Array.isArray(backup.attachments)) {
    throw new Error('Invalid backup header');
  }
  const records = backup.tables;
  if (Object.keys(records).length !== tables.length ||
      !timingSafeStringEqual(backup.checksumSha256, computeBackupChecksum({ tables: records, attachments: backup.attachments }))) {
    throw new Error('Invalid backup checksum');
  }
  for (const table of tables) {
    const selected = columns(table);
    const rows = records[table];
    if (!Array.isArray(rows) || rows.some(row => !row || Object.keys(row).length !== selected.length ||
        selected.some(key => !Object.hasOwn(row, key) ||
          (row[key] !== null && typeof row[key] !== 'string' && typeof row[key] !== 'number')) ||
        (selected.includes('is_demo') && row.is_demo !== Number(demo)))) {
      throw new Error('Invalid backup schema or environment');
    }
  }
  if (!records.users.some(row => row.role === 'representative' && row.is_active === 1)) {
    throw new Error('Backup requires an active representative');
  }
  const indexed = new Map(records.library_files.map(row => [row.stored_name, row]));
  if (indexed.size !== records.library_files.length || indexed.size !== backup.attachments.length) {
    throw new Error('Invalid attachment inventory');
  }
  const previous = db.prepare('SELECT stored_name FROM library_files').pluck().all() as string[];
  const written: string[] = [];
  const seen = new Set<string>();
  try {
    // Stage new immutable files before switching database references in one transaction.
    for (const item of backup.attachments) {
      if (!item || !validName(item.name) || typeof item.base64 !== 'string' ||
          item.base64.length > Math.ceil(maxFileSize / 3) * 4 || seen.has(item.name)) {
        throw new Error('Invalid attachment');
      }
      const row = indexed.get(item.name);
      const bytes = Buffer.from(item.base64, 'base64');
      if (!row || bytes.length !== row.size_bytes || hashBytes(bytes) !== item.sha256 ||
          bytes.toString('base64') !== item.base64) throw new Error('Invalid attachment checksum');
      seen.add(item.name);
      const name = 'restore-' + crypto.randomUUID() + path.extname(item.name).slice(0, 16);
      const location = path.join(UPLOADS_DIR, name);
      const descriptor = fs.openSync(location, 'wx', 0o600);
      written.push(location);
      try {
        fs.writeFileSync(descriptor, bytes);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      row.stored_name = name;
    }
    if (written.length && process.platform !== 'win32') {
      const dir = fs.openSync(UPLOADS_DIR, 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
    db.transaction(() => {
      db.pragma('defer_foreign_keys = ON');
      db.prepare('DELETE FROM sessions').run();
      for (const table of [...tables].reverse()) db.prepare(`DELETE FROM ${table}`).run();
      for (const table of tables) {
        const selected = columns(table);
        const insert = db.prepare(`INSERT INTO ${table} (${selected.join(',')}) VALUES (${selected.map(() => '?').join(',')})`);
        for (const row of records[table]) insert.run(...selected.map(key => row[key]));
      }
      if ((db.pragma('foreign_key_check') as unknown[]).length) {
        throw new Error('Invalid backup relations');
      }
      finalize();
    })();
  } catch (error) {
    for (const location of written) fs.rmSync(location, { force: true });
    throw error;
  }
  for (const name of previous.filter(validName)) {
    try {
      fs.rmSync(path.join(UPLOADS_DIR, name), { force: true });
    } catch (error) {
      console.warn('Could not clean up a superseded backup attachment', error);
    }
  }
}
