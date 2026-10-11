package com.anywecon.selis

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AlertDialog
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Edge-to-edge host for the Selis WebView.
 *
 * - Only the PDF zooms: WebView page zoom and the overscroll glow are disabled.
 * - System bar / cutout insets are exposed to the UI as CSS px through the tiny
 *   `SelisAndroid` bridge (read on startup, pushed as a `selis:insets` event on change),
 *   because not every Android WebView reports env(safe-area-inset-*).
 * - Back asks the UI first (`window.__selisBack()`, state/navigation.ts): it closes
 *   sheets, leaves the viewer or the tab, and says whether it did. Only at the root
 *   does the system back run (Tauri's handler: finish the activity). WebView history
 *   alone is not enough: Chromium skips entries pushed without a user gesture, so a
 *   viewer opened by "Open with" on a cold start would close the app on back.
 * - The UI needs a modern WebView (ES2022, 'wasm-unsafe-eval', Tailwind v4 CSS). On an
 *   outdated one (no Play updates) a native dialog explains it instead of a blank screen.
 */
class MainActivity : TauriActivity() {
  @Volatile private var insetsJson: String = "{\"top\":0,\"right\":0,\"bottom\":0,\"left\":0}"
  private var selisWebView: WebView? = null
  private val mainHandler = Handler(Looper.getMainLooper())

  private val backCallback = object : OnBackPressedCallback(true) {
    override fun handleOnBackPressed() {
      val webView = selisWebView ?: return systemBack()
      var answered = false
      // A UI that does not answer (still loading, busy) must not swallow back.
      val timeout = Runnable {
        if (!answered) {
          answered = true
          systemBack()
        }
      }
      mainHandler.postDelayed(timeout, BACK_ANSWER_TIMEOUT_MS)
      webView.evaluateJavascript("typeof window.__selisBack === 'function' && window.__selisBack() === true") { result ->
        if (answered) return@evaluateJavascript
        answered = true
        mainHandler.removeCallbacks(timeout)
        if (result != "true") systemBack()
      }
    }
  }

  /** The default back (Tauri / AndroidX): leaves the app from the root screen. */
  private fun systemBack() {
    backCallback.isEnabled = false
    onBackPressedDispatcher.onBackPressed()
    backCallback.isEnabled = true
  }

  override fun onResume() {
    super.onResume()
    // Re-added so it stays the most recently added callback (it runs first), ahead of
    // the handler Tauri registers once its plugins have loaded.
    backCallback.remove()
    onBackPressedDispatcher.addCallback(this, backCallback)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    warnIfWebViewOutdated()
  }

  private fun warnIfWebViewOutdated() {
    val version = WebView.getCurrentWebViewPackage()?.versionName ?: return
    val major = version.substringBefore('.').toIntOrNull() ?: return
    if (major >= MIN_WEBVIEW_MAJOR) return
    AlertDialog.Builder(this)
      .setTitle(R.string.webview_outdated_title)
      .setMessage(getString(R.string.webview_outdated_message, MIN_WEBVIEW_MAJOR, version))
      .setCancelable(false)
      .setPositiveButton(R.string.webview_outdated_update) { _, _ ->
        openStore("com.google.android.webview")
        finish()
      }
      .setNegativeButton(R.string.webview_outdated_close) { _, _ -> finish() }
      .show()
  }

  private fun openStore(packageName: String) {
    try {
      startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$packageName")))
    } catch (_: ActivityNotFoundException) {
      // No store app (e.g. de-Googled device): the user updates WebView their own way.
    }
  }

  private companion object {
    /** Chromium 111: ES2022 syntax, CSP 'wasm-unsafe-eval' (97+), color-mix()/@property (111+). */
    const val MIN_WEBVIEW_MAJOR = 111

    const val BACK_ANSWER_TIMEOUT_MS = 600L
  }

  override fun onWebViewCreate(webView: WebView) {
    webView.settings.apply {
      setSupportZoom(false)
      builtInZoomControls = false
      displayZoomControls = false
    }
    webView.overScrollMode = View.OVER_SCROLL_NEVER
    selisWebView = webView
    webView.addJavascriptInterface(Bridge(), "SelisAndroid")

    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val density = view.resources.displayMetrics.density
      val json = "{\"top\":${bars.top / density},\"right\":${bars.right / density}," +
        "\"bottom\":${bars.bottom / density},\"left\":${bars.left / density}}"
      if (json != insetsJson) {
        insetsJson = json
        view.post {
          (view as WebView).evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('selis:insets',{detail:$json}))",
            null,
          )
        }
      }
      insets
    }
    ViewCompat.requestApplyInsets(webView)
  }

  /** Methods are called by the UI on a WebView binder thread. */
  private inner class Bridge {
    @JavascriptInterface
    fun getInsets(): String = insetsJson

    /** Dark UI ⇒ light status/navigation bar icons, and vice versa. */
    @JavascriptInterface
    fun setDarkSystemBars(dark: Boolean) {
      runOnUiThread {
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.isAppearanceLightStatusBars = !dark
        controller.isAppearanceLightNavigationBars = !dark
      }
    }
  }
}
