package team.nsi.clawmaster.core;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.UUID;
import org.json.JSONObject;

/** Bounded UTF-8 records replaced atomically inside an application-owned directory. */
final class LocalFiles {
    static final int MAX_BYTES = 1024 * 1024;
    private LocalFiles() {}

    static Path record(Path root, String id) throws IOException {
        if (!id.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")) {
            throw new IOException("invalid_id");
        }
        return root.resolve(id + ".json");
    }

    static JSONObject read(Path path) throws Exception {
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) || Files.size(path) > MAX_BYTES) {
            throw new IOException("invalid_record");
        }
        return new JSONObject(new String(Files.readAllBytes(path), StandardCharsets.UTF_8));
    }

    static void write(Path path, JSONObject value) throws Exception {
        byte[] bytes = value.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_BYTES) throw new IOException("record_limit");
        if (Files.isSymbolicLink(path)) throw new IOException("invalid_record");
        Path temporary = path.resolveSibling("." + UUID.randomUUID() + ".tmp");
        try {
            Files.write(temporary, bytes);
            Files.move(temporary, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally {
            Files.deleteIfExists(temporary);
        }
    }
}
