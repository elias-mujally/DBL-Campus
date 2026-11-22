# المعمارية الهندسية للنظام (System Architecture — DBL Campus)

## 1. القرارات الهندسية والتقنيات المختارة

تم تصميم **DBL Campus** وفق مبدأ **البساطة المعمارية المتينة (Pragmatic Monolith)** لتوفير نظام متعدد المستخدمين حقيقي يعمل محلياً عبر الشبكة المحلية دون تعقيد الخدمات المصغرة (Microservices) أو الاعتماد على سحابة خارجية:

| الطبقة | التقنية المختارة | سبب الاختيار |
| :--- | :--- | :--- |
| **الخادم الخلفي (Backend)** | Node.js + Express (`server.ts`) | خفيف، سريع، يدعم تقديم واجهة SPA وواجهات REST API ورفع/تنزيل الملفات في عملية مركزية واحدة يسهل تشغيلها على Windows. |
| **قاعدة البيانات (Database)** | SQLite (`better-sqlite3`) بوضع `WAL` | قاعدة بيانات علائقية حقيقية تدعم المعاملات الذرية (`ACID Transactions`)، المفاتيح الأجنبية (`Foreign Keys`)، والقراءة المتزامنة العالية لعدة مستخدمين على الشبكة المحلية، مع تخزينها في ملف محلي يسهل نسخه احتياطياً. |
| **الواجهة الأمامية (Frontend)** | React 19 + TypeScript + Tailwind CSS v4 | بناء واجهة عربية RTL متجاوبة (Mobile-first)، سريعة التفاعل، مع دعم الوضع الداكن والفاتح وقوالب طباعة A4 قياسية. |
| **قابلية التثبيت (PWA)** | `vite-plugin-pwa` + Web App Manifest | تتيح للطلاب تثبيت المنصة على شاشات هواتفهم وحواسيبهم مع تخزين الأصول الثابتة محلياً. |

---

## 2. مخطط قاعدة البيانات العلائقية (Database Schema)

تقع قاعدة البيانات افتراضياً في `./data/dbl_campus.sqlite` وتُدار عبر ترحيلات قابلة للإعادة (`runMigrations()` في `src/server/db.ts`):

1. **`users`**: حسابات المستخدمين (`id`, `university_id` فريد، `full_name`, `email` فريد، `password_hash`, `role`, `group_name`, `responsibilities_json`, `is_active`, `is_demo`).
2. **`sessions`**: جلسات المصادقة النشطة (`token`, `user_id`, `created_at`, `expires_at`).
3. **`courses`**: المقررات الدراسية (`id`, `code` فريد، `name_ar`, `name_en`, `instructor`, `credit_hours`, `level`, `semester`).
4. **`lectures`**: المحاضرات الأسبوعية (`id`, `course_id`, `day_of_week`, `start_time`, `end_time`, `location`, `instructor`, `target_group`, `lecture_type`, `status` [`official` | `confirmed_temp` | `proposed` | `cancelled`]).
5. **`assignments` & `assignment_progress`**:
   - جدول `assignments` يحفظ بيانات التكليف وحالته العامة للدفعة (`general_status`) وحالة توثيق المصدر (`confirmation_status`).
   - جدول `assignment_progress` يحفظ حالة التقدم الشخصية لكل طالب (`not_started` | `in_progress` | `completed`) بمعزل تام عن الحالة العامة.
6. **`announcements` & `announcement_reads`**:
   - جدول `announcements` للإعلانات والتعميمات المثبتة والموجهة لمجموعات محددة.
   - جدول `announcement_reads` لتوثيق قراءة كل مستخدم للإعلان.
7. **`requests`, `request_endorsements`, & `request_history`**:
   - جدول `requests` للمعاملات (طلب، شكوى، اقتراح) مع بصمة إصدار النص (`version_hash`).
   - جدول `request_endorsements` بقيود `UNIQUE(request_id, student_id)` لمنع تكرار التأييد.
   - جدول `request_history` لتوثيق جميع انتقالات الحالة والردود الرسمية.
8. **`tasks` & `task_comments`**: نظام تفويض المهام لفريق المندوب والتعليقات التتابعية عليها.
9. **`library_files`**: فهرس الملفات الدراسية المخزنة فعلياً على القرص داخل `./data/uploads/`.
10. **`audit_logs`**: سجل التدقيق الأمني لجميع العمليات الإدارية الحساسة.

---

## 3. منظومة الأمن والصلاحيات (Security Architecture)

- **تخزين كلمات المرور**: التشفير باستخدام خوارزمية `scrypt` المدمجة في `node:crypto` مع ملح عشوائي (`16-byte random salt`) ومقارنة محمية ضد هجمات التوقيت (`crypto.timingSafeEqual`).
- **إدارة الجلسات**: رموز جلسات عشوائية عالية الإنتروبيا (`32-byte hex token`) تُحفظ في جدول `sessions` مع تاريخ صلاحية، وتُمرر عبر ترويسة `Authorization: Bearer` من الذاكرة (`In-Memory Store`) لتجنب مخاطر تخزين الرموز الحساسة في `localStorage`.
- **التحقق الإلزامي في الخادم (Server-Side RBAC)**: كل مسار API يتحقق من هوية المستخدم وصلاحياته الفعلية عبر دالة `hasPermission(user, responsibility)` في الخادم قبل تنفيذ أي عملية.
- **الحماية من SQL Injection و Path Traversal**:
  - جميع استعلامات SQLite تستخدم Prepared Statements (`db.prepare(...)`) حصرياً.
  - مسارات الملفات المرفوعة تُفحص عبر `path.resolve` وشرط الاحتواء الصارم داخل مجلد التخزين (`resolvedPath.startsWith(UPLOADS_DIR + path.sep)`) مع التحقق من امتداد الملف وحجمه وصلاحية مجموعة الطالب قبل التنزيل.
- **تحديد معدل محاولات الدخول (Rate Limiting)**: حماية مسار `/api/auth/login` من هجمات التخمين المتكرر.

---

## 4. كيفية توسيع النظام للوصول من خارج الشبكة المحلية مستقبلاً

يعمل الإصدار الأول على الشبكة المحلية (LAN). ولإتاحة الوصول الآمن عبر الإنترنت مستقبلاً دون تغيير شيفرة التطبيق:
1. **عبر نفق آمن للشبكة الخاصة (Tailscale / Cloudflare Tunnel / WireGuard)**:
   - تثبيت `Cloudflare Tunnel (cloudflared)` أو `Tailscale` على الجهاز المستضيف وتوجيه النفق إلى `http://localhost:3000` مع تفعيل HTTPS تلقائياً.
2. **عبر خادم وكيل عكسي (Nginx / Caddy Reverse Proxy) على VPS**:
   - وضع التطبيق خلف `Caddy` أو `Nginx` لتوفير شهادة TLS (HTTPS) وضبط متغير البيئة `DBL_ADMIN_SETUP_CODE` لحماية الإعداد الأولي.
