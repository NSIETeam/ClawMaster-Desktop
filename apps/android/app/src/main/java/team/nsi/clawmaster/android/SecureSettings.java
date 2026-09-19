package team.nsi.clawmaster.android;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import team.nsi.clawmaster.core.ChatClient;

/** Provider credentials encrypted by a non-exportable Android Keystore key. */
final class SecureSettings {
    private static final String ALIAS = "clawmaster.model-key.v1";
    private final SharedPreferences prefs;
    SecureSettings(Context context) { prefs = context.getSharedPreferences("model", Context.MODE_PRIVATE); }
    String base() { return prefs.getString("base", "https://api.deepseek.com"); }
    String model() { return prefs.getString("model", "deepseek-flash"); }
    boolean configured() { return prefs.contains("ciphertext"); }

    String key() throws Exception {
        if (!configured()) return "";
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, encryptionKey(), new GCMParameterSpec(128, Base64.decode(prefs.getString("iv", ""), Base64.NO_WRAP)));
        cipher.updateAAD(ALIAS.getBytes(StandardCharsets.UTF_8));
        return new String(cipher.doFinal(Base64.decode(prefs.getString("ciphertext", ""), Base64.NO_WRAP)), StandardCharsets.UTF_8);
    }

    void save(String base, String model, String enteredKey) throws Exception {
        if (enteredKey.trim().isEmpty() && !base.trim().equals(base())) throw new IOException("new_endpoint_requires_key");
        String value = enteredKey.trim().isEmpty() ? key() : enteredKey.trim();
        new ChatClient(base, model, value);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, encryptionKey());
        cipher.updateAAD(ALIAS.getBytes(StandardCharsets.UTF_8));
        String encrypted = Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
        if (!prefs.edit().putString("base", base.trim()).putString("model", model.trim())
            .putString("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)).putString("ciphertext", encrypted).commit()) {
            throw new IOException("settings_save_failed");
        }
    }

    void removeKey() throws IOException {
        if (!prefs.edit().remove("ciphertext").remove("iv").commit()) throw new IOException("settings_save_failed");
    }

    private SecretKey encryptionKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).build());
        return generator.generateKey();
    }
}
