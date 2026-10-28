package com.anywecon.selis

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.print.PrintAttributes
import android.print.PrintCallbacks
import android.util.Log
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.ByteArrayInputStream
import java.io.File

@InvokeArg
class HtmlToPdfArgs {
  /** The sanitised HTML (written by Rust in the app's work folder). */
  lateinit var html: String
  /** Where the PDF goes (the stage, served to the viewer for the preview). */
  lateinit var pdf: String
  /** Page size in thousandths of an inch (A4 portrait: 8268 × 11693). */
  var widthMils: Int = 8268
  var heightMils: Int = 11693
}

/**
 * HTML → PDF with the WebView's own print engine and no print dialog (ADR 0035,
 * src/commands/convert.rs). An off-screen WebView that runs no JavaScript and loads
 * nothing (network blocked, no file or content access, every request answered empty)
 * lays the page out; its PrintDocumentAdapter is driven by hand (android.print.
 * PrintCallbacks) into a file. Page margins come from the HTML's @page rule.
 */
@TauriPlugin
class ConvertPlugin(private val activity: Activity) : Plugin(activity) {
  private val main = Handler(Looper.getMainLooper())

  @Command
  fun available(invoke: Invoke) {
    val result = JSObject()
    result.put("available", PrintCallbacks.available())
    invoke.resolve(result)
  }

  @Command
  fun htmlToPdf(invoke: Invoke) {
    val args = invoke.parseArgs(HtmlToPdfArgs::class.java)
    Thread {
      val html = try {
        File(args.html).readText(Charsets.UTF_8)
      } catch (e: Exception) {
        invoke.reject("cannot read the converted document: ${e.message}")
        return@Thread
      }
      main.post { print(html, args, invoke) }
    }.start()
  }

  @SuppressLint("SetJavaScriptEnabled")
  private fun print(html: String, args: HtmlToPdfArgs, invoke: Invoke) {
    if (!PrintCallbacks.available()) {
      invoke.reject("unsupported: this Android version does not allow printing without the dialog")
      return
    }
    val view = WebView(activity)
    var finished = false
    val finish = { error: String? ->
      if (!finished) {
        finished = true
        main.removeCallbacksAndMessages(view)
        view.stopLoading()
        view.destroy()
        if (error == null) {
          invoke.resolve()
        } else {
          File(args.pdf).delete()
          Log.w(TAG, "conversion failed: $error")
          invoke.reject(error)
        }
      }
    }
    view.settings.apply {
      javaScriptEnabled = false
      blockNetworkLoads = true
      allowFileAccess = false
      allowContentAccess = false
      loadsImagesAutomatically = true
      setGeolocationEnabled(false)
    }
    view.webViewClient = object : WebViewClient() {
      override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        // data: URLs never reach here; anything else (a link the sanitiser missed) gets nothing.
        if (request.url.scheme == "data") return null
        return WebResourceResponse("text/plain", "utf-8", 204, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
      }

      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true

      override fun onPageFinished(view: WebView, url: String?) {
        if (finished) return
        try {
          val attributes = PrintAttributes.Builder()
            .setMediaSize(PrintAttributes.MediaSize("selis", "Selis", args.widthMils, args.heightMils))
            .setResolution(PrintAttributes.Resolution("pdf", "PDF", 300, 300))
            .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
            .setColorMode(PrintAttributes.COLOR_MODE_COLOR)
            .build()
          val out = ParcelFileDescriptor.open(
            File(args.pdf),
            ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE or ParcelFileDescriptor.MODE_WRITE_ONLY,
          )
          PrintCallbacks.print(view.createPrintDocumentAdapter("document"), attributes, out) { error ->
            out.close()
            main.post { finish(error) }
          }
        } catch (e: LinkageError) {
          finish("unsupported: ${e.message}")
        } catch (e: Exception) {
          finish(e.message ?: "print failed")
        }
      }
    }
    main.postAtTime({ finish("timed out") }, view, android.os.SystemClock.uptimeMillis() + TIMEOUT_MS)
    view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
  }

  private companion object {
    const val TAG = "SelisConvert"
    const val TIMEOUT_MS = 120_000L
  }
}
