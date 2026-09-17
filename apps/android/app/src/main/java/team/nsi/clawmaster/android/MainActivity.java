package team.nsi.clawmaster.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import android.widget.HorizontalScrollView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.List;
import team.nsi.clawmaster.core.AgentEngine;

/** Native phone UI for conversations, local notes and explicit tool approvals. */
public final class MainActivity extends Activity implements AgentController.Listener {
    private static final int INK = Color.rgb(28, 43, 38);
    private static final int GREEN = Color.rgb(23, 107, 88);
    private AgentController controller;
    private FrameLayout content;
    private LinearLayout messages;
    private ScrollView transcript;
    private EditText prompt;
    private Button send;
    private TextView status;
    private String tab = "chat";
    private AlertDialog approvalDialog;
    private JSONObject displayedApproval;
    private String exportDocumentId;
    private boolean resumed;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        try { controller = ((ClawMasterApplication) getApplication()).controller(); }
        catch (Exception failure) {
            TextView error = label(R.string.storage_error, 18);
            setContentView(error);
            return;
        }
        LinearLayout root = column();
        root.setBackgroundColor(Color.rgb(247, 249, 246));
        root.setPadding(dp(16), dp(16), dp(16), dp(8));
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
                view.setPadding(dp(16) + bars.left, bars.top + dp(12), dp(16) + bars.right, Math.max(bars.bottom, ime.bottom) + dp(8));
                return insets;
            });
        }
        TextView title = label(R.string.app_name, 26);
        title.setTypeface(null, Typeface.BOLD);
        root.addView(title);
        TextView subtitle = label(R.string.tagline, 12);
        subtitle.setTextColor(GREEN);
        root.addView(subtitle);
        content = new FrameLayout(this);
        LinearLayout.LayoutParams body = new LinearLayout.LayoutParams(-1, 0, 1);
        body.topMargin = dp(16);
        root.addView(content, body);
        LinearLayout tabs = row();
        Button chat = button(R.string.chat, () -> show("chat")); chat.setId(R.id.tab_chat);
        Button notes = button(R.string.notes, () -> show("notes")); notes.setId(R.id.tab_notes);
        Button settings = button(R.string.settings, () -> show("settings")); settings.setId(R.id.tab_settings);
        Button files = button(R.string.files, () -> show("files")); files.setId(R.id.tab_files);
        Button tasks = button(R.string.tasks, () -> show("tasks")); tasks.setId(R.id.tab_tasks);
        tabs.addView(chat); tabs.addView(notes); tabs.addView(files); tabs.addView(tasks); tabs.addView(settings);
        HorizontalScrollView tabScroll = new HorizontalScrollView(this); tabScroll.addView(tabs); root.addView(tabScroll);
        setContentView(root);
        show(state == null ? "chat" : state.getString("tab", "chat"));
        if (state != null && prompt != null) prompt.setText(state.getString("draft", ""));
        if (state != null) exportDocumentId = state.getString("exportDocumentId");
        controller.observe(this);
    }

    @Override public void onSaveInstanceState(Bundle state) {
        state.putString("tab", tab);
        if (prompt != null) state.putString("draft", prompt.getText().toString());
        state.putString("exportDocumentId", exportDocumentId);
        super.onSaveInstanceState(state);
    }
    @Override protected void onResume() { super.onResume(); resumed = true; if (controller != null) changed(); }
    @Override protected void onPause() { resumed = false; super.onPause(); }
    @Override protected void onDestroy() {
        if (controller != null) controller.remove(this);
        if (approvalDialog != null) approvalDialog.dismiss();
        super.onDestroy();
    }

    private void show(String selected) {
        if ("settings".equals(selected) && controller.running()) { toast(R.string.busy); return; }
        tab = selected;
        content.removeAllViews();
        if ("notes".equals(tab)) showNotes();
        else if ("files".equals(tab)) showFiles();
        else if ("tasks".equals(tab)) showTasks();
        else if ("settings".equals(tab)) showSettings();
        else showChat();
    }

    private void showChat() {
        LinearLayout layout = column();
        LinearLayout actions = row();
        actions.addView(button(R.string.new_chat, () -> {
            if (controller.running()) { toast(R.string.busy); return; }
            try { controller.newConversation(); } catch (Exception e) { toast(R.string.storage_error); }
        }), weighted());
        actions.addView(button(R.string.history, this::showHistory), weighted());
        layout.addView(actions);
        transcript = new ScrollView(this);
        transcript.setFillViewport(true);
        messages = column(); messages.setId(R.id.messages);
        transcript.addView(messages);
        layout.addView(transcript, new LinearLayout.LayoutParams(-1, 0, 1));
        status = label(R.string.thinking, 12); status.setId(R.id.status);
        layout.addView(status);
        LinearLayout composer = row();
        prompt = input(R.string.prompt_hint, false);
        prompt.setId(R.id.prompt);
        prompt.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        prompt.setMaxLines(5);
        composer.addView(prompt, weighted());
        send = button(R.string.send, () -> {
            if (controller.running()) { controller.stop(); return; }
            String text = prompt.getText().toString().trim();
            if (text.isEmpty()) return;
            if (!controller.settings.configured()) { toast(R.string.configure_first); return; }
            try { controller.send(text); prompt.setText(""); }
            catch (Exception e) { toast(R.string.invalid_config); }
        });
        send.setId(R.id.send);
        composer.addView(send);
        layout.addView(composer);
        content.addView(layout);
        renderChat();
    }

    @Override public void changed() {
        if (isDestroyed()) return;
        if ("chat".equals(tab)) renderChat();
        if (!resumed) return;
        JSONObject proposed = controller.running() ? null : controller.approval();
        if (proposed == displayedApproval) return;
        if (approvalDialog != null) approvalDialog.dismiss();
        approvalDialog = null;
        displayedApproval = proposed;
        if (proposed == null) return;
        JSONObject args = proposed.optJSONObject("args");
        String details;
        if (args != null && "notes_write".equals(proposed.optString("name"))) details = getString(R.string.approval_body, args.optString("title"), args.optString("content"));
        else if (args != null && "documents_create".equals(proposed.optString("name"))) {
            details = getString(R.string.document_creation_review, args.optString("name") + "." + args.optString("format"), args.optString("content"));
        } else if (args != null && "documents_edit".equals(proposed.optString("name"))) {
            JSONObject review = proposed.optJSONObject("review");
            JSONObject document = review == null ? null : review.optJSONObject("document");
            StringBuilder summary = new StringBuilder(getString(R.string.document_edit_review,
                document == null ? args.optString("id") : document.optString("name"), args.optString("expectedRevision")));
            try {
                JSONArray changes = new JSONArray(args.getString("changesJson"));
                JSONArray units = document == null ? new JSONArray() : document.getJSONArray("units");
                for (int i = 0; i < changes.length(); i++) {
                    JSONObject change = changes.getJSONObject(i); String before = "";
                    for (int j = 0; j < units.length(); j++) if (change.getString("key").equals(units.getJSONObject(j).getString("key"))) before = units.getJSONObject(j).getString("text");
                    summary.append("\n\n").append(getString(R.string.document_change_review, change.getString("key"), before, change.getString("text")));
                }
                details = summary.toString();
            } catch (Exception failure) { details = args.toString(); }
        } else details = proposed.toString();
        TextView body = text(details, 15);
        body.setPadding(dp(20), dp(8), dp(20), dp(8));
        body.setTextIsSelectable(true);
        ScrollView scroll = new ScrollView(this); scroll.addView(body);
        approvalDialog = new AlertDialog.Builder(this).setTitle(R.string.approval_title).setView(scroll)
            .setPositiveButton(R.string.approve, (dialog, which) -> controller.decide(proposed, true))
            .setNegativeButton(R.string.reject, (dialog, which) -> controller.decide(proposed, false))
            .setOnCancelListener(dialog -> controller.decide(proposed, false)).create();
        approvalDialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        approvalDialog.show();
    }

    private void renderChat() {
        if (messages == null || status == null) return;
        messages.removeAllViews();
        try {
            JSONArray history = controller.snapshot().getJSONArray("messages");
            if (history.length() == 0) addCard(getString(R.string.welcome), false);
            for (int i = 0; i < history.length(); i++) {
                JSONObject item = history.getJSONObject(i);
                String role = item.getString("role");
                if ("tool".equals(role)) {
                    addCard(getString(R.string.tool_result, item.optString("tool_call_id")) + "\n" + item.optString("content"), false);
                } else {
                    String body = item.isNull("content") ? "" : item.optString("content");
                    if (!body.isEmpty()) addCard(getString("user".equals(role) ? R.string.you : R.string.assistant) + "\n\n" + body, "user".equals(role));
                }
            }
            String state = controller.status();
            int label = 0;
            if ("thinking".equals(state)) label = R.string.thinking;
            else if ("approval".equals(state) || "waiting_approval".equals(state)) label = R.string.approval_waiting;
            else if ("stopped".equals(state)) label = R.string.stopped;
            else if ("interrupted".equals(state)) label = R.string.interrupted;
            else if ("conversation_limit".equals(state)) label = R.string.limit_reached;
            else if (!state.isEmpty() && !"complete".equals(state) && !state.startsWith("notes_") && !state.startsWith("documents_")) label = R.string.failed;
            status.setText(label == 0 ? ((state.startsWith("notes_") || state.startsWith("documents_")) && controller.running() ? getString(R.string.tool_running, state) : "") : getString(label));
            send.setText(controller.running() ? R.string.stop : R.string.send);
            prompt.setEnabled(!controller.running());
            transcript.post(() -> transcript.fullScroll(View.FOCUS_DOWN));
        } catch (Exception e) { status.setText(R.string.storage_error); }
    }

    private void addCard(String value, boolean user) {
        TextView card = text(value, 15);
        card.setTextIsSelectable(true);
        card.setPadding(dp(14), dp(14), dp(14), dp(14));
        GradientDrawable background = new GradientDrawable();
        background.setColor(user ? Color.rgb(224, 240, 231) : Color.WHITE);
        background.setCornerRadius(dp(16));
        card.setBackground(background);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.setMargins(user ? dp(24) : 0, dp(6), user ? 0 : dp(24), dp(6));
        messages.addView(card, params);
    }

    private void showSettings() {
        LinearLayout form = column();
        EditText base = input(R.string.provider_url, true); base.setId(R.id.base_url); base.setText(controller.settings.base());
        EditText model = input(R.string.model, true); model.setId(R.id.model_id); model.setText(controller.settings.model());
        EditText key = input(R.string.api_key, true); key.setId(R.id.api_key);
        key.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        key.setHint(R.string.key_hint);
        key.setSaveEnabled(false);
        key.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        form.addView(label(R.string.provider_url, 13)); form.addView(base);
        form.addView(label(R.string.model, 13)); form.addView(model);
        form.addView(label(R.string.api_key, 13)); form.addView(key);
        Button save = button(R.string.save_settings, () -> {
            try {
                controller.settings.save(base.getText().toString(), model.getText().toString(), key.getText().toString());
                key.setText(""); toast(R.string.saved);
            } catch (Exception e) { toast(R.string.invalid_config); }
        });
        save.setId(R.id.save_settings);
        form.addView(save);
        form.addView(button(R.string.clear_key, () -> {
            try { controller.settings.removeKey(); key.setText(""); toast(R.string.key_removed); }
            catch (Exception e) { toast(R.string.storage_error); }
        }));
        TextView privacy = label(R.string.privacy, 14); privacy.setPadding(0, dp(24), 0, dp(24));
        form.addView(privacy);
        form.addView(button(R.string.enable_notifications, () -> {
            if (Build.VERSION.SDK_INT >= 33) requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 90);
            else toast(R.string.notifications_system_settings);
        }));
        form.addView(label(R.string.about_version, 12));
        ScrollView scroll = new ScrollView(this); scroll.addView(form); content.addView(scroll);
    }

    private void showNotes() {
        LinearLayout layout = column();
        layout.addView(button(R.string.new_note, () -> editNote(null)));
        LinearLayout list = column();
        ScrollView scroll = new ScrollView(this); scroll.addView(list);
        layout.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        content.addView(layout);
        new Thread(() -> {
            try {
                JSONArray result = controller.notes.search("");
                runOnUiThread(() -> {
                    if (isDestroyed() || !"notes".equals(tab)) return;
                    if (result.length() == 0) list.addView(label(R.string.empty_notes, 16));
                    for (int i = 0; i < result.length(); i++) {
                        JSONObject note = result.optJSONObject(i);
                        Button open = new Button(this); open.setAllCaps(false); open.setText(note.optString("title"));
                        open.setOnClickListener(view -> {
                            try { editNote(controller.notes.read(note.optString("id"))); }
                            catch (Exception e) { toast(R.string.storage_error); }
                        });
                        list.addView(open);
                    }
                });
            } catch (Exception e) { runOnUiThread(() -> toast(R.string.storage_error)); }
        }, "clawmaster-note-list").start();
    }

    private void editNote(JSONObject existing) {
        LinearLayout editor = column();
        EditText title = input(R.string.note_title, true);
        EditText body = input(R.string.note_content, false);
        body.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        body.setGravity(Gravity.TOP); body.setMinLines(12);
        if (existing != null) { title.setText(existing.optString("title")); body.setText(existing.optString("content")); }
        editor.addView(title); editor.addView(body);
        ScrollView scroll = new ScrollView(this); scroll.addView(editor);
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle(existing == null ? R.string.new_note : R.string.notes)
            .setView(scroll).setPositiveButton(R.string.save_note, null).setNegativeButton(R.string.cancel, null).create();
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            try {
                JSONObject proposal = new JSONObject().put("id", existing == null ? "" : existing.getString("id"))
                    .put("expectedRevision", existing == null ? "" : existing.getString("revision"))
                    .put("title", title.getText().toString()).put("content", body.getText().toString());
                controller.notes.write(proposal);
                dialog.dismiss(); show("notes");
            } catch (Exception e) { toast("revision_conflict".equals(e.getMessage()) ? R.string.conflict : R.string.storage_error); }
        }));
        dialog.show();
        dialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
    }

    private void showHistory() {
        if (controller.running()) { toast(R.string.busy); return; }
        new Thread(() -> {
            try {
                List<JSONObject> records = controller.conversations.list();
                runOnUiThread(() -> {
                    if (isDestroyed()) return;
                    if (records.isEmpty()) { toast(R.string.empty_history); return; }
                    String[] titles = new String[records.size()];
                    for (int i = 0; i < titles.length; i++) {
                        JSONArray values = records.get(i).optJSONArray("messages");
                        String first = values == null || values.length() == 0 ? getString(R.string.new_chat) : values.optJSONObject(0).optString("content");
                        titles[i] = first.substring(0, Math.min(60, first.length()));
                    }
                    new AlertDialog.Builder(this).setTitle(R.string.history).setItems(titles, (dialog, index) -> {
                        try { controller.open(records.get(index).getString("id")); }
                        catch (Exception e) { toast(controller.running() ? R.string.busy : R.string.storage_error); }
                    }).setNegativeButton(R.string.cancel, null).show();
                });
            } catch (Exception e) { runOnUiThread(() -> toast(R.string.storage_error)); }
        }, "clawmaster-history").start();
    }

    private void showFiles() {
        LinearLayout layout = column();
        layout.addView(label(R.string.files_help, 14));
        layout.addView(button(R.string.import_file, () -> {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE);
            startActivityForResult(intent, 30);
        }));
        LinearLayout list = column(); ScrollView scroll = new ScrollView(this); scroll.addView(list);
        layout.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1)); content.addView(layout);
        new Thread(() -> {
            try {
                JSONArray files = controller.documents.list();
                runOnUiThread(() -> {
                    if (isDestroyed() || !"files".equals(tab)) return;
                    if (files.length() == 0) list.addView(label(R.string.empty_files, 16));
                    for (int i = 0; i < files.length(); i++) {
                        JSONObject file = files.optJSONObject(i);
                        Button open = new Button(this); open.setAllCaps(false); open.setText(file.optString("name"));
                        open.setOnClickListener(view -> previewFile(file)); list.addView(open);
                    }
                });
            } catch (Exception failure) { runOnUiThread(() -> toast(R.string.file_failed)); }
        }, "clawmaster-files").start();
    }
    private void previewFile(JSONObject file) {
        new Thread(() -> {
            try {
                JSONObject document = controller.documents.read(file.getString("id"));
                JSONArray units = document.getJSONArray("units");
                StringBuilder preview = new StringBuilder();
                for (int i = 0; i < units.length(); i++) {
                    JSONObject unit = units.getJSONObject(i);
                    preview.append(unit.getString("key")).append("\n").append(unit.getString("text")).append("\n\n");
                }
                runOnUiThread(() -> {
                    if (isDestroyed()) return;
                    TextView body = text(preview.toString(), 15); body.setTextIsSelectable(true);
                    ScrollView scroll = new ScrollView(this); scroll.addView(body);
                    new AlertDialog.Builder(this).setTitle(file.optString("name")).setView(scroll)
                        .setPositiveButton(R.string.export_file, (dialog, which) -> {
                            exportDocumentId = file.optString("id");
                            startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                                .setType("application/octet-stream").putExtra(Intent.EXTRA_TITLE, file.optString("name")), 31);
                        }).setNegativeButton(R.string.cancel, null).show();
                });
            } catch (Exception failure) { runOnUiThread(() -> toast(R.string.file_failed)); }
        }, "clawmaster-preview").start();
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if ((request != 30 && request != 31) || result != RESULT_OK || data == null || data.getData() == null) return;
        Uri uri = data.getData(); String selectedId = exportDocumentId;
        new Thread(() -> {
            try {
                if (request == 30) {
                    String name = null;
                    try (android.database.Cursor cursor = getContentResolver().query(uri, new String[]{android.provider.OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                        if (cursor != null && cursor.moveToFirst()) name = cursor.getString(0);
                    }
                    if (name == null) throw new java.io.IOException("missing_document_name");
                    java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
                    try (java.io.InputStream input = getContentResolver().openInputStream(uri)) {
                        if (input == null) throw new java.io.IOException("document_unavailable");
                        byte[] buffer = new byte[8192]; int count;
                        while ((count = input.read(buffer)) != -1) {
                            if (bytes.size() + count > team.nsi.clawmaster.core.OfficeDocuments.MAX_FILE_BYTES) throw new java.io.IOException("document_size_limit");
                            bytes.write(buffer, 0, count);
                        }
                    }
                    controller.documents.importFile(name, bytes.toByteArray());
                } else {
                    byte[] bytes = controller.documents.bytes(selectedId);
                    try (java.io.OutputStream output = getContentResolver().openOutputStream(uri, "wt")) {
                        if (output == null) throw new java.io.IOException("document_unavailable");
                        output.write(bytes);
                    }
                }
                runOnUiThread(() -> { if (!isDestroyed()) { toast(R.string.saved); show("files"); } });
            } catch (Exception failure) { runOnUiThread(() -> toast(R.string.file_failed)); }
        }, "clawmaster-document-transfer").start();
    }
    private void showTasks() {
        LinearLayout layout = column();
        layout.addView(label(R.string.tasks_help, 14));
        layout.addView(button(R.string.new_task, this::scheduleDialog));
        LinearLayout list = column(); ScrollView scroll = new ScrollView(this); scroll.addView(list);
        layout.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1)); content.addView(layout);
        try {
            JSONArray tasks = controller.tasks.list();
            for (int i = 0; i < tasks.length(); i++) {
                JSONObject task = tasks.getJSONObject(i);
                String promptText = task.getString("prompt");
                list.addView(text(promptText.substring(0, Math.min(100, promptText.length())) + "\n" + taskState(task.optString("state"))
                    + " · " + java.text.DateFormat.getDateTimeInstance().format(new java.util.Date(task.getLong("dueAt"))), 15));
                LinearLayout actions = row();
                actions.addView(button(R.string.task_open, () -> {
                    try { controller.open(task.getString("conversationId")); show("chat"); changed(); }
                    catch (Exception failure) { toast(R.string.task_not_started); }
                }), weighted());
                actions.addView(button(R.string.task_retry, () -> {
                    new AlertDialog.Builder(this).setMessage(R.string.retry_warning).setPositiveButton(R.string.task_retry, (dialog, which) -> {
                        try { controller.tasks.retry(task.getString("id"), System.currentTimeMillis()); TaskScheduling.reconcile(this, controller.tasks); show("tasks"); }
                        catch (Exception failure) { toast(R.string.task_failed); }
                    }).setNegativeButton(R.string.cancel, null).show();
                }), weighted());
                actions.addView(button(R.string.stop, () -> {
                    try {
                        controller.tasks.cancel(task.getString("id"));
                        if (task.getString("id").equals(controller.activeTask())) controller.stop();
                        TaskScheduling.reconcile(this, controller.tasks); show("tasks");
                    } catch (Exception failure) { toast(R.string.task_failed); }
                }), weighted());
                list.addView(actions);
            }
            if (tasks.length() == 0) list.addView(label(R.string.empty_tasks, 16));
        } catch (Exception failure) { toast(R.string.task_failed); }
    }
    private String taskState(String state) {
        switch (state) {
            case "scheduled": return getString(R.string.task_scheduled);
            case "running": return getString(R.string.thinking);
            case "waiting_approval": return getString(R.string.approval_waiting);
            case "complete": return getString(R.string.task_complete);
            case "cancelled": case "stopped": return getString(R.string.stopped);
            case "interrupted": return getString(R.string.interrupted);
            default: return getString(R.string.failed);
        }
    }
    private void scheduleDialog() {
        if (!controller.settings.configured()) { toast(R.string.configure_first); return; }
        LinearLayout form = column(); EditText taskPrompt = input(R.string.task_prompt, false);
        EditText delay = input(R.string.task_delay, true); delay.setInputType(InputType.TYPE_CLASS_NUMBER); delay.setText("0");
        EditText repeat = input(R.string.task_repeat, true); repeat.setInputType(InputType.TYPE_CLASS_NUMBER); repeat.setText("0");
        form.addView(taskPrompt); form.addView(label(R.string.task_delay, 13)); form.addView(delay);
        form.addView(label(R.string.task_repeat, 13)); form.addView(repeat);
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle(R.string.new_task).setView(form)
            .setPositiveButton(R.string.task_schedule, null).setNegativeButton(R.string.cancel, null).create();
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            try {
                long delayMinutes = Long.parseLong(delay.getText().toString());
                if (delayMinutes < 0 || delayMinutes > 525600) throw new IllegalArgumentException();
                controller.tasks.create(taskPrompt.getText().toString(), System.currentTimeMillis() + delayMinutes * 60000L, Long.parseLong(repeat.getText().toString()));
                TaskScheduling.reconcile(this, controller.tasks); dialog.dismiss(); show("tasks");
            } catch (Exception failure) { toast(R.string.task_failed); }
        }));
        dialog.show();
    }

    private int dp(int value) { return Math.round(getResources().getDisplayMetrics().density * value); }
    private LinearLayout column() { LinearLayout view = new LinearLayout(this); view.setOrientation(LinearLayout.VERTICAL); return view; }
    private LinearLayout row() { LinearLayout view = new LinearLayout(this); view.setOrientation(LinearLayout.HORIZONTAL); view.setGravity(Gravity.CENTER_VERTICAL); return view; }
    private LinearLayout.LayoutParams weighted() { return new LinearLayout.LayoutParams(0, -2, 1); }
    private TextView label(int resource, int size) { return text(getString(resource), size); }
    private TextView text(String value, int size) { TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(INK); return view; }
    private EditText input(int hint, boolean single) {
        EditText view = new EditText(this); view.setHint(hint); view.setSingleLine(single); view.setTextSize(15);
        view.setPadding(dp(10), dp(12), dp(10), dp(12)); return view;
    }
    private Button button(int label, Runnable action) {
        Button view = new Button(this); view.setText(label); view.setAllCaps(false); view.setTextColor(GREEN);
        view.setOnClickListener(ignored -> action.run()); return view;
    }
    private void toast(int resource) { Toast.makeText(this, resource, Toast.LENGTH_LONG).show(); }
}
