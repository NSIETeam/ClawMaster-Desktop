package team.nsi.clawmaster.core;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;
import java.util.stream.Stream;
import org.json.JSONArray;
import org.json.JSONObject;

/** Durable schedules and terminal outcomes; interrupted runs require an explicit owner retry. */
public final class TaskStore {
    private final Path root;
    public TaskStore(Path root) throws IOException { this.root = Files.createDirectories(root).toRealPath(); }
    public synchronized JSONObject create(String prompt, long dueAt, long intervalMinutes) throws Exception {
        if (prompt.trim().isEmpty() || prompt.length() > 16000 || dueAt < 0 || intervalMinutes < 0
            || (intervalMinutes > 0 && intervalMinutes < 15) || intervalMinutes > 525600) throw new IOException("invalid_schedule");
        JSONArray tasks = list();
        if (tasks.length() >= 100) throw new IOException("task_count_limit");
        int jobId = 1000;
        for (int i = 0; i < tasks.length(); i++) jobId = Math.max(jobId, tasks.getJSONObject(i).getInt("jobId") + 1);
        JSONObject task = new JSONObject().put("schema", 1).put("id", UUID.randomUUID().toString()).put("jobId", jobId)
            .put("prompt", prompt.trim()).put("dueAt", dueAt).put("intervalMinutes", intervalMinutes)
            .put("state", "scheduled").put("conversationId", "").put("runs", new JSONArray());
        save(task); return task;
    }
    public synchronized JSONArray list() throws Exception {
        JSONArray result = new JSONArray();
        try (Stream<Path> entries = Files.list(root)) {
            for (Path path : (Iterable<Path>) entries.filter(p -> p.toString().endsWith(".json")).sorted().limit(101)::iterator) result.put(LocalFiles.read(path));
        }
        if (result.length() > 100) throw new IOException("task_count_limit");
        return result;
    }
    public synchronized JSONObject read(String id) throws Exception {
        JSONObject task = LocalFiles.read(LocalFiles.record(root, id));
        if (task.getInt("schema") != 1 || !id.equals(task.getString("id"))) throw new IOException("invalid_task_record");
        return task;
    }
    public synchronized JSONObject claim(String id, String conversationId, long now) throws Exception {
        JSONObject task = read(id);
        if (!"scheduled".equals(task.getString("state")) || task.getLong("dueAt") > now) throw new IOException("task_not_due");
        task.put("state", "running").put("conversationId", conversationId); save(task); return task;
    }
    public synchronized void finish(String id, String outcome, long now) throws Exception {
        if (!outcome.matches("[a-z][a-z0-9_]{0,80}")) throw new IOException("invalid_task_outcome");
        JSONObject task = read(id);
        if ("cancelled".equals(task.getString("state"))) return;
        JSONArray history = task.getJSONArray("runs");
        history.put(new JSONObject().put("at", now).put("outcome", outcome).put("conversationId", task.getString("conversationId")));
        while (history.length() > 100) history.remove(0);
        task.put("state", outcome);
        if ("complete".equals(outcome) && task.getLong("intervalMinutes") > 0) {
            task.put("state", "scheduled").put("dueAt", now + task.getLong("intervalMinutes") * 60000L);
        }
        save(task);
    }
    public synchronized void cancel(String id) throws Exception { JSONObject task = read(id); task.put("state", "cancelled"); save(task); }
    public synchronized void retry(String id, long now) throws Exception {
        JSONObject task = read(id);
        if ("running".equals(task.getString("state")) || "waiting_approval".equals(task.getString("state"))) throw new IOException("task_needs_review");
        task.put("state", "scheduled").put("dueAt", now); save(task);
    }
    /** Called once per process before any runner starts; it never replays a claimed task. */
    public synchronized void recoverInterrupted(long now) throws Exception {
        JSONArray tasks = list();
        for (int i = 0; i < tasks.length(); i++) {
            JSONObject task = tasks.getJSONObject(i);
            if ("running".equals(task.getString("state"))) finish(task.getString("id"), "interrupted", now);
        }
    }
    private void save(JSONObject task) throws Exception { LocalFiles.write(LocalFiles.record(root, task.getString("id")), task); }
}
