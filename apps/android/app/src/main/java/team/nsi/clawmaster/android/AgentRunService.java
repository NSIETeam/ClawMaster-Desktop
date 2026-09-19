package team.nsi.clawmaster.android;

import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/** Owner-initiated, bounded execution continues after the Activity leaves the foreground. */
public final class AgentRunService extends Service implements AgentController.Listener {
    private AgentController controller;
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            boolean attach = controller == null;
            if (attach) controller = ((ClawMasterApplication) getApplication()).controller();
            AgentController owner = controller;
            if (Build.VERSION.SDK_INT >= 29) startForeground(AgentNotifications.RUNNING,
                AgentNotifications.build(this, R.string.task_running_background, true), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            else startForeground(AgentNotifications.RUNNING, AgentNotifications.build(this, R.string.task_running_background, true));
            if (attach) owner.observe(this);
            if (intent != null && "stop".equals(intent.getAction())) owner.stop();
            else owner.startReserved();
            if (!owner.running()) stopSelf();
        } catch (Exception failure) { if (controller != null) controller.stop(); stopSelf(); }
        return START_NOT_STICKY;
    }
    @Override public void changed() {
        if (controller != null && !controller.running()) {
            controller.remove(this); controller = null;
            stopForeground(STOP_FOREGROUND_REMOVE); stopSelf();
        }
    }
    @Override public void onTimeout(int startId, int fgsType) { if (controller != null) controller.stop(); stopSelf(); }
    @Override public void onDestroy() {
        if (controller != null) { controller.remove(this); if (controller.running()) controller.stop(); }
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
