package team.nsi.clawmaster.android;

import android.content.Context;
import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

/** Proves the release Activity renders the shared desktop ClawMaster client from local DSH. */
@RunWith(AndroidJUnit4.class)
public final class DshParityTest {
    @Test(timeout = 55 * 60 * 1000)
    public void releaseApkStartsLocalDshAndRendersDesktopClientAcrossHostRestarts() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        try (java.io.InputStream harness = context.getAssets().open("dsh/harness.zip");
             java.io.InputStream npm = context.getAssets().open("dsh/npm.zip")) {
            assertTrue(harness.read() >= 0);
            assertTrue(npm.read() >= 0);
        }
        try (ActivityScenario<DshActivity> scenario = ActivityScenario.launch(DshActivity.class)) {
            JSONObject initial = awaitDesktopClient(scenario, TimeUnit.MINUTES.toMillis(52));
            assertDesktopProfile(context);
            int firstPort = localPort(initial);
            assertTrue("desktop client must render branded content", initial.getString("body").contains("ClawMaster"));
            assertTrue("shared ClawMaster WatchDog workbench must mount", initial.getString("body").contains("WatchDog"));

            scenario.recreate();
            JSONObject recreated = awaitDesktopClient(scenario, TimeUnit.MINUTES.toMillis(2));
            assertEquals("Activity recreation must reuse the running local host", firstPort, localPort(recreated));

            context.startService(new android.content.Intent(context, DshRuntimeService.class)
                .setAction(DshRuntimeService.ACTION_STOP));
            assertTrue("runtime stop was not reflected in the Activity", awaitStatus(scenario, R.string.dsh_stopped, 15));
            androidx.test.espresso.Espresso.onView(androidx.test.espresso.matcher.ViewMatchers.withId(R.id.dsh_retry))
                .perform(androidx.test.espresso.action.ViewActions.click());
            assertTrue("runtime restart did not become ready", awaitStatus(scenario, R.string.dsh_ready, 5 * 60));
            scenario.onActivity(activity -> ((WebView) activity.findViewById(R.id.dsh_web_view)).reload());
            JSONObject restarted = awaitDesktopClient(scenario, TimeUnit.MINUTES.toMillis(2));
            assertEquals("restarted DSH must continue serving the desktop client", "ClawMaster", restarted.getString("title"));
        }
    }

    private static void assertDesktopProfile(Context context) throws Exception {
        java.io.File manifest = new java.io.File(context.getFilesDir(),
            "clawmaster-dsh/home/profiles/web/package.json");
        JSONObject profile = new JSONObject(java.nio.file.Files.readString(manifest.toPath(), java.nio.charset.StandardCharsets.UTF_8))
            .getJSONObject("dsh").getJSONObject("profile");
        JSONArray bundles = profile.getJSONArray("bundles");
        String[] expected = {
            "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
            "@xmanrui/dsh-im", "dsh-better-sidebar", "@nanmicoder/dsh-agent-teams",
            "@openviking/dsh-memory-plugin", "dsh-routing-suite", "@clawmaster/dsh-desktop-policy",
            "@clawmaster/dsh-frontend", "@clawmaster/dsh-guard", "@clawmaster/dsh-notes",
            "@clawmaster/dsh-graph-memory", "@clawmaster/dsh-office", "@clawmaster/dsh-rpa",
            "@clawmaster/dsh-updates"
        };
        assertEquals("Android must install the desktop default bundle list", expected.length, bundles.length());
        for (int index = 0; index < expected.length; index++) {
            assertEquals("desktop bundle order at index " + index, expected[index], bundles.getString(index));
        }
    }

    private static JSONObject awaitDesktopClient(ActivityScenario<DshActivity> scenario, long timeoutMs) throws Exception {
        long deadline = android.os.SystemClock.elapsedRealtime() + timeoutMs;
        AtomicReference<JSONObject> result = new AtomicReference<>();
        while (android.os.SystemClock.elapsedRealtime() < deadline) {
            CountDownLatch evaluated = new CountDownLatch(1);
            scenario.onActivity(activity -> {
                WebView web = activity.findViewById(R.id.dsh_web_view);
                web.evaluateJavascript("JSON.stringify({title:document.title,href:location.href,body:document.body?.innerText||'',workbench:!!document.querySelector('#root .cm-dsh-workbench')})", value -> {
                    try {
                        Object decoded = new JSONTokener(value).nextValue();
                        if (decoded instanceof String) {
                            JSONObject candidate = new JSONObject((String) decoded);
                            if ("ClawMaster".equals(candidate.optString("title"))
                                && candidate.optString("href").startsWith("http://127.0.0.1:")
                                && candidate.optBoolean("workbench")
                                && candidate.optString("body").contains("WatchDog")
                                && candidate.optString("body").contains("ClawMaster")) result.set(candidate);
                        }
                    } catch (Exception ignored) {
                        // The app shell has not mounted yet; the next WebView poll observes its current DOM.
                    }
                    evaluated.countDown();
                });
            });
            if (!evaluated.await(1, TimeUnit.SECONDS)) continue;
            JSONObject ready = result.get();
            if (ready != null) return ready;
            String status = statusText(scenario);
            Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
            assertNotEquals("DSH startup failed: " + status, context.getString(R.string.dsh_start_failed), status);
            assertNotEquals("DSH host stopped: " + status, context.getString(R.string.dsh_host_stopped), status);
        }
        fail("Timed out waiting for ClawMaster desktop DOM; status=" + statusText(scenario));
        throw new AssertionError("unreachable");
    }

    private static int localPort(JSONObject dom) throws Exception {
        String authority = android.net.Uri.parse(dom.getString("href")).getAuthority();
        return android.net.Uri.parse("http://" + authority).getPort();
    }

    private static String statusText(ActivityScenario<DshActivity> scenario) {
        AtomicReference<String> value = new AtomicReference<>("");
        scenario.onActivity(activity -> {
            android.widget.TextView status = activity.findViewById(R.id.dsh_runtime_status);
            value.set(status.getText().toString());
        });
        return value.get();
    }

    private static boolean awaitStatus(ActivityScenario<DshActivity> scenario, int expected, int timeoutSeconds) throws Exception {
        long deadline = android.os.SystemClock.elapsedRealtime() + TimeUnit.SECONDS.toMillis(timeoutSeconds);
        while (android.os.SystemClock.elapsedRealtime() < deadline) {
            AtomicReference<String> value = new AtomicReference<>("");
            scenario.onActivity(activity -> value.set(((android.widget.TextView) activity.findViewById(R.id.dsh_runtime_status)).getText().toString()));
            if (scenario.getState() == androidx.lifecycle.Lifecycle.State.DESTROYED) return false;
            if (InstrumentationRegistry.getInstrumentation().getTargetContext().getString(expected).contentEquals(value.get())) return true;
            Thread.sleep(250);
        }
        return false;
    }
}
