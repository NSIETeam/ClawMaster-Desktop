package team.nsi.clawmaster.android;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.view.View;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;
import java.io.FileOutputStream;
import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.assertion.ViewAssertions.matches;
import static androidx.test.espresso.matcher.ViewMatchers.withId;
import static androidx.test.espresso.matcher.ViewMatchers.isDisplayed;
import static org.junit.Assert.*;

/** A separate instrumentation process verifies data from the preceding installed-app run. */
@RunWith(AndroidJUnit4.class)
public final class ColdStartCheck {
    @Test public void committedNoteAndToolReceiptSurviveForceStop() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        AgentController controller = ((ClawMasterApplication) context.getApplicationContext()).controller();
        assertFalse(controller.running());
        assertNull(controller.approval());
        assertEquals(1, controller.notes.search("Release persistence").length());
        String conversationId = null;
        for (JSONObject record : controller.conversations.list()) {
            String messages = record.getJSONArray("messages").toString();
            if (messages.contains("Release persistence") && messages.contains("revision")) {
                assertTrue(messages.contains("Recorded mobile turn completed."));
                assertFalse(record.getBoolean("running"));
                conversationId = record.getString("id");
            }
        }
        assertNotNull("The approved write and its receipt must remain in phone storage", conversationId);
        String savedId = conversationId;
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                try { controller.open(savedId); }
                catch (Exception e) { throw new AssertionError(e); }
            });
            onView(withId(R.id.messages)).check(matches(isDisplayed()));
            scenario.onActivity(activity -> {
                View view = activity.getWindow().getDecorView();
                Bitmap bitmap = Bitmap.createBitmap(view.getWidth(), view.getHeight(), Bitmap.Config.ARGB_8888);
                try (FileOutputStream output = new FileOutputStream(new File(activity.getExternalFilesDir(null), "release-screen.png"))) {
                    view.draw(new Canvas(bitmap));
                    assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output));
                } catch (Exception e) { throw new AssertionError(e); }
                finally { bitmap.recycle(); }
            });
        }
    }
}
