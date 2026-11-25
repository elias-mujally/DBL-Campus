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
}

test('Android DBLNativeBridge saves, restores, and clears token without calling localStorage.setItem', async () => {
  let nativeToken = '';
  const env = installMockEnvironment({
    DBLNativeBridge: {
      saveSessionToken(token: string) {
        nativeToken = token;
        return true;
      },
      getSessionToken() {
        return nativeToken;
      },
      clearSessionToken() {
        nativeToken = '';
        return true;
      },
    },
  });

  try {
    await persistAuthToken('android-secret-token');
    assert.equal(nativeToken, 'android-secret-token');
    assert.equal(getAuthToken(), 'android-secret-token');

    setAuthToken('');
    const restored = await restorePersistedAuthToken();
    assert.equal(restored, 'android-secret-token');
    assert.equal(getAuthToken(), 'android-secret-token');

    await persistAuthToken('');
    assert.equal(nativeToken, '');
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
  let nativeToken = 'valid-session-token';
  const env = installMockEnvironment({
    DBLNativeBridge: {
      saveSessionToken(token: string) {
        nativeToken = token;
        return true;
      },
      getSessionToken() {
        return nativeToken;
      },
      clearSessionToken() {
        nativeToken = '';
        return true;
      },
    },
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
    assert.equal(nativeToken, '');
    assert.equal(getAuthToken(), '');

    nativeToken = 'expired-token';
    const unauthorizedResult = await restoreAndValidateSession(async () => {
      throw new ApiError('Unauthorized', 401, false);
    });
    assert.equal(unauthorizedResult.hasStoredToken, false);
    assert.equal(unauthorizedResult.offline, false);
    assert.equal(unauthorizedResult.status, null);
    assert.equal(nativeToken, '');
    assert.equal(getAuthToken(), '');
  } finally {
    env.cleanup();
  }
});

test('restoreAndValidateSession keeps token when offline and restores once connection returns', async () => {
  let nativeToken = 'offline-resilient-token';
  const env = installMockEnvironment({
    DBLNativeBridge: {
      saveSessionToken(token: string) {
        nativeToken = token;
        return true;
      },
      getSessionToken() {
        return nativeToken;
      },
      clearSessionToken() {
        nativeToken = '';
        return true;
      },
    },
  });

  try {
    const offlineResult = await restoreAndValidateSession(async () => {
      throw new ApiError('Network offline', 0, true);
    });
    assert.equal(offlineResult.hasStoredToken, true);
    assert.equal(offlineResult.offline, true);
    assert.equal(offlineResult.status, null);
    assert.equal(nativeToken, 'offline-resilient-token');
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
