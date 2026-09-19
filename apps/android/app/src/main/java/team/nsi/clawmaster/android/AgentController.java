package team.nsi.clawmaster.android;

import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import team.nsi.clawmaster.core.AgentEngine;
import team.nsi.clawmaster.core.ChatClient;
import team.nsi.clawmaster.core.ConversationStore;
import team.nsi.clawmaster.core.DocumentStore;
import team.nsi.clawmaster.core.NoteStore;
import team.nsi.clawmaster.core.TaskStore;

/** Serial phone executor; Android services own execution lifetime and approvals remain durable. */
final class AgentController {
    interface Listener { void changed(); }
    interface ModelFactory { AgentEngine.Model create() throws Exception; }
    final SecureSettings settings;
    final NoteStore notes;
    final ConversationStore conversations;
    final DocumentStore documents;
    final TaskStore tasks;
    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final List<Listener> listeners = new ArrayList<>();
    private JSONObject current;
    private volatile JSONObject snapshot;
    private volatile boolean running;
    private volatile String status = "";
    private JSONObject approval;
    private AgentEngine.Cancellation cancellation;
    private AgentEngine.Model model;
    ModelFactory scheduledModelFactory = this::provider;
    private Runnable pendingStart;
    private String taskId = "";
    private final Runnable deadline = this::stop;

    AgentController(Context context) throws Exception {
        this.context = context.getApplicationContext();
        settings = new SecureSettings(context);
        notes = new NoteStore(context.getFilesDir().toPath().resolve("notes"));
        conversations = new ConversationStore(context.getFilesDir().toPath().resolve("conversations"));
        documents = new DocumentStore(context.getFilesDir().toPath().resolve("documents"));
        tasks = new TaskStore(context.getFilesDir().toPath().resolve("tasks"));
        tasks.recoverInterrupted(System.currentTimeMillis());
        List<JSONObject> history = conversations.list();
        current = history.isEmpty() ? conversations.create() : conversations.load(history.get(0).getString("id"));
        snapshot = new JSONObject(current.toString());
        refreshApproval();
        if (current.optBoolean("interrupted")) status = "interrupted";
        TaskScheduling.reconcile(context, tasks);
    }
    void observe(Listener listener) { listeners.add(listener); listener.changed(); }
    void remove(Listener listener) { listeners.remove(listener); }
    JSONObject snapshot() { return snapshot; }
    JSONObject approval() { return approval; }
    boolean running() { return running; }
    String status() { return status; }
    String activeTask() { return taskId; }

    private void notifyListeners() {
        for (Listener listener : new ArrayList<>(listeners)) {
            try { listener.changed(); }
            catch (RuntimeException failure) { android.util.Log.e("ClawMaster", "Listener failed"); }
        }
    }
    private void publish(JSONObject record, String state) throws Exception {
        JSONObject value = new JSONObject(record.toString());
        main.post(() -> { snapshot = value; status = state; notifyListeners(); });
    }
    private void refreshApproval() throws Exception {
        JSONObject pending = current.optJSONObject("pendingApproval");
        approval = pending == null ? null : new JSONObject(pending.toString());
    }
    void newConversation() throws Exception {
        if (running) throw new IllegalStateException("busy");
        current = conversations.create(); taskId = ""; model = null; refreshApproval(); publish(current, "");
    }
    void open(String id) throws Exception {
        if (running) throw new IllegalStateException("busy");
        current = conversations.load(id); taskId = ""; model = null;
        JSONArray records = tasks.list();
        for (int i = 0; i < records.length(); i++) {
            JSONObject task = records.getJSONObject(i);
            if (id.equals(task.optString("conversationId")) && current.has("pendingApproval") && !"cancelled".equals(task.optString("state"))) taskId = task.getString("id");
        }
        refreshApproval(); publish(current, current.optBoolean("interrupted") ? "interrupted" : "");
    }
    void send(String text) throws Exception { send(text, provider()); }

    /** Instrumentation injects only the model; it still launches the production foreground service. */
    void send(String text, AgentEngine.Model provider) {
        if (current.has("pendingApproval")) throw new IllegalStateException("approval_pending");
        if (!running) taskId = "";
        reserve(provider, text, null, true);
    }
    private ChatClient provider() throws Exception { return new ChatClient(settings.base(), settings.model(), settings.key()); }

    void startScheduled(String id) throws Exception {
        if (running) throw new IllegalStateException("busy");
        JSONObject task = tasks.read(id);
        AgentEngine.Model provider = scheduledModelFactory.create();
        JSONObject record = conversations.create();
        tasks.claim(id, record.getString("id"), System.currentTimeMillis());
        current = record; taskId = id; approval = null;
        reserve(provider, task.getString("prompt"), null, false);
        startReserved();
    }
    void decide(JSONObject displayed, boolean allowed) {
        if (running || displayed != approval) return;
        try {
            reserve(model == null ? provider() : model, null, allowed, true);
        } catch (Exception failure) { status = AgentEngine.safeError(failure); notifyListeners(); }
    }

    private void reserve(AgentEngine.Model provider, String prompt, Boolean decision, boolean foreground) {
        if (running) throw new IllegalStateException("busy");
        running = true; status = "thinking"; model = provider;
        cancellation = new AgentEngine.Cancellation();
        JSONObject record = current;
        String ownerTask = taskId;
        AgentEngine.Cancellation token = cancellation;
        pendingStart = () -> worker.execute(() -> {
            String finalState = "complete";
            try {
                AgentEngine engine = new AgentEngine(provider, notes, conversations, documents);
                AgentEngine.Observer observer = new AgentEngine.Observer() {
                    @Override public void changed(JSONObject value, String operation) throws Exception { publish(value, operation); }
                    @Override public boolean approve(JSONObject proposed, AgentEngine.Cancellation cancelled) throws Exception {
                        cancelled.check();
                        throw new AgentEngine.ApprovalDeferred(proposed);
                    }
                };
                if (decision == null) engine.run(record, prompt, observer, token);
                else engine.resume(record, decision, observer, token);
                if (record.has("pendingApproval")) finalState = "waiting_approval";
            } catch (CancellationException stopped) { finalState = "stopped"; }
            catch (Exception failure) { finalState = AgentEngine.safeError(failure); }
            String completion = finalState;
            main.post(() -> {
                main.removeCallbacks(deadline);
                running = false; pendingStart = null;
                try {
                    if (!ownerTask.isEmpty()) tasks.finish(ownerTask, completion, System.currentTimeMillis());
                    snapshot = new JSONObject(record.toString());
                    status = completion; refreshApproval();
                    AgentNotifications.result(context, "waiting_approval".equals(completion));
                } catch (Exception failure) { status = "storage_error"; }
                notifyListeners();
                try { TaskScheduling.reconcile(context, tasks); }
                catch (Exception failure) { status = "schedule_registration_failed"; notifyListeners(); }
            });
        });
        notifyListeners();
        if (foreground) {
            try { context.startForegroundService(new Intent(context, AgentRunService.class)); }
            catch (RuntimeException failure) { pendingStart = null; running = false; status = "background_start_failed"; notifyListeners(); throw failure; }
        }
    }
    void startReserved() {
        Runnable start = pendingStart;
        if (start == null) return;
        pendingStart = null;
        main.postDelayed(deadline, 8 * 60 * 1000L);
        start.run();
    }
    void stop() {
        if (!running) {
            if (approval != null) {
                try {
                    new AgentEngine(model, notes, conversations, documents).cancelPending(current);
                    if (!taskId.isEmpty()) {
                        tasks.finish(taskId, "stopped", System.currentTimeMillis());
                    }
                    snapshot = new JSONObject(current.toString());
                    refreshApproval();
                    status = "stopped";
                    notifyListeners();
                } catch (Exception failure) { status = "storage_error"; notifyListeners(); }
            }
            return;
        }
        cancellation.cancel();
        if (model != null) model.cancel();
        if (pendingStart != null) { pendingStart = null; running = false; status = "stopped"; notifyListeners(); }
    }
}
