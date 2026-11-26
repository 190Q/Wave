package com.wave.app

import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.util.Log
import android.support.v4.media.MediaBrowserCompat
import android.support.v4.media.MediaDescriptionCompat
import androidx.core.app.ServiceCompat
import androidx.media.MediaBrowserServiceCompat
import androidx.media.session.MediaButtonReceiver

/** Hosts playback and exposes the most recent song to Android. */
class MediaPlaybackService : MediaBrowserServiceCompat() {
  companion object {
    @Volatile
    private var instance: MediaPlaybackService? = null

    fun syncPlayback(): Boolean = instance?.syncWakeLock() ?: false

    fun isForeground(): Boolean = instance?.foregroundActive == true
  }

  private var wakeLock: PowerManager.WakeLock? = null
  private val wakeLockController = PlaybackWakeLock(::hold, ::release)
  private var taskRemoved = false
  @Volatile
  private var foregroundActive = false

  override fun onCreate() {
    super.onCreate()
    instance = this
    NativePlayback.initialise(this)
    sessionToken = MediaPlayback.session(this).sessionToken
    NativePlayback.updateSessionQueue(this)
    if (NativePlayback.backgroundEnabled(this) && !NativePlayback.snapshot(this).optBoolean("live")) {
      NativePlayback.recentTrack(this)?.let { MediaPlayback.prepareResume(this, it) }
    }
  }

  override fun onGetRoot(clientPackageName: String, clientUid: Int, rootHints: Bundle?): BrowserRoot? {
    if (!NativePlayback.backgroundEnabled(this)) return null
    if (!getSharedPreferences("wave-media", MODE_PRIVATE).getBoolean("controls-enabled", true)) return null
    if (NativePlayback.recentTrack(this) == null) return null
    val extras = Bundle().apply { putBoolean(BrowserRoot.EXTRA_RECENT, true) }
    return BrowserRoot("recent", extras)
  }

  override fun onLoadChildren(parentId: String, result: Result<MutableList<MediaBrowserCompat.MediaItem>>) {
    val track = if (parentId == "recent" && NativePlayback.backgroundEnabled(this)) {
      NativePlayback.recentTrack(this)
    } else null
    if (track == null) {
      result.sendResult(mutableListOf())
      return
    }
    val description = MediaDescriptionCompat.Builder()
      .setMediaId(track.optString("id"))
      .setTitle(track.optString("title"))
      .setSubtitle(track.optString("artist"))
    val artwork = track.optString("artwork")
    if (artwork.isNotEmpty()) {
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(artwork, bounds)
      val options = BitmapFactory.Options().apply {
        inSampleSize = artworkSampleSize(bounds.outWidth, bounds.outHeight, 256)
      }
      BitmapFactory.decodeFile(artwork, options)?.let { description.setIconBitmap(it) }
    }
    result.sendResult(mutableListOf(
      MediaBrowserCompat.MediaItem(description.build(), MediaBrowserCompat.MediaItem.FLAG_PLAYABLE)
    ))
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == Intent.ACTION_MEDIA_BUTTON) {
      MediaButtonReceiver.handleIntent(MediaPlayback.session(this), intent)
    }
    setForegroundActive(foreground())
    if (foregroundActive) NativePlayback.foregroundReady() else NativePlayback.foregroundFailed()
    return START_NOT_STICKY
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    taskRemoved = true
    NativePlayback.setUiVisible(this, false)
    syncWakeLock()
    super.onTaskRemoved(rootIntent)
  }

  @Synchronized
  private fun setForegroundActive(active: Boolean) {
    foregroundActive = active
    syncWakeLock()
  }

  @Synchronized
  private fun syncWakeLock(): Boolean {
    wakeLockController.sync(foregroundActive, MediaPlayback.playing)
    val stop = playbackServiceCanStop(taskRemoved, MediaPlayback.playing, NativePlayback.wantsPlayback)
    if (stop) stopSelf()
    return stop
  }

  override fun onDestroy() {
    Log.i("Wave", "the playback service stopped")
    if (instance === this) instance = null
    setForegroundActive(false)
    NativePlayback.release()
    MediaPlayback.releaseSession(this)
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
