/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Bell,
  BookOpen,
  Calendar,
  CheckSquare,
  Database,
  FolderOpen,
  GraduationCap,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquarePlus,
  Moon,
  Search,
  Smartphone,
  Sun,
  UserCheck,
  Users,
  X,
  User,
} from 'lucide-react';
import type {
  Announcement,
  Assignment,
  CohortRequest,
  CohortTask,
  Course,
  Lecture,
  LibraryFile,
  ScheduleConflict,
  UserAccount,
} from './types';
import { ROLE_LABELS_AR, apiFetch, getAuthToken, setAuthToken, persistAuthToken, restoreAndValidateSession } from './utils/api';
import { hasPermission } from './utils/domainLogic';
import { getSavedThemePreference, saveThemePreference, shouldHidePwaInstallUi } from './utils/nativeBridge';
import { isNativeCapacitorApp } from './utils/mobileConfig';
import { PWAInstallButton, OfflineIndicator } from './components/PWAInstallButton';
import { MobileAppsModal } from './components/MobileAppsModal';
import { DashboardView } from './components/DashboardView';
import { ScheduleView } from './components/ScheduleView';
import { AssignmentsView } from './components/AssignmentsView';
import { AnnouncementsView } from './components/AnnouncementsView';
import { RequestsView } from './components/RequestsView';
import { TasksView, LibraryView } from './components/TasksAndLibraryView';
import { AdminAndStudentsView } from './components/AdminAndStudentsView';

interface SearchResultItem {
  id: string;
  type: string;
  title: string;
  subtitle: string;
  tab: string;
}

export default function App() {
  const [darkMode, setDarkMode] = useState<boolean>(() => getSavedThemePreference());
  const [user, setUser] = useState<UserAccount | null>(null);
  const [demoAccounts, setDemoAccounts] = useState<UserAccount[]>([]);
  const [hasProdRep, setHasProdRep] = useState<boolean>(false);
  const [requiresSetupPasscode, setRequiresSetupPasscode] = useState<boolean>(false);
  const [authTab, setAuthTab] = useState<'login' | 'demo' | 'setup'>('demo');
  const [activeTab, setActiveTab] = useState<string>('dashboard');
  const [loading, setLoading] = useState<boolean>(true);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);

  // Login form state
  const [loginIdentifier, setLoginIdentifier] = useState('rep@demo.dbl.local');
  const [loginPassword, setLoginPassword] = useState('Demo@2026');

  // Production First-Run Setup form state
  const [setupUniId, setSetupUniId] = useState('');
  const [setupName, setSetupName] = useState('');
  const [setupEmail, setSetupEmail] = useState('');
  const [setupPassword, setSetupPassword] = useState('');
  const [setupGroup, setSetupGroup] = useState('A');
  const [setupCode, setSetupCode] = useState('');

  // App Data
  const [courses, setCourses] = useState<Course[]>([]);
  const [lectures, setLectures] = useState<Lecture[]>([]);
  const [conflicts, setConflicts] = useState<ScheduleConflict[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [requests, setRequests] = useState<CohortRequest[]>([]);
  const [tasks, setTasks] = useState<CohortTask[]>([]);
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [members, setMembers] = useState<UserAccount[]>([]);

  // Global search & notification center & profile modal
  const [selectedResult, setSelectedResult] = useState<SearchResultItem | null>(null);
  const [searchError, setSearchError] = useState(false);
  const [globalQuery, setGlobalQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResultItem[]>([]);
  const [showNotifPanel, setShowNotifPanel] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showMobileAppsModal, setShowMobileAppsModal] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [profileEmail, setProfileEmail] = useState('');
  const [profileCurrentPass, setProfileCurrentPass] = useState('');
  const [loadError, setLoadError] = useState('');
  const [profileNewPass, setProfileNewPass] = useState('');

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    saveThemePreference(darkMode);
  }, [darkMode]);

  useEffect(() => {
    const handleNativeBack = (event: Event) => {
      if (showMobileAppsModal) {
        event.preventDefault();
        setShowMobileAppsModal(false);
      } else if (showProfileModal) {
        event.preventDefault();
        setShowProfileModal(false);
      } else if (showNotifPanel) {
        event.preventDefault();
        setShowNotifPanel(false);
      } else if (mobileMenuOpen) {
        event.preventDefault();
        setMobileMenuOpen(false);
      } else if (activeTab !== 'dashboard') {
        event.preventDefault();
        setActiveTab('dashboard');
      }
    };
    window.addEventListener('dbl-native-back', handleNativeBack);
    return () => window.removeEventListener('dbl-native-back', handleNativeBack);
  }, [showMobileAppsModal, showProfileModal, showNotifPanel, mobileMenuOpen, activeTab]);

  const notify = useCallback((msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => {
      setToast((prev) => (prev?.msg === msg ? null : prev));
    }, 4500);
  }, []);

  const loadAllCohortData = useCallback(async () => {
    const token = getAuthToken();
    try {
      const [
        coursesData,
        lecturesData,
        assignmentsData,
        announcementsData,
        requestsData,
        tasksData,
        filesData,
        usersData,
      ] = await Promise.all([
        apiFetch<Course[]>('/api/courses'),
        apiFetch<{ lectures: Lecture[]; conflicts: ScheduleConflict[] }>('/api/lectures'),
        apiFetch<Assignment[]>('/api/assignments'),
        apiFetch<Announcement[]>('/api/announcements'),
        apiFetch<CohortRequest[]>('/api/requests'),
        apiFetch<CohortTask[]>('/api/tasks'),
        apiFetch<LibraryFile[]>('/api/files'),
        apiFetch<UserAccount[]>('/api/users'),
      ]);

      if (token !== getAuthToken()) return;
      setCourses(coursesData);
      setLectures(lecturesData.lectures);
      setConflicts(lecturesData.conflicts);
      setAssignments(assignmentsData);
      setAnnouncements(announcementsData);
      setRequests(requestsData);
      setTasks(tasksData);
      setFiles(filesData);
      setMembers(usersData);
    } catch (err: unknown) {
      if (token !== getAuthToken()) return;
      notify(err instanceof Error ? err.message : 'تعذر تحميل بيانات الدفعة', 'error');
    }
  }, [notify]);

  const switchSession = useCallback((token: string, nextUser: UserAccount | null) => {
    setAuthToken(token);
    void persistAuthToken(token);
    setCourses([]);
    setLectures([]);
    setConflicts([]);
    setAssignments([]);
    setAnnouncements([]);
    setRequests([]);
    setTasks([]);
    setFiles([]);
    setMembers([]);
    setSearchResults([]);
    setSelectedResult(null);
    setGlobalQuery('');
    setActiveTab('dashboard');
    setProfileCurrentPass('');
    setProfileNewPass('');
    setUser(nextUser);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        type AuthStatusResponse = {
          user: UserAccount | null;
          hasProductionRepresentative: boolean;
          requiresSetupPasscode: boolean;
          demoEnabled?: boolean;
          demoAccounts: UserAccount[];
        };
        const { status, offline } = await restoreAndValidateSession(() => apiFetch<AuthStatusResponse>('/api/auth/status'));
        if (offline || !status) return;
        const availableDemos = status.demoAccounts || [];
        setDemoAccounts(availableDemos);
        setHasProdRep(status.hasProductionRepresentative);
        setRequiresSetupPasscode(status.requiresSetupPasscode);

        if (availableDemos.length === 0) {
          setAuthTab(!status.hasProductionRepresentative && status.requiresSetupPasscode ? 'setup' : 'login');
          setLoginIdentifier('');
          setLoginPassword('');
        }

        // Support ?autostart=1 in demo-enabled environments
        const params = new URLSearchParams(window.location.search);
        if (status.user) {
          setUser(status.user);
          await loadAllCohortData();
        } else if (params.get('autostart') === '1' && availableDemos.length > 0) {
          const repDemo = availableDemos[0];
          const loginRes = await apiFetch<{ token: string; user: UserAccount }>(
            '/api/auth/demo-login',
            {
              method: 'POST',
              body: JSON.stringify({ userId: repDemo.id }),
            }
          );
          switchSession(loginRes.token, loginRes.user);
          await loadAllCohortData();
        }
      } catch {
        setAuthTab('login');
        setLoadError('تعذر التحقق من اتصال الخادم.');
      } finally {
        setLoading(false);
      }
    })();
  }, [loadAllCohortData, switchSession]);

  useEffect(() => {
    if (!user || !globalQuery.trim()) {
      setSearchResults([]);
      return;
    }
    setSearchError(false);
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const res = await apiFetch<{ results: SearchResultItem[] }>(
          `/api/search?q=${encodeURIComponent(globalQuery.trim())}`
        );
        if (active) setSearchResults(res.results);
      } catch {
        if (active) { setSearchResults([]); setSearchError(true); }
      }
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [globalQuery, user]);

  useEffect(() => {
    if (selectedResult && activeTab === selectedResult.tab) {
      const hit = document.getElementById('result-' + selectedResult.id);
      hit?.scrollIntoView({ block: 'center' });
      hit?.focus({ preventScroll: true });
    }
  }, [activeTab, selectedResult]);

  const openSearchResult = (item: SearchResultItem) => {
    setActiveTab(item.tab);
    setSelectedResult(item);
    setGlobalQuery('');
    setMobileMenuOpen(false);
  };

  const handleStandardLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await apiFetch<{ token: string; user: UserAccount }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          identifier: loginIdentifier,
          password: loginPassword,
        }),
      });
      switchSession(res.token, res.user);
      setActiveTab('dashboard');
      if (!res.user.mustChangePassword) await loadAllCohortData();
      notify(`مرحباً بك، ${res.user.fullName}`);
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : 'تعذر تسجيل الدخول', 'error');
    }
  };

  const handleQuickDemoSwitch = async (targetUserId: string) => {
    try {
      const res = await apiFetch<{ token: string; user: UserAccount }>('/api/auth/demo-login', {
        method: 'POST',
        body: JSON.stringify({ userId: targetUserId }),
      });
      switchSession(res.token, res.user);
      if (!res.user.mustChangePassword) await loadAllCohortData();
      notify(`تم التبديل إلى جلسة: ${res.user.fullName} (${ROLE_LABELS_AR[res.user.role]})`);
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : 'تعذر تبديل الحساب التجريبي', 'error');
    }
  };

  const handleProductionRepSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await apiFetch<{ token: string; user: UserAccount }>(
        '/api/auth/setup-production-rep',
        {
          method: 'POST',
          body: JSON.stringify({
            universityId: setupUniId,
            fullName: setupName,
            email: setupEmail,
            password: setupPassword,
            groupName: setupGroup,
            setupCode,
          }),
        }
      );
      switchSession(res.token, res.user);
      setHasProdRep(true);
      if (!res.user.mustChangePassword) await loadAllCohortData();
      notify('تم إعداد حساب مندوب الدفعة الفعلي بنجاح');
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : 'تعذر إعداد الحساب', 'error');
    }
  };

  const handleLogout = async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore
    } finally {
      await persistAuthToken('');
    switchSession('', null);
    }
  };

  const handleLogoutAllSessions = async () => {
    try {
      await apiFetch('/api/auth/logout-all', { method: 'POST' });
      notify('تم إنهاء جميع الجلسات النشطة لحسابك على كافة الأجهزة');
    } catch {
      // ignore
    } finally {
      await persistAuthToken('');
    setShowProfileModal(false);
    switchSession('', null);
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await apiFetch<{ user: UserAccount }>('/api/auth/profile', {
        method: 'PUT',
        body: JSON.stringify({
          fullName: user?.mustChangePassword ? user.fullName : profileName,
          email: user?.mustChangePassword ? user.email : profileEmail,
          currentPassword: profileCurrentPass || undefined,
          newPassword: profileNewPass || undefined,
        }),
      });
      setUser(res.user);
      setProfileNewPass('');
      setProfileCurrentPass('');
      setShowProfileModal(false);
      notify('تم تحديث معلومات حسابك الشخصية بنجاح');
      await loadAllCohortData();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : 'تعذر تحديث الحساب', 'error');
    }
  };

  const unreadAnnouncements = announcements.filter((a) => !a.isRead);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 text-slate-700 dark:text-slate-300">
        <div className="text-center space-y-2">
          <GraduationCap className="w-10 h-10 text-teal-600 mx-auto animate-bounce" />
          <p className="text-sm font-bold">جاري تحميل منصة DBL Campus...</p>
        </div>
      </div>
    );
  }

  if (user?.mustChangePassword) {
    return <main className="max-w-md mx-auto p-6">
      <h1 className="text-xl font-bold">تغيير كلمة المرور الأولية</h1>
      <form onSubmit={handleSaveProfile} className="grid gap-3 mt-4">
        <label>الرمز الأولي<input type="password" autoComplete="current-password" required value={profileCurrentPass}
          onChange={event => setProfileCurrentPass(event.target.value)} className="block border rounded px-2 py-1" /></label>
        <label>كلمة مرور جديدة<input type="password" autoComplete="new-password" required minLength={8} value={profileNewPass}
          onChange={event => setProfileNewPass(event.target.value)} className="block border rounded px-2 py-1" /></label>
        <button type="submit">حفظ كلمة المرور</button>
      </form>
      <button type="button" onClick={handleLogout} className="mt-4">تسجيل الخروج</button>
      {toast && <p role="status">{toast.msg}</p>}
    </main>;
  }

  // ==========================================
  // LOGIN & DEMO / FIRST-RUN SETUP SCREEN
  // ==========================================
    const hidePwaInstallUi = shouldHidePwaInstallUi(isNativeCapacitorApp());
  if (!user) {
    return (
      <div className="min-h-screen flex flex-col justify-between bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
        <OfflineIndicator />
        {toast && (
          <div
            role="status"
            className={`fixed top-4 left-4 z-50 px-4 py-3 rounded-xl shadow-lg text-xs font-bold text-white ${
              toast.type === 'error' ? 'bg-rose-600' : 'bg-teal-600'
            }`}
          >
            {toast.msg}
          </div>
        )}

        <header className="safe-top flex items-center justify-between gap-2 sm:gap-6 px-3 sm:px-6 py-3 sm:py-4 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
          <div className="flex items-center gap-2 whitespace-nowrap shrink-0">
            <GraduationCap className="w-6 h-6 text-teal-600 shrink-0" />
            <span className="text-base sm:text-lg font-bold tracking-tight">DBL Campus</span>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <button
              type="button"
              onClick={() => setShowMobileAppsModal(true)}
              className="inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg border border-teal-600/40 dark:border-teal-500/40 bg-teal-50 dark:bg-teal-950/40 text-teal-800 dark:text-teal-300 text-xs font-bold hover:bg-teal-100 dark:hover:bg-teal-900/50 transition-colors whitespace-nowrap shrink-0"
            >
              <Smartphone className="w-3.5 h-3.5 shrink-0" />
              <span className="hidden sm:inline">تطبيق الهاتف (APK / IPA)</span>
              <span className="sm:hidden">تطبيق الهاتف</span>
            </button>
            <div className="hidden sm:block">
              {!hidePwaInstallUi && <PWAInstallButton />}
            </div>
            <button
              type="button"
              onClick={() => setDarkMode(!darkMode)}
              aria-label="تبديل الوضع الليلي والنهاري"
              className="p-2 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
            >
              {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
        </header>

        <main className="max-w-5xl w-full mx-auto px-4 py-6 sm:py-10 grid grid-cols-1 lg:grid-cols-12 gap-6 sm:gap-8 items-start">
          {/* Right Introductory Column */}
          <div className="order-2 lg:order-1 lg:col-span-6 space-y-5">
            <p className="text-xs font-bold text-teal-700 dark:text-teal-400">
              منصة إدارة الدفعات الجامعية المركزية عبر الإنترنت (HTTPS Multi-User Platform)
            </p>
            <h1 className="text-3xl font-bold text-slate-900 dark:text-white leading-tight">
              إدارة منظمة للدفعة الجامعية من أي مكان.
            </h1>
            <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
              تتيح منصة <strong>DBL Campus</strong> لمندوب الدفعة ونائبه والمنسقين والطلاب الوصول المركزي الآمن عبر الإنترنت (HTTPS) من الهواتف والحواسيب إلى الجدول الدراسي، التكاليف، الطلبات الجماعية وكشوف التأييد الرسمية (A4)، ومكتبة المحاضرات وفق صلاحيات دقيقة.
            </p>

            <div className="space-y-3 pt-2 text-xs text-slate-700 dark:text-slate-300">
              <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
                <strong className="text-slate-900 dark:text-white block mb-1">
                  1. نظام طلبات وتأييد طلابي نزيه وموثق
                </strong>
                <span>
                  تصويت واحد لكل طالب، سحب التأييد قبل الإغلاق، منع تغيير النص جوهرياً دون إعادة تأكيد، وتصدير كشوف A4 تميز بين التأييد الإلكتروني والتوقيع اليدوي.
                </span>
              </div>
              <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
                <strong className="text-slate-900 dark:text-white block mb-1">
                  2. وصول سحابي آمن وتثبيت كتطبيق PWA
                </strong>
                <span>
                  تعمل المنصة عبر HTTPS مع حماية الجلسات وفحص الملفات المرفوعة، وتدعم التثبيت المباشر على هواتف Android و iOS والوصول من أي شبكة.
                </span>
              </div>
            </div>
          </div>

          {/* Left Authentication & Demo Switcher Card */}
          <div className="order-1 lg:order-2 lg:col-span-6 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 sm:p-6 shadow-sm">
            <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg mb-5">
              {demoAccounts.length > 0 && (
                <button
                  type="button"
                  onClick={() => setAuthTab('demo')}
                  className={`flex-1 py-2 text-xs font-bold rounded-md transition-colors ${
                    authTab === 'demo'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  بيئة التجربة السريعة
                </button>
              )}
              <button
                type="button"
                onClick={() => setAuthTab('login')}
                className={`flex-1 py-2 text-xs font-bold rounded-md transition-colors ${
                  authTab === 'login'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                تسجيل الدخول
              </button>
              {!hasProdRep && requiresSetupPasscode && demoAccounts.length === 0 && (
                <button
                  type="button"
                  onClick={() => setAuthTab('setup')}
                  className={`flex-1 py-2 text-xs font-bold rounded-md transition-colors ${
                    authTab === 'setup'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  إعداد المندوب الفعلي
                </button>
              )}
            </div>

            {loadError && <button type="button" onClick={() => window.location.reload()}>{loadError} إعادة المحاولة</button>}
            {authTab === 'demo' && demoAccounts.length > 0 && (
              <div className="space-y-3">
                <p className="text-xs text-slate-600 dark:text-slate-400">
                  اختر أي حساب من الحسابات التجريبية الجاهزة لاختبار الصلاحيات والأدوار المختلفة فوراً (كلمة المرور الموحدة لبيئة التجربة فقط: <code className="font-mono">Demo@2026</code>):
                </p>
                <div className="space-y-2">
                  {demoAccounts.map((acc) => (
                    <button
                      key={acc.id}
                      type="button"
                      onClick={() => handleQuickDemoSwitch(acc.id)}
                      className="w-full text-right p-3 rounded-xl border border-slate-200 dark:border-slate-800 hover:border-teal-500 dark:hover:border-teal-500 hover:bg-teal-50/30 dark:hover:bg-teal-950/20 transition-all flex items-center justify-between gap-3"
                    >
                      <div>
                        <div className="text-xs font-bold text-slate-900 dark:text-slate-100">
                          {acc.fullName}
                        </div>
                        <div className="text-[11px] text-slate-500 font-mono mt-0.5">
                          {acc.universityId} · {acc.email} · مجموعة {acc.groupName}
                        </div>
                      </div>
                      <span className="text-xs font-bold text-teal-700 dark:text-teal-400 shrink-0">
                        دخول كـ {ROLE_LABELS_AR[acc.role]} ←
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {authTab === 'login' && (
              <form onSubmit={handleStandardLogin} className="space-y-4 text-xs">
                <div>
                  <label className="block font-semibold mb-1.5">
                    الرقم الجامعي أو البريد الإلكتروني
                  </label>
                  <input
                    type="text"
                    value={loginIdentifier}
                    onChange={(e) => setLoginIdentifier(e.target.value)}
                    autoComplete="username"
                    required
                    placeholder={demoAccounts.length > 0 ? '20251001 أو rep@demo.dbl.local' : 'الرقم الجامعي أو البريد الإلكتروني'}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3.5 py-2.5 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1.5">كلمة المرور</label>
                  <input
                    type="password"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3.5 py-2.5 font-mono"
                  />
                </div>
                <button
                  type="submit"
                  className="w-full py-2.5 rounded-lg bg-teal-600 text-white font-bold hover:bg-teal-700 transition-colors"
                >
                  تسجيل الدخول إلى المنصة
                </button>
              </form>
            )}

            {authTab === 'setup' && !hasProdRep && (
              <form onSubmit={handleProductionRepSetup} className="space-y-3 text-xs">
                <p className="text-slate-600 dark:text-slate-400">
                  إعداد أولي آمن لحساب مندوب الدفعة الفعلي (يُقفل تلقائياً فور إنشاء الحساب):
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-semibold mb-1">الرقم الجامعي</label>
                    <input
                      type="text"
                      value={setupUniId}
                      onChange={(e) => setSetupUniId(e.target.value)}
                      required
                      className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2 font-mono"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold mb-1">المجموعة</label>
                    <select
                      value={setupGroup}
                      onChange={(e) => setSetupGroup(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2"
                    >
                      <option value="A">المجموعة A</option>
                      <option value="B">المجموعة B</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block font-semibold mb-1">الاسم الكامل لمندوب الدفعة</label>
                  <input
                    type="text"
                    value={setupName}
                    onChange={(e) => setSetupName(e.target.value)}
                    required
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">البريد الإلكتروني</label>
                  <input
                    type="email"
                    value={setupEmail}
                    onChange={(e) => setSetupEmail(e.target.value)}
                    required
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">كلمة المرور الخاصة (8 أحرف فأكثر)</label>
                  <input
                    type="password"
                    value={setupPassword}
                    onChange={(e) => setSetupPassword(e.target.value)}
                    minLength={8}
                    required
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2 font-mono"
                  />
                </div>
                {requiresSetupPasscode && (
                  <div>
                    <label className="block font-semibold mb-1">رمز الإعداد الأولي (DBL_ADMIN_SETUP_CODE)</label>
                    <input
                      type="password"
                      value={setupCode}
                      onChange={(e) => setSetupCode(e.target.value)}
                      required
                      className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2 font-mono"
                    />
                  </div>
                )}
                <button
                  type="submit"
                  className="w-full py-2.5 rounded-lg bg-slate-900 dark:bg-teal-600 text-white font-bold"
                >
                  اعتماد حساب مندوب الدفعة الفعلي
                </button>
              </form>
            )}
          </div>
        </main>

        <footer className="px-6 py-4 border-t border-slate-200 dark:border-slate-800 text-xs text-slate-500 flex flex-wrap items-center justify-between gap-2">
          <span>DBL Campus — Student Cohort Management Platform</span>
          <span>جاهز للاستضافة المركزية عبر الإنترنت (HTTPS) وتثبيت الهواتف (PWA / APK / IPA)</span>
        </footer>

        {showMobileAppsModal && (
          <MobileAppsModal
            user={null}
            onClose={() => setShowMobileAppsModal(false)}
            notify={notify}
          />
        )}
      </div>
    );
  }

  // ==========================================
  // AUTHENTICATED WORKSPACE SHELL
  // ==========================================
  const canSeeStudentsTab =
    hasPermission(user, 'students') || hasPermission(user, 'permissions');
  const canSeeAdminTab =
    user.role === 'representative' ||
    hasPermission(user, 'backup') ||
    hasPermission(user, 'permissions');

  const navItems = [
    { id: 'dashboard', label: 'لوحة التحكم', icon: LayoutDashboard },
    { id: 'schedule', label: 'الجدول والمواد', icon: Calendar },
    { id: 'assignments', label: 'التكاليف الدراسية', icon: BookOpen },
    {
      id: 'announcements',
      label: 'الإعلانات',
      icon: Bell,
      badge: unreadAnnouncements.length,
    },
    { id: 'requests', label: 'الطلبات والتأييد', icon: MessageSquarePlus },
    { id: 'tasks', label: 'المهام والمسؤوليات', icon: CheckSquare },
    { id: 'library', label: 'مكتبة المحاضرات', icon: FolderOpen },
    ...(canSeeStudentsTab
      ? [{ id: 'students', label: 'الطلاب والصلاحيات', icon: Users }]
      : []),
    ...(canSeeAdminTab
      ? [{ id: 'admin', label: 'النسخ الاحتياطي والسجل', icon: Database }]
      : []),
  ];

  const staffMembers = members.filter((m) => m.role !== 'student');

  return (
    <div className="min-h-screen flex flex-col lg:flex-row bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <OfflineIndicator />

      {toast && (
        <div
          role="status"
          className={`fixed top-4 left-4 z-50 px-4 py-3 rounded-xl shadow-lg text-xs font-bold text-white ${
            toast.type === 'error' ? 'bg-rose-600' : 'bg-teal-600'
          }`}
        >
          {toast.msg}
        </div>
      )}

      {/* Desktop Right Sidebar (RTL) */}
      <aside className="no-print hidden lg:flex lg:flex-col lg:w-64 shrink-0 border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 justify-between">
        <div>
          <div className="px-6 py-5 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2.5">
            <GraduationCap className="w-6 h-6 text-teal-600 shrink-0" />
            <span className="text-lg font-bold tracking-tight whitespace-nowrap">
              DBL Campus
            </span>
          </div>

          <nav className="p-3 space-y-1" aria-label="القائمة الرئيسية">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-colors whitespace-nowrap ${
                    isActive
                      ? 'bg-slate-900 dark:bg-teal-600 text-white'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </div>
                  {item.badge ? (
                    <span className="font-mono tabular-nums text-[11px] font-bold px-1.5 py-0.5 rounded bg-amber-500 text-white">
                      {item.badge}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Role Quick-Switcher in Demo Mode + User Profile Footer */}
        <div className="p-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
          {demoAccounts.length > 0 && (
            <div className="p-2.5 rounded-xl bg-slate-100 dark:bg-slate-800/80 space-y-1.5">
              <label className="block text-[11px] font-bold text-slate-600 dark:text-slate-300">
                تبديل الدور التجريبي السريع:
              </label>
              <select
                value={user.id}
                onChange={(e) => handleQuickDemoSwitch(e.target.value)}
                aria-label="تبديل الدور التجريبي"
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-xs font-semibold"
              >
                {demoAccounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {ROLE_LABELS_AR[acc.role]}: {acc.fullName.split(' (')[0]}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => {
                setProfileName(user.fullName);
                setProfileEmail(user.email);
                setProfileNewPass('');
                setShowProfileModal(true);
              }}
              className="text-right flex-1 min-w-0 hover:opacity-80"
            >
              <div className="text-xs font-bold text-slate-900 dark:text-slate-100 truncate">
                {user.fullName.replace(' - تجريبي)', ')')}
              </div>
              <div className="text-[11px] text-slate-500 truncate">
                {ROLE_LABELS_AR[user.role]} · مجموعة {user.groupName}
              </div>
            </button>

            <button
              type="button"
              onClick={handleLogout}
              aria-label="تسجيل الخروج"
              title="تسجيل الخروج"
              className="p-2 rounded-lg text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 pb-16 lg:pb-0">
        {/* Top Header */}
        <header className="no-print safe-top sticky top-0 z-30 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-b border-slate-200 dark:border-slate-800 px-3 sm:px-4 lg:px-8 py-2.5 flex items-center justify-between gap-2 sm:gap-4">
          {/* Mobile Brand + Menu Toggle + Active Breadcrumb */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="فتح القائمة الجانبية"
              className="lg:hidden p-2 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <Menu className="w-4 h-4" />
            </button>
            <div className="flex lg:hidden items-center gap-1.5">
              <GraduationCap className="w-5 h-5 text-teal-600" />
              <span className="font-bold text-sm whitespace-nowrap">DBL Campus</span>
            </div>
            <span className="hidden lg:inline text-xs font-semibold text-slate-500">
              دفعة تقنية المعلومات ·{' '}
              <strong className="text-slate-900 dark:text-slate-100">
                {navItems.find((i) => i.id === activeTab)?.label}
              </strong>
            </span>
          </div>

          {/* Global Permission-Aware Search Input (hidden on very narrow mobile, full on sm+) */}
          <div className="hidden sm:block relative flex-1 max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute right-3 top-2.5" />
            <input
              type="search"
              value={globalQuery}
              onChange={(e) => setGlobalQuery(e.target.value)}
              placeholder="بحث شامل في المقررات، التكاليف، الطلبات، والملفات..."
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 pr-9 pl-3 py-1.5 text-xs"
            />
            {globalQuery.trim().length > 0 && (
              <div className="absolute left-0 right-0 mt-1.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl z-50 max-h-80 overflow-y-auto p-2">
                {searchResults.length === 0 ? (
                  <p className="p-3 text-center text-xs text-slate-500">
                    {searchError ? 'تعذر البحث' : 'لا توجد نتائج مطابقة'} ضمن صلاحيات حسابك.
                  </p>
                ) : (
                  searchResults.map((item) => (
                    <button
                      key={`${item.type}-${item.id}`}
                      type="button"
                      onClick={() => openSearchResult(item)}
                      className="w-full text-right p-2.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-between gap-2"
                    >
                      <div>
                        <div className="text-xs font-bold text-slate-900 dark:text-slate-100">
                          {item.title}
                        </div>
                        <div className="text-[11px] text-slate-500">{item.subtitle}</div>
                      </div>
                      <span className="text-[11px] text-teal-600 font-semibold shrink-0">
                        انتقال ←
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Actions Zone */}
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setShowMobileAppsModal(true)}
              aria-label="تنزيل تطبيق الهاتف APK و IPA"
              className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-teal-600/40 dark:border-teal-500/40 bg-teal-50 dark:bg-teal-950/40 text-teal-800 dark:text-teal-300 text-xs font-bold hover:bg-teal-100 dark:hover:bg-teal-900/50 transition-colors whitespace-nowrap shrink-0"
            >
              <Smartphone className="w-3.5 h-3.5 shrink-0" />
              <span>APK / IPA</span>
            </button>
            <div className="hidden md:block">
              {!hidePwaInstallUi && <PWAInstallButton />}
            </div>

            {/* Notification Center Button */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowNotifPanel(!showNotifPanel)}
                aria-label="مركز الإشعارات"
                className="relative p-2 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <Bell className="w-4 h-4" />
                {unreadAnnouncements.length > 0 && (
                  <span className="absolute -top-1 -left-1 px-1.5 py-0.2 rounded-full bg-amber-600 text-white text-[10px] font-mono font-bold">
                    {unreadAnnouncements.length}
                  </span>
                )}
              </button>

              {showNotifPanel && (
                <div className="absolute left-0 mt-2 w-80 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl p-3 z-50">
                  <div className="flex items-center justify-between pb-2 border-b border-slate-200 dark:border-slate-800">
                    <span className="text-xs font-bold">مركز الإشعارات والتنبيهات</span>
                    <button
                      type="button"
                      onClick={() => setShowNotifPanel(false)}
                      aria-label="إغلاق الإشعارات"
                    >
                      <X className="w-3.5 h-3.5 text-slate-400" />
                    </button>
                  </div>
                  <div className="mt-2 space-y-2 max-h-64 overflow-y-auto">
                    {unreadAnnouncements.length === 0 ? (
                      <p className="text-xs text-slate-500 text-center py-4">
                        جميع الإعلانات مقروءة، لا توجد تنبيهات جديدة.
                      </p>
                    ) : (
                      unreadAnnouncements.map((ann) => (
                        <button
                          key={ann.id}
                          type="button"
                          onClick={async () => {
                            await apiFetch(`/api/announcements/${ann.id}/read`, {
                              method: 'POST',
                            });
                            setShowNotifPanel(false);
                            setActiveTab('announcements');
                            await loadAllCohortData();
                          }}
                          className="w-full text-right p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800 hover:bg-teal-50 dark:hover:bg-teal-950/30 block"
                        >
                          <div className="text-xs font-bold text-slate-900 dark:text-slate-100">
                            {ann.title}
                          </div>
                          <div className="text-[11px] text-slate-500 mt-0.5 line-clamp-1">
                            {ann.content}
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => setDarkMode(!darkMode)}
              aria-label="تبديل الوضع الداكن والفاتح"
              className="p-2 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>

            <button
              type="button"
              onClick={() => {
                setProfileName(user.fullName);
                setProfileEmail(user.email);
                setProfileNewPass('');
                setShowProfileModal(true);
              }}
              aria-label="إدارة الحساب الشخصي"
              className="p-2 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <User className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Active View Container */}
        <main className="flex-1 max-w-6xl w-full mx-auto px-4 lg:px-8 py-6">
          {activeTab === 'dashboard' && (
            <DashboardView
              user={user}
              lectures={lectures}
              assignments={assignments}
              announcements={announcements}
              requests={requests}
              tasks={tasks}
              files={files}
              onNavigate={setActiveTab}
              onQuickEndorse={async (reqId) => {
                try {
                  await apiFetch(`/api/requests/${reqId}/endorse`, { method: 'POST' });
                  notify('تم تسجيل تأييدك للطلب بنجاح');
                  await loadAllCohortData();
                } catch (err: unknown) {
                  notify(err instanceof Error ? err.message : 'تعذر التأييد', 'error');
                }
              }}
            />
          )}

          {activeTab === 'schedule' && (
            <ScheduleView
              key={selectedResult?.id}
              user={user}
              courses={courses}
              lectures={lectures}
              conflicts={conflicts}
              onRefresh={loadAllCohortData}
              notify={notify}
            />
          )}

          {activeTab === 'assignments' && (
            <AssignmentsView
              key={selectedResult?.id}
              user={user}
              courses={courses}
              assignments={assignments}
              files={files}
              onRefresh={loadAllCohortData}
              notify={notify}
            />
          )}

          {activeTab === 'announcements' && (
            <AnnouncementsView
              key={selectedResult?.id}
              user={user}
              announcements={announcements}
              onRefresh={loadAllCohortData}
              notify={notify}
            />
          )}

          {activeTab === 'requests' && (
            <RequestsView
              key={selectedResult?.id}
              user={user}
              requests={requests}
              onRefresh={loadAllCohortData}
              notify={notify}
            />
          )}

          {activeTab === 'tasks' && (
            <TasksView
              user={user}
              tasks={tasks}
              staffMembers={staffMembers.length > 0 ? staffMembers : [user]}
              onRefresh={loadAllCohortData}
              notify={notify}
            />
          )}

          {activeTab === 'library' && (
            <LibraryView
              user={user}
              courses={courses}
              files={files}
              onRefresh={loadAllCohortData}
              notify={notify}
            />
          )}

          {activeTab === 'students' && (
            <AdminAndStudentsView
              user={user}
              members={members}
              mode="students"
              onRefresh={loadAllCohortData}
              notify={notify}
            />
          )}

          {activeTab === 'admin' && (
            <AdminAndStudentsView
              user={user}
              members={members}
              mode="admin"
              onRefresh={loadAllCohortData}
              notify={notify}
            />
          )}
        </main>
      </div>

      {/* Mobile Slide-Over Navigation Drawer */}
      {mobileMenuOpen && (
        <div
          className="no-print lg:hidden fixed inset-0 z-50 flex justify-start bg-slate-950/60"
          role="dialog"
          aria-modal="true"
          aria-label="القائمة الجانبية للهاتف"
        >
          <div className="w-72 max-w-[85vw] bg-white dark:bg-slate-900 h-full flex flex-col justify-between p-4 shadow-2xl overflow-y-auto">
            <div className="space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800">
                <div className="flex items-center gap-2">
                  <GraduationCap className="w-5 h-5 text-teal-600" />
                  <span className="font-bold text-base">DBL Campus</span>
                </div>
                <button
                  type="button"
                  onClick={() => setMobileMenuOpen(false)}
                  aria-label="إغلاق القائمة الجانبية"
                  className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute right-3 top-2.5" />
                <input
                  type="search"
                  value={globalQuery}
                  onChange={(e) => setGlobalQuery(e.target.value)}
                  placeholder="بحث شامل..."
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 pr-9 pl-3 py-2 text-xs"
                />
              </div>

              {globalQuery.trim() && <div className="space-y-1">
                {searchError && <p role="status">تعذر البحث</p>}
                {searchResults.map(item => <button key={item.id} type="button" onClick={() => openSearchResult(item)}
                  className="block w-full text-start rounded border px-2 py-1 text-xs">{item.title}</button>)}
              </div>}

              <nav className="space-y-1">
                {navItems.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setActiveTab(item.id);
                        setMobileMenuOpen(false);
                      }}
                      className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold ${
                        isActive
                          ? 'bg-slate-900 dark:bg-teal-600 text-white'
                          : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <Icon className="w-4 h-4" />
                        <span>{item.label}</span>
                      </div>
                      {item.badge ? (
                        <span className="font-mono text-[11px] font-bold px-1.5 py-0.5 rounded bg-amber-500 text-white">
                          {item.badge}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </nav>
            </div>

            <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-2.5">
              <button
                type="button"
                onClick={() => {
                  setMobileMenuOpen(false);
                  setShowMobileAppsModal(true);
                }}
                className="w-full inline-flex items-center justify-center gap-2 py-2 px-3 rounded-lg border border-teal-600/40 bg-teal-50 dark:bg-teal-950/40 text-teal-800 dark:text-teal-300 text-xs font-bold"
              >
                <Smartphone className="w-4 h-4 shrink-0" />
                <span>تطبيق الهاتف (APK / IPA)</span>
              </button>
              {!hidePwaInstallUi && <PWAInstallButton />}
              <button
                type="button"
                onClick={handleLogout}
                className="w-full py-2 rounded-lg text-xs font-semibold text-rose-600 border border-rose-200 dark:border-rose-900/50 hover:bg-rose-50 dark:hover:bg-rose-950/30"
              >
                تسجيل الخروج
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mobile Bottom Navigation Bar (<= 15% height cap) */}
      <nav
        aria-label="تنقل الهاتف"
        className="no-print safe-bottom lg:hidden fixed bottom-0 inset-x-0 z-40 min-h-14 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 flex items-center justify-around px-1"
      >
        {navItems.slice(0, 5).map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              className={`flex flex-col items-center justify-center py-1 px-2 rounded-lg text-[10px] font-semibold ${
                isActive
                  ? 'text-teal-600 dark:text-teal-400'
                  : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              <Icon className="w-4 h-4 mb-0.5" />
              <span className="truncate max-w-[60px]">{item.label.split(' ')[0]}</span>
            </button>
          );
        })}
      </nav>

      {/* Personal Profile Modal */}
      {showProfileModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="profile-modal-title"
        >
          <div className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-xl">
            <h3 id="profile-modal-title" className="text-lg font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <UserCheck className="w-5 h-5 text-teal-600" />
              <span>إدارة معلومات حسابي الشخصي</span>
            </h3>
            <form onSubmit={handleSaveProfile} className="mt-4 space-y-3 text-xs">
              <div>
                <label className="block font-semibold mb-1">الرقم الجامعي (ثابت)</label>
                <input
                  type="text"
                  value={user.universityId}
                  disabled
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800/50 px-3 py-2 font-mono text-slate-500"
                />
              </div>
              <div>
                <label className="block font-semibold mb-1">الاسم الكامل</label>
                <input
                  type="text"
                  value={profileName}
                  onChange={(e) => setProfileName(e.target.value)}
                  required
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                />
              </div>
              <div>
                <label className="block font-semibold mb-1">البريد الإلكتروني</label>
                <input
                  type="email"
                  value={profileEmail}
                  onChange={(e) => setProfileEmail(e.target.value)}
                  required
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 font-mono"
                />
              </div>
              <label className="block">
                كلمة المرور الحالية عند تغيير البريد أو كلمة المرور
                <input type="password" autoComplete="current-password" value={profileCurrentPass}
                  onChange={event => setProfileCurrentPass(event.target.value)}
                  className="block w-full rounded-lg border px-3 py-2" />
              </label>
              <div>
                <label className="block font-semibold mb-1">
                  كلمة مرور جديدة (اتركها فارغة للإبقاء على الحالية)
                </label>
                <input
                  type="password"
                  value={profileNewPass}
                  onChange={(e) => setProfileNewPass(e.target.value)}
                  placeholder="8 أحرف على الأقل..."
                  minLength={8}
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 font-mono"
                />
              </div>

              {demoAccounts.length > 0 && (
                <div className="pt-2 border-t border-slate-200 dark:border-slate-800">
                  <label className="block font-semibold mb-1">
                    تبديل الجلسة التجريبية (لاختبار الهاتف والحاسوب):
                  </label>
                  <select
                    value={user.id}
                    onChange={(e) => {
                      setShowProfileModal(false);
                      handleQuickDemoSwitch(e.target.value);
                    }}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2 font-semibold"
                  >
                    {demoAccounts.map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {ROLE_LABELS_AR[acc.role]}: {acc.fullName}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="pt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 dark:border-slate-800">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="px-3 py-2 rounded-lg text-rose-600 font-semibold hover:bg-rose-50 dark:hover:bg-rose-950/30"
                  >
                    تسجيل الخروج
                  </button>
                  <button
                    type="button"
                    onClick={handleLogoutAllSessions}
                    className="px-2.5 py-2 rounded-lg text-[11px] text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                    title="إنهاء تسجيل الدخول على جميع الهواتف والمتصفحات الأخرى"
                  >
                    إنهاء كل الجلسات
                  </button>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setShowProfileModal(false)}
                    className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700"
                  >
                    إلغاء
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 rounded-lg bg-teal-600 text-white font-semibold"
                  >
                    حفظ التغييرات
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
      {showMobileAppsModal && (
        <MobileAppsModal
          user={user}
          onClose={() => setShowMobileAppsModal(false)}
          notify={notify}
        />
      )}
    </div>
  );
}
