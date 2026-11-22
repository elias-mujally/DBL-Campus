# دليل بناء وتنزيل تطبيق DBL Campus على Android (APK) و iOS (IPA)

تم تجهيز مشروع **DBL Campus** رسمياً باستخدام إطار **Capacitor** مع مشروعي **Android** و**iOS** الأصليين وملف **GitHub Actions CI/CD** الجاهز لتوليد حزم **`DBL-Campus-Android.apk`** و**`DBL-Campus-iOS.ipa`** تلقائياً ومجاناً عبر خوادم GitHub السحابية (`ubuntu-latest` و`macos-15`).

---

## 1. توليد ملفات APK و IPA تلقائياً عبر GitHub Actions (الطريقة الأسهل والأسرع)

لا تحتاج إلى تنصيب Android Studio أو امتلاك جهاز Mac لبناء تطبيق iOS؛ يوفر لك GitHub خوادم Ubuntu وmacOS مجاناً:

1. أنشئ مستودعاً على **GitHub** وارفع إليه ملفات هذا المشروع (بما فيها مجلد `.github/workflows/build-mobile.yml`).
2. من صفحة المستودع في GitHub، انتقل إلى تبويب **Actions**.
3. اختر سير العمل المسمى:
   **`Build Android APK & iOS IPA (DBL Campus)`**
4. اضغط على زر **Run workflow**:
   - إذا أدخلت رقم إصدار مثل `v1.0.0` في حقل `release_tag`، سيقوم GitHub ببناء الملفين ونشرهما تلقائياً كروابط تنزيل مباشرة في صفحة **Releases**.
   - وإذا تركته فارغاً، ستجد الملفين جاهزين للتنزيل ضمن قسم **Artifacts** في نهاية التشغيل:
     - `DBL-Campus-Android-APK` ← يحتوي على **`DBL-Campus-Android.apk`**
     - `DBL-Campus-iOS-IPA` ← يحتوي على **`DBL-Campus-iOS.ipa`**

---

## 2. توزيع ملفات APK و IPA على طلاب الدفعة عبر الشبكة المحلية (بدون إنترنت)

بعد تنزيل ملفي `DBL-Campus-Android.apk` و`DBL-Campus-iOS.ipa` من GitHub:
1. سجّل الدخول بحساب **مندوب الدفعة** في المنصة.
2. اضغط على زر **تطبيق الهاتف (APK / IPA)** في الشريط العلوي.
3. ارفع ملفي `.apk` و`.ipa` مباشرة عبر نموذج الرفع (أو انسخهما يدوياً إلى مجلد `data/releases/` باسم `DBL-Campus-Android.apk` و`DBL-Campus-iOS.ipa`).
4. فور الرفع، سيظهر لكل طالب يتصل بالخادم المحلي زر **تنزيل مباشر للـ APK** أو **تنزيل مباشر للـ IPA** مع بصمة التحقق `SHA-256`.

---

## 3. طريقة تثبيت التطبيق على هواتف الطلاب

### أ) هواتف Android (`.apk`)
1. نزّل ملف `DBL-Campus-Android.apk` من الخادم المحلي أو من GitHub Releases.
2. افتح الملف على الهاتف واسمح بالتثبيت من مصادر غير معروفة (*Install unknown apps*) عند الطلب.
3. افتح التطبيق، واضغط على **تطبيق الهاتف (APK / IPA) ← إعداد خادم الشبكة المحلية**، ثم أدخل عنوان خادم المندوب (مثال: `http://192.168.1.15:3000`) واضغط **اختبار وحفظ**.

### ب) هواتف iPhone / iPad (`.ipa`)
بسبب سياسات أبل لتوقيع التطبيقات، يمكنك تثبيت ملف `DBL-Campus-iOS.ipa` بأحد الخيارات التالية:
1. **التثبيت المباشر على أجهزة الطلاب (بدون حساب مطور مدفوع)**: عبر أداة مجانية مفتوحة المصدر مثل **[AltStore](https://altstore.io/)** أو **[Sideloadly](https://sideloadly.io/)** أو **TrollStore**.
2. **التوزيع الرسمي عبر TestFlight / App Store**: عبر فتح مجلد `ios/App/App.xcworkspace` في **Xcode** على جهاز Mac وتوقيعه بحساب Apple Developer.
3. **البديل السريع بدون كابل**: يمكن لطلاب iOS أيضاً استخدام زر **تثبيت التطبيق (PWA)** من متصفح Safari (`المشاركة ← إضافة إلى الشاشة الرئيسية`).

---

## 4. البناء المحلي (اختياري للمطورين)

### بناء Android APK محلياً (يتطلب Java 21 + Android SDK)
```bash
npm run build
npx cap sync android
cd android
./gradlew assembleDebug
# المسار الناتج: android/app/build/outputs/apk/debug/app-debug.apk
```

### بناء iOS IPA محلياً (يتطلب macOS + Xcode)
```bash
npm run build
npx cap sync ios
npx cap open ios
# ثم من Xcode اختر: Product -> Archive -> Distribute App
```
