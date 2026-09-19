package team.nsi.clawmaster.core;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import static org.junit.Assert.*;

/** Recorded model requests cross a store reopen before a real Office write is authorized. */
public final class DurableApprovalTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();
    private final AgentEngine.Observer background = new AgentEngine.Observer() {
        public void changed(JSONObject record, String operation) {}
        public boolean approve(JSONObject proposal, AgentEngine.Cancellation cancellation) throws Exception { throw new AgentEngine.ApprovalDeferred(proposal); }
    };
    private static final class Model implements AgentEngine.Model {
        int calls;
        JSONArray continuation;
        public JSONObject complete(JSONArray messages, JSONArray tools, AgentEngine.Cancellation token) throws Exception {
            if (++calls > 1) { continuation = messages; return Json.message("assistant", "Reviewed outcome."); }
            return Json.message("assistant", "Create a report").put("tool_calls", new JSONArray().put(new JSONObject().put("id", "office-1").put("type", "function")
                .put("function", new JSONObject().put("name", "documents_create").put("arguments", "{\"name\":\"Report\",\"format\":\"docx\",\"content\":\"Reviewed report\"}"))));
        }
        public void cancel() {}
    }
    @Test public void pendingOfficeWriteSurvivesReopenAndCommitsExactlyOnceAfterReview() throws Exception { scenario(true); }
    @Test public void rejectedOfficeWriteProducesAReceiptButNoDocument() throws Exception { scenario(false); }
    private void scenario(boolean allow) throws Exception {
        NoteStore notes = new NoteStore(temporary.newFolder("notes").toPath());
        java.nio.file.Path sessions = temporary.newFolder("sessions").toPath();
        ConversationStore conversations = new ConversationStore(sessions);
        DocumentStore documents = new DocumentStore(temporary.newFolder("documents").toPath());
        JSONObject record = conversations.create(); Model model = new Model();
        AgentEngine engine = new AgentEngine(model, notes, conversations, documents);
        engine.run(record, "Make the report", background, new AgentEngine.Cancellation());
        assertEquals(0, documents.list().length()); assertEquals(1, model.calls);
        JSONObject reopened = new ConversationStore(sessions).load(record.getString("id"));
        assertTrue(reopened.has("pendingApproval"));
        assertThrows(Exception.class, () -> engine.run(reopened, "Skip approval", background, new AgentEngine.Cancellation()));
        engine.resume(reopened, allow, background, new AgentEngine.Cancellation());
        assertEquals(allow ? 1 : 0, documents.list().length());
        assertFalse(reopened.has("pendingApproval"));
        assertThrows(Exception.class, () -> engine.resume(reopened, allow, background, new AgentEngine.Cancellation()));
        assertEquals(2, model.calls);
        JSONObject receipt = new JSONObject(model.continuation.getJSONObject(3).getString("content"));
        if (allow) assertEquals("Reviewed report", documents.read(receipt.getString("id")).getJSONArray("units").getJSONObject(0).getString("text"));
        else assertEquals("user_rejected", receipt.getString("error"));
    }
    @Test public void cancelledPersistedApprovalDoesNotNeedAModelRequest() throws Exception {
        NoteStore notes = new NoteStore(temporary.newFolder("notes").toPath());
        ConversationStore sessions = new ConversationStore(temporary.newFolder("sessions").toPath());
        DocumentStore documents = new DocumentStore(temporary.newFolder("documents").toPath());
        JSONObject record = sessions.create(); Model model = new Model(); AgentEngine engine = new AgentEngine(model, notes, sessions, documents);
        engine.run(record, "Make report", background, new AgentEngine.Cancellation()); engine.cancelPending(record);
        assertEquals(0, documents.list().length()); assertEquals(1, model.calls);
        assertFalse(sessions.load(record.getString("id")).has("pendingApproval"));
    }
    @Test public void crashDuringApprovalCommitIsUnknownNotAnotherApproval() throws Exception {
        NoteStore notes = new NoteStore(temporary.newFolder("notes").toPath());
        ConversationStore sessions = new ConversationStore(temporary.newFolder("sessions").toPath());
        DocumentStore documents = new DocumentStore(temporary.newFolder("documents").toPath());
        JSONObject record = sessions.create(); AgentEngine engine = new AgentEngine(new Model(), notes, sessions, documents);
        engine.run(record, "Make report", background, new AgentEngine.Cancellation());
        record.getJSONObject("pendingApproval").put("state", "committing"); record.put("running", true); sessions.save(record);
        JSONObject reopened = sessions.load(record.getString("id"));
        assertFalse(reopened.has("pendingApproval")); assertTrue(reopened.getBoolean("interrupted"));
        assertTrue(reopened.getJSONArray("messages").toString().contains("outcome_unknown"));
        assertEquals(0, documents.list().length());
    }
    @Test public void existingConversationGetsWorkspaceToolsWithoutLosingItsRecordedContext() throws Exception {
        NoteStore notes = new NoteStore(temporary.newFolder("notes").toPath());
        ConversationStore sessions = new ConversationStore(temporary.newFolder("sessions").toPath());
        DocumentStore documents = new DocumentStore(temporary.newFolder("documents").toPath());
        JSONObject record = sessions.create().put("systemPrompt", "Released note-only context").put("tools", AgentEngine.toolSchemas());
        record.getJSONArray("messages").put(Json.message("user", "Old message")).put(Json.message("assistant", "Old response"));
        sessions.save(record);
        new AgentEngine(new Model(), notes, sessions, documents).run(record, "Make a report", background, new AgentEngine.Cancellation());
        JSONObject restored = sessions.load(record.getString("id"));
        assertEquals(7, restored.getJSONArray("tools").length());
        JSONObject previous = restored.getJSONArray("contextHistory").getJSONObject(0);
        assertEquals(2, previous.getInt("endMessageIndex"));
        assertEquals("Released note-only context", previous.getString("systemPrompt"));
        assertEquals(3, previous.getJSONArray("tools").length());
        assertEquals("Old message", restored.getJSONArray("messages").getJSONObject(0).getString("content"));
        assertTrue(restored.has("pendingApproval"));
    }
}
