declare const __DBL_NATIVE_SERVER_ORIGIN__: string;
const nativeOrigin = typeof __DBL_NATIVE_SERVER_ORIGIN__ === 'undefined' ? '' : __DBL_NATIVE_SERVER_ORIGIN__;
const SERVER_URL_STORAGE_KEY = 'dbl_campus_server_url';

/**
 * Validates and normalizes a user-provided LAN or remote server base URL.
 * Strictly allows only http:// or https:// protocols to prevent unsafe URL schemes.
 */
export function validateServerBaseUrl(rawInput: string): {
  valid: boolean;
  normalized: string;
  errorAr?: string;
} {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { valid: true, normalized: '' };
  }

  let candidate = trimmed;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        valid: false,
        normalized: '',
        errorAr: 'يجب أن يبدأ عنوان الخادم بـ http:// أو https:// فقط.',
      };
    }
    if (!parsed.hostname) {
      return {
        valid: false,
        normalized: '',
        errorAr: 'عنوان الخادم غير مكتمل.',
      };
    }
    if (parsed.protocol === 'http:' && !/^(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(parsed.hostname)) {
      return { valid: false, normalized: '', errorAr: 'يتطلب عنوان الخادم العام اتصال HTTPS.' };
    }
    const cleanOrigin = `${parsed.protocol}//${parsed.host}`;
    return { valid: true, normalized: cleanOrigin };
  } catch {
    return {
      valid: false,
      normalized: '',
      errorAr: 'صيغة عنوان الخادم غير صالحة (مثال صحيح: http://192.168.1.15:3000).',
    };
  }
}

/**
 * Resolves a relative API path (e.g. "/api/courses") against an optional custom base URL.
 */
export function resolveApiUrl(path: string, baseUrl: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const cleanBase = baseUrl.trim().replace(/\/+$/, '');
  if (!cleanBase) return cleanPath;
  return `${cleanBase}${cleanPath}`;
}

/**
 * Detects whether the frontend is currently running inside a Capacitor native APK/IPA shell.
 */
export function isNativeCapacitorApp(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  if (cap && typeof cap.isNativePlatform === 'function') {
    return cap.isNativePlatform();
  }
  return window.location.protocol === 'capacitor:' || window.location.protocol === 'ionic:';
}

export function getBundledServerOrigin(): string { return nativeOrigin; }

export function getSavedServerBaseUrl(): string {
  if (nativeOrigin) return nativeOrigin;
  if (typeof window === 'undefined') return '';
  try {
    const stored = window.localStorage.getItem(SERVER_URL_STORAGE_KEY) || '';
    const check = validateServerBaseUrl(stored);
    return check.valid ? check.normalized : '';
  } catch {
    return '';
  }
}

export function saveServerBaseUrl(rawInput: string): {
  valid: boolean;
  normalized: string;
  errorAr?: string;
} {
  if (nativeOrigin) return { valid: false, normalized: nativeOrigin, errorAr: 'عنوان الإنتاج محدد في إصدار التطبيق.' };
  const check = validateServerBaseUrl(rawInput);
  if (!check.valid) return check;
  if (typeof window !== 'undefined') {
    try {
      if (check.normalized) {
        window.localStorage.setItem(SERVER_URL_STORAGE_KEY, check.normalized);
      } else {
        window.localStorage.removeItem(SERVER_URL_STORAGE_KEY);
      }
    } catch {
      // ignore storage quota errors
    }
  }
  return check;
}
