package com.anywecon.selis

import android.app.Activity
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The device's transfer identity (ADR 0011): a 32-byte Ed25519 seed, kept
 * encrypted with an AES-256-GCM key that never leaves the Android Keystore.
 *
 * The sealed seed lives in noBackupFilesDir (never in a backup or a device
 * transfer: a restored copy could not be opened anyway, the Keystore key stays
 * on this device). If it cannot be opened (Keystore reset, file damaged) a new
 * identity is made: trusted devices then see a new device, nothing else is lost.
 * Called from src/commands/transfer.rs; the seed is never given to the UI.
 */
@TauriPlugin
class DeviceKeyPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun deviceKey(invoke: Invoke) {
    Thread {
      try {
        val seed = synchronized(LOCK) { load() ?: create() }
        val out = JSObject()
        out.put("seed", Base64.encodeToString(seed, Base64.NO_WRAP))
        seed.fill(0)
        invoke.resolve(out)
      } catch (e: Exception) {
        invoke.reject(e.message ?: "device key unavailable")
      }
    }.start()
  }

  private val file: File get() = File(activity.noBackupFilesDir, FILE_NAME)

  private fun wrapKey(create: Boolean): SecretKey? {
    val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
    if (!create) return null
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    generator.init(
      KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build()
    )
    return generator.generateKey()
  }

  /** The stored seed, or null when there is none or it cannot be opened. */
  private fun load(): ByteArray? {
    val sealed = runCatching { file.readBytes() }.getOrNull() ?: return null
    if (sealed.size != IV_BYTES + SEED_BYTES + TAG_BYTES) return null
    val key = runCatching { wrapKey(create = false) }.getOrNull() ?: return null
    return runCatching {
      val cipher = Cipher.getInstance(TRANSFORMATION)
      cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BYTES * 8, sealed, 0, IV_BYTES))
      cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES)
    }.getOrNull()?.takeIf { it.size == SEED_BYTES }
  }

  private fun create(): ByteArray {
    val seed = ByteArray(SEED_BYTES).also { SecureRandom().nextBytes(it) }
    val key = wrapKey(create = true) ?: error("keystore unavailable")
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, key) // the Keystore picks the IV
    val sealed = cipher.iv + cipher.doFinal(seed)
    // Atomic replace: temp file, fsync, rename.
    val tmp = File(file.parentFile, "$FILE_NAME.tmp")
    tmp.outputStream().use { out ->
      out.write(sealed)
      out.fd.sync()
    }
    if (!tmp.renameTo(file)) error("could not store the device key")
    return seed
  }

  private companion object {
    val LOCK = Any()
    const val KEYSTORE = "AndroidKeyStore"
    const val ALIAS = "selis-device-key-wrap-v1"
    const val FILE_NAME = "device-key-v1.bin"
    const val TRANSFORMATION = "AES/GCM/NoPadding"
    const val IV_BYTES = 12
    const val SEED_BYTES = 32
    const val TAG_BYTES = 16
  }
}
