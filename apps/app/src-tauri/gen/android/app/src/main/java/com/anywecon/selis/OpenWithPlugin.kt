package com.anywecon.selis

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.util.Log
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * "Open with" and share target (intent filters in AndroidManifest.xml).
 *
 * Collects PDF `content://` URIs from ACTION_VIEW, ACTION_SEND and
 * ACTION_SEND_MULTIPLE — the launch intent on a cold start, onNewIntent on a
 * warm start — until Rust takes them with `takePending` (src/commands/open_with.rs).
 * Rust then imports a copy into the library through the content resolver in
 * read-only mode; the sender's file is never written. No storage permission is
 * needed: the sender grants read access to these URIs with the intent.
 */
@TauriPlugin
class OpenWithPlugin(private val activity: Activity) : Plugin(activity) {
  private val pending = ArrayList<JSObject>()

  init {
    // Registered during app setup, after onCreate: the launch intent is already set.
    collect(activity.intent)
  }

  override fun onNewIntent(intent: Intent) {
    collect(intent)
  }

  @Command
  fun takePending(invoke: Invoke) {
    val items = JSArray()
    synchronized(pending) {
      pending.forEach { items.put(it) }
      pending.clear()
    }
    val result = JSObject()
    result.put("items", items)
    invoke.resolve(result)
  }

  private fun collect(intent: Intent?) {
    if (intent == null || intent.getBooleanExtra(HANDLED_EXTRA, false)) return
    // Reopening from Recents re-delivers the original intent, whose URI grant is gone.
    if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
    val uris = when (intent.action) {
      Intent.ACTION_VIEW -> listOfNotNull(intent.data)
      Intent.ACTION_SEND -> listOfNotNull(streamExtra(intent)) + clipUris(intent)
      Intent.ACTION_SEND_MULTIPLE -> streamListExtra(intent) + clipUris(intent)
      else -> return
    }.filter { it.scheme == "content" }.distinct()
    // The same Intent object is seen again if the plugin is re-created.
    intent.putExtra(HANDLED_EXTRA, true)
    if (uris.isEmpty()) return
    val items = uris.map { uri ->
      JSObject().apply {
        put("uri", uri.toString())
        displayName(uri)?.let { put("name", it) }
      }
    }
    synchronized(pending) { pending.addAll(items) }
    Log.i(TAG, "received ${items.size} document(s) via ${intent.action}")
  }

  private fun streamExtra(intent: Intent): Uri? =
    if (Build.VERSION.SDK_INT >= 33) {
      intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    } else {
      @Suppress("DEPRECATION")
      intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri
    }

  private fun streamListExtra(intent: Intent): List<Uri> =
    if (Build.VERSION.SDK_INT >= 33) {
      intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
    } else {
      @Suppress("DEPRECATION")
      intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
    }

  private fun clipUris(intent: Intent): List<Uri> {
    val clip = intent.clipData ?: return emptyList()
    return (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
  }

  /** The sender's file name (OpenableColumns.DISPLAY_NAME), used as the document title. */
  private fun displayName(uri: Uri): String? =
    try {
      activity.contentResolver
        .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
        ?.use { cursor ->
          if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getString(0) else null
        }
    } catch (e: Exception) {
      // Some providers refuse queries (SecurityException) or omit the column.
      Log.w(TAG, "no display name for a shared document", e)
      null
    }

  private companion object {
    const val TAG = "SelisOpenWith"
    const val HANDLED_EXTRA = "com.anywecon.selis.OPEN_WITH_HANDLED"
  }
}
