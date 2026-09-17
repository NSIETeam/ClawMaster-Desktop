package team.nsi.clawmaster.android;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import android.net.http.SslError;
import java.util.ArrayList;

/** Hosts the shared DSH Web client served by the on-device Node runtime. */
public final class DshActivity extends Activity {
    private static final int FILE_REQUEST = 4320;
    private WebView webView;
    private TextView status;
    private View statusPanel;
    private android.webkit.ValueCallback<Uri[]> fileCallback;
    private int localPort = -1;
    private String runtimeState;
    private boolean receiverRegistered;

    private final BroadcastReceiver runtimeReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (!DshRuntimeService.ACTION_STATUS.equals(intent.getAction())) return;
            String state = intent.getStringExtra(DshRuntimeService.EXTRA_STATE);
            String message = intent.getStringExtra(DshRuntimeService.EXTRA_MESSAGE);
            if (message != null) status.setText(message);
            if ("ready".equals(state)) {
                String url = intent.getStringExtra(DshRuntimeService.EXTRA_URL);
                if (url == null || !isAuthenticatedLoopbackUrl(Uri.parse(url))) {
                    showFailure();
                    return;
                }
                int nextPort = Uri.parse(url).getPort();
                if (!"ready".equals(runtimeState) || localPort != nextPort) {
                    localPort = nextPort;
                    webView.loadUrl(url);
                }
                runtimeState = "ready";
                statusPanel.setVisibility(View.GONE);
            } else if ("failed".equals(state) || "stopped".equals(state)) {
                runtimeState = state;
                showFailure();
            } else {
                runtimeState = state;
            }
        }
    };

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        webView = new WebView(this);
        webView.setId(R.id.dsh_web_view);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        webView.setWebViewClient(new LocalDshWebViewClient());
        webView.setWebChromeClient(new DshWebChromeClient());
        webView.setBackgroundColor(0xfff7f9f6);

        status = new TextView(this);
        status.setId(R.id.dsh_runtime_status);
        status.setText(R.string.dsh_starting);
        status.setTextSize(16);
        status.setGravity(Gravity.CENTER);
        status.setPadding(dp(28), dp(18), dp(28), dp(18));
        statusPanel = new LinearLayout(this);
        ((LinearLayout) statusPanel).setOrientation(LinearLayout.VERTICAL);
        ((LinearLayout) statusPanel).setGravity(Gravity.CENTER);
        ((LinearLayout) statusPanel).addView(status, new LinearLayout.LayoutParams(-1, -2));
        Button retry = new Button(this);
        retry.setId(R.id.dsh_retry);
        retry.setText(R.string.dsh_retry);
        retry.setOnClickListener(view -> startRuntime());
        ((LinearLayout) statusPanel).addView(retry);
        statusPanel.setBackgroundColor(0xfff7f9f6);

        FrameLayout root = new FrameLayout(this);
        root.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        root.addView(statusPanel, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
    }

    @Override protected void onStart() {
        super.onStart();
        IntentFilter filter = new IntentFilter(DshRuntimeService.ACTION_STATUS);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(runtimeReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(runtimeReceiver, filter);
        receiverRegistered = true;
        startRuntime();
    }

    @Override protected void onStop() {
        if (receiverRegistered) {
            unregisterReceiver(runtimeReceiver);
            receiverRegistered = false;
        }
        super.onStop();
    }

    private void startRuntime() {
        statusPanel.setVisibility(View.VISIBLE);
        status.setText(R.string.dsh_starting);
        Intent service = new Intent(this, DshRuntimeService.class).setAction(DshRuntimeService.ACTION_START);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(service);
        else startService(service);
    }

    private void showFailure() {
        statusPanel.setVisibility(View.VISIBLE);
        if (fileCallback != null) {
            fileCallback.onReceiveValue(null);
            fileCallback = null;
        }
    }

    private boolean isAuthenticatedLoopbackUrl(Uri uri) {
        if (!"http".equals(uri.getScheme()) || !"127.0.0.1".equals(uri.getHost()) || uri.getPort() < 1
            || !"/".equals(uri.getPath()) || uri.getUserInfo() != null || uri.getFragment() != null) return false;
        String query = uri.getEncodedQuery();
        if (query == null) return false;
        int tokens = 0;
        for (String item : query.split("&", -1)) {
            int equals = item.indexOf('=');
            if (!"token".equals(Uri.decode(equals < 0 ? item : item.substring(0, equals)))
                || equals < 0 || Uri.decode(item.substring(equals + 1)).isEmpty()) return false;
            tokens++;
        }
        return tokens == 1;
    }

    private static boolean sameLocalOrigin(Uri uri, int port) {
        return port > 0 && "127.0.0.1".equals(uri.getHost()) && uri.getPort() == port
            && ("http".equals(uri.getScheme()) || "blob".equals(uri.getScheme()));
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_REQUEST || fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                result = new Uri[count];
                for (int index = 0; index < count; index++) result[index] = data.getClipData().getItemAt(index).getUri();
            } else if (data.getData() != null) result = new Uri[]{data.getData()};
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    @Override public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override protected void onDestroy() {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
        }
        super.onDestroy();
    }

    private int dp(int value) { return (int) (value * getResources().getDisplayMetrics().density + 0.5f); }

    private final class LocalDshWebViewClient extends WebViewClient {
        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (sameLocalOrigin(uri, localPort) || "about".equals(uri.getScheme())) return false;
            Toast.makeText(DshActivity.this, R.string.dsh_navigation_blocked, Toast.LENGTH_SHORT).show();
            return true;
        }

        @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel();
        }
    }

    private final class DshWebChromeClient extends WebChromeClient {
        @Override public boolean onShowFileChooser(WebView view, android.webkit.ValueCallback<Uri[]> callback,
            FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType("*/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params != null && params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
            try {
                startActivityForResult(picker, FILE_REQUEST);
                return true;
            } catch (Exception failure) {
                fileCallback = null;
                callback.onReceiveValue(null);
                return false;
            }
        }
    }
}
