package com.wave.app

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.ServiceCompat

/**
 * What keeps a song playing while the app is in the background.
 *
 * Android stops an app that has nothing in the foreground, and the webview and
 * its audio element go with it. This service holds the media playback slot and
 * a partial wake lock while a song is playing, so the audio survives
 * the app being backgrounded and the screen going off.
 *
 * It is also where the notification's own buttons land, since it is the part of
 * the app that is still there when the rest of it is not.
 */
class MediaPlaybackService : Service() {
  companion object {
    @Volatile
    private var instance: MediaPlaybackService? = null

    fun syncPlayback() {
      instance?.syncWakeLock()
    }
  }

  private var wakeLock: PowerManager.WakeLock? = null
  private val wakeLockController = PlaybackWakeLock(::hold, ::release)
  private var foregroundActive = false

  override fun onCreate() {
    super.onCreate()
    instance = this
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == MediaPlayback.ACTION_CONTROL) {
      val value = if (intent.hasExtra(MediaPlayback.EXTRA_VALUE)) {
        intent.getDoubleExtra(MediaPlayback.EXTRA_VALUE, 0.0)
      } else {
        null
      }
      MediaPlayback.press(intent.getStringExtra(MediaPlayback.EXTRA_PRESS), value)
    }

    setForegroundActive(foreground())
    // Nothing to resume from: the queue lives in the webview, which is gone if
    // this process was killed.
    return START_NOT_STICKY
  }

  @Synchronized
  private fun setForegroundActive(active: Boolean) {
    foregroundActive = active
    syncWakeLock()
  }

  @Synchronized
  private fun syncWakeLock() {
    wakeLockController.sync(foregroundActive, MediaPlayback.playing)
  }

  override fun onDestroy() {
    Log.i("Wave", "the playback service stopped")
    if (instance === this) instance = null
    setForegroundActive(false)
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }

  /**
   * Puts the notification up and takes the media playback slot. Android wants
   * this within a few seconds of the service being started, so it is the first
   * thing done here.
   */
  private fun foreground(): Boolean {
    val notification = MediaPlayback.current
    if (notification == null) {
      // Nothing is loaded, so there is nothing to be in the foreground for.
      Log.i("Wave", "the playback service stopped: nothing is loaded")
      stopSelf()
      return false
    }

    val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
    } else {
      0
    }

    try {
      ServiceCompat.startForeground(this, MediaPlayback.NOTIFICATION_ID, notification, type)
      Log.i("Wave", "the playback service is in the foreground")
      return true
    } catch (error: Exception) {
      Log.i("Wave", "the playback service could not go to the foreground")
      Log.w("Wave", "the playback service could not go to the foreground", error)
      stopSelf()
      return false
    }
  }

  /** A partial wake lock, so the audio is not cut off when the screen goes off. */
  private fun hold() {
    if (wakeLock != null) {
      return
    }

    val power = getSystemService(POWER_SERVICE) as PowerManager
    wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "wave:playback").apply {
      setReferenceCounted(false)
      acquire()
    }
  }

  private fun release() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
  }
}
