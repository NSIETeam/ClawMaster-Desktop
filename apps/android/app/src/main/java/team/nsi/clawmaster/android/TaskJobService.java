package team.nsi.clawmaster.android;

import android.app.job.JobParameters;
import android.app.job.JobService;

/** A scheduled run releases its job when approval is needed; no background write is preapproved. */
public final class TaskJobService extends JobService implements AgentController.Listener {
    private AgentController controller;
    private JobParameters parameters;
    @Override public boolean onStartJob(JobParameters value) {
        try {
            controller = ((ClawMasterApplication) getApplication()).controller();
            org.json.JSONObject task = controller.tasks.read(value.getExtras().getString("taskId"));
            if (!"scheduled".equals(task.getString("state")) || task.getLong("dueAt") != value.getExtras().getLong("dueAt")) return false;
            if (controller.running() || task.getLong("dueAt") > System.currentTimeMillis()) {
                new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> jobFinished(value, true));
                return true;
            }
            parameters = value;
            controller.startScheduled(value.getExtras().getString("taskId"));
            controller.observe(this);
            return true;
        } catch (Exception failure) {
            try { controller.tasks.finish(value.getExtras().getString("taskId"), "schedule_failed", System.currentTimeMillis()); }
            catch (Exception storageFailure) { android.util.Log.e("ClawMaster", "Task outcome could not be stored"); }
            parameters = null; return false;
        }
    }
    @Override public void changed() {
        if (parameters != null && !controller.running()) {
            JobParameters completed = parameters; parameters = null;
            controller.remove(this); jobFinished(completed, false);
        }
    }
    @Override public boolean onStopJob(JobParameters value) {
        if (parameters == value) { controller.remove(this); if (controller.running()) controller.stop(); parameters = null; }
        return false;
    }
    @Override public void onDestroy() {
        if (controller != null) controller.remove(this);
        if (parameters != null && controller != null) controller.stop();
        super.onDestroy();
    }
}
