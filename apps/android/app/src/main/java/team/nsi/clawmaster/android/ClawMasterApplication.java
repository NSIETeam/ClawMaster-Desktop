package team.nsi.clawmaster.android;

import android.app.Application;

/** Owns the in-process agent independently of Activity recreation. */
public final class ClawMasterApplication extends Application {
    private AgentController controller;
    synchronized AgentController controller() throws Exception {
        if (controller == null) controller = new AgentController(this);
        return controller;
    }
}
