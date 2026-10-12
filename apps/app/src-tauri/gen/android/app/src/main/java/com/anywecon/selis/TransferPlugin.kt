package com.anywecon.selis

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class ForegroundArgs {
  /** Notification texts, already translated by the UI (i18n). */
  lateinit var channel: String
  lateinit var title: String
  lateinit var text: String
  var progress: Int = 0
  var max: Int = 0
}

/**
 * Android side of the Transfer screen (src/commands/transfer.rs, ADR 0010):
 *
 * - `open` / `close`: a Wi-Fi multicast lock while the endpoint exists, so
 *   mDNS finds devices on the same network (Android drops multicast otherwise).
 * - `foreground` / `stopForeground`: a dataSync foreground service while a
 *   transfer runs, so leaving the app does not stop it. Android 15+ limits
 *   dataSync services to 6 h a day; on that timeout the service stops at once
 *   and a `selis:transfer-timeout` window event tells the UI to pause
 *   (receives resume later).
 * - `notifications` permission (Android 13+) for the progress notification;
 *   without it the service still runs, the notification is just not shown.
 */
@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")])
class TransferPlugin(private val activity: Activity) : Plugin(activity) {
  private var multicast: WifiManager.MulticastLock? = null
  private var webView: android.webkit.WebView? = null

  override fun load(webView: android.webkit.WebView) {
    super.load(webView)
    this.webView = webView
    instance = this
  }

  @Command
  fun open(invoke: Invoke) {
    if (multicast == null) {
      val wifi = activity.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
      multicast = wifi?.createMulticastLock("selis-transfer")?.apply {
        setReferenceCounted(false)
        runCatching { acquire() }
      }
    }
    invoke.resolve()
  }

  @Command
  fun close(invoke: Invoke) {
    multicast?.let { if (it.isHeld) runCatching { it.release() } }
    multicast = null
    TransferForegroundService.stop(activity)
    invoke.resolve()
  }

  @Command
  fun foreground(invoke: Invoke) {
    val args = invoke.parseArgs(ForegroundArgs::class.java)
    try {
      TransferForegroundService.show(activity, args)
      invoke.resolve()
    } catch (e: Exception) {
      // ForegroundServiceStartNotAllowedException (background start, or the daily
      // dataSync limit is used up): the transfer goes on while the app is open.
      invoke.reject(e.message ?: "foreground service not allowed", "notAllowed")
    }
  }

  @Command
  fun stopForeground(invoke: Invoke) {
    TransferForegroundService.stop(activity)
    invoke.resolve()
  }

  /** The UI pauses running receives (`selis:transfer-timeout`, features/transfer). */
  internal fun onServiceTimeout() {
    activity.runOnUiThread {
      webView?.evaluateJavascript("window.dispatchEvent(new Event('selis:transfer-timeout'))", null)
    }
  }

  companion object {
    @Volatile internal var instance: TransferPlugin? = null
  }
}

class TransferForegroundService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val notification = pending ?: return START_NOT_STICKY.also { stopSelf() }
    val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0
    ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
    running = true
    // The transfer is resumable; if the process dies it is not restarted on its own.
    return START_NOT_STICKY
  }

  /** Android 15+: the dataSync budget is used up. Stop within seconds, then pause. */
  override fun onTimeout(startId: Int, fgsType: Int) {
    running = false
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    stopSelf()
    TransferPlugin.instance?.onServiceTimeout()
  }

  override fun onDestroy() {
    running = false
    super.onDestroy()
  }

  companion object {
    private const val CHANNEL_ID = "transfer"
    private const val NOTIFICATION_ID = 7301
    @Volatile private var pending: Notification? = null
    @Volatile private var running = false

    fun show(activity: Activity, args: ForegroundArgs) {
      val context = activity.applicationContext
      val manager = context.getSystemService(NotificationManager::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, args.channel, NotificationManager.IMPORTANCE_LOW))
      }
      val open = PendingIntent.getActivity(
        context, 0,
        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
      )
      val notification = NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_stat_transfer)
        .setContentTitle(args.title)
        .setContentText(args.text)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setSilent(true)
        .setContentIntent(open)
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        .apply { if (args.max > 0) setProgress(args.max, args.progress.coerceIn(0, args.max), false) }
        .build()
      pending = notification
      if (running) {
        // Already in the foreground: only the notification changes (allowed from the background).
        manager.notify(NOTIFICATION_ID, notification)
      } else {
        androidx.core.content.ContextCompat.startForegroundService(context, Intent(context, TransferForegroundService::class.java))
      }
    }

    fun stop(context: Context) {
      pending = null
      if (running) context.stopService(Intent(context, TransferForegroundService::class.java))
      running = false
    }
  }
}
