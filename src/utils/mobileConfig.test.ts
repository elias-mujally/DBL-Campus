import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveApiUrl, validateServerBaseUrl } from './mobileConfig.ts';

test('validateServerBaseUrl accepts valid LAN http/https URLs and strips trailing slashes', () => {
  const lan = validateServerBaseUrl('http://192.168.1.25:3000/');
  assert.equal(lan.valid, true);
  assert.equal(lan.normalized, 'http://192.168.1.25:3000');

  const autoHttp = validateServerBaseUrl('192.168.1.25:3000');
  assert.equal(autoHttp.valid, true);
  assert.equal(autoHttp.normalized, 'http://192.168.1.25:3000');

  const emptyReset = validateServerBaseUrl('   ');
  assert.equal(emptyReset.valid, true);
  assert.equal(emptyReset.normalized, '');
});

test('validateServerBaseUrl blocks dangerous non-HTTP schemes like javascript: and data:', () => {
  const jsScheme = validateServerBaseUrl('javascript:alert(1)');
  assert.equal(jsScheme.valid, false);

  const dataScheme = validateServerBaseUrl('data:text/html,<h1>x</h1>');
  assert.equal(dataScheme.valid, false);

  const fileScheme = validateServerBaseUrl('file:///etc/passwd');
  assert.equal(fileScheme.valid, false);
});

test('resolveApiUrl joins relative API paths with LAN base URL cleanly', () => {
  assert.equal(resolveApiUrl('/api/courses', ''), '/api/courses');
  assert.equal(
    resolveApiUrl('/api/courses', 'http://192.168.1.10:3000/'),
    'http://192.168.1.10:3000/api/courses'
  );
  assert.equal(
    resolveApiUrl('api/auth/login', 'https://campus.example.edu'),
    'https://campus.example.edu/api/auth/login'
  );
});
