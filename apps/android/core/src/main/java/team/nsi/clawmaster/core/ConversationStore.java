package team.nsi.clawmaster.core;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import java.util.stream.Stream;

/** Versioned model transcript records; interrupted tools never replay on startup. */
public final class ConversationStore {
    private final Path root;
    public ConversationStore(Path root) throws IOException {
        this.root = Files.createDirectories(root).toRealPath();
    }

    public synchronized JSONObject create() throws Exception {
        JSONObject record = new JSONObject().put("schema", 1).put("id", UUID.randomUUID().toString())
            .put("messages", new JSONArray()).put("running", false).put("updatedAt", System.currentTimeMillis());
        save(record);
        return record;
    }

    public synchronized void save(JSONObject record) throws Exception {
        if (record.getInt("schema") != 1) throw new IOException("unsupported_conversation");
        record.put("updatedAt", System.currentTimeMillis());
        LocalFiles.write(LocalFiles.record(root, record.getString("id")), record);
    }

    public synchronized JSONObject load(String id) throws Exception {
        JSONObject record = LocalFiles.read(LocalFiles.record(root, id));
        if (record.getInt("schema") != 1 || !id.equals(record.getString("id"))) throw new IOException("unsupported_conversation");
        JSONArray messages = record.getJSONArray("messages");
        if (messages.length() > 1000) throw new IOException("conversation_limit");
        if (record.getBoolean("running")) {
            // A crash can occur after a note commit but before its receipt is saved.
            // Missing receipts are unknown outcomes, never permission to repeat a write.
            JSONObject approval = record.optJSONObject("pendingApproval");
            if (approval == null || !"awaiting".equals(approval.optString("state"))) {
                AgentEngine.settlePendingTools(messages);
                record.remove("pendingApproval");
            }
            record.put("running", false).put("interrupted", true);
            save(record);
        }
        return record;
    }

    public synchronized List<JSONObject> list() throws Exception {
        List<JSONObject> records = new ArrayList<>();
        try (Stream<Path> files = Files.list(root)) {
            for (Path file : (Iterable<Path>) files.filter(p -> p.toString().endsWith(".json")).limit(1001)::iterator) {
                JSONObject record = LocalFiles.read(file);
                if (record.getInt("schema") != 1) throw new IOException("unsupported_conversation");
                records.add(record);
            }
        }
        if (records.size() > 1000) throw new IOException("conversation_count_limit");
        records.sort(Comparator.comparingLong((JSONObject o) -> o.optLong("updatedAt")).reversed());
        return records;
    }
}
