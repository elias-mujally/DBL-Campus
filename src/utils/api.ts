import { getSavedServerBaseUrl, isNativeCapacitorApp, resolveApiUrl } from './mobileConfig';
import { clearNativeSessionToken, loadNativeSessionToken, saveNativeSessionToken } from './nativeBridge';

export class ApiError extends Error {
  status: number;
  isNetworkError: boolean;

  constructor(message: string, status: number, isNetworkError = false) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.isNetworkError = isNetworkError;
  }
}

let authTokenMemory = '';

export function setAuthToken(token: string): void {
  authTokenMemory = token;
}

export function getAuthToken(): string {
  return authTokenMemory;
}

export async function persistAuthToken(token: string): Promise<void> {
  authTokenMemory = token;
  if (!token) {
    await clearNativeSessionToken();
    return;
  }
  await saveNativeSessionToken(token);
}

export async function restorePersistedAuthToken(): Promise<string> {
  const token = await loadNativeSessionToken();
  if (token) {
    authTokenMemory = token;
  }
  return token;
}

export async function restoreAndValidateSession<T extends { user: unknown | null }>(
  fetchStatus: () => Promise<T>,
): Promise<{ status: T | null; offline: boolean; hasStoredToken: boolean }> {
  const token = await restorePersistedAuthToken();
  try {
    const status = await fetchStatus();
    if (status.user === null) {
      await persistAuthToken('');
      return { status, offline: false, hasStoredToken: false };
    }
    return { status, offline: false, hasStoredToken: Boolean(token) };
  } catch (err) {
    if (err instanceof ApiError && err.isNetworkError) {
      return { status: null, offline: true, hasStoredToken: Boolean(token) };
    }
    if (err instanceof ApiError && err.status === 401) {
      await persistAuthToken('');
      return { status: null, offline: false, hasStoredToken: false };
    }
    throw err;
  }
}

export function buildApiUrl(path: string): string {
  const origin = getSavedServerBaseUrl();
  if (isNativeCapacitorApp() && !origin) throw new Error('لم يُضبط عنوان خادم HTTPS لهذا الإصدار.');
  return resolveApiUrl(path, origin);
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (authTokenMemory) {
    headers.Authorization = `Bearer ${authTokenMemory}`;
  }
  let res: Response;
  try {
    res = await fetch(buildApiUrl(path), {
      ...options,
      headers,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Network error';
    throw new ApiError(msg || 'Network error', 0, true);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(data.error || `Request failed (${res.status})`, res.status, false);
  }
  return data as T;
}


export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

export const ROLE_LABELS_AR: Record<string, string> = {
  representative: 'مندوب الدفعة',
  deputy: 'نائب المندوب',
  coordinator: 'منسق أكاديمي',
  student: 'طالب',
};

export const RESPONSIBILITY_LABELS_AR: Record<string, string> = {
  lectures: 'إدارة الجدول والمحاضرات',
  assignments: 'إدارة التكاليف',
  files: 'إدارة مكتبة الملفات',
  announcements: 'نشر الإعلانات',
  requests: 'متابعة الطلبات وكشوف التأييد',
  students: 'إدارة بيانات الطلاب',
  permissions: 'إدارة الصلاحيات وسجل العمليات',
  backup: 'النسخ الاحتياطي والاستعادة',
};

export async function downloadLibraryFile(id: string, name: string): Promise<void> {
  const { downloadUrl } = await apiFetch<{ downloadUrl: string }>(
    `/api/files/${encodeURIComponent(id)}/download-ticket`, { method: 'POST' }
  );
  const link = document.createElement('a');
  link.href = buildApiUrl(downloadUrl);
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
}
