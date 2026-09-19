package team.nsi.clawmaster.android;

import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.os.PersistableBundle;
import org.json.JSONArray;
import org.json.JSONObject;
import team.nsi.clawmaster.core.TaskStore;

/** Android owns network-aware scheduling; the durable task store owns eligibility and replay policy. */
final class TaskScheduling {
    private TaskScheduling() {}
    static void reconcile(Context context, TaskStore store) throws Exception {
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        JSONArray tasks = store.list();
        for (int i = 0; i < tasks.length(); i++) {
            JSONObject task = tasks.getJSONObject(i);
            int jobId = task.getInt("jobId");
            if (!"scheduled".equals(task.getString("state"))) { scheduler.cancel(jobId); continue; }
            JobInfo existing = scheduler.getPendingJob(jobId);
            long due = task.getLong("dueAt");
            if (existing != null && existing.getExtras().getLong("dueAt") == due) continue;
            PersistableBundle extras = new PersistableBundle();
            extras.putString("taskId", task.getString("id")); extras.putLong("dueAt", due);
            int result = scheduler.schedule(new JobInfo.Builder(jobId, new ComponentName(context, TaskJobService.class))
                .setExtras(extras).setMinimumLatency(Math.max(0, due - System.currentTimeMillis()))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPersisted(true).build());
            if (result != JobScheduler.RESULT_SUCCESS) throw new java.io.IOException("schedule_registration_failed");
        }
    }
}
