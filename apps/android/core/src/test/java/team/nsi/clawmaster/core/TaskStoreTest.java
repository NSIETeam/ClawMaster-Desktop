package team.nsi.clawmaster.core;

import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import static org.junit.Assert.*;

/** Clock values are explicit; no wall-clock sleep or shared filesystem is required. */
public final class TaskStoreTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();
    @Test public void eachDueRunCanBeClaimedOnceAndOnlySuccessSchedulesAnother() throws Exception {
        TaskStore store = new TaskStore(temporary.newFolder().toPath());
        JSONObject task = store.create("Read report", 1000, 15); String id = task.getString("id");
        assertThrows(Exception.class, () -> store.claim(id, "conversation", 999));
        store.claim(id, "conversation", 1000);
        assertThrows(Exception.class, () -> store.claim(id, "duplicate", 1001));
        store.finish(id, "complete", 2000);
        assertEquals(902000, store.read(id).getLong("dueAt"));
        store.claim(id, "second", 902000); store.finish(id, "waiting_approval", 902001);
        assertEquals("waiting_approval", store.read(id).getString("state"));
        assertThrows(Exception.class, () -> store.retry(id, 903000));
    }
    @Test public void processDeathAndFailureDoNotAutomaticallyRepeatModelOrWriteWork() throws Exception {
        java.nio.file.Path root = temporary.newFolder().toPath(); TaskStore store = new TaskStore(root);
        String id = store.create("Read", 0, 15).getString("id"); store.claim(id, "first", 1);
        TaskStore reopened = new TaskStore(root); reopened.recoverInterrupted(2);
        assertEquals("interrupted", reopened.read(id).getString("state"));
        assertThrows(Exception.class, () -> reopened.claim(id, "second", 3));
        reopened.retry(id, 4); reopened.claim(id, "second", 4); reopened.finish(id, "model_http_429", 5);
        assertEquals("model_http_429", reopened.read(id).getString("state"));
    }
    @Test public void cancellationWinsAgainstLateCompletionAndInvalidIntervalsAreRejected() throws Exception {
        TaskStore store = new TaskStore(temporary.newFolder().toPath());
        assertThrows(Exception.class, () -> store.create("Read", 0, 1));
        String id = store.create("Read", 0, 15).getString("id"); store.claim(id, "first", 1);
        store.cancel(id); store.finish(id, "complete", 2);
        assertEquals("cancelled", store.read(id).getString("state"));
    }
}
