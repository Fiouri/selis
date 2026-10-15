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
  /** Most photos one pick returns (1: the single-photo picker; up to 100). */
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
  private val single = PickVisualMedia()
  private var one = false

  @Command
  fun pick(invoke: Invoke) {
    val args = invoke.parseArgs(PickPhotosArgs::class.java)
    one = args.max <= 1
    val request = PickVisualMediaRequest(PickVisualMedia.ImageOnly)
    val intent = if (one) {
      single.createIntent(activity, request)
    } else {
      contract = PickMultipleVisualMedia(args.max.coerceIn(2, 100))
      contract.createIntent(activity, request)
    }
    startActivityForResult(invoke, intent, "picked")
  }

  @ActivityCallback
  fun picked(invoke: Invoke, result: ActivityResult) {
    val uris = if (one) {
      listOfNotNull(single.parseResult(result.resultCode, result.data))
    } else {
      contract.parseResult(result.resultCode, result.data)
    }
    val out = JSObject()
    out.put("uris", JSArray(uris.map { it.toString() }))
    invoke.resolve(out)
  }
}
