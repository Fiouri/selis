package com.anywecon.selis

import android.app.Activity
import androidx.activity.result.ActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts.PickMultipleVisualMedia
import androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class PickPhotosArgs {
  /** Most photos one pick returns (2–100; the system picker may allow fewer). */
  var max: Int = 50
}

/**
 * The Android photo picker (P4b, ADR 0017): several images, no storage permission. The picker
 * grants read access to the returned content URIs for this process; Rust copies each one into
 * the stage (src/commands/photos.rs) before the UI reads it.
 */
@TauriPlugin
class PhotoPickerPlugin(private val activity: Activity) : Plugin(activity) {
  private var contract = PickMultipleVisualMedia(50)

  @Command
  fun pick(invoke: Invoke) {
    val args = invoke.parseArgs(PickPhotosArgs::class.java)
    contract = PickMultipleVisualMedia(args.max.coerceIn(2, 100))
    val intent = contract.createIntent(activity, PickVisualMediaRequest(PickVisualMedia.ImageOnly))
    startActivityForResult(invoke, intent, "picked")
  }

  @ActivityCallback
  fun picked(invoke: Invoke, result: ActivityResult) {
    val uris = contract.parseResult(result.resultCode, result.data)
    val out = JSObject()
    out.put("uris", JSArray(uris.map { it.toString() }))
    invoke.resolve(out)
  }
}
