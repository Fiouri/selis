package com.anywecon.selis

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationCompat
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
  /** Transferred and total size in KiB (the progress bar; the job's byte counts). */
  var progress: Int = 0
  var max: Int = 0
  /** Sending (upload) or receiving (download). */
  var upload: Boolean = false
}

/**
 * Android side of the Transfer screen (src/commands/transfer.rs, ADR 0010):
 *
 * - `open` / `close`: a Wi-Fi multicast lock while the endpoint exists, so
 *   mDNS finds devices on the same network (Android drops multicast otherwise).
 * - `foreground` / `stopForeground`: keep a running transfer alive when the
 *   user leaves the app (ADR 0027) — on Android 14+ a user-initiated data
 *   transfer job (`TransferJobService`), below that a foreground service
 *   without a type (`TransferForegroundService`). When the system stops the
 *   job, a `selis:transfer-timeout` window event tells the UI to pause
 *   (receives resume later).
 * - `notifications` permission (Android 13+) for the progress notification;
 *   without it the transfer still runs, the notification is just not shown.
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
    TransferKeepAlive.stop(activity)
    invoke.resolve()
  }

  @Command
  fun foreground(invoke: Invoke) {
    val args = invoke.parseArgs(ForegroundArgs::class.java)
    try {
      TransferKeepAlive.show(activity, args)
      invoke.resolve()
    } catch (e: Exception) {
      // The app is not visible (a user-initiated job is scheduled only from the
      // foreground) or the service may not start: the transfer goes on while the app
      // is open, and the next progress update tries again.
      invoke.reject(e.message ?: "background transfer not allowed", "notAllowed")
    }
  }

  @Command
  fun stopForeground(invoke: Invoke) {
    TransferKeepAlive.stop(activity)
    invoke.resolve()
  }

  /** The UI pauses running receives (`selis:transfer-timeout`, features/transfer). */
  internal fun onBackgroundStopped() {
    activity.runOnUiThread {
      webView?.evaluateJavascript("window.dispatchEvent(new Event('selis:transfer-timeout'))", null)
    }
  }

  companion object {
    @Volatile internal var instance: TransferPlugin? = null
  }
}

/**
 * Keeps a running transfer alive while the app is in the background (ADR 0027). Play
 * recommends a user-initiated data transfer job over a dataSync foreground service for
 * transfers the user starts (Play Console Help 13392821), so Android 14+ uses
 * [TransferJobService]; Android 8–13 have no such job and keep [TransferForegroundService].
 */
internal object TransferKeepAlive {
  private const val CHANNEL_ID = "transfer"
  const val NOTIFICATION_ID = 7301

  fun show(activity: Activity, args: ForegroundArgs) {
    val context = activity.applicationContext
    val notification = notification(context, args)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      TransferJobService.show(context, notification, args)
    } else {
      TransferForegroundService.show(context, notification)
    }
  }

  fun stop(context: Context) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      TransferJobService.stop(context.applicationContext)
    } else {
      TransferForegroundService.stop(context.applicationContext)
    }
  }

  private fun notification(context: Context, args: ForegroundArgs): Notification {
    val manager = context.getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, args.channel, NotificationManager.IMPORTANCE_LOW))
    }
    val open = PendingIntent.getActivity(
      context, 0,
      Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )
    return NotificationCompat.Builder(context, CHANNEL_ID)
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
  }
}

/**
 * Android 14+: a user-initiated data transfer job while bytes move. The transfer itself runs
 * in Rust in this process; the running job keeps the process alive and shows the notification
 * (also in the system's Task Manager). Scheduling needs the app to be visible, which it is when
 * the user starts a transfer. A job the system stops (lost network, thermal, no progress) is
 * not rescheduled: the UI pauses and the receive stays resumable.
 */
@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
class TransferJobService : JobService() {
  override fun onStartJob(params: JobParameters): Boolean {
    val notification = pending
    scheduled = false
    if (notification == null) return false // The transfer ended before the job started.
    current = this
    running = params
    setNotification(params, TransferKeepAlive.NOTIFICATION_ID, notification, JOB_END_NOTIFICATION_POLICY_REMOVE)
    updateTransferredNetworkBytes(params, downloaded, uploaded)
    return true
  }

  override fun onStopJob(params: JobParameters): Boolean {
    if (running === params) {
      running = null
      current = null
      pending = null
      // Cancelled by us (stop()) is not a reason to pause.
      if (params.stopReason != JobParameters.STOP_REASON_CANCELLED_BY_APP) {
        TransferPlugin.instance?.onBackgroundStopped()
      }
    }
    return false
  }

  companion object {
    private const val JOB_ID = 7301
    @Volatile private var pending: Notification? = null
    @Volatile private var current: TransferJobService? = null
    @Volatile private var running: JobParameters? = null
    @Volatile private var scheduled = false
    @Volatile private var downloaded = 0L
    @Volatile private var uploaded = 0L

    @SuppressLint("MissingPermission") // RUN_USER_INITIATED_JOBS is in the manifest.
    fun show(context: Context, notification: Notification, args: ForegroundArgs) {
      val done = args.progress.toLong() * 1024
      val total = args.max.toLong() * 1024
      downloaded = if (args.upload) 0L else done
      uploaded = if (args.upload) done else 0L
      pending = notification
      val service = current
      val params = running
      if (service != null && params != null) {
        service.setNotification(params, TransferKeepAlive.NOTIFICATION_ID, notification, JOB_END_NOTIFICATION_POLICY_REMOVE)
        service.updateTransferredNetworkBytes(params, downloaded, uploaded)
        return
      }
      if (scheduled) return
      val unknown = JobInfo.NETWORK_BYTES_UNKNOWN.toLong()
      val job = JobInfo.Builder(JOB_ID, ComponentName(context, TransferJobService::class.java))
        .setUserInitiated(true)
        // Any network, also a Wi-Fi without internet (LAN transfers):
        // setRequiredNetworkType() would ask for validated internet.
        .setRequiredNetwork(NetworkRequest.Builder().clearCapabilities().build())
        .setEstimatedNetworkBytes(
          if (args.upload || total == 0L) unknown else total,
          if (!args.upload || total == 0L) unknown else total,
        )
        .build()
      val scheduler = context.getSystemService(JobScheduler::class.java)
      if (scheduler.schedule(job) != JobScheduler.RESULT_SUCCESS) {
        pending = null
        throw IllegalStateException("user-initiated job not allowed now")
      }
      scheduled = true
    }

    fun stop(context: Context) {
      pending = null
      val service = current
      val params = running
      current = null
      running = null
      if (service != null && params != null) {
        service.jobFinished(params, false)
      } else if (scheduled) {
        context.getSystemService(JobScheduler::class.java).cancel(JOB_ID)
      }
      scheduled = false
    }
  }
}

/**
 * Android 8–13: a foreground service while bytes move. It declares no foreground service type
 * (types are enforced from Android 14, where [TransferJobService] runs instead), so the
 * manifest asks for FOREGROUND_SERVICE only up to API 33.
 */
class TransferForegroundService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val notification = pending ?: return START_NOT_STICKY.also { stopSelf() }
    startForeground(TransferKeepAlive.NOTIFICATION_ID, notification)
    running = true
    // The transfer is resumable; if the process dies it is not restarted on its own.
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    running = false
    super.onDestroy()
  }

  companion object {
    @Volatile private var pending: Notification? = null
    @Volatile private var running = false

    fun show(context: Context, notification: Notification) {
      pending = notification
      if (running) {
        // Already in the foreground: only the notification changes.
        context.getSystemService(NotificationManager::class.java).notify(TransferKeepAlive.NOTIFICATION_ID, notification)
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
