package com.wave.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

class LibraryWorkService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val label = LibraryWork.started(this)
    try {
      val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
      } else {
        0
      }
      ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(label), type)
      if (label == null) {
        finish()
      } else {
        hold()
      }
    } catch (error: Exception) {
      Log.w("Wave", "library work could not enter the foreground", error)
      stopSelf()
    }
    return START_NOT_STICKY
  }

  override fun onTimeout(startId: Int, fgsType: Int) {
    Log.w("Wave", "library work reached Android's foreground service time limit")
    stopSelf()
  }

  override fun onDestroy() {
    LibraryWork.stopped(this)
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }

  fun finish() {
    LibraryWork.stopped(this)
    stopSelf()
  }

  fun update(label: String) {
    try {
      val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      manager.notify(NOTIFICATION_ID, notification(label))
    } catch (error: Exception) {
      Log.w("Wave", "library work notification could not be updated", error)
    }
  }

  fun hold() {
    val lock = wakeLock ?: run {
      val power = getSystemService(POWER_SERVICE) as PowerManager
      power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "wave:library-work").apply {
        setReferenceCounted(false)
        wakeLock = this
      }
    }
    lock.acquire(WAKE_LOCK_TIMEOUT_MS)
  }

  private fun notification(label: String?): Notification {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        getString(R.string.notification_channel_library),
        NotificationManager.IMPORTANCE_LOW
      )
      channel.setShowBadge(false)
      manager.createNotificationChannel(channel)
    }
    val intent = Intent(this, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val pending = PendingIntent.getActivity(
      this,
      0,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_wave_notification)
      .setContentTitle(getString(R.string.library_work_title))
      .setContentText(label ?: getString(R.string.library_work_finishing))
      .setContentIntent(pending)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .build()
  }

  companion object {
    private const val CHANNEL_ID = "wave-library-work"
    private const val NOTIFICATION_ID = 2
    private const val WAKE_LOCK_TIMEOUT_MS = 7 * 60 * 60 * 1000L
  }
}
