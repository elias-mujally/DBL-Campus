# خطة تحديث نسخة الإنتاج الآمنة على Google Cloud (campus.dblab.site)

توثّق هذه الخطة خطوات تحديث بيئة الإنتاج لإصدار **DBL Campus v1.4.0** بأمان على خادم Google Compute Engine (GCE) بما يتوافق تماماً مع `deploy/gce/compose.sh` و`deploy/gce/compose.tunnel.yml`.

---

## 1. المتطلبات المسبقة قبل التحديث
- التأكد من عدم تعديل أو استبدال ملف البيئة المحمي `CAMPUS_ENV_FILE` (بصلاحيات `chmod 600`) إلا عند الحاجة لتحديث متغيرات محددة.
- التأكد من وجود مساحة قرص كافية ضمن حد الطبقة المجانية (30 GB Standard Persistent Disk) عبر `df -h`.
- تسجيل رقم الإصدار/الوسم الحالي (`git rev-parse HEAD` أو صورة Docker الحالية) لاستخدامه في التراجع الفوري عند اللزوم.

---

## 2. النسخ الاحتياطي المتسق لـ SQLite WAL و`/data/uploads`
قبل سحب أو تشغيل أي حاوية جديدة، يجب أخذ نسخة احتياطية متسقة لقاعدة بيانات SQLite (في وضع WAL) وملفات `/data/uploads`:

```bash
BACKUP_DIR="/var/backups/dbl-campus/$(date +%Y%m%d-%H%M%S)"
sudo mkdir -p "$BACKUP_DIR"

# 1) نسخة احتياطية متسقة لقاعدة البيانات عبر sqlite3 .backup (تتعامل بأمان مع WAL)
sqlite3 /mnt/disks/campus-data/campus.db ".backup '$BACKUP_DIR/campus.db'"
# التحقق من سلامة النسخة الاحتياطية
sqlite3 "$BACKUP_DIR/campus.db" "PRAGMA integrity_check;"

# 2) نسخ مجلد المرفقات /data/uploads (من مسار البيانات CAMPUS_DATA_PATH)
sudo rsync -a /mnt/disks/campus-data/uploads/ "$BACKUP_DIR/uploads/"

# 3) حفظ نسخة احتياطية مشفرة/محمية من ملف البيئة (دون كشفها في السجلات)
sudo cp -p "$CAMPUS_ENV_FILE" "$BACKUP_DIR/.env.bak"
sudo chmod 600 "$BACKUP_DIR/.env.bak"
```

---

## 3. الحفاظ على `DBL_SESSION_SECRET` وجلسات الطلاب
- **عدم إعادة توليد `DBL_SESSION_SECRET`**: يجب الإبقاء على قيمة `DBL_SESSION_SECRET` كما هي داخل `CAMPUS_ENV_FILE` حتى لا يتم تسجيل خروج الطلاب أو إبطال الجلسات النشطة.
- التحقق من بقاء `CAMPUS_DATA_PATH` مشيراً إلى نفس القرص الدائم (Mountpoint) المحتوي على قاعدة البيانات والجلسات.

---

## 4. تحديث `DBL_ANDROID_RELEASE_SHA256`
عند وجود توقيع إصدار جديد لتطبيق Android (v1.4.0)، يتم تحديث بصمة `DBL_ANDROID_RELEASE_SHA256` في `CAMPUS_ENV_FILE`:
1. فتح `CAMPUS_ENV_FILE` بصلاحيات مقيدة (`chmod 600`).
2. تحديث `DBL_ANDROID_RELEASE_SHA256=<NEW_SHA256_FINGERPRINT>` مع الإبقاء على `DBL_SESSION_SECRET` وبقية المتغيرات دون تغيير.
3. التحقق بعد التشغيل من استجابة `/.well-known/assetlinks.json` على نطاق `campus.dblab.site`.

---

## 5. تنفيذ التحديث عبر `deploy/gce/compose.sh` و`compose.tunnel.yml`
تستخدم بيئة الإنتاج `CAMPUS_INGRESS=tunnel` (الافتراضي في `compose.sh`) والذي يربط `docker-compose.yml` و`deploy/gce/compose.yml` و`deploy/gce/compose.tunnel.yml` (خادم Caddy على `127.0.0.1:8080` خلف `cloudflared`):

```bash
cd /opt/dbl-campus
git fetch origin
git checkout v1.4.0   # أو الفرع/الالتزام المعتمد للإصدار

export CAMPUS_ENV_FILE=/etc/dbl-campus/campus.env
export CAMPUS_DATA_PATH=/mnt/disks/campus-data
export CAMPUS_INGRESS=tunnel

./deploy/gce/compose.sh
```
> ملاحظة: يقوم `compose.sh` بتشغيل `docker compose --env-file "$envfile" ... up -d --wait --no-build --pull missing` لضمان عدم إعادة البناء على الخادم الضعيف وتقليل وقت التوقف.

---

## 6. التحقق بعد التحديث (HTTPS وCloudflare Tunnel وService Worker)
1. **حالة الحاويات والنفق**:
   - `docker ps` والتأكد من صحة حاويتي التطبيق وCaddy (`127.0.0.1:8080`).
   - `sudo systemctl status cloudflared` والتأكد من اتصال النفق بنجاح.
2. **HTTPS والموقع الحي**:
   - فحص `curl -I` على نطاق `campus.dblab.site` ببروتوكول HTTPS والتأكد من `HTTP/2 200` وصلاحية شهادة TLS من Cloudflare.
   - فحص نقطة الصحة الداخلية على `127.0.0.1:8080/health` (أو مسار الصحة المعتمد).
3. **Service Worker وتحديث الواجهة**:
   - التحقق من استجابة `/sw.js` أو ملف Service Worker برؤوس عدم التخزين المؤقت (`Cache-Control: no-cache`) لضمان حصول المتصفحات وتطبيق PWA على نسخة v1.4.0 وهوية Aurora Signature الجديدة.
   - فحص `/.well-known/assetlinks.json` للتأكد من مطابقة `DBL_ANDROID_RELEASE_SHA256`.

---

## 7. البقاء ضمن الحدود المجانية لـ Google Cloud (Free Tier)
- الالتزام بنوع الجهاز `e2-micro` في إحدى مناطق US المؤهلة للطبقة المجانية، وبقرص `Standard Persistent Disk` لا يتجاوز 30 GB.
- استخدام `--no-build` كما في `compose.sh` لتفادي استهلاك الذاكرة والمعالج في البناء المحلي.
- تقييد حركة المرور الخارجية عبر Cloudflare Tunnel (`127.0.0.1:8080`) وتجنب حجز عناوين IP خارجية إضافية غير مستخدمة.
- بعد التأكد من استقرار الإصدار الجديد بـ 24 ساعة، تنظيف الصور غير المستخدمة فقط للحفاظ على مساحة القرص:
  ```bash
  docker image prune -f
  ```

---

## 8. خطة التراجع الفورية (Immediate Rollback Plan)
في حال ظهور أي خلل في قاعدة البيانات أو الواجهة أو تسجيل الدخول:

1. **إيقاف الحاويات الحالية مؤقتاً**:
   ```bash
   docker compose --env-file "$CAMPUS_ENV_FILE" -f docker-compose.yml -f deploy/gce/compose.yml -f deploy/gce/compose.tunnel.yml down
   ```
2. **العودة إلى الالتزام/الإصدار السابق**:
   ```bash
   cd /opt/dbl-campus
   git checkout <PREVIOUS_TAG_OR_COMMIT>
   ```
3. **استعادة النسخة الاحتياطية (عند وجود تعديل في مخطط قاعدة البيانات أو الملفات)**:
   ```bash
   sudo cp "$BACKUP_DIR/campus.db" /mnt/disks/campus-data/campus.db
   sudo rm -f /mnt/disks/campus-data/campus.db-wal /mnt/disks/campus-data/campus.db-shm
   sudo rsync -a --delete "$BACKUP_DIR/uploads/" /mnt/disks/campus-data/uploads/
   sudo cp -p "$BACKUP_DIR/.env.bak" "$CAMPUS_ENV_FILE"
   ```
4. **إعادة تشغيل النسخة السابقة والتحقق**:
   ```bash
   ./deploy/gce/compose.sh
   curl -I 127.0.0.1:8080/health
   ```
