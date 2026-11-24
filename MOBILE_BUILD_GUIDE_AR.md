# دليل بناء وتوقيع وتوزيع تطبيقات الهاتف — DBL Campus (Android APK & iOS IPA)

يعتمد **DBL Campus** على **Capacitor 8** لتشغيل التطبيق نفسه بتطبيقين أصليين على **Android** و**iOS** مرتبطين بخادم الإنتاج الرسمي عبر HTTPS:

- **عنوان الإنتاج الرسمي**: `https://campus.dblab.site`
- **معرّف التطبيق (Application ID / Bundle ID)**: `edu.dbl.campus`
- **الإصدار الحالي**: `1.1.0` (`versionCode / CURRENT_PROJECT_VERSION = 10100`)
- **سير عمل البناء الآلي**: `.github/workflows/build-mobile.yml`

---

## 1. القدرات الأصلية المدعومة على الهاتف (إصدار 1.1.0)

- **اتصال HTTPS مغلق على الإنتاج**: في إصدارات الإنتاج (`mode=native`) يُحقن عنوان `https://campus.dblab.site` داخل الحزمة ويُمنع تجاوزه، مع تعطيل حركة HTTP غير المشفرة (`usesCleartextTraffic="false"`) وتعطيل النسخ الاحتياطي غير المصرّح به عبر ADB (`allowBackup="false"`).
- **العربية وRTL والوضع الداكن**: واجهة عربية افتراضية بالكامل (`dir="rtl"`)، وتعريب قوائم النظام في iOS (`ar`), وحفظ تفضيل الوضع الداكن محلياً عبر إعادة التشغيل، مع مراعاة حواف الشاشة الآمنة (`safe-top` / `safe-bottom`).
- **تنزيل المرفقات عبر تذاكر موقّعة قصيرة العمر**:
  - على **Android**: عبر `DownloadManager` مباشرة إلى مجلد التنزيلات (`Downloads`) مع إشعار نظامي دون مغادرة شاشة التطبيق.
  - على **iOS**: عبر `URLSession` ثم شاشة المشاركة النظامية (`UIActivityViewController`) لحفظ الملف في تطبيق الملفات (Files) أو فتحه.
- **الطباعة وتصدير مستندات A4 الرسمية (PDF)**:
  - على **Android**: جسر أصلي إلى `PrintManager` بمقاس `ISO_A4` (الطباعة أو الحفظ كـ PDF).
  - على **iOS**: جسر أصلي إلى `UIPrintInteractionController` (AirPrint أو الحفظ كـ PDF).
- **تصدير CSV والنسخ الاحتياطي**: يعمل على الويب وعلى Android (`MediaStore.Downloads`) وعلى iOS (`UIActivityViewController`).
- **زر الرجوع في Android**: يُغلق النوافذ المنبثقة أو القائمة الجانبية أو يعود إلى لوحة المتابعة قبل تصغير التطبيق بدلاً من إنهائه فجأة.

---

## 2. إعداد مفتاح توقيع Android الدائم (مرة واحدة فقط — خارج المستودع)

> **تحذير أمني مهم**: لا تضع ملف `.keystore` أو كلمات مروره داخل Git أو أي مستودع عام أو خاص أبداً. احتفظ بنسخة احتياطية مشفرة للمفتاح في مكان آمن؛ لأن فقدانه يمنع ترقية التطبيق المثبت عند الطلاب دون إلغاء تثبيته أولاً.

### الخطوة 1: إنشاء مفتاح الإصدار الدائم على جهازك

```bash
keytool -genkeypair -v \
  -storetype PKCS12 \
  -keystore dbl-campus-release.keystore \
  -alias dbl-campus-release \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000 \
  -dname "CN=DBL Campus, OU=Student Cohort, O=DBL Lab, C=YE"
```

### الخطوة 2: تحويل المفتاح إلى Base64

- **على Linux / macOS**:
  ```bash
  base64 -w 0 dbl-campus-release.keystore > keystore.b64
  # على macOS:
  base64 -i dbl-campus-release.keystore | tr -d '\n' > keystore.b64
  ```
- **على Windows (PowerShell)**:
  ```powershell
  [Convert]::ToBase64String([IO.File]::ReadAllBytes("dbl-campus-release.keystore")) | Set-Content -NoNewline keystore.b64
  ```

### الخطوة 3: إضافة المتغيرات والأسرار في مستودع GitHub

من صفحة المستودع: **Settings → Secrets and variables → Actions**

1. **Repository Variable (في تبويب Variables)**:
   - `DBL_PRODUCTION_URL` = `https://campus.dblab.site`
2. **Repository Secrets (في تبويب Secrets)**:
   - `ANDROID_KEYSTORE_BASE64`: محتوى `keystore.b64` (سطر واحد دون مسافات).
   - `ANDROID_KEYSTORE_PASSWORD`: كلمة مرور ملف الـ Keystore.
   - `ANDROID_KEY_ALIAS`: `dbl-campus-release`
   - `ANDROID_KEY_PASSWORD`: كلمة مرور المفتاح.

*(احذف `keystore.b64` بعد إضافته إلى GitHub Secrets، واحتفظ بملف `dbl-campus-release.keystore` وكلمات مروره في مدير كلمات مرور مشفّر).*

---

## 3. إصدار نسخ Android APK وiOS عبر GitHub Actions (قابل للتكرار مستقبلاً)

1. بعد دمج Pull Request في `main`، أنشئ وسم الإصدار وارفعه:
   ```bash
   git checkout main && git pull
   git tag -a v1.1.0 -m "Release DBL Campus Mobile v1.1.0"
   git push origin v1.1.0
   ```
2. من GitHub: **Actions → Build and verify mobile apps → Run workflow**:
   - الفرع: `main`
   - `release_tag`: `v1.1.0`
   - `publish_release`: اتركه `false` لإنشاء مسودة للمراجعة أولاً (أو `true` للنشر الفوري).
3. يتحقق سير العمل تلقائياً من:
   - سلامة خادم الإنتاج الحي `https://campus.dblab.site/api/health` (`status=ok`, `storageWritable=true`, `demoEnabled=false`).
   - بناء وتوقيع `DBL-Campus-Android.apk` بمفتاح الإصدار الدائم ورفض أي توقيع Debug (`CN=Android Debug`).
   - فحص التوقيع عبر `apksigner` والتحقق من تضمين `https://campus.dblab.site` وإصدار `1.1.0`.
   - تثبيت وتشغيل الـ APK فعلياً على **محاكي Android** داخل CI.
   - بناء وتشغيل تطبيق iOS على **محاكي iPhone Simulator** داخل `macos-15` وتجهيز `DBL-Campus-iOS-unsigned.ipa` مع `SHA256SUMS-iOS.txt`.
   - إنشاء **GitHub Release** يحتوي على `DBL-Campus-Android.apk` و`SHA256SUMS.txt`.

لأي إصدار مستقبلي (مثل `v1.2.0`): حدّث `"version"` في `package.json` (وملفات Android/iOS إن رغبت)، ادمج في `main`، أنشئ الوسم `v1.2.0`، وشغّل سير العمل بالوسم الجديد — سيُحدّث سير العمل أرقام الإصدار والـ `versionCode` تلقائياً (`10200`).

---

## 4. متطلبات التوقيع والتثبيت على أجهزة iPhone الفعلية (iOS)

يُنتج سير العمل حزمة `DBL-Campus-iOS-unsigned.ipa` (ضمن GitHub Actions Artifacts) ومفحوصة على محاكي iPhone، ولا يفعّل أي اشتراك مدفوع تلقائياً. لتثبيت التطبيق على أجهزة iPhone حقيقية لديك 3 خيارات واضحة:

| الخيار | التكلفة | مدة الصلاحية | عدد الأجهزة | طريقة التوزيع |
| --- | --- | --- | --- | --- |
| **1. تثبيت PWA عبر Safari (موصى به فوراً دون تكلفة)** | مجاني بالكامل | دائم (يتحدث تلقائياً) | غير محدود | فتح `https://campus.dblab.site` في Safari ← **مشاركة ← إضافة إلى الشاشة الرئيسية** |
| **2. التوقيع الشخصي المجاني (Apple ID مجاني + Xcode / Sideloadly / AltStore)** | مجاني ($0) | 7 أيام (يحتاج إعادة توقيع أسبوعية) | محدود جداً (حتى 3 تطبيقات لكل جهاز) | استخدام `DBL-Campus-iOS-unsigned.ipa` أو فتح `ios/App/App.xcodeproj` في Xcode على جهاز Mac |
| **3. برنامج مطوري Apple الرسمي (TestFlight / App Store / Ad Hoc)** | **$99 سنوياً** (يتطلب موافقتك قبل التفعيل) | TestFlight: 90 يوماً لكل بناء / App Store: دائم | TestFlight: حتى 10,000 طالب / Ad Hoc: 100 جهاز | ضبط Team وBundle ID `edu.dbl.campus` في Xcode ← `Product → Archive → Distribute App` |

---

## 5. البناء المحلي (اختياري للمطورين)

```bash
# بناء حزمة الإنتاج المربوطة بـ https://campus.dblab.site ومزامنة المشروعين
DBL_NATIVE_SERVER_URL=https://campus.dblab.site npm run cap:sync:prod

# Android (يتطلب Java 21 + Android SDK + مفتاح الإصدار)
cd android && ./gradlew assembleRelease \
  -Pandroid.injected.signing.store.file=/path/to/dbl-campus-release.keystore \
  -Pandroid.injected.signing.store.password="$ANDROID_KEYSTORE_PASSWORD" \
  -Pandroid.injected.signing.key.alias="$ANDROID_KEY_ALIAS" \
  -Pandroid.injected.signing.key.password="$ANDROID_KEY_PASSWORD"

# iOS (يتطلب macOS + Xcode)
npx cap open ios
```
