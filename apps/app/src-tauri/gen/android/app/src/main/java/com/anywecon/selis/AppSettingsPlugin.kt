package com.anywecon.selis

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

/**
 * Opens Selis' page in the system settings (P4c, ADR 0016): after the camera permission was
 * denied for good, Android no longer asks, so "Open settings" is the way back. The scan screen
 * retries the camera when the app returns to the foreground.
 */
@TauriPlugin
class AppSettingsPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun open(invoke: Invoke) {
    val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", activity.packageName, null))
    activity.startActivity(intent)
    invoke.resolve()
  }
}
