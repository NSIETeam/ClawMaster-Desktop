package team.nsi.clawmaster.core;

import org.json.JSONArray;
import org.json.JSONObject;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSocketFactory;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CancellationException;

/** Direct HTTPS Chat Completions transport; credentials never follow redirects. */
public final class ChatClient implements AgentEngine.Model {
    private final URI endpoint;
    private final String model;
    private final String key;
    private final SSLSocketFactory socketFactory;
    private volatile HttpsURLConnection active;

    public ChatClient(String base, String model, String key) throws Exception {
        this(base, model, key, null);
    }

    /** Test-local trust roots leave the process-wide TLS configuration unchanged. */
    ChatClient(String base, String model, String key, SSLSocketFactory socketFactory) throws Exception {
        this.endpoint = validateEndpoint(base);
        if (model.trim().isEmpty() || model.length() > 200 || key.trim().isEmpty() || key.length() > 8192
            || key.contains("\n") || key.contains("\r")) throw new IOException("invalid_config");
        this.model = model.trim();
        this.key = key.trim();
        this.socketFactory = socketFactory;
    }

    public static URI validateEndpoint(String base) throws Exception {
        URI uri = new URI(base.trim());
        if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null
            || uri.getQuery() != null || uri.getFragment() != null || base.length() > 2048) throw new IOException("invalid_endpoint");
        String path = uri.getPath() == null ? "" : uri.getPath().replaceAll("/+$", "");
        if (path.endsWith("/chat/completions")) throw new IOException("expected_base_url");
        return new URI("https", null, uri.getHost(), uri.getPort(), path + "/chat/completions", null, null);
    }

    @Override public JSONObject complete(JSONArray messages, JSONArray tools, AgentEngine.Cancellation cancellation) throws Exception {
        cancellation.check();
        JSONObject request = new JSONObject().put("model", model).put("messages", messages)
            .put("tools", tools).put("tool_choice", "auto").put("stream", false).put("max_tokens", 4096);
        byte[] body = request.toString().getBytes(StandardCharsets.UTF_8);
        HttpsURLConnection connection = (HttpsURLConnection) endpoint.toURL().openConnection();
        if (socketFactory != null) connection.setSSLSocketFactory(socketFactory);
        active = connection;
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(20000);
            connection.setReadTimeout(90000);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + key);
            connection.setFixedLengthStreamingMode(body.length);
            cancellation.check();
            try (java.io.OutputStream output = connection.getOutputStream()) { output.write(body); }
            int status = connection.getResponseCode();
            cancellation.check();
            if (status != 200) throw new IOException("model_http_" + status);
            try (InputStream input = connection.getInputStream()) {
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    cancellation.check();
                    if (output.size() + count > 1024 * 1024) throw new IOException("response_limit");
                    output.write(buffer, 0, count);
                }
                JSONObject response = new JSONObject(output.toString("UTF-8"));
                JSONArray choices = response.getJSONArray("choices");
                if (choices.length() != 1) throw new IOException("invalid_model_response");
                JSONObject choice = choices.getJSONObject(0);
                String finish = choice.getString("finish_reason");
                if (!"stop".equals(finish) && !"tool_calls".equals(finish)) throw new IOException("model_output_incomplete");
                return choice.getJSONObject("message");
            }
        } catch (Exception failure) {
            if (cancellation.cancelled()) throw new CancellationException();
            throw failure;
        } finally {
            connection.disconnect();
            active = null;
        }
    }

    @Override public void cancel() {
        HttpsURLConnection connection = active;
        if (connection != null) connection.disconnect();
    }
}
