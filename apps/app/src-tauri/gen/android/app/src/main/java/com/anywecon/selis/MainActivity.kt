package com.anywecon.selis

import android.os.Bundle
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
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
 * - Back gestures are handled by WryActivity: it calls WebView.goBack() while the
 *   page has history, so in-app navigation uses the History API and the activity
 *   only finishes from the root screen.
 */
class MainActivity : TauriActivity() {
  @Volatile private var insetsJson: String = "{\"top\":0,\"right\":0,\"bottom\":0,\"left\":0}"

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    webView.settings.apply {
      setSupportZoom(false)
      builtInZoomControls = false
      displayZoomControls = false
    }
    webView.overScrollMode = View.OVER_SCROLL_NEVER
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
