package edu.dbl.campus;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class EndToEndSessionTest {

  private static final String HOST = "127.0.0.1";
  private static final int PORT = 3999;

  private static JSONObject httpGet(String path, String bearerToken) throws Exception {
    HttpURLConnection conn = (HttpURLConnection) new URL("http", HOST, PORT, path).openConnection();
    conn.setRequestMethod("GET");
    conn.setConnectTimeout(10000);
    conn.setReadTimeout(10000);
    conn.setRequestProperty("Accept", "application/json");
    if (bearerToken != null && !bearerToken.isEmpty()) {
      conn.setRequestProperty("Authorization", "Bearer " + bearerToken);
    }
    int code = conn.getResponseCode();
    InputStream stream = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
    String body = readStream(stream);
    conn.disconnect();
    assertTrue("Expected 2xx from GET " + path + ", got " + code + ": " + body, code >= 200 && code < 300);
    return new JSONObject(body);
  }

  private static JSONObject httpPost(String path, JSONObject payload, String bearerToken) throws Exception {
    HttpURLConnection conn = (HttpURLConnection) new URL("http", HOST, PORT, path).openConnection();
    conn.setRequestMethod("POST");
    conn.setConnectTimeout(10000);
    conn.setReadTimeout(10000);
    conn.setDoOutput(true);
    conn.setRequestProperty("Content-Type", "application/json");
    conn.setRequestProperty("Accept", "application/json");
    if (bearerToken != null && !bearerToken.isEmpty()) {
      conn.setRequestProperty("Authorization", "Bearer " + bearerToken);
    }
    if (payload != null) {
      byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);
      try (OutputStream os = conn.getOutputStream()) {
        os.write(bytes);
      }
    }
    int code = conn.getResponseCode();
    InputStream stream = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
    String body = readStream(stream);
    conn.disconnect();
    assertTrue("Expected 2xx from POST " + path + ", got " + code + ": " + body, code >= 200 && code < 300);
    return body.isEmpty() ? new JSONObject() : new JSONObject(body);
  }

  private static String readStream(InputStream stream) throws Exception {
    if (stream == null) {
      return "";
    }
    StringBuilder sb = new StringBuilder();
    try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
      String line;
      while ((line = reader.readLine()) != null) {
        sb.append(line);
      }
    }
    return sb.toString();
  }

  private static WebView waitForBridgeReady(ActivityScenario<MainActivity> scenario) throws Exception {
    AtomicReference<WebView> webViewRef = new AtomicReference<>();
    long deadline = System.currentTimeMillis() + 15000L;
    while (System.currentTimeMillis() < deadline) {
      AtomicReference<Boolean> readyRef = new AtomicReference<>(false);
      CountDownLatch latch = new CountDownLatch(1);
      scenario.onActivity(activity -> {
        WebView wv = activity.getBridge().getWebView();
        webViewRef.set(wv);
        if (wv != null) {
          wv.evaluateJavascript(
              "(function(){ return typeof window.DBLSecureSession !== 'undefined' && window.location && window.location.origin && (window.location.origin === ('https://' + 'localhost') || window.location.origin === ('capacitor://' + 'localhost')); })()",
              value -> {
                readyRef.set("true".equals(value));
                latch.countDown();
              });
        } else {
          latch.countDown();
        }
      });
      latch.await(5, TimeUnit.SECONDS);
      if (Boolean.TRUE.equals(readyRef.get())) {
        return webViewRef.get();
      }
      Thread.sleep(200);
    }
    throw new AssertionError("Timed out waiting for DBLSecureSession bridge on MainActivity WebView");
  }

  private static JSONObject invokeSecureSession(ActivityScenario<MainActivity> scenario, String action, String token) throws Exception {
    waitForBridgeReady(scenario);
    String requestId = UUID.randomUUID().toString();
    JSONObject req = new JSONObject();
    req.put("id", requestId);
    req.put("action", action);
    if (token != null) {
      req.put("token", token);
    }
    String jsTrigger =
        "(function(){"
            + "window.__dblE2EResult = null;"
            + "window.DBLSecureSession.onmessage = function(ev){ window.__dblE2EResult = ev.data; };"
            + "window.DBLSecureSession.postMessage(" + JSONObject.quote(req.toString()) + ");"
            + "return 'sent';"
            + "})()";
    CountDownLatch sendLatch = new CountDownLatch(1);
    scenario.onActivity(activity -> {
      WebView wv = activity.getBridge().getWebView();
      wv.evaluateJavascript(jsTrigger, value -> sendLatch.countDown());
    });
    assertTrue("Timed out sending DBLSecureSession message", sendLatch.await(5, TimeUnit.SECONDS));

    long deadline = System.currentTimeMillis() + 10000L;
    while (System.currentTimeMillis() < deadline) {
      AtomicReference<String> rawRef = new AtomicReference<>();
      CountDownLatch pollLatch = new CountDownLatch(1);
      scenario.onActivity(activity -> {
        WebView wv = activity.getBridge().getWebView();
        wv.evaluateJavascript("window.__dblE2EResult", value -> {
          rawRef.set(value);
          pollLatch.countDown();
        });
      });
      pollLatch.await(5, TimeUnit.SECONDS);
      String raw = rawRef.get();
      if (raw != null && !"null".equals(raw) && !raw.isEmpty()) {
        String unwrapped = new JSONObject("{\"v\":" + raw + "}").getString("v");
        JSONObject resp = new JSONObject(unwrapped);
        if (requestId.equals(resp.optString("id"))) {
          return resp;
        }
      }
      Thread.sleep(100);
    }
    throw new AssertionError("Timed out waiting for DBLSecureSession response for action=" + action);
  }

  @Test
  public void step1_loginAndPersistSession() throws Exception {
    JSONObject statusBefore = httpGet("/api/auth/status", null);
    JSONArray demoAccounts = statusBefore.optJSONArray("demoAccounts");
    assertNotNull("Expected demoAccounts in /api/auth/status", demoAccounts);
    assertTrue("Expected at least one demo account", demoAccounts.length() > 0);

    String selectedUserId = null;
    for (int i = 0; i < demoAccounts.length(); i++) {
      JSONObject acc = demoAccounts.getJSONObject(i);
      if ("student".equals(acc.optString("role"))) {
        selectedUserId = acc.has("id") ? acc.getString("id") : acc.getString("userId");
        break;
      }
    }
    if (selectedUserId == null) {
      JSONObject first = demoAccounts.getJSONObject(0);
      selectedUserId = first.has("id") ? first.getString("id") : first.getString("userId");
    }

    JSONObject loginBody = new JSONObject();
    loginBody.put("userId", selectedUserId);
    JSONObject loginResp = httpPost("/api/auth/demo-login", loginBody, null);
    String token = loginResp.optString("token", "");
    JSONObject user = loginResp.optJSONObject("user");
    assertFalse("Expected non-empty token from demo-login", token.isEmpty());
    assertNotNull("Expected user object from demo-login", user);

    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      CountDownLatch storeLatch = new CountDownLatch(1);
      AtomicReference<Boolean> storedRef = new AtomicReference<>(false);
      scenario.onActivity(activity -> {
        storedRef.set(activity.encryptAndStoreSessionToken(token));
        storeLatch.countDown();
      });
      assertTrue("Timed out storing token via MainActivity", storeLatch.await(5, TimeUnit.SECONDS));
      assertTrue("encryptAndStoreSessionToken should return true", Boolean.TRUE.equals(storedRef.get()));

      JSONObject getResp = invokeSecureSession(scenario, "get", null);
      assertTrue("DBLSecureSession get should succeed", getResp.optBoolean("ok", false));
      assertEquals("DBLSecureSession should return stored token", token, getResp.optString("token", ""));
    }

    JSONObject statusAfter = httpGet("/api/auth/status", token);
    JSONObject authedUser = statusAfter.optJSONObject("user");
    assertNotNull("Expected authenticated non-null user from /api/auth/status", authedUser);
  }

  @Test
  public void step2_coldRestartRestoresSessionThenLogout() throws Exception {
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      JSONObject getResp = invokeSecureSession(scenario, "get", null);
      assertTrue("DBLSecureSession get after cold restart should succeed", getResp.optBoolean("ok", false));
      String restoredToken = getResp.optString("token", "");
      assertFalse("Expected persisted token to be restored from AndroidKeyStore after force-stop", restoredToken.isEmpty());

      JSONObject statusResp = httpGet("/api/auth/status", restoredToken);
      JSONObject authedUser = statusResp.optJSONObject("user");
      assertNotNull("Expected valid authenticated user on cold restart", authedUser);

      httpPost("/api/auth/logout", new JSONObject(), restoredToken);

      JSONObject clearResp = invokeSecureSession(scenario, "clear", null);
      assertTrue("DBLSecureSession clear should succeed", clearResp.optBoolean("ok", false));
    }
  }

  @Test
  public void step3_coldRestartAfterLogoutDoesNotRestoreSession() throws Exception {
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      JSONObject getResp = invokeSecureSession(scenario, "get", null);
      assertTrue("DBLSecureSession get after logout cold restart should succeed", getResp.optBoolean("ok", false));
      assertEquals("Expected empty string from DBLSecureSession after logout", "", getResp.optString("token", ""));
    }

    JSONObject statusAfterLogout = httpGet("/api/auth/status", null);
    assertTrue("Expected user == null in /api/auth/status without token", statusAfterLogout.isNull("user"));
  }
}
