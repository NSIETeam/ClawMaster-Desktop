package team.nsi.clawmaster.core;

import com.sun.net.httpserver.HttpsConfigurator;
import com.sun.net.httpserver.HttpsServer;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

/** Real loopback TLS exchanges exercise request encoding, errors and cancellation. */
public class ChatClientTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    private final class Server implements AutoCloseable {
        final HttpsServer server;
        final SSLContext ssl;
        final ExecutorService threads = Executors.newCachedThreadPool();
        Server() throws Exception {
            Path root = temporary.newFolder().toPath();
            Path keys = root.resolve("test.p12");
            Process process = new ProcessBuilder(System.getProperty("java.home") + "/bin/keytool", "-genkeypair", "-noprompt",
                "-keystore", keys.toString(), "-storetype", "PKCS12", "-storepass", "test-password",
                "-keypass", "test-password", "-alias", "test", "-keyalg", "RSA", "-keysize", "2048",
                "-validity", "1", "-dname", "CN=localhost", "-ext", "SAN=dns:localhost,ip:127.0.0.1")
                .redirectErrorStream(true).redirectOutput(root.resolve("keytool.log").toFile()).start();
            try {
                assertTrue("Certificate generation timed out", process.waitFor(20, TimeUnit.SECONDS));
                assertEquals(0, process.exitValue());
            } finally {
                if (process.isAlive()) { process.destroyForcibly(); assertTrue(process.waitFor(5, TimeUnit.SECONDS)); }
            }
            KeyStore store = KeyStore.getInstance("PKCS12");
            try (java.io.InputStream input = Files.newInputStream(keys)) { store.load(input, "test-password".toCharArray()); }
            KeyManagerFactory keysFactory = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
            keysFactory.init(store, "test-password".toCharArray());
            TrustManagerFactory trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
            trust.init(store);
            ssl = SSLContext.getInstance("TLS"); ssl.init(keysFactory.getKeyManagers(), trust.getTrustManagers(), null);
            server = HttpsServer.create(new InetSocketAddress("localhost", 0), 0);
            server.setHttpsConfigurator(new HttpsConfigurator(ssl)); server.setExecutor(threads);
        }
        ChatClient client() throws Exception {
            return new ChatClient("https://localhost:" + server.getAddress().getPort() + "/v1", "recorded-model", "test-only-key", ssl.getSocketFactory());
        }
        @Override public void close() throws Exception {
            server.stop(0); threads.shutdownNow(); assertTrue(threads.awaitTermination(5, TimeUnit.SECONDS));
        }
    }

    @Test public void serializesToolsAndPreservesTheAssistantReasoningAndArguments() throws Exception {
        try (Server fixture = new Server()) {
            AtomicReference<JSONObject> request = new AtomicReference<>();
            AtomicReference<String> authorization = new AtomicReference<>();
            fixture.server.createContext("/v1/chat/completions", exchange -> {
                try {
                    authorization.set(exchange.getRequestHeaders().getFirst("Authorization"));
                    request.set(new JSONObject(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8)));
                    byte[] body = "{\"choices\":[{\"finish_reason\":\"tool_calls\",\"message\":{\"role\":\"assistant\",\"content\":null,\"reasoning_content\":\"recorded reasoning fixture\",\"tool_calls\":[{\"id\":\"one\",\"type\":\"function\",\"function\":{\"name\":\"notes_search\",\"arguments\":\"{\\\"query\\\":\\\"test\\\"}\"}}]}}]}".getBytes(StandardCharsets.UTF_8);
                    exchange.sendResponseHeaders(200, body.length);
                    exchange.getResponseBody().write(body);
                } finally { exchange.close(); }
            });
            fixture.server.start();
            JSONObject response = fixture.client().complete(new JSONArray().put(Json.message("user", "Find test")), AgentEngine.toolSchemas(), new AgentEngine.Cancellation());
            assertEquals("Bearer test-only-key", authorization.get());
            assertFalse(request.get().getBoolean("stream"));
            assertEquals(3, request.get().getJSONArray("tools").length());
            assertEquals("recorded reasoning fixture", response.getString("reasoning_content"));
            assertEquals("notes_search", response.getJSONArray("tool_calls").getJSONObject(0).getJSONObject("function").getString("name"));
        }
    }

    @Test public void redirectsDoNotReceiveASecondAuthenticatedRequest() throws Exception {
        try (Server fixture = new Server()) {
            AtomicInteger redirected = new AtomicInteger();
            fixture.server.createContext("/v1/chat/completions", exchange -> {
                exchange.getResponseHeaders().set("Location", "https://localhost:" + fixture.server.getAddress().getPort() + "/other");
                exchange.sendResponseHeaders(307, -1); exchange.close();
            });
            fixture.server.createContext("/other", exchange -> { redirected.incrementAndGet(); exchange.sendResponseHeaders(200, -1); exchange.close(); });
            fixture.server.start();
            IOException failure = assertThrows(IOException.class, () -> fixture.client().complete(new JSONArray(), AgentEngine.toolSchemas(), new AgentEngine.Cancellation()));
            assertEquals("model_http_307", failure.getMessage());
            assertEquals(0, redirected.get());
        }
    }

    @Test public void providerErrorsDoNotExposeResponseBodies() throws Exception {
        try (Server fixture = new Server()) {
            fixture.server.createContext("/v1/chat/completions", exchange -> {
                byte[] body = "sensitive-provider-diagnostic".getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(402, body.length); exchange.getResponseBody().write(body); exchange.close();
            });
            fixture.server.start();
            IOException failure = assertThrows(IOException.class, () -> fixture.client().complete(new JSONArray(), AgentEngine.toolSchemas(), new AgentEngine.Cancellation()));
            assertEquals("model_http_402", failure.getMessage());
            assertFalse(failure.toString().contains("sensitive-provider-diagnostic"));
        }
    }

    @Test public void cancellationInterruptsAnActiveResponseAndReleasesTheConnection() throws Exception {
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        ExecutorService caller = Executors.newSingleThreadExecutor();
        try (Server fixture = new Server()) {
            fixture.server.createContext("/v1/chat/completions", exchange -> {
                try {
                    exchange.sendResponseHeaders(200, 0);
                    exchange.getResponseBody().write(' '); exchange.getResponseBody().flush();
                    entered.countDown();
                    release.await(10, TimeUnit.SECONDS);
                } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
                finally { exchange.close(); }
            });
            fixture.server.start();
            ChatClient client = fixture.client();
            AgentEngine.Cancellation token = new AgentEngine.Cancellation();
            Future<?> response = caller.submit(() -> {
                assertThrows(java.util.concurrent.CancellationException.class, () -> client.complete(new JSONArray(), AgentEngine.toolSchemas(), token));
            });
            assertTrue(entered.await(10, TimeUnit.SECONDS));
            token.cancel(); client.cancel(); release.countDown();
            response.get(5, TimeUnit.SECONDS);
        } finally {
            release.countDown(); caller.shutdownNow(); assertTrue(caller.awaitTermination(5, TimeUnit.SECONDS));
        }
    }
}
