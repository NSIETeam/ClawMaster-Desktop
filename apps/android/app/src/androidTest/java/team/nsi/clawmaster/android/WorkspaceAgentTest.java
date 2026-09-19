package team.nsi.clawmaster.android;

import android.content.Context;
import androidx.lifecycle.Lifecycle;
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
import team.nsi.clawmaster.core.OfficeDocuments;
import static org.junit.Assert.*;

/** Android framework and shaded Office execution, not a desktop-only parser smoke. */
@RunWith(AndroidJUnit4.class)
public final class WorkspaceAgentTest {
    private AgentController controller() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        return ((ClawMasterApplication) context.getApplicationContext()).controller();
    }
    @Test public void officeFormatsCreateReadEditAndExportOnTheDevice() throws Exception {
        AgentController controller = controller();
        for (String format : new String[]{"docx", "xlsx", "pptx"}) {
            byte[] original = OfficeDocuments.create(format, "Phone report");
            JSONObject file = controller.documents.importFile("Phone-" + java.util.UUID.randomUUID() + "." + format, original);
            JSONObject read = controller.documents.read(file.getString("id"));
            JSONArray changes = new JSONArray().put(new JSONObject().put("key", read.getJSONArray("units").getJSONObject(0).getString("key")).put("text", "Reviewed on phone"));
            controller.documents.edit(new JSONObject().put("id", file.getString("id")).put("expectedRevision", file.getString("revision")).put("changes", changes));
            byte[] exported = controller.documents.bytes(file.getString("id"));
            assertEquals("Reviewed on phone", OfficeDocuments.read(format, exported).getJSONObject(0).getString("text"));
            assertEquals("Phone report", OfficeDocuments.read(format, original).getJSONObject(0).getString("text"));
        }
    }
    @Test public void foregroundServiceKeepsTheTurnAliveAfterActivityStops() throws Exception {
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1), finished = new CountDownLatch(1);
        AgentController controller = controller();
        AgentController.Listener listener = () -> { if ("complete".equals(controller.status())) finished.countDown(); };
        AgentEngine.Model model = new AgentEngine.Model() {
            public JSONObject complete(JSONArray messages, JSONArray tools, AgentEngine.Cancellation token) throws Exception {
                entered.countDown();
                if (!release.await(45, TimeUnit.SECONDS)) throw new AssertionError("Model barrier timeout");
                token.check(); return Json.message("assistant", "Background completed");
            }
            public void cancel() { release.countDown(); }
        };
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                try { controller.newConversation(); controller.send("Read in background", model); controller.observe(listener); }
                catch (Exception failure) { throw new AssertionError(failure); }
            });
            assertTrue(entered.await(30, TimeUnit.SECONDS));
            scenario.moveToState(Lifecycle.State.CREATED);
            assertTrue(controller.running());
            release.countDown();
            assertTrue("Background state: " + controller.status(), finished.await(30, TimeUnit.SECONDS));
            scenario.moveToState(Lifecycle.State.RESUMED);
            assertTrue(controller.snapshot().getJSONArray("messages").toString().contains("Background completed"));
        } finally {
            release.countDown();
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { controller.remove(listener); controller.stop(); });
        }
    }
    @Test public void schedulesAreRegisteredWithAndroidAndCancellationRemovesThem() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        AgentController controller = controller();
        JSONObject task = controller.tasks.create("Fixture report", System.currentTimeMillis() + 3600000, 15);
        try {
            TaskScheduling.reconcile(context, controller.tasks);
            android.app.job.JobInfo job = context.getSystemService(android.app.job.JobScheduler.class).getPendingJob(task.getInt("jobId"));
            assertNotNull(job); assertTrue(job.isPersisted());
            assertEquals(task.getString("id"), job.getExtras().getString("taskId"));
            controller.tasks.cancel(task.getString("id")); TaskScheduling.reconcile(context, controller.tasks);
            assertNull(context.getSystemService(android.app.job.JobScheduler.class).getPendingJob(task.getInt("jobId")));
        } finally { controller.tasks.cancel(task.getString("id")); TaskScheduling.reconcile(context, controller.tasks); }
    }
    @Test public void androidJobExecutesOnceAndLeavesItsConversationReceipt() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        AgentController controller = controller();
        JSONObject task = controller.tasks.create("Read a synthetic report", System.currentTimeMillis(), 0);
        CountDownLatch finished = new CountDownLatch(1);
        java.util.concurrent.atomic.AtomicInteger calls = new java.util.concurrent.atomic.AtomicInteger();
        AgentController.Listener listener = () -> {
            if (!controller.running() && "complete".equals(controller.status()) && task.optString("id").equals(controller.activeTask())) finished.countDown();
        };
        AgentController.ModelFactory original = controller.scheduledModelFactory;
        try {
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
                controller.scheduledModelFactory = () -> new AgentEngine.Model() {
                    public JSONObject complete(JSONArray messages, JSONArray tools, AgentEngine.Cancellation token) throws Exception {
                        calls.incrementAndGet(); return Json.message("assistant", "Scheduled report inspected");
                    }
                    public void cancel() {}
                };
                controller.observe(listener);
            });
            TaskScheduling.reconcile(context, controller.tasks);
            try (android.os.ParcelFileDescriptor command = InstrumentationRegistry.getInstrumentation().getUiAutomation()
                    .executeShellCommand("cmd jobscheduler run -f " + context.getPackageName() + " " + task.getInt("jobId"));
                 java.io.InputStream output = new android.os.ParcelFileDescriptor.AutoCloseInputStream(command)) {
                byte[] buffer = new byte[512]; while (output.read(buffer) != -1) { /* Drain the owned command. */ }
            }
            assertTrue("Scheduled state: " + controller.status(), finished.await(45, TimeUnit.SECONDS));
            assertEquals(1, calls.get());
            JSONObject stored = controller.tasks.read(task.getString("id"));
            assertEquals("complete", stored.getString("state"));
            assertTrue(controller.conversations.load(stored.getString("conversationId")).getJSONArray("messages").toString().contains("Scheduled report inspected"));
        } finally {
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
                controller.remove(listener); controller.stop(); controller.scheduledModelFactory = original;
            });
            controller.tasks.cancel(task.getString("id")); TaskScheduling.reconcile(context, controller.tasks);
        }
    }
}
