package edu.dbl.campus;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
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
}
