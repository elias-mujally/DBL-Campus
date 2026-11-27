# خطة تحديث نسخة الإنتاج على Google Cloud (`campus.dblab.site`) إلى v1.5.0

توضح هذه الخطة خطوات ترقية **DBL Campus** على بيئة الإنتاج في Google Compute Engine (GCE) إلى الإصدار **v1.5.0 (10500)** باستخدام `deploy/gce/compose.sh` و`deploy/gce/compose.tunnel.yml` دون فقدان البيانات أو الجلسات.

---

## 1. الفحص المسبق وحدود GCE المجانية
- التحقق من وجود `CAMPUS_ENV_FILE` وصلاحياته (`chmod 600`) وتضمّنه لقيمة `DBL_SESSION_SECRET` الثابتة لضمان استمرار صلاحية الجلسات النشطة.
- التحقق من حدود GCE المجانية (`e2-micro` / قرص `30 GB Standard Persistent Disk`) عبر:
  ```bash
  df -h / /mnt/disks/campus-data
  free -h
  docker system df
  ```
- تسجيل الالتزام الحالي قبل التحديث للرجوع السريع عند الحاجة:
  ```bash
  PREV_COMMIT=$(git rev-parse HEAD)
  echo "$PREV_COMMIT"
  ```

---

## 2. النسخ الاحتياطي المتسق لـ SQLite WAL و`/data/uploads`
قبل أي تعديل، يُنشأ نسخ احتياطي متسق لقاعدة البيانات (مع دعم وضع WAL) ومجلد المرفوعات وملف البيئة:

```bash
BACKUP_DIR="/var/backups/dbl-campus/$(date +%Y%m%d-%H%M%S)"
sudo mkdir -p "$BACKUP_DIR"

# 1) نسخ احتياطي متسق لقاعدة بيانات SQLite (يدعم WAL)
sqlite3 /mnt/disks/campus-data/campus.db ".backup '$BACKUP_DIR/campus.db'"
sqlite3 "$BACKUP_DIR/campus.db" "PRAGMA integrity_check;"

# 2) نسخ مجلد /data/uploads (CAMPUS_DATA_PATH)
sudo rsync -a /mnt/disks/campus-data/uploads/ "$BACKUP_DIR/uploads/"

# 3) حفظ نسخة آمنة من ملف البيئة (يحوي DBL_SESSION_SECRET)
sudo cp -p "$CAMPUS_ENV_FILE" "$BACKUP_DIR/.env.bak"
sudo chmod 600 "$BACKUP_DIR/.env.bak"

# تسجيل version الحالي قبل الترقية
sqlite3 /mnt/disks/campus-data/campus.db "PRAGMA user_version;"
```

---

## 3. التحديث وبناء الإصدار v1.5.0 وترحيل قاعدة البيانات (`3` -> `4`)
1. سحب التحديثات وبناء وتشغيل الحاويات مع الحفاظ على `DBL_SESSION_SECRET` وبيانات `/mnt/disks/campus-data`:
   ```bash
   git fetch origin
   git checkout <v1.5.0-tag-or-branch>
   ./deploy/gce/compose.sh up -d --build
   ```
2. عند إقلاع الخادم، يتم ترحيل قاعدة البيانات تلقائياً وبشكل آمن عبر `PRAGMA user_version` من `3` إلى `4` لإنشاء جدول `invitation_codes` دون مساس بجداول `users` أو `sessions` أو `audit_logs`.
3. التحقق من نجاح الترحيل وسلامة الحسابات والجلسات:
   ```bash
   sqlite3 /mnt/disks/campus-data/campus.db "PRAGMA user_version;"
   sqlite3 /mnt/disks/campus-data/campus.db "SELECT name FROM sqlite_master WHERE type='table' AND name='invitation_codes';"
   sqlite3 /mnt/disks/campus-data/campus.db "SELECT COUNT(*) AS users_count FROM users; SELECT COUNT(*) AS sessions_count FROM sessions;"
   ```

---

## 4. التحقق بعد التحديث (HTTPS، Cloudflare Tunnel، Cache-Control وService Worker)
- **التحقق من الخدمة محلياً وعبر Cloudflare Tunnel وHTTPS:**
  ```bash
  CAMPUS_DOMAIN="campus.dblab.site"
  ./deploy/gce/compose.sh ps
  ./deploy/gce/compose.sh logs --tail=50
  curl -fsS "https://${CAMPUS_DOMAIN}/api/health"
  ```
- **التحقق من `Cache-Control: no-cache` وService Worker:**
  ```bash
  curl -sI "https://${CAMPUS_DOMAIN}/" | grep -iE 'cache-control|etag'
  curl -sI "https://${CAMPUS_DOMAIN}/sw.js" | grep -iE 'cache-control|content-type'
  ```
  يُتأكد من إرجاع `Cache-Control: no-cache` لصفحة الدخول وملف `sw.js` حتى يلتقط المتصفح وتطبيق الويب إصدار `v1.5.0` فوراً.
- **التحقق الوظيفي:**
  - استمرار تسجيل الدخول بالحسابات القديمة والجلسات النشطة دون الحاجة لإعادة تسجيل الدخول.
  - التحقق من عمل واجهات `/api/auth/status` و`/api/auth/login` وإدارة رموز الدعوة من لوحة المخولين.

---

## 5. خطة التراجع المختبرة (Rollback Plan)
في حال ظهور أي خلل بعد الترقية إلى `v1.5.0`:

```bash
# 1) إيقاف الحاويات الحالية
./deploy/gce/compose.sh down

# 2) استعادة قاعدة البيانات و/data/uploads وملف البيئة من النسخة الاحتياطية
sudo cp "$BACKUP_DIR/campus.db" /mnt/disks/campus-data/campus.db
sudo rm -f /mnt/disks/campus-data/campus.db-wal /mnt/disks/campus-data/campus.db-shm
sudo rsync -a --delete "$BACKUP_DIR/uploads/" /mnt/disks/campus-data/uploads/
sudo cp -p "$BACKUP_DIR/.env.bak" "$CAMPUS_ENV_FILE"
sudo chmod 600 "$CAMPUS_ENV_FILE"

# 3) الرجوع إلى الالتزام السابق وإعادة البناء والتشغيل
git checkout "$PREV_COMMIT"
./deploy/gce/compose.sh up -d --build

# 4) التحقق من عودة الخدمة وسلامة قاعدة البيانات
sqlite3 /mnt/disks/campus-data/campus.db "PRAGMA integrity_check; PRAGMA user_version;"
curl -fsS "https://${CAMPUS_DOMAIN}/api/health"
```
