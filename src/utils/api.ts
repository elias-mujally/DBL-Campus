let authTokenMemory = '';

export function setAuthToken(token: string): void {
  authTokenMemory = token;
}

export function getAuthToken(): string {
  return authTokenMemory;
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

  const res = await fetch(path, {
    ...options,
    headers,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `خطأ في الاتصال بالخادم (${res.status})`);
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
