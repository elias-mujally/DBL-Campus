@echo off
chcp 65001 >nul
title DBL Campus — Student Cohort Management Platform
echo ============================================================================
echo   DBL Campus — منصة إدارة الدفعات الجامعية (تشغيل محلي متعدد المستخدمين)
echo ============================================================================
echo.

where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [خطأ] لم يتم العثور على Node.js. يرجى تثبيت Node.js 20 أو أحدث من https://nodejs.org
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [1/3] جاري تثبيت الحزم البرمجية لأول مرة...
    call npm ci --legacy-peer-deps
)

echo [2/3] عناوين الشبكة المحلية (LAN IP) للدخول من الهواتف والأجهزة الأخرى على نفس الشبكة:
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    echo   - http:%%a:3000
)
echo   - على نفس الحاسوب: http://localhost:3000
echo.
echo [3/3] جاري تشغيل الخادم المركزي وقاعدة البيانات المحلية SQLite...
call npm run dev
pause
