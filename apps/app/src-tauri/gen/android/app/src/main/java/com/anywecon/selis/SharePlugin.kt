package com.anywecon.selis

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File
import java.util.concurrent.TimeUnit

@InvokeArg
class ShareArgs {
  /** Absolute path of the library copy (resolved by Rust, never taken from the UI). */
  lateinit var path: String
  /** File name the recipient sees ("Report.pdf"). */
  lateinit var name: String
}

/**
 * The system share sheet for a library document (src/commands/share.rs).
 *
 * The library copy is named by its hash, so it is copied to cache/share/<title>.pdf
 * and offered through the FileProvider (res/xml/file_paths.xml exposes only that
 * folder) with a read-only grant. Old copies are removed after a day: a receiving
 * app may still be reading a recent one.
 */
@TauriPlugin
class SharePlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun share(invoke: Invoke) {
    val args = invoke.parseArgs(ShareArgs::class.java)
    Thread {
      try {
        val dir = File(activity.cacheDir, "share").apply { mkdirs() }
        val cutoff = System.currentTimeMillis() - TimeUnit.DAYS.toMillis(1)
        dir.listFiles()?.filter { it.lastModified() < cutoff }?.forEach { it.delete() }
        val out = File(dir, safeName(args.name))
        File(args.path).inputStream().use { input -> out.outputStream().use { input.copyTo(it) } }
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", out)
        val send = Intent(Intent.ACTION_SEND).apply {
          type = "application/pdf"
          putExtra(Intent.EXTRA_STREAM, uri)
          clipData = ClipData.newRawUri(out.name, uri)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        activity.runOnUiThread {
          activity.startActivity(Intent.createChooser(send, null))
          invoke.resolve()
        }
      } catch (e: Exception) {
        invoke.reject(e.message ?: "share failed")
      }
    }.start()
  }

  private fun safeName(name: String): String {
    val base = name.replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_").trim().take(120).ifEmpty { "document" }
    return if (base.endsWith(".pdf", ignoreCase = true)) base else "$base.pdf"
  }
}
