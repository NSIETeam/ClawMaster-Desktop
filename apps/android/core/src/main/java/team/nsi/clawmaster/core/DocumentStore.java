package team.nsi.clawmaster.core;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.UUID;
import java.util.stream.Stream;
import org.json.JSONArray;
import org.json.JSONObject;

/** App-private imported copies and immutable revisions; external originals are never overwritten. */
public final class DocumentStore {
    private final Path root;
    public DocumentStore(Path root) throws IOException { this.root = Files.createDirectories(root).toRealPath(); }

    public synchronized JSONArray list() throws Exception {
        JSONArray result = new JSONArray();
        try (Stream<Path> files = Files.list(root)) {
            for (Path file : (Iterable<Path>) files.filter(p -> p.toString().endsWith(".json")).sorted().limit(201)::iterator) result.put(LocalFiles.read(file));
        }
        if (result.length() > 200) throw new IOException("document_count_limit");
        return result;
    }
    public synchronized JSONObject metadata(String id) throws Exception {
        JSONObject record = LocalFiles.read(LocalFiles.record(root, id));
        if (record.getInt("schema") != 1 || !record.getString("id").equals(id)) throw new IOException("invalid_document_record");
        return record;
    }
    public synchronized JSONObject read(String id) throws Exception {
        JSONObject record = metadata(id);
        return new JSONObject(record.toString()).put("units", OfficeDocuments.read(record.getString("format"), bytes(id)))
            .put("scope", "Body paragraphs and top-level tables in DOCX; existing cells in XLSX; top-level text shapes in PPTX. Headers, drawings, embedded objects and complex layout are not represented. Formulas are not evaluated.");
    }
    public synchronized byte[] bytes(String id) throws Exception {
        JSONObject record = metadata(id);
        String revision = record.getString("revision");
        if (!revision.matches("[a-f0-9]{64}")) throw new IOException("invalid_document_revision");
        Path path = root.resolve(revision + ".bin");
        if (!Files.isRegularFile(path, java.nio.file.LinkOption.NOFOLLOW_LINKS) || Files.size(path) > OfficeDocuments.MAX_FILE_BYTES) throw new IOException("invalid_document_blob");
        byte[] bytes = Files.readAllBytes(path);
        if (!hash(bytes).equals(revision)) throw new IOException("invalid_document_revision");
        return bytes;
    }
    /** User-selected import is a new private copy, not an approval for later model writes. */
    public synchronized JSONObject importFile(String name, byte[] bytes) throws Exception {
        if (name.length() > 160 || name.contains("/") || name.contains("\\") || name.trim().isEmpty()) throw new IOException("invalid_document_name");
        String format = name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
        OfficeDocuments.read(format, bytes);
        if (list().length() >= 200) throw new IOException("document_count_limit");
        JSONObject record = new JSONObject().put("schema", 1).put("id", UUID.randomUUID().toString())
            .put("name", name).put("format", format).put("revisions", new JSONArray());
        return persist(record, bytes);
    }
    public synchronized void validateEdit(JSONObject args) throws Exception {
        Json.keys(args, "id", "expectedRevision", "changes");
        JSONObject record = metadata(Json.text(args, "id", 36));
        if (!record.getString("revision").equals(Json.text(args, "expectedRevision", 64))) throw new IOException("revision_conflict");
        if (record.getJSONArray("revisions").length() >= 100) throw new IOException("document_revision_limit");
        OfficeDocuments.edit(record.getString("format"), bytes(record.getString("id")), args.getJSONArray("changes"));
    }
    public synchronized JSONObject edit(JSONObject args) throws Exception {
        validateEdit(args);
        JSONObject record = metadata(args.getString("id"));
        byte[] updated = OfficeDocuments.edit(record.getString("format"), bytes(record.getString("id")), args.getJSONArray("changes"));
        return persist(record, updated);
    }
    public synchronized JSONObject create(JSONObject args) throws Exception {
        Json.keys(args, "name", "format", "content");
        String format = Json.text(args, "format", 8);
        String name = Json.text(args, "name", 150);
        return importFile(name + "." + format, OfficeDocuments.create(format, Json.text(args, "content", 32768)));
    }
    private JSONObject persist(JSONObject record, byte[] bytes) throws Exception {
        String revision = hash(bytes);
        Path blob = root.resolve(revision + ".bin");
        if (!Files.exists(blob)) {
            Path temporary = Files.createTempFile(root, ".document-", ".tmp");
            try {
                Files.write(temporary, bytes);
                Files.move(temporary, blob, java.nio.file.StandardCopyOption.ATOMIC_MOVE);
            } finally { Files.deleteIfExists(temporary); }
        }
        if (Files.isSymbolicLink(blob) || !hash(Files.readAllBytes(blob)).equals(revision)) throw new IOException("invalid_document_blob");
        JSONArray revisions = record.getJSONArray("revisions");
        if (revisions.length() == 0 || !revision.equals(record.optString("revision"))) revisions.put(revision);
        record.put("revision", revision).put("bytes", bytes.length);
        LocalFiles.write(LocalFiles.record(root, record.getString("id")), record);
        return new JSONObject(record.toString());
    }
    private static String hash(byte[] bytes) throws Exception {
        StringBuilder value = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) value.append(String.format(Locale.ROOT, "%02x", b & 255));
        return value.toString();
    }
}
