package team.nsi.clawmaster.core;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.stream.Stream;

/** Phone-local notes with revision checks on every replacement. */
public final class NoteStore {
    private final Path root;
    public NoteStore(Path root) throws IOException {
        this.root = Files.createDirectories(root).toRealPath();
    }

    public synchronized JSONObject read(String id) throws Exception {
        JSONObject note = LocalFiles.read(LocalFiles.record(root, id));
        Json.keys(note, "schema", "id", "title", "content", "revision");
        if (note.getInt("schema") != 1 || !id.equals(note.getString("id"))) throw new IOException("unsupported_note");
        String title = Json.text(note, "title", 160);
        String content = Json.text(note, "content", 32768);
        if (!revision(title, content).equals(note.getString("revision"))) throw new IOException("invalid_note_revision");
        return note;
    }

    public synchronized JSONArray search(String query) throws Exception {
        if (query.length() > 200) throw new IOException("query_limit");
        List<Path> files = new ArrayList<>();
        try (Stream<Path> entries = Files.list(root)) {
            entries.filter(p -> p.getFileName().toString().endsWith(".json")).limit(2001).forEach(files::add);
        }
        if (files.size() > 2000) throw new IOException("note_count_limit");
        files.sort(Comparator.comparing(p -> p.getFileName().toString()));
        JSONArray result = new JSONArray();
        for (Path file : files) {
            String name = file.getFileName().toString();
            JSONObject note = read(name.substring(0, name.length() - 5));
            String title = note.getString("title");
            String body = note.getString("content");
            if (!(title + "\n" + body).toLowerCase(Locale.ROOT).contains(query.toLowerCase(Locale.ROOT))) continue;
            result.put(new JSONObject().put("id", note.getString("id")).put("title", title)
                .put("revision", note.getString("revision")).put("excerpt", body.substring(0, Math.min(120, body.length()))));
            if (result.length() == 100) break;
        }
        return result;
    }

    /** Validate the exact proposed values before presenting an approval. */
    public synchronized void validateWrite(JSONObject proposal) throws Exception {
        Json.keys(proposal, "id", "title", "content", "expectedRevision");
        String id = Json.text(proposal, "id", 36);
        String title = Json.text(proposal, "title", 160);
        Json.text(proposal, "content", 32768);
        String expected = Json.text(proposal, "expectedRevision", 64);
        if (title.trim().isEmpty()) throw new IOException("empty_title");
        if (id.isEmpty()) {
            if (!expected.isEmpty()) throw new IOException("revision_conflict");
        } else if (!read(id).getString("revision").equals(expected)) {
            throw new IOException("revision_conflict");
        }
    }

    /** The caller owns approval; the store rechecks the reviewed revision at commit. */
    public synchronized JSONObject write(JSONObject proposal) throws Exception {
        validateWrite(proposal);
        String id = proposal.getString("id");
        if (id.isEmpty()) id = UUID.randomUUID().toString();
        String title = proposal.getString("title");
        String body = proposal.getString("content");
        JSONObject note = new JSONObject().put("schema", 1).put("id", id).put("title", title)
            .put("content", body).put("revision", revision(title, body));
        LocalFiles.write(LocalFiles.record(root, id), note);
        return new JSONObject().put("id", id).put("title", title).put("revision", note.getString("revision"));
    }

    private static String revision(String title, String body) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest((title + "\0" + body).getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder();
        for (byte value : digest) hex.append(String.format(Locale.ROOT, "%02x", value & 255));
        return hex.toString();
    }
}
