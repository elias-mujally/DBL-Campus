import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiError,
  getAuthToken,
  persistAuthToken,
  restoreAndValidateSession,
  restorePersistedAuthToken,
  setAuthToken,
} from './api.ts';
import {
  OFFICIAL_ANDROID_APK_URL,
  OFFICIAL_RELEASES_URL,
  shouldAllowLanServerConfig,
  shouldHidePwaInstallUi,
} from './nativeBridge.ts';

function createLocalStorageSpy() {
  const store = new Map<string, string>();
  let setItemCalls = 0;

  return {
    get setItemCalls() {
      return setItemCalls;
    },
    api: {
      getItem(key: string) {
        return store.has(key) ? store.get(key)! : null;
      },
      setItem(key: string, value: string) {
        setItemCalls += 1;
        store.set(key, value);
      },
      removeItem(key: string) {
        store.delete(key);
      },
    },
  };
}

function installMockEnvironment(mockWindow: Record<string, unknown>) {
  const prevWindow = (globalThis as Record<string, unknown>).window;
  const prevLocalStorage = (globalThis as Record<string, unknown>).localStorage;
  const storageSpy = createLocalStorageSpy();

  (globalThis as Record<string, unknown>).window = mockWindow;
  (globalThis as Record<string, unknown>).localStorage = storageSpy.api;

  return {
    storageSpy,
    cleanup() {
      setAuthToken('');
      if (prevWindow === undefined) {
        delete (globalThis as Record<string, unknown>).window;
      } else {
        (globalThis as Record<string, unknown>).window = prevWindow;
      }
      if (prevLocalStorage === undefined) {
        delete (globalThis as Record<string, unknown>).localStorage;
      } else {
        (globalThis as Record<string, unknown>).localStorage = prevLocalStorage;
      }
    },
  };
function createMockAndroidSecureSession(initialToken = '') {
let token = initialToken;
const listeners = new Set<(event: MessageEvent) => void>();
const emit = (payload: { id: string; ok: boolean; token?: string }) => queueMicrotask(() => { const ev = { data: JSON.stringify(payload) } as MessageEvent; for (const l of [...listeners]) l(ev); });
return {
  getToken: () => token,
  setToken: (next: string) => { token = next; },
  channel: {
    addEventListener(type: 'message', listener: (event: MessageEvent) => void) { if (type === 'message') listeners.add(listener); },
    removeEventListener(type: 'message', listener: (event: MessageEvent) => void) { if (type === 'message') listeners.delete(listener); },
    postMessage(raw: string) {
      const msg = JSON.parse(raw) as { id: string; action: 'set' | 'get' | 'clear'; token?: string };
      if (msg.action === 'set') { token = msg.token || ''; emit({ id: msg.id, ok: true, token }); return; }
      if (msg.action === 'get') { emit({ id: msg.id, ok: true, token }); return; }
      if (msg.action === 'clear') { token = ''; emit({ id: msg.id, ok: true, token: '' }); return; }
      emit({ id: msg.id, ok: false });
    },
  },
};
}

test('Android DBLSecureSession saves, restores, and clears token without calling localStorage.setItem', async () => {
  const androidSession = createMockAndroidSecureSession();
  const env = installMockEnvironment({
    DBLSecureSession: androidSession.channel,
  });

  try {
    await persistAuthToken('android-secret-token');
    assert.equal(androidSession.getToken(), 'android-secret-token');
    assert.equal(getAuthToken(), 'android-secret-token');

    setAuthToken('');
    const restored = await restorePersistedAuthToken();
    assert.equal(restored, 'android-secret-token');
    assert.equal(getAuthToken(), 'android-secret-token');

    await persistAuthToken('');
    assert.equal(androidSession.getToken(), '');
    assert.equal(getAuthToken(), '');
    assert.equal(env.storageSpy.setItemCalls, 0);
  } finally {
    env.cleanup();
  }
});

test('iOS webkit.messageHandlers.dblSecureStorage saves, restores, and clears token without localStorage.setItem', async () => {
  let iosToken = '';
  const env = installMockEnvironment({
    webkit: {
      messageHandlers: {
        dblSecureStorage: {
          async postMessage(payload: { action: string; token?: string }) {
            if (payload.action === 'set') {
              iosToken = payload.token || '';
              return true;
            }
            if (payload.action === 'get') {
              return iosToken;
            }
            if (payload.action === 'clear') {
              iosToken = '';
              return true;
            }
            return null;
          },
        },
      },
    },
  });

  try {
    await persistAuthToken('ios-secret-token');
    assert.equal(iosToken, 'ios-secret-token');
    assert.equal(getAuthToken(), 'ios-secret-token');

    setAuthToken('');
    const restored = await restorePersistedAuthToken();
    assert.equal(restored, 'ios-secret-token');
    assert.equal(getAuthToken(), 'ios-secret-token');

    await persistAuthToken('');
    assert.equal(iosToken, '');
    assert.equal(getAuthToken(), '');
    assert.equal(env.storageSpy.setItemCalls, 0);
  } finally {
    env.cleanup();
  }
});

test('restoreAndValidateSession restores on restart and clears token on user: null or 401 ApiError', async () => {
  const androidSession = createMockAndroidSecureSession('valid-session-token');
  const env = installMockEnvironment({
    DBLSecureSession: androidSession.channel,
  });

  try {
    const okResult = await restoreAndValidateSession(async () => ({
      user: { id: 'u1', role: 'student' },
    }));
    assert.equal(okResult.hasStoredToken, true);
    assert.equal(okResult.offline, false);
    assert.deepEqual(okResult.status, { user: { id: 'u1', role: 'student' } });
    assert.equal(getAuthToken(), 'valid-session-token');

    const nullUserResult = await restoreAndValidateSession(async () => ({
      user: null,
    }));
    assert.equal(nullUserResult.hasStoredToken, false);
    assert.equal(nullUserResult.offline, false);
    assert.equal(androidSession.getToken() ,'');
    assert.equal(getAuthToken(), '');

     androidSession.setToken('expired-token');
    const unauthorizedResult = await restoreAndValidateSession(async () => {
      throw new ApiError('Unauthorized', 401, false);
    });
    assert.equal(unauthorizedResult.hasStoredToken, false);
    assert.equal(unauthorizedResult.offline, false);
    assert.equal(unauthorizedResult.status, null);
    assert.equal(androidSession.getToken(), '');
    assert.equal(getAuthToken(), '');
  } finally {
    env.cleanup();
  }
});

test('restoreAndValidateSession keeps token when offline and restores once connection returns', async () => {
  const androidSession = createMockAndroidSecureSession('offline-resilient-token');
  const env = installMockEnvironment({
    DBLSecureSession: androidSession.channel,
  });

  try {
    const offlineResult = await restoreAndValidateSession(async () => {
      throw new ApiError('Network offline', 0, true);
    });
    assert.equal(offlineResult.hasStoredToken, true);
    assert.equal(offlineResult.offline, true);
    assert.equal(offlineResult.status, null);
    assert.equal(androidSession.getToken(), 'offline-resilient-token');
    assert.equal(getAuthToken(), 'offline-resilient-token');

    setAuthToken('');
    const onlineResult = await restoreAndValidateSession(async () => ({
      user: { id: 'u1', role: 'student' },
    }));
    assert.equal(onlineResult.hasStoredToken, true);
    assert.equal(onlineResult.offline, false);
    assert.deepEqual(onlineResult.status, { user: { id: 'u1', role: 'student' } });
    assert.equal(getAuthToken(), 'offline-resilient-token');
  } finally {
    env.cleanup();
  }
});

test('concurrent restorePersistedAuthToken and persistAuthToken("") does not restore old token', async () => {
  let iosToken = 'stale-session-token';
  const env = installMockEnvironment({
    webkit: {
      messageHandlers: {
        dblSecureStorage: {
          async postMessage(payload: { action: string; token?: string }) {
            if (payload.action === 'get') {
              await new Promise((resolve) => setTimeout(resolve, 25));
              return iosToken;
            }
            if (payload.action === 'clear') {
              iosToken = '';
              return true;
            }
            if (payload.action === 'set') {
              iosToken = payload.token || '';
              return true;
            }
            return null;
          },
        },
      },
    },
  });

  try {
    setAuthToken('stale-session-token');
    await Promise.all([
      restorePersistedAuthToken(),
      persistAuthToken(''),
    ]);

    assert.equal(iosToken, '');
    assert.equal(getAuthToken(), '');
  } finally {
    env.cleanup();
  }
});

test('UI visibility and official Android APK URL rules', () => {
  assert.equal(shouldHidePwaInstallUi(true), true);
  assert.equal(shouldHidePwaInstallUi(false), false);

  assert.equal(shouldAllowLanServerConfig('', true), false);
  assert.equal(shouldAllowLanServerConfig('https://campus.example.com', false), false);
  assert.equal(shouldAllowLanServerConfig('', false), true);

  assert.ok(OFFICIAL_ANDROID_APK_URL.startsWith(OFFICIAL_RELEASES_URL));
  assert.ok(OFFICIAL_ANDROID_APK_URL.endsWith('/download/DBL-Campus-Android.apk'));
  assert.equal(/v?\d+\.\d+/.test(OFFICIAL_ANDROID_APK_URL), false);
});

test('restoreAndValidateSession ignores stale { user } response after persistAuthToken("") logout', async () => {
  const androidSession = createMockAndroidSecureSession('old-session-token');
  const env = installMockEnvironment({
    DBLSecureSession: androidSession.channel,
  });

  try {
    let resolveFetch!: (val: { user: { id: string; role: string } }) => void;
    const validationPromise = restoreAndValidateSession(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    await persistAuthToken('');

    resolveFetch({ user: { id: 'old-u1', role: 'student' } });
    const result = await validationPromise;

    assert.equal(result.stale, true);
    assert.equal(result.status, null);
    assert.equal(result.hasStoredToken, false);
    assert.equal(androidSession.getToken(), '');
    assert.equal(getAuthToken(), '');
  } finally {
    env.cleanup();
  }
});

test('restoreAndValidateSession ignores stale 401 or { user: null } after persistAuthToken("new-account-token")', async () => {
  const androidSession = createMockAndroidSecureSession('old-account-token');
  const env = installMockEnvironment({
    DBLSecureSession: androidSession.channel,
  });

  try {
    let rejectFetch!: (err: unknown) => void;
    const stale401Promise = restoreAndValidateSession(
      () =>
        new Promise<{ user: unknown | null }>((_, reject) => {
          rejectFetch = reject;
        }),
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    await persistAuthToken('new-account-token');

    rejectFetch(new ApiError('Unauthorized', 401, false));
    const res401 = await stale401Promise;

    assert.equal(res401.stale, true);
    assert.equal(res401.status, null);
    assert.equal(res401.hasStoredToken, true);
    assert.equal(androidSession.getToken(), 'new-account-token');
    assert.equal(getAuthToken(), 'new-account-token');

    let resolveNullFetch!: (val: { user: null }) => void;
    const staleNullPromise = restoreAndValidateSession(
      () =>
        new Promise<{ user: null }>((resolve) => {
          resolveNullFetch = resolve;
        }),
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    await persistAuthToken('new-account-token');

    resolveNullFetch({ user: null });
    const resNull = await staleNullPromise;

    assert.equal(resNull.stale, true);
    assert.equal(resNull.status, null);
    assert.equal(resNull.hasStoredToken, true);
    assert.equal(androidSession.getToken(), 'new-account-token');
    assert.equal(getAuthToken(), 'new-account-token');
  } finally {
    env.cleanup();
  }
});
}
