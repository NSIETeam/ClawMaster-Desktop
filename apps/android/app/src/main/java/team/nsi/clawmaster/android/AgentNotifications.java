package team.nsi.clawmaster.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;

/** Private task notifications never include prompts, document names or model output. */
final class AgentNotifications {
    static final int RUNNING = 10;
    private static final String CHANNEL = "agent-tasks";
    private AgentNotifications() {}
    static Notification build(Context context, int text, boolean ongoing) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, context.getString(R.string.task_channel), NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(context, 0, new Intent(context, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = new Notification.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_clawmaster).setContentTitle(context.getString(R.string.app_name))
            .setContentText(context.getString(text)).setContentIntent(open).setOngoing(ongoing)
            .setVisibility(Notification.VISIBILITY_PRIVATE).setAutoCancel(!ongoing);
        if (ongoing) {
            PendingIntent stop = PendingIntent.getService(context, 1, new Intent(context, AgentRunService.class).setAction("stop"), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            builder.addAction(new Notification.Action.Builder(null, context.getString(R.string.stop), stop).build());
        }
        return builder.build();
    }
    static void result(Context context, boolean approval) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager.areNotificationsEnabled()) manager.notify(11, build(context, approval ? R.string.task_needs_approval : R.string.task_finished, false));
    }
}
