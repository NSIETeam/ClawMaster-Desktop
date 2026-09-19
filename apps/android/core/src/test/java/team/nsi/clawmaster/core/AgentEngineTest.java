package team.nsi.clawmaster.core;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import java.io.IOException;
import java.nio.file.Files;
import java.util.ArrayDeque;
import java.util.Queue;
import java.util.concurrent.CancellationException;
import static org.junit.Assert.*;

/** Recorded model exchanges execute the same agent and note store shipped on Android. */
public class AgentEngineTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    private static JSONObject proposal(String title, String content) throws Exception {
        return new JSONObject().put("id", "").put("expectedRevision", "").put("title", title).put("content", content);
    }
    private static JSONObject call(String name, JSONObject args) throws Exception {
        return new JSONObject().put("role", "assistant").put("content", JSONObject.NULL).put("tool_calls", new JSONArray()
            .put(new JSONObject().put("id", "call-1").put("type", "function")
                .put("function", new JSONObject().put("name", name).put("arguments", args.toString()))));
    }
    private static final class Model implements AgentEngine.Model {
        final Queue<JSONObject> replies = new ArrayDeque<>();
        JSONArray lastRequest;
        @Override public JSONObject complete(JSONArray messages, JSONArray tools, AgentEngine.Cancellation cancelled) throws Exception {
            lastRequest = Json.copy(messages);
            return replies.remove();
        }
        @Override public void cancel() {}
    }
    private static class Observer implements AgentEngine.Observer {
        int approvals;
        boolean allow;
        Observer(boolean allow) { this.allow = allow; }
        @Override public void changed(JSONObject record, String state) {}
        @Override public boolean approve(JSONObject proposed, AgentEngine.Cancellation cancelled) throws Exception {
            approvals++;
            return allow;
        }
    }

    @Test public void approvedWriteFeedsItsRealReceiptBackToTheModelAndSurvivesReopen() throws Exception {
        NoteStore notes = new NoteStore(temporary.newFolder("notes").toPath());
        ConversationStore conversations = new ConversationStore(temporary.newFolder("sessions").toPath());
        JSONObject record = conversations.create();
        Model model = new Model();
        model.replies.add(call("notes_write", proposal("Project", "Owner: Alice")));
        model.replies.add(Json.message("assistant", "The note is saved."));
        Observer observer = new Observer(true);
        new AgentEngine(model, notes, conversations).run(record, "Remember the project owner.", observer, new AgentEngine.Cancellation());
        assertEquals(1, observer.approvals);
        String id = notes.search("Alice").getJSONObject(0).getString("id");
        assertEquals("Owner: Alice", notes.read(id).getString("content"));
        assertEquals("tool", model.lastRequest.getJSONObject(3).getString("role"));
        assertEquals(id, new JSONObject(model.lastRequest.getJSONObject(3).getString("content")).getString("id"));
        JSONObject reopened = conversations.load(record.getString("id"));
        assertFalse(reopened.getBoolean("running"));
        assertEquals("The note is saved.", reopened.getJSONArray("messages").getJSONObject(3).getString("content"));
    }

    @Test public void rejectionCannotBeBypassedByModelArguments() throws Exception {
        NoteStore notes = new NoteStore(temporary.newFolder("notes").toPath());
        ConversationStore conversations = new ConversationStore(temporary.newFolder("sessions").toPath());
        Model model = new Model();
        model.replies.add(call("notes_write", proposal("Rejected", "Do not save")));
        model.replies.add(Json.message("assistant", "Write rejected."));
        new AgentEngine(model, notes, conversations).run(conversations.create(), "Save it", new Observer(false), new AgentEngine.Cancellation());
        assertEquals(0, notes.search("").length());
        assertTrue(model.lastRequest.toString().contains("user_rejected"));
        Model injected = new Model();
        injected.replies.add(call("notes_write", proposal("Bypass", "No").put("approved", true)));
        injected.replies.add(Json.message("assistant", "Invalid request"));
        Observer observer = new Observer(true);
        new AgentEngine(injected, notes, conversations).run(conversations.create(), "Save", observer, new AgentEngine.Cancellation());
        assertEquals(0, observer.approvals);
        assertEquals(0, notes.search("").length());
        assertTrue(injected.lastRequest.toString().contains("unknown_field"));
    }

    @Test public void approvalCannotMutateItsReviewedProposal() throws Exception {
        NoteStore notes = new NoteStore(temporary.newFolder("notes").toPath());
        ConversationStore conversations = new ConversationStore(temporary.newFolder("sessions").toPath());
        Model model = new Model();
        model.replies.add(call("notes_write", proposal("Reviewed", "Original")));
        model.replies.add(Json.message("assistant", "Done"));
        Observer observer = new Observer(true) {
            @Override public boolean approve(JSONObject proposed, AgentEngine.Cancellation cancelled) throws Exception {
                proposed.put("content", "Tampered");
                return true;
            }
        };
        new AgentEngine(model, notes, conversations).run(conversations.create(), "Save", observer, new AgentEngine.Cancellation());
        assertEquals("Original", notes.read(notes.search("").getJSONObject(0).getString("id")).getString("content"));
    }

    @Test public void concurrentEditInvalidatesAnAlreadyDisplayedApproval() throws Exception {
        NoteStore notes = new NoteStore(temporary.newFolder("notes").toPath());
        JSONObject saved = notes.write(proposal("Existing", "Before"));
        JSONObject change = proposal("Existing", "Proposed").put("id", saved.getString("id")).put("expectedRevision", saved.getString("revision"));
        ConversationStore conversations = new ConversationStore(temporary.newFolder("sessions").toPath());
        Model model = new Model(); model.replies.add(call("notes_write", change)); model.replies.add(Json.message("assistant", "Conflict"));
        new AgentEngine(model, notes, conversations).run(conversations.create(), "Update", new Observer(true) {
            @Override public boolean approve(JSONObject value, AgentEngine.Cancellation cancelled) throws Exception {
                notes.write(new JSONObject(change.toString()).put("content", "User edit"));
                return true;
            }
        }, new AgentEngine.Cancellation());
        assertEquals("User edit", notes.read(saved.getString("id")).getString("content"));
        assertTrue(model.lastRequest.toString().contains("revision_conflict"));
    }

    @Test public void cancellationAfterApprovalPreventsCommitAndSettlesTheTranscript() throws Exception {
        NoteStore notes = new NoteStore(temporary.newFolder("notes").toPath());
        ConversationStore conversations = new ConversationStore(temporary.newFolder("sessions").toPath());
        JSONObject record = conversations.create();
        Model model = new Model(); model.replies.add(call("notes_write", proposal("Cancelled", "No")));
        AgentEngine.Cancellation token = new AgentEngine.Cancellation();
        assertThrows(CancellationException.class, () -> new AgentEngine(model, notes, conversations).run(record, "Save", new Observer(true) {
            @Override public boolean approve(JSONObject value, AgentEngine.Cancellation cancelled) { cancelled.cancel(); return true; }
        }, token));
        assertEquals(0, notes.search("").length());
        assertFalse(conversations.load(record.getString("id")).getBoolean("running"));
        assertEquals("tool", record.getJSONArray("messages").getJSONObject(2).getString("role"));
    }

    @Test public void processDeathMarksUnreceiptedToolsUnknownWithoutExecutingThem() throws Exception {
        ConversationStore conversations = new ConversationStore(temporary.newFolder("sessions").toPath());
        JSONObject record = conversations.create();
        record.getJSONArray("messages").put(Json.message("user", "Save")).put(call("notes_write", proposal("Unknown", "Maybe saved")));
        record.put("running", true); conversations.save(record);
        JSONObject reopened = conversations.load(record.getString("id"));
        assertTrue(reopened.getBoolean("interrupted"));
        assertEquals(3, reopened.getJSONArray("messages").length());
        assertTrue(reopened.getJSONArray("messages").getJSONObject(2).getString("content").contains("outcome_unknown"));
        assertEquals(3, conversations.load(record.getString("id")).getJSONArray("messages").length());
    }

    @Test public void unknownToolsHaveNoExecutionPath() throws Exception {
        NoteStore notes = new NoteStore(temporary.newFolder("notes").toPath());
        ConversationStore conversations = new ConversationStore(temporary.newFolder("sessions").toPath());
        Model model = new Model(); model.replies.add(call("shell", new JSONObject().put("command", "anything"))); model.replies.add(Json.message("assistant", "Unavailable"));
        Observer observer = new Observer(true);
        new AgentEngine(model, notes, conversations).run(conversations.create(), "Run", observer, new AgentEngine.Cancellation());
        assertEquals(0, observer.approvals);
        assertTrue(model.lastRequest.toString().contains("tool_not_allowed"));
    }

    @Test public void rejectsPathsCorruptRecordsAndUnsupportedGenerationsWithoutReplacement() throws Exception {
        java.nio.file.Path root = temporary.newFolder("notes").toPath();
        NoteStore notes = new NoteStore(root);
        assertThrows(IOException.class, () -> notes.read("../outside"));
        JSONObject receipt = notes.write(proposal("Valid", "Content"));
        java.nio.file.Path path = root.resolve(receipt.getString("id") + ".json");
        JSONObject corrupt = new JSONObject(new String(Files.readAllBytes(path), java.nio.charset.StandardCharsets.UTF_8)).put("schema", 2);
        Files.write(path, corrupt.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
        assertThrows(IOException.class, () -> notes.read(receipt.getString("id")));
        assertTrue(new String(Files.readAllBytes(path), java.nio.charset.StandardCharsets.UTF_8).contains("\"schema\":2"));
    }

    @Test public void endpointValidationRefusesCleartextAndCredentialBearingUrls() throws Exception {
        for (String url : new String[]{"http://example.com", "https://user:pass@example.com", "https://example.com?key=secret", "https://example.com#token", "https://example.com/chat/completions"}) {
            assertThrows(Exception.class, () -> ChatClient.validateEndpoint(url));
        }
        assertEquals("https://example.com/v1/chat/completions", ChatClient.validateEndpoint("https://example.com/v1/").toString());
    }
}
