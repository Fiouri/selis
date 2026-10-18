package com.anywecon.selis

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.view.HapticFeedbackConstants
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

/**
 * Camera support for the scan (P4c, ADR 0016; ADR 0032). "Open settings": after the camera
 * permission was denied for good, Android no longer asks, so the app's settings page is the way
 * back; the scan screen retries the camera when the app returns to the foreground. "Haptic": a
 * short confirm tick when a page is captured, through the view's haptic feedback (no VIBRATE
 * permission; it follows the system's touch-feedback setting).
 */
@TauriPlugin
class AppSettingsPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun open(invoke: Invoke) {
    val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", activity.packageName, null))
    activity.startActivity(intent)
    invoke.resolve()
  }

  @Command
  fun haptic(invoke: Invoke) {
    val feedback = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY
    activity.runOnUiThread {
      activity.window.decorView.performHapticFeedback(feedback)
      invoke.resolve()
    }
  }
}
