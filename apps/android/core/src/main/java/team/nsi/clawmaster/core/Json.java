package team.nsi.clawmaster.core;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;

/** Strict checks for model, configuration and durable JSON values. */
public final class Json {
    private Json() {}

    public static String text(JSONObject value, String key, int max) throws Exception {
        Object raw = value.get(key);
        if (!(raw instanceof String) || ((String) raw).length() > max) throw new IOException("invalid_" + key);
        return (String) raw;
    }

    public static void keys(JSONObject value, String... names) throws Exception {
        Set<String> allowed = new HashSet<>(Arrays.asList(names));
        Iterator<String> keys = value.keys();
        while (keys.hasNext()) if (!allowed.remove(keys.next())) throw new IOException("unknown_field");
        if (!allowed.isEmpty()) throw new IOException("missing_field");
    }

    public static JSONObject message(String role, String content) throws Exception {
        return new JSONObject().put("role", role).put("content", content);
    }

    public static JSONArray copy(JSONArray value) throws Exception {
        return new JSONArray(value.toString());
    }
}
