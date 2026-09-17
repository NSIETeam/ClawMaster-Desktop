package team.nsi.clawmaster.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/** Runs the on-device DSH Web host while the shared WebView client is in use. */
public final class DshRuntimeService extends Service {
    public static final String ACTION_START = "team.nsi.clawmaster.android.dsh.START";
    public static final String ACTION_STOP = "team.nsi.clawmaster.android.dsh.STOP";
    public static final String ACTION_STATUS = "team.nsi.clawmaster.android.dsh.STATUS";
    public static final String EXTRA_STATE = "state";
    public static final String EXTRA_MESSAGE = "message";
    public static final String EXTRA_URL = "url";

    private static final String CHANNEL_ID = "dsh_runtime";
    private static final int NOTIFICATION_ID = 4301;
    private static final String PNPM_VERSION = "11.7.0";
    private static final long MAX_ARCHIVE_BYTES = 512L * 1024L * 1024L;
    private static final long MAX_EXTRACTED_BYTES = 1024L * 1024L * 1024L;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean starting = new AtomicBoolean();
    private volatile boolean stopping;
    private volatile Process hostProcess;
    private volatile String readyUrl;
    private volatile String currentState = "starting";
    private volatile String currentMessage;

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        ensureNotificationChannel();
        startInForeground(getString(R.string.dsh_starting));
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopping = true;
            Process process = hostProcess;
            hostProcess = null;
            readyUrl = null;
            if (process != null) {
                process.destroy();
                Thread cleanup = new Thread(() -> {
                    try {
                        if (!process.waitFor(3, TimeUnit.SECONDS)) process.destroyForcibly();
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        process.destroyForcibly();
                    }
                    stopOnMainThread(startId);
                }, "clawmaster-dsh-stop");
                cleanup.setDaemon(true);
                cleanup.start();
            } else {
                stopOnMainThread(startId);
            }
            return START_NOT_STICKY;
        }
        if (readyUrl != null) {
            publish("ready", getString(R.string.dsh_ready), readyUrl);
        } else if (starting.get()) {
            publish(currentState, currentMessage, null);
        } else if (starting.compareAndSet(false, true)) {
            stopping = false;
            publish("starting", getString(R.string.dsh_preparing), null);
            executor.execute(this::prepareAndRun);
        }
        return START_NOT_STICKY;
    }

    private void prepareAndRun() {
        String phase = "runtime initialization";
        try {
            File root = new File(getFilesDir(), "clawmaster-dsh");
            if (!root.isDirectory() && !root.mkdirs()) throw new IllegalStateException("runtime storage unavailable");
            phase = "runtime payload verification";
            setProgress(getString(R.string.dsh_extracting));
            File harness = preparePayload("dsh/harness.zip", "dsh/harness.zip.json", root, "harness");
            File npm = preparePayload("dsh/npm.zip", "dsh/npm.zip.json", root, "npm");
            File node = new File(getApplicationInfo().nativeLibraryDir, "libclawmaster_node.so");
            if (!node.isFile() || !node.canExecute()) throw new IllegalStateException("Android Node runtime unavailable");
            File commandDirectory = ensureNodeCommand(root, node);
            File nodeLibraries = new File(getApplicationInfo().nativeLibraryDir);
            File pnpmRoot = new File(root, "pnpm-" + PNPM_VERSION);
            File pnpmCli = new File(pnpmRoot, "node_modules/pnpm/bin/pnpm.cjs");
            if (!pnpmCli.isFile()) {
                phase = "package manager installation";
                setProgress(getString(R.string.dsh_installing_package_manager));
                runCommand(new File(harness, "apps/cli"), node, commandDirectory, nodeLibraries,
                    new File(npm, "bin/npm-cli.js").getAbsolutePath(), "install", "--prefix", pnpmRoot.getAbsolutePath(),
                    "--no-save", "--no-audit", "--no-fund", "pnpm@" + PNPM_VERSION);
            }
            File installMarker = new File(harness, ".android-pnpm-installed");
            File lockFile = new File(harness, "pnpm-lock.yaml");
            String lockHash = sha256(lockFile);
            if (!pnpmCli.isFile()) throw new IllegalStateException("package manager installation incomplete");
            if (!installMarker.isFile() || !lockHash.equals(readText(installMarker))) {
                phase = "locked dependency installation";
                setProgress(getString(R.string.dsh_installing_dependencies));
                runCommand(harness, node, commandDirectory, nodeLibraries, pnpmCli.getAbsolutePath(), "install", "--prod", "--frozen-lockfile");
                writeText(installMarker, lockHash);
            }
            if (stopping) return;
            phase = "DSH Web host startup";
            setProgress(getString(R.string.dsh_starting));
            launchHost(harness, node, commandDirectory, nodeLibraries, root);
        } catch (Exception failure) {
            if (!stopping) {
                android.util.Log.e("ClawMasterDSH", "Runtime failed during " + phase + " (" + failure.getClass().getSimpleName() + ")");
                readyUrl = null;
                publish("failed", getString(R.string.dsh_start_failed), null);
                startInForeground(getString(R.string.dsh_start_failed));
            }
        } finally {
            starting.set(false);
            if (stopping) stopSelf();
        }
    }

    private File preparePayload(String archiveAsset, String metadataAsset, File root, String name) throws Exception {
        JSONObject metadata;
        try (InputStream input = getAssets().open(metadataAsset)) {
            byte[] bytes = readBytes(input, 1024 * 1024);
            metadata = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        }
        String archiveHash = metadata.getString("archiveSha256");
        if (!archiveHash.matches("[0-9a-f]{64}")) throw new IllegalStateException("invalid runtime payload manifest");
        String contentHash = metadata.optString("contentSha256", archiveHash);
        if (!contentHash.matches("[0-9a-f]{64}")) contentHash = archiveHash;
        File destination = new File(root, name + "-" + contentHash);
        File marker = new File(destination, ".android-payload-sha256");
        if (marker.isFile() && archiveHash.equals(readText(marker))) return destination;

        File archive = new File(root, name + ".zip.tmp");
        File temporary = new File(root, name + "-" + contentHash + ".tmp");
        deleteTree(temporary);
        try (InputStream input = getAssets().open(archiveAsset); FileOutputStream output = new FileOutputStream(archive)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[64 * 1024];
            long copied = 0;
            int count;
            while ((count = input.read(buffer)) != -1) {
                copied += count;
                if (copied > MAX_ARCHIVE_BYTES) throw new IllegalStateException("runtime payload exceeds size limit");
                digest.update(buffer, 0, count);
                output.write(buffer, 0, count);
            }
            if (!archiveHash.equals(hex(digest.digest()))) throw new IllegalStateException("runtime payload checksum mismatch");
        } catch (Exception failure) {
            archive.delete();
            throw failure;
        }
        try {
            unpack(archive, temporary);
            if ("harness".equals(name)) {
                JSONObject bundle;
                try (InputStream input = new FileInputStream(new File(temporary, ".bundle-manifest.json"))) {
                    bundle = new JSONObject(new String(readBytes(input, 1024 * 1024), StandardCharsets.UTF_8));
                }
                if (!contentHash.equals(bundle.optString("contentSha256"))) throw new IllegalStateException("harness content checksum mismatch");
            }
            writeText(new File(temporary, ".android-payload-sha256"), archiveHash);
            deleteTree(destination);
            if (!temporary.renameTo(destination)) throw new IllegalStateException("runtime payload activation failed");
            return destination;
        } finally {
            archive.delete();
            deleteTree(temporary);
        }
    }

    private static void unpack(File archive, File destination) throws Exception {
        if (!destination.mkdirs() && !destination.isDirectory()) throw new IllegalStateException("runtime extraction directory unavailable");
        String base = destination.getCanonicalPath() + File.separator;
        byte[] buffer = new byte[64 * 1024];
        long extracted = 0;
        try (ZipInputStream input = new ZipInputStream(new FileInputStream(archive))) {
            ZipEntry entry;
            while ((entry = input.getNextEntry()) != null) {
                String name = entry.getName().replace('\\', '/');
                if (name.startsWith("/") || name.contains("../") || name.equals("..")) throw new IllegalStateException("unsafe runtime archive entry");
                File output = new File(destination, name);
                String canonical = output.getCanonicalPath();
                if (!canonical.startsWith(base)) throw new IllegalStateException("runtime archive entry escapes storage");
                if (entry.isDirectory()) {
                    if (!output.mkdirs() && !output.isDirectory()) throw new IllegalStateException("runtime directory extraction failed");
                } else {
                    File parent = output.getParentFile();
                    if (parent == null || (!parent.mkdirs() && !parent.isDirectory())) throw new IllegalStateException("runtime parent extraction failed");
                    try (FileOutputStream stream = new FileOutputStream(output)) {
                        int count;
                        while ((count = input.read(buffer)) != -1) {
                            extracted += count;
                            if (extracted > MAX_EXTRACTED_BYTES) throw new IllegalStateException("expanded runtime payload exceeds size limit");
                            stream.write(buffer, 0, count);
                        }
                    }
                }
                input.closeEntry();
            }
        }
    }

    private File ensureNodeCommand(File runtimeRoot, File node) throws Exception {
        File directory = new File(runtimeRoot, "bin");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IllegalStateException("runtime command directory unavailable");
        File command = new File(directory, "node");
        boolean linked = false;
        if (Files.isSymbolicLink(command.toPath())) {
            linked = node.getAbsolutePath().equals(Files.readSymbolicLink(command.toPath()).toString());
        }
        if (!linked) {
            if (command.exists() && !command.delete()) throw new IllegalStateException("stale Node command link cannot be removed");
            if (Files.isSymbolicLink(command.toPath()) && !command.delete()) throw new IllegalStateException("stale Node command link cannot be removed");
            Files.createSymbolicLink(command.toPath(), node.toPath());
        }
        return directory;
    }

    private String commandPath(File commandDirectory) {
        return commandDirectory.getAbsolutePath() + File.pathSeparator + "/system/bin:/system/xbin";
    }

    private void runCommand(File workingDirectory, File node, File commandDirectory, File libraries, String... arguments) throws Exception {
        ArrayList<String> command = new ArrayList<>();
        command.add(node.getAbsolutePath());
        for (String argument : arguments) command.add(argument);
        ProcessBuilder builder = new ProcessBuilder(command).directory(workingDirectory).redirectErrorStream(true);
        builder.environment().put("LD_LIBRARY_PATH", libraries.getAbsolutePath());
        builder.environment().put("PATH", commandPath(commandDirectory));
        builder.environment().put("HOME", new File(getFilesDir(), "clawmaster-dsh/home").getAbsolutePath());
        builder.environment().put("TMPDIR", getCacheDir().getAbsolutePath());
        builder.environment().put("CI", "true");
        File home = new File(builder.environment().get("HOME"));
        if (!home.isDirectory() && !home.mkdirs()) throw new IllegalStateException("runtime home unavailable");
        Process process = builder.start();
        hostProcess = process;
        Thread drain = drainOutput(process, null, null);
        boolean exited = process.waitFor(45, TimeUnit.MINUTES);
        if (!exited) {
            process.destroyForcibly();
            throw new IllegalStateException("runtime dependency installation timed out");
        }
        drain.join(TimeUnit.SECONDS.toMillis(5));
        hostProcess = null;
        if (process.exitValue() != 0) throw new IllegalStateException("runtime dependency installation failed");
    }

    private void launchHost(File harness, File node, File commandDirectory, File libraries, File runtimeRoot) throws Exception {
        File cli = new File(harness, "apps/cli/lib/bin.js");
        File preload = new File(harness, "desktop-defaults.mjs");
        if (!cli.isFile() || !preload.isFile()) throw new IllegalStateException("desktop DSH artifacts unavailable");
        ProcessBuilder builder = new ProcessBuilder(node.getAbsolutePath(), "--import", Uri.fromFile(preload).toString(),
            cli.getAbsolutePath(), "web", "--no-open", "--host", "127.0.0.1", "--port", "0")
            .directory(harness).redirectErrorStream(true);
        builder.environment().put("LD_LIBRARY_PATH", libraries.getAbsolutePath());
        builder.environment().put("PATH", commandPath(commandDirectory));
        builder.environment().put("DSH_DESKTOP_DEFAULTS", "1");
        builder.environment().put("DSH_HOME", new File(runtimeRoot, "home").getAbsolutePath());
        builder.environment().put("NODE_ENV", "production");
        builder.environment().put("TMPDIR", getCacheDir().getAbsolutePath());
        Process process = builder.start();
        hostProcess = process;
        CountDownLatch ready = new CountDownLatch(1);
        AtomicBoolean invalidOrClosed = new AtomicBoolean();
        Thread reader = drainOutput(process, ready, invalidOrClosed);
        if (!ready.await(5, TimeUnit.MINUTES)) {
            process.destroyForcibly();
            reader.join(TimeUnit.SECONDS.toMillis(2));
            throw new IllegalStateException("DSH Web host did not become ready");
        }
        if (invalidOrClosed.get()) {
            process.destroyForcibly();
            throw new IllegalStateException("DSH Web host output closed before readiness");
        }
        String url = readyUrl;
        if (url == null) throw new IllegalStateException("DSH Web host returned no authenticated URL");
        publish("ready", getString(R.string.dsh_ready), url);
        startInForeground(getString(R.string.dsh_ready));
        Thread monitor = new Thread(() -> watchHost(process), "clawmaster-dsh-watch");
        monitor.setDaemon(true);
        monitor.start();
    }

    private Thread drainOutput(Process process, CountDownLatch ready, AtomicBoolean closed) {
        Thread reader = new Thread(() -> {
            try (BufferedReader input = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = input.readLine()) != null) {
                    if (ready != null && readyUrl == null) {
                        String url = parseStartupUrl(line);
                        if (url != null) {
                            readyUrl = url;
                            ready.countDown();
                        }
                    }
                }
            } catch (Exception ignored) {
                // Process exit is the observable failure signal; child output can contain credentials.
            } finally {
                if (ready != null && readyUrl == null) {
                    closed.set(true);
                    ready.countDown();
                }
            }
        }, "clawmaster-dsh-output");
        reader.setDaemon(true);
        reader.start();
        return reader;
    }

    private void watchHost(Process process) {
        try {
            int exit = process.waitFor();
            if (hostProcess == process) hostProcess = null;
            if (!stopping) {
                readyUrl = null;
                publish("failed", getString(R.string.dsh_host_stopped), null);
                startInForeground(getString(R.string.dsh_host_stopped));
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    private static String parseStartupUrl(String line) {
        if (!line.startsWith("dsh web: ")) return null;
        String candidate = line.substring("dsh web: ".length()).split("\\s+", 2)[0];
        Uri uri = Uri.parse(candidate);
        if (!"http".equals(uri.getScheme()) || !"127.0.0.1".equals(uri.getHost()) || uri.getPort() < 1
            || uri.getPath() == null || !"/".equals(uri.getPath()) || uri.getUserInfo() != null || uri.getFragment() != null) return null;
        String raw = uri.getEncodedQuery();
        if (raw == null || raw.isEmpty()) return null;
        String token = null;
        for (String pair : raw.split("&", -1)) {
            int equals = pair.indexOf('=');
            String name = Uri.decode(equals < 0 ? pair : pair.substring(0, equals));
            String value = Uri.decode(equals < 0 ? "" : pair.substring(equals + 1));
            if (!"token".equals(name) || token != null || value.isEmpty()) return null;
            token = value;
        }
        return token == null ? null : candidate;
    }

    private void publish(String state, String message, String url) {
        currentState = state;
        currentMessage = message;
        Intent status = new Intent(ACTION_STATUS).setPackage(getPackageName())
            .putExtra(EXTRA_STATE, state).putExtra(EXTRA_MESSAGE, message);
        if (url != null) status.putExtra(EXTRA_URL, url);
        sendBroadcast(status);
    }

    private void setProgress(String message) {
        startInForeground(message);
        publish("starting", message, null);
    }

    private void startInForeground(String message) {
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(this, CHANNEL_ID) : new Notification.Builder(this);
        Intent open = new Intent(this, DshActivity.class);
        PendingIntent content = PendingIntent.getActivity(this, 0, open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent stop = new Intent(this, DshRuntimeService.class).setAction(ACTION_STOP);
        PendingIntent stopAction = PendingIntent.getService(this, 1, stop,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        builder.setSmallIcon(R.drawable.ic_clawmaster).setContentTitle(getString(R.string.app_name))
            .setContentText(message).setOngoing(true).setContentIntent(content)
            .addAction(new Notification.Action.Builder(null, getString(R.string.dsh_stop), stopAction).build());
        Notification notification = builder.build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        else startForeground(NOTIFICATION_ID, notification);
    }

    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, getString(R.string.dsh_notification_channel), NotificationManager.IMPORTANCE_LOW);
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
    }

    private void stopHostProcess() {
        Process process = hostProcess;
        hostProcess = null;
        readyUrl = null;
        if (process != null) {
            process.destroy();
            try {
                if (!process.waitFor(3, TimeUnit.SECONDS)) process.destroyForcibly();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                process.destroyForcibly();
            }
        }
        publish("stopped", getString(R.string.dsh_stopped), null);
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
        }
        return hex(digest.digest());
    }

    private static String hex(byte[] bytes) {
        StringBuilder value = new StringBuilder(bytes.length * 2);
        for (byte item : bytes) value.append(String.format("%02x", item & 0xff));
        return value.toString();
    }

    private static String readText(File file) throws Exception {
        try (InputStream input = new FileInputStream(file)) {
            return new String(readBytes(input, 1024 * 1024), StandardCharsets.UTF_8).trim();
        }
    }

    private static byte[] readBytes(InputStream input, int maximumBytes) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int count;
        while ((count = input.read(buffer)) != -1) {
            if (output.size() + count > maximumBytes) throw new IllegalStateException("runtime metadata exceeds size limit");
            output.write(buffer, 0, count);
        }
        return output.toByteArray();
    }

    private void stopOnMainThread(int startId) {
        currentState = "stopped";
        currentMessage = getString(R.string.dsh_stopped);
        android.os.Handler handler = new android.os.Handler(getMainLooper());
        handler.post(() -> {
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf(startId);
            publish(currentState, currentMessage, null);
        });
    }

    private static void writeText(File file, String value) throws Exception {
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(value.getBytes(StandardCharsets.UTF_8));
        }
    }

    private static void deleteTree(File file) {
        if (!file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        file.delete();
    }

    @Override public void onDestroy() {
        stopping = true;
        stopHostProcess();
        executor.shutdownNow();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
