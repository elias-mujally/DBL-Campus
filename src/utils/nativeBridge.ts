declare const __DBL_APP_VERSION__: string;

const THEME_STORAGE_KEY = 'dbl_campus_theme';

interface AndroidNativeBridge {
  printDocument?: (title: string) => void;
  downloadFile?: (url: string, fileName: string) => void;
  saveBase64File?: (fileName: string, mimeType: string, base64Data: string) => void;
    saveSessionToken?(token: string): boolean;
    getSessionToken?(): string;
    clearSessionToken?(): boolean;
}

interface WebKitMessageHandler {
  postMessage: (payload: unknown) => void;
}

interface NativeBridgeWindow extends Window {
  DBLNativeBridge?: AndroidNativeBridge;
  webkit?: {
    messageHandlers?: {
      dblPrint?: WebKitMessageHandler;
      dblDownload?: WebKitMessageHandler;
      dblSaveFile?: WebKitMessageHandler;
dblSecureStorage?: { postMessage: (payload: Record<string, unknown>) => Promise<unknown> };
    };
  };
}

export function getAppVersion(): string {
  return typeof __DBL_APP_VERSION__ === 'string' && __DBL_APP_VERSION__
    ? __DBL_APP_VERSION__
    : '1.1.0';
}

export function sanitizeDownloadFilename(rawName: string, fallback = 'DBL_Campus_Document'): string {
  const base = rawName
    .replace(/\.\./g, '')
    .replace(/[/\\]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  const safe = base.replace(/^[._]+/, '').slice(0, 140);
  return safe || fallback;
}

export function isAllowedNativeDownloadUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function getSavedThemePreference(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === 'dark';
  } catch {
    return false;
  }
}

export function saveThemePreference(isDark: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, isDark ? 'dark' : 'light');
  } catch {
    // ignore storage restrictions
  }
}

function getBridgeWindow(): NativeBridgeWindow | null {
  if (typeof window === 'undefined') return null;
  return window as unknown as NativeBridgeWindow;
}

/**
 * Triggers native Android PrintManager or iOS UIPrintInteractionController when running
 * inside the Capacitor mobile shell, falling back to browser window.print() on web/PWA.
 */
export function printCurrentDocument(title = 'DBL Campus — مستند رسمي'): 'android' | 'ios' | 'web' {
  const safeTitle = sanitizeDownloadFilename(title, 'DBL_Campus_Document');
  const win = getBridgeWindow();
  if (win?.DBLNativeBridge && typeof win.DBLNativeBridge.printDocument === 'function') {
    win.DBLNativeBridge.printDocument(safeTitle);
    return 'android';
  }
  const iosPrint = win?.webkit?.messageHandlers?.dblPrint;
  if (iosPrint && typeof iosPrint.postMessage === 'function') {
    iosPrint.postMessage({ title: safeTitle });
    return 'ios';
  }
  if (typeof window !== 'undefined' && typeof window.print === 'function') {
    window.print();
  }
  return 'web';
}

/**
 * Downloads a file from a short-lived signed HTTPS ticket URL using Android DownloadManager
 * or iOS URLSession + Share Sheet when inside the mobile app, or a standard anchor click on web.
 */
export function downloadFromSignedUrl(fullUrl: string, fileName: string): 'android' | 'ios' | 'web' {
  const safeName = sanitizeDownloadFilename(fileName, 'DBL_Campus_Attachment');
  const win = getBridgeWindow();

  if (isAllowedNativeDownloadUrl(fullUrl)) {
    if (win?.DBLNativeBridge && typeof win.DBLNativeBridge.downloadFile === 'function') {
      win.DBLNativeBridge.downloadFile(fullUrl, safeName);
      return 'android';
    }
    const iosDownload = win?.webkit?.messageHandlers?.dblDownload;
    if (iosDownload && typeof iosDownload.postMessage === 'function') {
      iosDownload.postMessage({ url: fullUrl, fileName: safeName });
      return 'ios';
    }
  }

  if (typeof document !== 'undefined') {
    const link = document.createElement('a');
    link.href = fullUrl;
    link.download = safeName;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }
  return 'web';
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(new Error('تعذر قراءة الملف للتصدير.'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Exports an in-memory Blob (CSV roster, JSON backup, SQLite backup) on Android/iOS native
 * shells without relying on unsupported WebView blob: anchor downloads.
 */
export async function exportBlobFile(
  blob: Blob,
  fileName: string,
  mimeType: string
): Promise<'android' | 'ios' | 'web'> {
  const safeName = sanitizeDownloadFilename(fileName, 'DBL_Campus_Export');
  const safeMime = mimeType || 'application/octet-stream';
  const win = getBridgeWindow();

  if (win?.DBLNativeBridge && typeof win.DBLNativeBridge.saveBase64File === 'function') {
    const base64Data = await blobToBase64(blob);
    win.DBLNativeBridge.saveBase64File(safeName, safeMime, base64Data);
    return 'android';
  }

  const iosSave = win?.webkit?.messageHandlers?.dblSaveFile;
  if (iosSave && typeof iosSave.postMessage === 'function') {
    const base64Data = await blobToBase64(blob);
    iosSave.postMessage({ fileName: safeName, mimeType: safeMime, base64Data });
    return 'ios';
  }

  if (typeof document !== 'undefined') {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = safeName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }
  return 'web';
}

export const OFFICIAL_GITHUB_REPO = 'elias-mujally/DBL-Campus';
export const OFFICIAL_RELEASES_URL = `https://github.com/${OFFICIAL_GITHUB_REPO}/releases/latest`;
export const OFFICIAL_ANDROID_APK_URL = `https://github.com/${OFFICIAL_GITHUB_REPO}/releases/latest/download/DBL-Campus-Android.apk`;

export function shouldHidePwaInstallUi(isNative: boolean): boolean {
  return Boolean(isNative);
}

export function shouldAllowLanServerConfig(bundledOrigin: string, isProd: boolean): boolean {
  return !bundledOrigin && !isProd;
}

export async function saveNativeSessionToken(token: string): Promise<boolean> {
  if (!token) {
    return clearNativeSessionToken();
  }
  const win = getBridgeWindow();
  try {
    if (win?.DBLNativeBridge && typeof win.DBLNativeBridge.saveSessionToken === 'function') {
      return Boolean(win.DBLNativeBridge.saveSessionToken(token));
    }
    const iosStorage = win?.webkit?.messageHandlers?.dblSecureStorage;
    if (iosStorage && typeof iosStorage.postMessage === 'function') {
      const result = await iosStorage.postMessage({ action: 'set', token });
      return result === undefined ? true : Boolean(result);
    }
  } catch {
    return false;
  }
  return false;
}

export async function loadNativeSessionToken(): Promise<string> {
  const win = getBridgeWindow();
  try {
    if (win?.DBLNativeBridge && typeof win.DBLNativeBridge.getSessionToken === 'function') {
      const token = win.DBLNativeBridge.getSessionToken();
      return typeof token === 'string' ? token : '';
    }
    const iosStorage = win?.webkit?.messageHandlers?.dblSecureStorage;
    if (iosStorage && typeof iosStorage.postMessage === 'function') {
      const result = await iosStorage.postMessage({ action: 'get' });
      return typeof result === 'string' ? result : '';
    }
  } catch {
    return '';
  }
  return '';
}

export async function clearNativeSessionToken(): Promise<boolean> {
  const win = getBridgeWindow();
  try {
    if (win?.DBLNativeBridge && typeof win.DBLNativeBridge.clearSessionToken === 'function') {
      return Boolean(win.DBLNativeBridge.clearSessionToken());
    }
    const iosStorage = win?.webkit?.messageHandlers?.dblSecureStorage;
    if (iosStorage && typeof iosStorage.postMessage === 'function') {
      const result = await iosStorage.postMessage({ action: 'clear' });
      return result === undefined ? true : Boolean(result);
    }
  } catch {
    return false;
  }
  return false;
}
