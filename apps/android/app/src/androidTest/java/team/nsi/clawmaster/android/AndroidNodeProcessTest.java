package team.nsi.clawmaster.android;

import android.content.Context;
import android.os.Build;
import android.os.Process;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import static org.junit.Assert.*;

/** Verifies the packaged Android Node executable under the application UID. */
@RunWith(AndroidJUnit4.class)
public final class AndroidNodeProcessTest {
    @Test public void packagedNodeRunsFromTheAppNativeLibraryDirectory() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File nativeDirectory = new File(context.getApplicationInfo().nativeLibraryDir);
        File node = new File(nativeDirectory, "libclawmaster_node.so");
        assertTrue("Android Node runtime was not packaged in nativeLibraryDir", node.isFile());
        assertTrue("Android Node runtime is not executable", node.canExecute());

        String source = "console.log(JSON.stringify({version:process.version,platform:process.platform,arch:process.arch,uid:process.getuid()}))";
        ProcessBuilder builder = new ProcessBuilder(node.getAbsolutePath(), "-e", source);
        builder.redirectErrorStream(true);
        builder.environment().put("LD_LIBRARY_PATH", nativeDirectory.getAbsolutePath());
        ProcessRunner result = ProcessRunner.run(builder);
        assertEquals("Android Node exited unsuccessfully: " + result.output, 0, result.exitCode);

        JSONObject runtime = new JSONObject(result.output.trim());
        assertEquals("v22.19.0", runtime.getString("version"));
        assertEquals("android", runtime.getString("platform"));
        String expectedArch = Build.SUPPORTED_ABIS[0].equals("arm64-v8a") ? "arm64" : "x64";
        assertEquals(expectedArch, runtime.getString("arch"));
        assertEquals(Process.myUid(), runtime.getInt("uid"));
    }

    private static final class ProcessRunner {
        final int exitCode;
        final String output;

        private ProcessRunner(int exitCode, String output) { this.exitCode = exitCode; this.output = output; }

        static ProcessRunner run(ProcessBuilder builder) throws Exception {
            java.lang.Process process = builder.start();
            try {
                assertTrue("Android Node did not exit within 30 seconds", process.waitFor(30, TimeUnit.SECONDS));
                return new ProcessRunner(process.exitValue(), new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8));
            } finally {
                if (process.isAlive()) process.destroyForcibly();
            }
        }
    }
}
