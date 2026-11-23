import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSafeContentDisposition,
  computeBackupChecksum,
  createRateLimiter,
  createSignedDownloadTicket,
  hashSessionToken,
  isAllowedCorsOrigin,
  parseTrustProxy,
  timingSafeStringEqual,
  validateUploadedFileSignature,
  verifySignedDownloadTicket,
} from './security';

test('isAllowedCorsOrigin enforces strict internet HTTPS origins in production and blocks arbitrary domains', () => {
  assert.equal(
    isAllowedCorsOrigin('https://campus.university.edu', {
      appUrl: 'https://campus.university.edu',
      isProduction: true,
    }),
    true
  );

  assert.equal(
    isAllowedCorsOrigin('https://students.university.edu', {
      appUrl: 'https://campus.university.edu',
      allowedOrigins: 'https://students.university.edu, https://admin.university.edu',
      isProduction: true,
    }),
    true
  );

  // Capacitor mobile shells remain allowed
  assert.equal(
    isAllowedCorsOrigin('capacitor://localhost', {
      appUrl: 'https://campus.university.edu',
      isProduction: true,
    }),
    true
  );

  // Untrusted external origin is blocked
  assert.equal(
    isAllowedCorsOrigin('https://evil.attacker.example', {
      appUrl: 'https://campus.university.edu',
      isProduction: true,
    }),
    false
  );

  // Private LAN HTTP origin is blocked in strict production unless explicitly enabled
  assert.equal(
    isAllowedCorsOrigin('http://192.168.1.15:3000', {
      appUrl: 'https://campus.university.edu',
      isProduction: true,
      allowLanOrigins: false,
    }),
    false
  );
  assert.equal(
    isAllowedCorsOrigin('http://192.168.1.15:3000', {
      appUrl: 'https://campus.university.edu',
      isProduction: true,
      allowLanOrigins: true,
    }),
    true
  );
});

test('validateUploadedFileSignature accepts genuine PDF/PNG/ZIP/TXT and rejects disguised scripts', () => {
  const realPdf = Buffer.from('%PDF-1.7\n%sample content', 'utf8');
  assert.equal(validateUploadedFileSignature('.pdf', realPdf).valid, true);

  const fakePdfScript = Buffer.from('<script>alert("xss")</script>', 'utf8');
  assert.equal(validateUploadedFileSignature('.pdf', fakePdfScript).valid, false);

  const realPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  assert.equal(validateUploadedFileSignature('.png', realPng).valid, true);
  assert.equal(validateUploadedFileSignature('.png', fakePdfScript).valid, false);

  const realDocx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
  assert.equal(validateUploadedFileSignature('.docx', realDocx).valid, true);
  assert.equal(validateUploadedFileSignature('.docx', fakePdfScript).valid, false);

  const validTxt = Buffer.from('محاضرة خوارزميات الأسبوع الرابع', 'utf8');
  assert.equal(validateUploadedFileSignature('.txt', validTxt).valid, true);

  const binaryDisguisedAsTxt = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
  assert.equal(validateUploadedFileSignature('.txt', binaryDisguisedAsTxt).valid, false);
});

test('Signed download tickets validate fileId, signature, and expiration', () => {
  const secret = 'test-signing-secret-12345';
  const now = 1_700_000_000_000;
  const ticket = createSignedDownloadTicket(
    { fileId: 'fil-101', userId: 'u-stu-1', exp: now + 60_000 },
    secret
  );

  const ok = verifySignedDownloadTicket(ticket, 'fil-101', secret, now + 10_000);
  assert.equal(ok.valid, true);
  assert.equal(ok.userId, 'u-stu-1');

  // Wrong file ID rejected
  assert.equal(verifySignedDownloadTicket(ticket, 'fil-999', secret, now + 10_000).valid, false);

  // Expired ticket rejected
  assert.equal(verifySignedDownloadTicket(ticket, 'fil-101', secret, now + 120_000).valid, false);

  // Tampered signature rejected
  assert.equal(verifySignedDownloadTicket(`${ticket}x`, 'fil-101', secret, now + 10_000).valid, false);
});

test('Session token hashing, trust proxy parsing, rate limiting, and backup checksums behave deterministically', () => {
  const raw = 'abc123sessiontoken';
  const digest = hashSessionToken(raw);
  assert.notEqual(digest, raw);
  assert.equal(digest.length, 64);
  assert.equal(hashSessionToken(raw), digest);

  assert.equal(parseTrustProxy(undefined, true), 1);
  assert.equal(parseTrustProxy(undefined, false), false);
  assert.equal(parseTrustProxy('2', true), 2);
  assert.equal(parseTrustProxy('false', true), false);

  assert.equal(timingSafeStringEqual('secret-1', 'secret-1'), true);
  assert.equal(timingSafeStringEqual('secret-1', 'secret-2'), false);
  assert.equal(timingSafeStringEqual('short', 'much-longer-string'), false);

  const limiter = createRateLimiter({ windowMs: 60_000, max: 2, maxKeys: 10 });
  assert.equal(limiter.allow('ip-1'), true);
  assert.equal(limiter.allow('ip-1'), true);
  assert.equal(limiter.allow('ip-1'), false);

  const cd = buildSafeContentDisposition('محاضرة 1\r\nInjected.pdf');
  assert.ok(!cd.includes('\r'));
  assert.ok(!cd.includes('\n'));
  assert.ok(cd.includes('filename*=UTF-8\'\''));

  const hashA = computeBackupChecksum({ users: [{ id: '1' }] });
  const hashB = computeBackupChecksum({ users: [{ id: '1' }] });
  assert.equal(hashA, hashB);
  assert.equal(hashA.length, 64);
});
