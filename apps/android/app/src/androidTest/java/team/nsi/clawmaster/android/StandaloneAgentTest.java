package team.nsi.clawmaster.android;

import android.content.Context;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import team.nsi.clawmaster.core.AgentEngine;
import team.nsi.clawmaster.core.Json;
import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.action.ViewActions.click;
import static androidx.test.espresso.assertion.ViewAssertions.matches;
import static androidx.test.espresso.matcher.ViewMatchers.withId;
import static androidx.test.espresso.matcher.ViewMatchers.withText;
import static androidx.test.espresso.matcher.ViewMatchers.isDisplayed;
import static androidx.test.espresso.matcher.RootMatchers.isDialog;
import static org.junit.Assert.*;
import static org.hamcrest.Matchers.containsString;

/** Exercises the release Activity, real phone storage and native approval dialog. */
@RunWith(AndroidJUnit4.class)
public final class StandaloneAgentTest {
    private static final class RecordedModel implements AgentEngine.Model {
        int calls;
        final String title;
        JSONArray continuation;
        RecordedModel(String title) { this.title = title; }
        @Override public JSONObject complete(JSONArray messages, JSONArray tools, AgentEngine.Cancellation cancelled) throws Exception {
            if (++calls == 1) return new JSONObject().put("role", "assistant").put("content", JSONObject.NULL)
                .put("tool_calls", new JSONArray().put(new JSONObject().put("id", "phone-call").put("type", "function")
                    .put("function", new JSONObject().put("name", "notes_write").put("arguments", new JSONObject()
                        .put("id", "").put("expectedRevision", "").put("title", title).put("content", "Stored independently on Android.").toString()))));
            continuation = Json.copy(messages);
            return Json.message("assistant", "Recorded mobile turn completed.");
        }
        @Override public void cancel() {}
    }

    private AgentController controller() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        return ((ClawMasterApplication) context.getApplicationContext()).controller();
    }

    private void awaitState(AgentController controller, String expected) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AgentController.Listener listener = () -> { if (expected.equals(controller.status())) latch.countDown(); };
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> controller.observe(listener));
        try { assertTrue("Agent state: " + controller.status(), latch.await(15, TimeUnit.SECONDS)); }
        finally { InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> controller.remove(listener)); }
    }

    @Test public void approvalSurvivesActivityRecreationAndStoresARealNote() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            AgentController controller = controller();
            RecordedModel model = new RecordedModel("Release persistence");
            scenario.onActivity(activity -> {
                try { controller.newConversation(); controller.send("Save a local note", model); }
                catch (Exception e) { throw new AssertionError(e); }
            });
            awaitState(controller, "waiting_approval");
            scenario.recreate();
            onView(withText(R.string.approve)).inRoot(isDialog()).perform(click());
            awaitState(controller, "complete");
            assertEquals(2, model.calls);
            assertTrue(model.continuation.toString().contains("revision"));
            assertTrue(controller.notes.search("Release persistence").length() > 0);
            scenario.recreate();
            onView(withText(containsString("Recorded mobile turn completed."))).check(matches(isDisplayed()));
            onView(withId(R.id.tab_notes)).perform(click());
        }
    }

    @Test public void rejectedWriteNeverReachesPhoneStorage() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            AgentController controller = controller();
            String title = "Rejected-" + java.util.UUID.randomUUID();
            RecordedModel model = new RecordedModel(title);
            scenario.onActivity(activity -> {
                try { controller.newConversation(); controller.send("Propose a note", model); }
                catch (Exception e) { throw new AssertionError(e); }
            });
            awaitState(controller, "waiting_approval");
            onView(withText(R.string.reject)).inRoot(isDialog()).perform(click());
            awaitState(controller, "complete");
            assertEquals(0, controller.notes.search(title).length());
            assertTrue(model.continuation.toString().contains("user_rejected"));
        }
    }

    @Test public void cancellingAPendingApprovalCannotCommit() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            AgentController controller = controller();
            String title = "Cancelled-" + java.util.UUID.randomUUID();
            scenario.onActivity(activity -> {
                try { controller.newConversation(); controller.send("Propose", new RecordedModel(title)); }
                catch (Exception e) { throw new AssertionError(e); }
            });
            awaitState(controller, "waiting_approval");
            scenario.onActivity(activity -> controller.stop());
            awaitState(controller, "stopped");
            assertEquals(0, controller.notes.search(title).length());
        }
    }

    @Test public void credentialsAreEncryptedAndRecoverableOnlyThroughTheKeystore() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        SecureSettings settings = new SecureSettings(context);
        String secret = "test-only-" + java.util.UUID.randomUUID();
        try {
            settings.save("https://example.test/v1", "recorded-model", secret);
            assertFalse(context.getSharedPreferences("model", Context.MODE_PRIVATE).getAll().toString().contains(secret));
            assertEquals(secret, new SecureSettings(context).key());
            assertThrows(Exception.class, () -> settings.save("http://example.test", "model", secret));
            assertEquals("https://example.test/v1", settings.base());
        } finally { settings.removeKey(); }
    }

    @Test public void documentApprovalShowsItsContentBeforeCreatingTheWordFile() throws Exception {
        AgentController controller = controller();
        String name = "Approved-" + java.util.UUID.randomUUID();
        java.util.concurrent.atomic.AtomicInteger calls = new java.util.concurrent.atomic.AtomicInteger();
        AgentEngine.Model model = new AgentEngine.Model() {
            public JSONObject complete(JSONArray messages, JSONArray tools, AgentEngine.Cancellation token) throws Exception {
                if (calls.incrementAndGet() == 1) return new JSONObject().put("role", "assistant").put("content", JSONObject.NULL)
                    .put("tool_calls", new JSONArray().put(new JSONObject().put("id", "document-call").put("type", "function")
                        .put("function", new JSONObject().put("name", "documents_create").put("arguments", new JSONObject()
                            .put("name", name).put("format", "docx").put("content", "Review this document content.").toString()))));
                return Json.message("assistant", "Document created after approval.");
            }
            public void cancel() {}
        };
        int previousCount = controller.documents.list().length();
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                try { controller.newConversation(); controller.send("Create a Word report", model); }
                catch (Exception failure) { throw new AssertionError(failure); }
            });
            awaitState(controller, "waiting_approval");
            assertEquals(previousCount, controller.documents.list().length());
            scenario.recreate();
            onView(withText(containsString(name + ".docx"))).inRoot(isDialog()).check(matches(isDisplayed()));
            onView(withText(containsString("Review this document content."))).inRoot(isDialog()).check(matches(isDisplayed()));
            onView(withText(R.string.approve)).inRoot(isDialog()).perform(click());
            awaitState(controller, "complete");
            assertEquals(2, calls.get());
            JSONArray files = controller.documents.list();
            assertEquals(previousCount + 1, files.length());
            boolean found = false;
            for (int i = 0; i < files.length(); i++) {
                JSONObject file = files.getJSONObject(i);
                if ((name + ".docx").equals(file.getString("name"))) {
                    assertEquals("Review this document content.", controller.documents.read(file.getString("id"))
                        .getJSONArray("units").getJSONObject(0).getString("text"));
                    found = true;
                }
            }
            assertTrue(found);
        } finally { InstrumentationRegistry.getInstrumentation().runOnMainSync(controller::stop); }
    }
}
