import React, { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  Server,
  Share2,
  ShieldCheck,
  Smartphone,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { UserAccount } from '../types';
import { apiFetch, buildApiUrl, formatBytes, getAuthToken } from '../utils/api';
import {
  getBundledServerOrigin,
  getSavedServerBaseUrl,
  isNativeCapacitorApp,
  saveServerBaseUrl,
  validateServerBaseUrl,
} from '../utils/mobileConfig';
import {
  OFFICIAL_ANDROID_APK_URL,
  OFFICIAL_RELEASES_URL,
  shouldAllowLanServerConfig,
} from '../utils/nativeBridge';

interface MobileReleaseInfo {
  platform: 'apk' | 'ipa';
  fileName: string;
  available: boolean;
  sizeBytes: number;
  updatedAt: string | null;
  sha256: string | null;
}

interface MobileReleasesPayload {
  apk: MobileReleaseInfo;
  ipa: MobileReleaseInfo;
}

interface MobileAppsModalProps {
  user: UserAccount | null;
  onClose: () => void;
  notify: (msg: string, type?: 'success' | 'error') => void;
}

type ModalTab = 'download' | 'admin' | 'server';

export const MobileAppsModal = ({ user, onClose, notify }: MobileAppsModalProps) => {
  const isRepresentative = user?.role === 'representative';
  const isNativeApp = isNativeCapacitorApp();
  const bundledOrigin = getBundledServerOrigin();
  const allowLanServerConfig = shouldAllowLanServerConfig(bundledOrigin, import.meta.env.PROD);
  const canConfigureLanServer = allowLanServerConfig && isRepresentative;

  const [activeTab, setActiveTab] = useState<ModalTab>('download');
  const [releases, setReleases] = useState<MobileReleasesPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploadingPlatform, setUploadingPlatform] = useState<'apk' | 'ipa' | null>(null);
  const [deletingPlatform, setDeletingPlatform] = useState<'apk' | 'ipa' | null>(null);

  const [serverInput, setServerInput] = useState(() => getSavedServerBaseUrl());
  const [testingServer, setTestingServer] = useState(false);

  const fetchReleases = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<MobileReleasesPayload>('/api/mobile/releases');
      setReleases(data);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'تعذر جلب معلومات التطبيقات', 'error');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void fetchReleases();
  }, [fetchReleases]);

  useEffect(() => {
    if (activeTab === 'admin' && !isRepresentative) {
      setActiveTab('download');
    }
    if (activeTab === 'server' && !canConfigureLanServer) {
      setActiveTab('download');
    }
  }, [activeTab, isRepresentative, canConfigureLanServer]);

  const handleCopyText = async (value: string, successMessage: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        notify(successMessage, 'success');
      } else {
        notify('النسخ التلقائي غير مدعوم في هذا المتصفح', 'success');
      }
    } catch {
      notify('تعذر نسخ النص', 'error');
    }
  };

  const handleUploadPackage = async (platform: 'apk' | 'ipa', file: File | null) => {
    if (!file || !isRepresentative) return;
    setUploadingPlatform(platform);
    try {
      const formData = new FormData();
      formData.append('platform', platform);
      formData.append('package', file);

      const token = getAuthToken();
      const response = await fetch(buildApiUrl('/api/mobile/releases/upload'), {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        credentials: 'include',
        body: formData,
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || 'تعذر رفع حزمة التطبيق');
      }

      notify(
        platform === 'apk' ? 'تم رفع حزمة Android بنجاح' : 'تم رفع حزمة iOS بنجاح',
        'success'
      );
      await fetchReleases();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'تعذر رفع حزمة التطبيق', 'error');
    } finally {
      setUploadingPlatform(null);
    }
  };

  const handleDeletePackage = async (platform: 'apk' | 'ipa') => {
    if (!isRepresentative) return;
    setDeletingPlatform(platform);
    try {
      await apiFetch(`/api/mobile/releases/${platform}`, { method: 'DELETE' });
      notify(
        platform === 'apk' ? 'تم حذف حزمة Android' : 'تم حذف حزمة iOS',
        'success'
      );
      await fetchReleases();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'تعذر حذف الحزمة', 'error');
    } finally {
      setDeletingPlatform(null);
    }
  };

  const handleSaveServerUrl = async () => {
    if (!canConfigureLanServer) return;
    const validation = validateServerBaseUrl(serverInput);
    if (!validation.valid) {
      notify(validation.errorAr || 'عنوان الخادم غير صالح', 'error');
      return;
    }

    setTestingServer(true);
    try {
      const targetUrl = validation.normalized ? `${validation.normalized}/api/health` : '/api/health';
      const response = await fetch(targetUrl);
      if (!response.ok) {
        throw new Error(`فشل الاتصال بالخادم (HTTP ${response.status})`);
      }
      saveServerBaseUrl(validation.normalized);
      setServerInput(validation.normalized);
      notify('تم حفظ عنوان الخادم والتحقق من الاتصال بنجاح', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'تعذر الاتصال بالخادم', 'error');
    } finally {
      setTestingServer(false);
    }
  };

  return (
    <div
      className="fixed aurora-modal-backdrop inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4"
      dir="rtl"
    >
      <div className="w-full aurora-modal-panel max-w-2xl max-h-[90vh] overflow-y-auto rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400">
              <Smartphone className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                تطبيق الدفعة على الهاتف
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                ثبّت التطبيق الرسمي على Android أو أضف المنصة إلى شاشة iPhone الرئيسية
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق"
            className="rounded-xl p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {(isRepresentative || canConfigureLanServer) && (
          <div className="flex flex-wrap gap-2 border-b border-slate-200 dark:border-slate-800 px-6 py-3 bg-slate-50/70 dark:bg-slate-950/40">
            <button
              type="button"
              onClick={() => setActiveTab('download')}
              className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition ${
                activeTab === 'download'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800'
              }`}
            >
              <Download className="h-4 w-4" />
              تحميل التطبيق
            </button>

            {isRepresentative && (
              <button
                type="button"
                onClick={() => setActiveTab('admin')}
                className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition ${
                  activeTab === 'admin'
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800'
                }`}
              >
                <ShieldCheck className="h-4 w-4" />
                إدارة الحزم
              </button>
            )}

            {canConfigureLanServer && (
              <button
                type="button"
                onClick={() => setActiveTab('server')}
                className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition ${
                  activeTab === 'server'
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800'
                }`}
              >
                <Server className="h-4 w-4" />
                إعداد خادم الشبكة المحلية
              </button>
            )}
          </div>
        )}

        <div className="p-6 space-y-5">
          {activeTab === 'download' && (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/40 p-5 flex flex-col justify-between gap-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-base font-bold text-slate-900 dark:text-white">
                      تطبيق Android الرسمي
                    </h3>
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 dark:bg-emerald-950/60 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      متاح
                    </span>
                  </div>
                  <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                    نزّل التطبيق الرسمي مباشرة على هاتف Android وثبّته بسهولة لمتابعة المحاضرات والإشعارات.
                  </p>
                </div>

                <div className="space-y-2.5">
                  <a
                    href={OFFICIAL_ANDROID_APK_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 px-4 py-2.5 text-sm font-semibold text-white transition"
                  >
                    <Download className="h-4 w-4" />
                    تنزيل تطبيق Android الرسمي
                  </a>

                  {!loading && releases?.apk.available && (
                    <a
                      href={buildApiUrl('/api/mobile/download/apk')}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 px-4 py-2.5 text-sm font-semibold text-slate-800 dark:text-slate-100 transition"
                    >
                      <Download className="h-4 w-4" />
                      <span>تنزيل من خادم المنصة</span>
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        ({formatBytes(releases.apk.sizeBytes)})
                      </span>
                    </a>
                  )}

                  <a
                    href={OFFICIAL_RELEASES_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex w-full items-center justify-center gap-1.5 py-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    عرض جميع الإصدارات الرسمية
                  </a>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/40 p-5 flex flex-col justify-between gap-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-base font-bold text-slate-900 dark:text-white">
                      مستخدمي iPhone
                    </h3>
                    <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 dark:bg-sky-950/60 px-2.5 py-0.5 text-xs font-semibold text-sky-700 dark:text-sky-300">
                      <Share2 className="h-3.5 w-3.5" />
                      Safari
                    </span>
                  </div>
                  <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                    للحصول على تجربة تطبيق كاملة على iPhone وiPad دون الحاجة إلى تثبيت خارجي:
                  </p>
                </div>

                <ol className="space-y-2.5 text-sm text-slate-700 dark:text-slate-200">
                  <li className="flex items-start gap-2.5">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-100 dark:bg-indigo-950/60 text-xs font-bold text-indigo-700 dark:text-indigo-300">
                      1
                    </span>
                    <span>افتح المنصة باستخدام متصفح Safari.</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-100 dark:bg-indigo-950/60 text-xs font-bold text-indigo-700 dark:text-indigo-300">
                      2
                    </span>
                    <span>اضغط على أيقونة «مشاركة» في شريط المتصفح.</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-100 dark:bg-indigo-950/60 text-xs font-bold text-indigo-700 dark:text-indigo-300">
                      3
                    </span>
                    <span>اختر «مشاركة ← إضافة إلى الشاشة الرئيسية» ثم اضغط إضافة.</span>
                  </li>
                </ol>
              </div>
            </div>
          )}

          {activeTab === 'admin' && isRepresentative && (
            <div className="space-y-4">
              <div className="rounded-2xl border border-amber-200 dark:border-amber-900/50 bg-amber-50/70 dark:bg-amber-950/20 px-4 py-3 text-xs text-amber-800 dark:text-amber-200">
                هذا القسم مخصص لمندوب الدفعة لرفع حزم التطبيق على الخادم والتحقق من بصمات SHA-256.
              </div>

              {(['apk', 'ipa'] as const).map((platform) => {
                const info = releases?.[platform];
                const isApk = platform === 'apk';
                const isUploading = uploadingPlatform === platform;
                const isDeleting = deletingPlatform === platform;

                return (
                  <div
                    key={platform}
                    className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/40 p-4 space-y-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                          {isApk ? 'حزمة Android (APK)' : 'حزمة iOS (IPA)'}
                        </h3>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          {info?.available
                            ? `${info.fileName} • ${formatBytes(info.sizeBytes)}`
                            : 'لا توجد حزمة مرفوعة على الخادم حالياً'}
                        </p>
                      </div>

                      <div className="flex items-center gap-2">
                        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 px-3 py-2 text-xs font-semibold text-white transition">
                          <Upload className="h-3.5 w-3.5" />
                          <span>{isUploading ? 'جارٍ الرفع...' : 'رفع حزمة'}</span>
                          <input
                            type="file"
                            accept={isApk ? '.apk' : '.ipa'}
                            disabled={isUploading}
                            className="hidden"
                            onChange={(e) => {
                              const file = e.target.files?.[0] || null;
                              void handleUploadPackage(platform, file);
                              e.target.value = '';
                            }}
                          />
                        </label>

                        {info?.available && (
                          <button
                            type="button"
                            disabled={isDeleting}
                            onClick={() => void handleDeletePackage(platform)}
                            className="inline-flex items-center gap-1.5 rounded-xl border border-rose-200 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/30 hover:bg-rose-100 dark:hover:bg-rose-950/50 px-3 py-2 text-xs font-semibold text-rose-700 dark:text-rose-300 transition"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span>{isDeleting ? 'جارٍ الحذف...' : 'حذف'}</span>
                          </button>
                        )}
                      </div>
                    </div>

                    {info?.available && info.sha256 && (
                      <div className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2">
                        <div className="min-w-0">
                          <span className="block text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                            SHA-256
                          </span>
                          <code className="block truncate text-xs text-slate-800 dark:text-slate-200" dir="ltr">
                            {info.sha256}
                          </code>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleCopyText(info.sha256 || '', 'تم نسخ بصمة SHA-256')}
                          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
                        >
                          <Copy className="h-3.5 w-3.5" />
                          نسخ
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {activeTab === 'server' && canConfigureLanServer && (
            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/40 p-5 space-y-4">
              <div className="space-y-1">
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                  إعداد خادم الشبكة المحلية (للتطوير فقط)
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {isNativeApp
                    ? 'أدخل عنوان خادم التطوير المحلي لاختبار التطبيق.'
                    : 'هذا الإعداد متاح فقط في بيئة التطوير للمندوب.'}
                </p>
              </div>

              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="url"
                  dir="ltr"
                  value={serverInput}
                  onChange={(e) => setServerInput(e.target.value)}
                  placeholder="أدخل رابط الخادم المحلي"
                  className="flex-1 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3.5 py-2.5 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <button
                  type="button"
                  disabled={testingServer}
                  onClick={() => void handleSaveServerUrl()}
                  className="rounded-xl bg-indigo-600 hover:bg-indigo-700 px-4 py-2.5 text-sm font-semibold text-white transition disabled:opacity-60"
                >
                  {testingServer ? 'جارٍ التحقق...' : 'حفظ واختبار'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
} ;
export default MobileAppsModal;
