package edu.dbl.campus;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import android.webkit.WebView;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class SecureSessionStoreTest {

  private static final String PREFS_NAME = "dbl_campus_secure_session";
  private static final String PREFS_KEY = "encrypted_session_token";

  private SharedPreferences getPrefs() {
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
  }

  @Before
  @After
  public void resetSessionPrefs() {
    getPrefs().edit().clear().commit();
  }

  @Test
  public void storeDecryptAndClearSessionToken() {
    final String testToken = "dbl-test-session-token-987654321";

    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      scenario.onActivity(activity -> {
        assertTrue(activity.encryptAndStoreSessionToken(testToken));

        String rawStored = getPrefs().getString(PREFS_KEY, null);
        assertNotNull(rawStored);
        assertFalse(rawStored.isEmpty());
        assertFalse(rawStored.contains(testToken));

        String decrypted = activity.decryptSessionToken();
        assertEquals(testToken, decrypted);

        assertTrue(activity.clearStoredSessionToken());
        assertFalse(getPrefs().contains(PREFS_KEY));
        assertEquals("", activity.decryptSessionToken());
      });
    }
  }

  @Test
  public void concurrentStoreAndClearDoNotFail() throws Exception {
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      final MainActivity[] holder = new MainActivity[1];
      scenario.onActivity(activity -> holder[0] = activity);
      MainActivity activity = holder[0];
      assertNotNull(activity);

      ExecutorService executor = Executors.newFixedThreadPool(4);
      try {
        List<Callable<Boolean>> tasks = new ArrayList<>();
        for (int i = 0; i < 16; i++) {
          final int index = i;
          tasks.add(() -> {
            if (index % 2 == 0) {
              return activity.encryptAndStoreSessionToken("concurrent-token-" + index);
            }
            return activity.clearStoredSessionToken();
          });
        }

        List<Future<Boolean>> results = executor.invokeAll(tasks);
        for (Future<Boolean> result : results) {
          assertTrue(result.get(10, TimeUnit.SECONDS));
        }
      } finally {
        executor.shutdownNow();
        activity.clearStoredSessionToken();
      }
    }
  }

  @Test
  public void untrustedSubframeCannotAccessSessionToken() throws Exception {
    final String expectedToken = "dbl-subframe-isolation-token-12345";
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      CountDownLatch storeLatch = new CountDownLatch(1);
      scenario.onActivity(activity -> {
        assertTrue(activity.encryptAndStoreSessionToken(expectedToken));
        storeLatch.countDown();
      });
      assertTrue(storeLatch.await(5, TimeUnit.SECONDS));

      long bridgeDeadline = System.currentTimeMillis() + 15000L;
      boolean bridgeReady = false;
      while (System.currentTimeMillis() < bridgeDeadline) {
        AtomicReference<String> readyRef = new AtomicReference<>("");
        CountDownLatch readyLatch = new CountDownLatch(1);
        scenario.onActivity(activity -> {
          WebView wv = activity.getBridge().getWebView();
          if (wv != null) {
            wv.evaluateJavascript(
                "(function(){ return String(typeof window.DBLSecureSession !== 'undefined' && typeof window.DBLNativeBridge !== 'undefined' && window.location && (window.location.origin === ('https://' + 'localhost') || window.location.origin === ('capacitor://' + 'localhost'))); })()",
                value -> {
                  readyRef.set(value);
                  readyLatch.countDown();
                });
          } else {
            readyLatch.countDown();
          }
        });
        readyLatch.await(5, TimeUnit.SECONDS);
        if ("\"true\"".equals(readyRef.get())) {
          bridgeReady = true;
          break;
        }
        Thread.sleep(200);
      }
      assertTrue("Timed out waiting for WebView main frame bridge", bridgeReady);

      AtomicReference<String> bridgeCheckRef = new AtomicReference<>();
      CountDownLatch bridgeCheckLatch = new CountDownLatch(1);
      scenario.onActivity(activity -> activity.getBridge().getWebView().evaluateJavascript(
          "(function(){ return String(typeof window.DBLNativeBridge.getSessionToken === 'undefined'); })()",
          value -> {
            bridgeCheckRef.set(value);
            bridgeCheckLatch.countDown();
          }));
      assertTrue(bridgeCheckLatch.await(5, TimeUnit.SECONDS));
      assertEquals("\"true\"", bridgeCheckRef.get());

      String reqId = UUID.randomUUID().toString();
      JSONObject mainReq = new JSONObject();
      mainReq.put("id", reqId);
      mainReq.put("action", "get");
      CountDownLatch mainSendLatch = new CountDownLatch(1);
      scenario.onActivity(activity -> activity.getBridge().getWebView().evaluateJavascript(
          "(function(){ window.__dblMainGet = null; window.DBLSecureSession.onmessage = function(e){ window.__dblMainGet = e.data; }; window.DBLSecureSession.postMessage("
              + JSONObject.quote(mainReq.toString()) + "); return 'sent'; })()",
          v -> mainSendLatch.countDown()));
      assertTrue(mainSendLatch.await(5, TimeUnit.SECONDS));

      String mainRaw = null;
      long mainDeadline = System.currentTimeMillis() + 10000L;
      while (System.currentTimeMillis() < mainDeadline) {
        AtomicReference<String> ref = new AtomicReference<>();
        CountDownLatch poll = new CountDownLatch(1);
        scenario.onActivity(activity -> activity.getBridge().getWebView().evaluateJavascript(
            "window.__dblMainGet",
            v -> {
              ref.set(v);
              poll.countDown();
            }));
        poll.await(5, TimeUnit.SECONDS);
        if (ref.get() != null && !"null".equals(ref.get())) {
          mainRaw = new JSONObject("{\"v\":" + ref.get() + "}").getString("v");
          break;
        }
        Thread.sleep(100);
      }
      assertNotNull("Main frame DBLSecureSession get timed out", mainRaw);
      JSONObject mainResp = new JSONObject(mainRaw);
      assertTrue(mainResp.optBoolean("ok", false));
      assertEquals(expectedToken, mainResp.optString("token", ""));

      String iframeScript =
          "(function(){"
              + "window.__dblIframeTestResult = null;"
              + "var untrustedDone = false;"
              + "var untrustedResult = null;"
              + "window.addEventListener('message', function(ev){"
              + "  if (ev.data && ev.data.source === 'untrusted-iframe') {"
              + "    untrustedDone = true;"
              + "    untrustedResult = ev.data.payload;"
              + "  }"
              + "});"
              + "var untrusted = document.createElement('iframe');"
              + "untrusted.setAttribute('sandbox', 'allow-scripts');"
              + "untrusted.srcdoc = '<script>if(typeof window.DBLSecureSession===\"undefined\"){parent.postMessage({source:\"untrusted-iframe\",payload:\"undefined\"},\"*\");}else{window.DBLSecureSession.onmessage=function(e){parent.postMessage({source:\"untrusted-iframe\",payload:e.data},\"*\");};window.DBLSecureSession.postMessage(JSON.stringify({id:\"untrusted\",action:\"get\"}));setTimeout(function(){parent.postMessage({source:\"untrusted-iframe\",payload:\"timeout\"},\"*\");},1500);}<\\/script>';"
              + "document.body.appendChild(untrusted);"
              + "var sameOrigin = document.createElement('iframe');"
              + "sameOrigin.src = window.location.origin + '/';"
              + "sameOrigin.onload = function(){"
              + "  var win = sameOrigin.contentWindow;"
              + "  var finish = function(sameOriginPayload){"
              + "    var timer = setInterval(function(){"
              + "      if (untrustedDone) {"
              + "        clearInterval(timer);"
              + "        window.__dblIframeTestResult = JSON.stringify({untrusted: untrustedResult, sameOrigin: sameOriginPayload});"
              + "        untrusted.remove();"
              + "        sameOrigin.remove();"
              + "      }"
              + "    }, 50);"
              + "  };"
              + "  try {"
              + "    if (!win || typeof win.DBLSecureSession === 'undefined') {"
              + "      finish('undefined');"
              + "    } else {"
              + "      var settled = false;"
              + "      win.DBLSecureSession.onmessage = function(e){ if (!settled) { settled = true; finish(e.data); } };"
              + "      win.DBLSecureSession.postMessage(JSON.stringify({id: 'same-origin', action: 'get'}));"
              + "      setTimeout(function(){ if (!settled) { settled = true; finish('timeout'); } }, 1500);"
              + "    }"
              + "  } catch (err) { finish('error:' + err.message); }"
              + "};"
              + "document.body.appendChild(sameOrigin);"
              + "return 'started';"
              + "})()";

      CountDownLatch iframeStartLatch = new CountDownLatch(1);
      scenario.onActivity(activity -> activity.getBridge().getWebView().evaluateJavascript(
          iframeScript, v -> iframeStartLatch.countDown()));
      assertTrue(iframeStartLatch.await(5, TimeUnit.SECONDS));

      String iframeRaw = null;
      long iframeDeadline = System.currentTimeMillis() + 15000L;
      while (System.currentTimeMillis() < iframeDeadline) {
        AtomicReference<String> ref = new AtomicReference<>();
        CountDownLatch poll = new CountDownLatch(1);
        scenario.onActivity(activity -> activity.getBridge().getWebView().evaluateJavascript(
            "window.__dblIframeTestResult",
            v -> {
              ref.set(v);
              poll.countDown();
            }));
        poll.await(5, TimeUnit.SECONDS);
        if (ref.get() != null && !"null".equals(ref.get())) {
          iframeRaw = new JSONObject("{\"v\":" + ref.get() + "}").getString("v");
          break;
        }
        Thread.sleep(100);
      }
      assertNotNull("Timed out waiting for iframe isolation results", iframeRaw);
      JSONObject iframeResults = new JSONObject(iframeRaw);
      String untrustedPayload = iframeResults.optString("untrusted", "");
      String sameOriginPayload = iframeResults.optString("sameOrigin", "");

      assertFalse("Untrusted iframe must not receive session token", untrustedPayload.contains(expectedToken));
      if (untrustedPayload.startsWith("{")) {
        assertFalse("Untrusted iframe DBLSecureSession must be rejected", new JSONObject(untrustedPayload).optBoolean("ok", false));
      }

      assertFalse("Same-origin iframe must not receive session token", sameOriginPayload.contains(expectedToken));
      if (sameOriginPayload.startsWith("{")) {
        assertFalse("Same-origin iframe DBLSecureSession must be rejected", new JSONObject(sameOriginPayload).optBoolean("ok", false));
      }

      CountDownLatch clearLatch = new CountDownLatch(1);
      scenario.onActivity(activity -> {
        activity.clearStoredSessionToken();
        clearLatch.countDown();
      });
      clearLatch.await(5, TimeUnit.SECONDS);
    }
  }
}
