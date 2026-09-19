package team.nsi.clawmaster.android;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import team.nsi.clawmaster.core.NoteStore;
import team.nsi.clawmaster.core.ConversationStore;
import static org.junit.Assert.*;

/** Runs in a new process after adb install -r, without clearing application data. */
@RunWith(AndroidJUnit4.class)
public final class UpgradeCheck {
    @Test public void updatePreservesReleasedNotesConversationAndEncryptedKey() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("0.2.2", context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName);
        android.content.SharedPreferences fixture = context.getSharedPreferences("upgrade-fixture", Context.MODE_PRIVATE);
        JSONObject note = new NoteStore(context.getFilesDir().toPath().resolve("notes")).read(fixture.getString("note", ""));
        assertEquals("Retain the released note.", note.getString("content"));
        assertEquals(fixture.getString("revision", ""), note.getString("revision"));
        JSONObject session = new ConversationStore(context.getFilesDir().toPath().resolve("conversations")).load(fixture.getString("conversation", ""));
        assertEquals("Retain this conversation.", session.getJSONArray("messages").getJSONObject(0).getString("content"));
        SecureSettings settings = new SecureSettings(context);
        try {
            assertEquals("synthetic-upgrade-key-not-a-provider-credential", settings.key());
            assertEquals("https://example.test/v1", settings.base());
        } finally { settings.removeKey(); }
    }
}
