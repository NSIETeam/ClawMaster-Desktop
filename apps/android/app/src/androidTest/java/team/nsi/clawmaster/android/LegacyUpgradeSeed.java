package team.nsi.clawmaster.android;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import team.nsi.clawmaster.core.NoteStore;
import team.nsi.clawmaster.core.ConversationStore;
import team.nsi.clawmaster.core.Json;
import team.nsi.clawmaster.core.AgentEngine;
import static org.junit.Assert.*;

/** Runs against the released 0.2.1 APK before replacement; all fixture values are synthetic. */
@RunWith(AndroidJUnit4.class)
public final class LegacyUpgradeSeed {
    @Test public void seedReleasedStorageAndKeystore() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("0.2.1", context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName);
        NoteStore notes = new NoteStore(context.getFilesDir().toPath().resolve("notes"));
        JSONObject note = notes.write(new JSONObject().put("id", "").put("expectedRevision", "")
            .put("title", "Upgrade fixture").put("content", "Retain the released note."));
        ConversationStore sessions = new ConversationStore(context.getFilesDir().toPath().resolve("conversations"));
        JSONObject conversation = sessions.create();
        AgentEngine.Model model = new AgentEngine.Model() {
            public JSONObject complete(org.json.JSONArray messages, org.json.JSONArray tools, AgentEngine.Cancellation token) throws Exception {
                return Json.message("assistant", "Released conversation reply.");
            }
            public void cancel() {}
        };
        new AgentEngine(model, notes, sessions).run(conversation, "Retain this conversation.", new AgentEngine.Observer() {
            public void changed(JSONObject record, String state) {}
            public boolean approve(JSONObject proposal, AgentEngine.Cancellation token) { return false; }
        }, new AgentEngine.Cancellation());
        new SecureSettings(context).save("https://example.test/v1", "upgrade-fixture", "synthetic-upgrade-key-not-a-provider-credential");
        context.getSharedPreferences("upgrade-fixture", Context.MODE_PRIVATE).edit()
            .putString("note", note.getString("id")).putString("revision", note.getString("revision"))
            .putString("conversation", conversation.getString("id")).commit();
    }
}
