package edu.dbl.campus;

import android.app.DownloadManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.Arrays;
import java.util.HashSet;
import org.json.JSONObject;
import com.getcapacitor.BridgeActivity;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.SecureRandom;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import android.os.Looper;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

public class MainActivity extends BridgeActivity {
    private static final int MAX_BASE64_EXPORT_BYTES = 16 * 1024 * 1024;
    private static final String KEYSTORE_PROVIDER = "AndroidKeyStore";
    private static final String SESSION_KEY_ALIAS = "dbl_campus_session_aes_key";
    private static final String SESSION_PREFS_NAME = "dbl_campus_secure_session";
    private static final String SESSION_PREFS_TOKEN_KEY = "encrypted_session_token";
    private static final String AES_GCM_TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int GCM_IV_LENGTH_BYTES = 12;
    private static final int GCM_TAG_LENGTH_BITS = 128;
    
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView != null) {
            webView.addJavascriptInterface(new DBLNativeBridge(webView), "DBLNativeBridge");
if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
registerSecureSessionListener(webView);
}
            webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
                String guessedName = URLUtil.guessFileName(url, contentDisposition, mimeType);
                enqueueSecureDownload(url, guessedName, mimeType);
            });
        }

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView currentWebView = getBridge() != null ? getBridge().getWebView() : null;
                if (currentWebView == null) {
                    moveTaskToBack(true);
                    return;
                }
                currentWebView.evaluateJavascript(
                    "(function(){var e=new CustomEvent('dbl-native-back',{cancelable:true});return !window.dispatchEvent(e);})();",
                    handled -> {
                        if (!"true".equals(handled)) {
                            if (currentWebView.canGoBack()) {
                                currentWebView.goBack();
                            } else {
                                moveTaskToBack(true);
                            }
                        }
                    }
                );
            }
        });
    }

private void registerSecureSessionListener(WebView webView) {
WebViewCompat.addWebMessageListener(
webView,
"DBLSecureSession",
new HashSet<>(Arrays.asList("https://localhost", "capacitor://localhost")),
(view, message, sourceOrigin, isMainFrame, replyProxy) -> {
String id = "";
try {
String rawData = message != null ? message.getData() : null;
JSONObject payload = rawData != null && !rawData.isEmpty() ? new JSONObject(rawData) : new JSONObject();
id = payload.optString("id", "");
String originStr = sourceOrigin != null ? sourceOrigin.toString() : "";
boolean trustedOrigin = "https://localhost".equals(originStr) || "capacitor://localhost".equals(originStr);
if (!isMainFrame || !trustedOrigin) {
JSONObject err = new JSONObject();
err.put("id", id);
err.put("ok", false);
err.put("error", "Untrusted frame or origin");
replyProxy.postMessage(err.toString());
return;
}
String action = payload.optString("action", "");
JSONObject res = new JSONObject();
res.put("id", id);
if ("set".equals(action)) {
String token = payload.optString("token", "");
if (!token.isEmpty()) {
encryptAndStoreSessionToken(token);
} else {
clearStoredSessionToken();
}
res.put("ok", true);
} else if ("get".equals(action)) {
String token = decryptSessionToken();
res.put("ok", true);
res.put("token", token != null ? token : "");
} else if ("clear".equals(action)) {
clearStoredSessionToken();
res.put("ok", true);
} else {
res.put("ok", false);
res.put("error", "Unsupported action");
}
replyProxy.postMessage(res.toString());
} catch (Exception e) {
try {
JSONObject err = new JSONObject();
err.put("id", id);
err.put("ok", false);
err.put("error", "Invalid message");
replyProxy.postMessage(err.toString());
} catch (Exception ignored) {
}
}
}
);
}

    private String sanitizeFileName(String rawName, String fallback) {
        if (rawName == null) {
            return fallback;
        }
        String cleaned = rawName.replaceAll("[/\\\\\\p{Cntrl}]", "_").trim();
        while (cleaned.startsWith(".")) {
            cleaned = cleaned.substring(1);
        }
        if (cleaned.length() > 140) {
            cleaned = cleaned.substring(0, 140);
        }
        return cleaned.isEmpty() ? fallback : cleaned;
    }

    private boolean isAllowedHttpsUrl(String rawUrl) {
        if (rawUrl == null || rawUrl.trim().isEmpty()) {
            return false;
        }
        Uri uri = Uri.parse(rawUrl.trim());
        return "https".equalsIgnoreCase(uri.getScheme()) && uri.getHost() != null && !uri.getHost().isEmpty();
    }

    private void enqueueSecureDownload(String url, String rawFileName, String mimeType) {
        if (!isAllowedHttpsUrl(url)) {
            runOnUiThread(() -> Toast.makeText(this, "تم رفض رابط تنزيل غير آمن.", Toast.LENGTH_SHORT).show());
            return;
        }
        String fileName = sanitizeFileName(rawFileName, "DBL_Campus_Attachment");
        try {
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) {
                return;
            }
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url.trim()));
            request.setTitle(fileName);
            request.setDescription("تنزيل ملف من DBL Campus");
            if (mimeType != null && !mimeType.trim().isEmpty()) {
                request.setMimeType(mimeType);
            }
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
            dm.enqueue(request);
            runOnUiThread(() -> Toast.makeText(this, "بدأ تنزيل الملف: " + fileName, Toast.LENGTH_SHORT).show());
        } catch (Exception ex) {
            runOnUiThread(() -> Toast.makeText(this, "تعذر بدء تنزيل الملف.", Toast.LENGTH_SHORT).show());
        }
    }
    private synchronized SecretKey getOrCreateSessionKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER);
        keyStore.load(null);
        if (keyStore.containsAlias(SESSION_KEY_ALIAS)) {
            KeyStore.Entry entry = keyStore.getEntry(SESSION_KEY_ALIAS, null);
            if (entry instanceof KeyStore.SecretKeyEntry) {
                return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
            }
        }
        KeyGenerator keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER);
        KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
                SESSION_KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(false)
                .build();
        keyGenerator.init(spec);
        return keyGenerator.generateKey();
    }

    synchronized boolean encryptAndStoreSessionToken(String token) {
        if (token == null || token.trim().isEmpty()) {
            return clearStoredSessionToken();
        }
        try {
            SecretKey secretKey = getOrCreateSessionKey();
            byte[] iv = new byte[GCM_IV_LENGTH_BYTES];
            new SecureRandom().nextBytes(iv);
            Cipher cipher = Cipher.getInstance(AES_GCM_TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, secretKey, new GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv));
            byte[] encrypted = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
            String payload = Base64.encodeToString(iv, Base64.NO_WRAP)
                    + ":"
                    + Base64.encodeToString(encrypted, Base64.NO_WRAP);
            SharedPreferences prefs = getSharedPreferences(SESSION_PREFS_NAME, Context.MODE_PRIVATE);
            return prefs.edit().putString(SESSION_PREFS_TOKEN_KEY, payload).commit();
        } catch (Exception ex) {
            return false;
        }
    }

    synchronized String decryptSessionToken() {
        try {
            SharedPreferences prefs = getSharedPreferences(SESSION_PREFS_NAME, Context.MODE_PRIVATE);
            String stored = prefs.getString(SESSION_PREFS_TOKEN_KEY, null);
            if (stored == null || stored.isEmpty()) {
                return "";
            }
            String[] parts = stored.split(":", 2);
            if (parts.length != 2) {
                clearStoredSessionToken();
                return "";
            }
            byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
            byte[] encrypted = Base64.decode(parts[1], Base64.NO_WRAP);
            if (iv.length != GCM_IV_LENGTH_BYTES) {
                clearStoredSessionToken();
                return "";
            }
            SecretKey secretKey = getOrCreateSessionKey();
            Cipher cipher = Cipher.getInstance(AES_GCM_TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, secretKey, new GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv));
            byte[] decrypted = cipher.doFinal(encrypted);
            return new String(decrypted, StandardCharsets.UTF_8);
        } catch (Exception ex) {
            clearStoredSessionToken();
            return "";
        }
    }

     synchronized boolean clearStoredSessionToken() {
        try {
            SharedPreferences prefs = getSharedPreferences(SESSION_PREFS_NAME, Context.MODE_PRIVATE);
            return prefs.edit().remove(SESSION_PREFS_TOKEN_KEY).commit();
        } catch (Exception ex) {
            return false;
        }
    }
    
    private class DBLNativeBridge {
        private final WebView webView;

        DBLNativeBridge(WebView webView) {
            this.webView = webView;
        }

        @JavascriptInterface
        public void printDocument(String title) {
            String jobName = sanitizeFileName(title, "DBL_Campus_Document");
            runOnUiThread(() -> {
                PrintManager printManager = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                if (printManager == null) {
                    Toast.makeText(MainActivity.this, "خدمة الطباعة غير متاحة على هذا الجهاز.", Toast.LENGTH_SHORT).show();
                    return;
                }
                PrintDocumentAdapter adapter = webView.createPrintDocumentAdapter(jobName);
                PrintAttributes attrs = new PrintAttributes.Builder()
                    .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                    .build();
                printManager.print(jobName, adapter, attrs);
            });
        }

        @JavascriptInterface
        public void downloadFile(String url, String fileName) {
            enqueueSecureDownload(url, fileName, null);
        }

        @JavascriptInterface
        public void saveBase64File(String rawFileName, String mimeType, String base64Data) {
            if (base64Data == null || base64Data.isEmpty() || base64Data.length() > (MAX_BASE64_EXPORT_BYTES * 4) / 3 + 16) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "حجم الملف المصدّر يتجاوز الحد المسموح.", Toast.LENGTH_SHORT).show());
                return;
            }
            String fileName = sanitizeFileName(rawFileName, "DBL_Campus_Export");
            String safeMime = (mimeType == null || mimeType.trim().isEmpty()) ? "application/octet-stream" : mimeType.trim();

            try {
                byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);
                if (bytes.length > MAX_BASE64_EXPORT_BYTES) {
                    runOnUiThread(() -> Toast.makeText(MainActivity.this, "حجم الملف المصدّر يتجاوز الحد المسموح.", Toast.LENGTH_SHORT).show());
                    return;
                }

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
                    values.put(MediaStore.Downloads.MIME_TYPE, safeMime);
                    values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    ContentResolver resolver = getContentResolver();
                    Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (uri == null) {
                        throw new IllegalStateException("MediaStore insert failed");
                    }
                    try (OutputStream out = resolver.openOutputStream(uri)) {
                        if (out == null) {
                            throw new IllegalStateException("OutputStream unavailable");
                        }
                        out.write(bytes);
                    }
                } else {
                    File downloadsDir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    if (downloadsDir == null) {
                        throw new IllegalStateException("Downloads directory unavailable");
                    }
                    File target = new File(downloadsDir, fileName);
                    try (FileOutputStream out = new FileOutputStream(target)) {
                        out.write(bytes);
                    }
                }

                runOnUiThread(() -> Toast.makeText(MainActivity.this, "تم حفظ الملف في التنزيلات: " + fileName, Toast.LENGTH_LONG).show());
            } catch (Exception ex) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "تعذر حفظ الملف المصدّر.", Toast.LENGTH_SHORT).show());
            }
        }

        private boolean isTrustedLocalOrigin() {
            if (Looper.myLooper() == Looper.getMainLooper()) {
                return isTrustedOriginUrl(webView.getUrl());
            }
            AtomicBoolean trusted = new AtomicBoolean(false);
            CountDownLatch latch = new CountDownLatch(1);
            runOnUiThread(() -> {
                try {
                    trusted.set(isTrustedOriginUrl(webView.getUrl()));
                } finally {
                    latch.countDown();
                }
            });
            try {
                if (!latch.await(2, TimeUnit.SECONDS)) {
                    return false;
                }
            } catch (InterruptedException ex) {
                Thread.currentThread().interrupt();
                return false;
            }
            return trusted.get();
        }

        private boolean isTrustedOriginUrl(String url) {
            if (url == null) {
                return false;
            }
            return url.equals("https://localhost")
                || url.startsWith("https://localhost/")
                || url.startsWith("https://localhost:")
                || url.equals("capacitor://localhost")
                || url.startsWith("capacitor://localhost/")
                || url.startsWith("capacitor://localhost:");
        }

    }
}
