import React, { useEffect, useState } from 'react';
import { Download, WifiOff, X } from 'lucide-react';
import { isNativeCapacitorApp } from '../utils/mobileConfig';
import { shouldHidePwaInstallUi } from '../utils/nativeBridge';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export const PWAInstallButton: React.FC = () => {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [showGuideModal, setShowGuideModal] = useState(false);

  useEffect(() => {
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    setIsInstalled(isStandalone);

    const ua = window.navigator.userAgent.toLowerCase();
    setIsIOS(/iphone|ipad|ipod/.test(ua));

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  if (isInstalled) return null;
if (shouldHidePwaInstallUi(isNativeCapacitorApp())) return null;

  const handleInstallClick = async () => {
    if (deferredPrompt) {
      await deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        setIsInstalled(true);
        setDeferredPrompt(null);
      }
    } else {
      setShowGuideModal(true);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={handleInstallClick}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
        title="تثبيت تطبيق DBL Campus على الجهاز"
      >
        <Download className="w-3.5 h-3.5" />
        <span>{isIOS ? 'تثبيت على iOS' : 'تثبيت التطبيق'}</span>
      </button>

      {showGuideModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="pwa-guide-title"
        >
          <div className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-xl">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800">
              <h3 id="pwa-guide-title" className="text-base font-bold text-slate-900 dark:text-slate-100">
                تثبيت تطبيق DBL Campus على جهازك
              </h3>
              <button
                type="button"
                onClick={() => setShowGuideModal(false)}
                aria-label="إغلاق نافذة التثبيت"
                className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="mt-4 space-y-3 text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
              <p>
                يمكنك تثبيت المنصة كتطبيق مستقل (PWA) يعمل عبر الإنترنت بـ <strong>HTTPS</strong> للوصول السريع إلى الجدول الدراسي والتكاليف من أي مكان:
              </p>
              <ol className="list-decimal list-inside space-y-2 text-xs text-slate-600 dark:text-slate-400">
                <li>
                  <strong>على الحاسوب (Chrome / Edge):</strong> اضغط على أيقونة التثبيت في شريط العنوان العلوي أو اختر <em>تثبيت تطبيق DBL Campus</em> من قائمة المتصفح.
                </li>
                <li>
                  <strong>على الهاتف (Android / iOS Safari):</strong> افتح رابط المنصة عبر <strong>HTTPS</strong>، ثم اضغط على قائمة المتصفح أو زر المشاركة (Share) واختر <strong>إضافة إلى الشاشة الرئيسية (Add to Home Screen)</strong>.
                </li>
              </ol>
            </div>
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setShowGuideModal(false)}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-teal-600 text-white hover:opacity-90"
              >
                حسناً، فهمت
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export const OfflineIndicator: React.FC = () => {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  if (isOnline) return null;

  return (
    <div className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-lg bg-amber-600 px-3.5 py-2 text-xs font-semibold text-white shadow-lg">
      <WifiOff className="w-4 h-4" />
      <span>وضع عدم الاتصال — يتم عرض البيانات المخزنة محلياً</span>
    </div>
  );
};
