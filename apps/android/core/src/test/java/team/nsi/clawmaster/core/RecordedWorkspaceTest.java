package team.nsi.clawmaster.core;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import static org.junit.Assert.*;

/** Owner-local mobile transcript replay includes the durable approval stop and a store reopen. */
public final class RecordedWorkspaceTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();
    @Test public void replayRejectedOfficeCreationMatchesTheRecordedTranscriptAndWorkspace() throws Exception {
        JSONObject fixture;
        try (InputStream input = getClass().getResourceAsStream("/office-approval-rejected.json")) {
            assertNotNull(input);
            fixture = new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
        }
        NoteStore notes = new NoteStore(temporary.newFolder("notes").toPath());
        ConversationStore sessions = new ConversationStore(temporary.newFolder("conversations").toPath());
        DocumentStore documents = new DocumentStore(temporary.newFolder("documents").toPath());
        AgentEngine.Model recorded = new AgentEngine.Model() {
            int index;
            public JSONObject complete(JSONArray messages, JSONArray tools, AgentEngine.Cancellation token) throws Exception {
                JSONArray names = new JSONArray();
                for (int i = 0; i < tools.length(); i++) names.put(tools.getJSONObject(i).getJSONObject("function").getString("name"));
                assertTrue(fixture.getJSONArray("expectedToolNames").similar(names));
                if (index == 1) assertEquals("{\"error\":\"user_rejected\"}", messages.getJSONObject(messages.length() - 1).getString("content"));
                return new JSONObject(fixture.getJSONArray("modelReplies").getJSONObject(index++).toString());
            }
            public void cancel() {}
        };
        AgentEngine.Observer observer = new AgentEngine.Observer() {
            public void changed(JSONObject record, String state) {}
            public boolean approve(JSONObject proposal, AgentEngine.Cancellation token) throws Exception { throw new AgentEngine.ApprovalDeferred(proposal); }
        };
        JSONObject conversation = sessions.create();
        AgentEngine engine = new AgentEngine(recorded, notes, sessions, documents);
        engine.run(conversation, fixture.getString("prompt"), observer, new AgentEngine.Cancellation());
        assertTrue(conversation.has("pendingApproval"));
        JSONObject reopened = sessions.load(conversation.getString("id"));
        engine.resume(reopened, false, observer, new AgentEngine.Cancellation());
        assertTrue(fixture.getJSONArray("expectedMessages").similar(sessions.load(conversation.getString("id")).getJSONArray("messages")));
        assertEquals(0, documents.list().length());
        assertEquals(0, notes.search("").length());
    }
}
