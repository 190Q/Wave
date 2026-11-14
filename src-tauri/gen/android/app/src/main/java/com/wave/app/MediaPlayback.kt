package com.wave.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.util.Log
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.media.app.NotificationCompat.MediaStyle
import java.io.File

/**
 * What the notification shade, the lockscreen and the headset buttons see.
 *
 * The audio itself is the webview's, so this holds a report of what that audio
 * element is doing rather than a player of its own: the song, whether it is
 * playing and how far in. The session and the notification live here because
 * both the plugin that is told about the song and the playback service that
 * keeps the process alive need them.
 */
object MediaPlayback {
  /** Sent to the playback service when a notification button is pressed. */
  const val ACTION_CONTROL = "com.wave.app.CONTROL"

  /** The action to hand to the front end, in the shape `presence.rs` emits. */
  const val EXTRA_PRESS = "press"

  /** Milliseconds for a seek, absent for every other action. */
  const val EXTRA_VALUE = "value"

  /** The one notification the playback service shows. */
  const val NOTIFICATION_ID = 1

  private const val CHANNEL_ID = "wave-playback"

  /** How far the seek button moves, matching the front end's own step. */
  private const val SEEK_STEP_MS = 10_000.0

  /** Where a button press goes. The plugin fills this in when it is loaded. */
  @Volatile
  var onControl: ((String, Double?) -> Unit)? = null

  private var session: MediaSessionCompat? = null
  private var notification: Notification? = null
  private var artwork: Bitmap? = null
  private var artworkPath = ""
  private var requests = 0

  /** The notification the playback service puts up, or null when nothing is on. */
  val current: Notification?
    get() = notification

  /** Shows a song, or takes the whole session down when there is none. */
  fun show(context: Context, song: Song) {
    artwork = artworkFor(song.artworkPath.orEmpty())

    val session = session(context)
    session.setMetadata(metadata(song))
    session.setPlaybackState(state(song))
    session.isActive = true

    // The notification is built before the service is started, so the service
    // always has one to put up when Android asks for it.
    val built = build(context, song)
    notification = built
    NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, built)
    keepAlive(context, true)
  }

  /** Takes the notification down and stops holding the process up. */
  fun clear(context: Context) {
    notification = null
    session?.isActive = false
    NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
    keepAlive(context, false)
  }

  /** Hands a button press to whoever is listening for one. */
  fun press(action: String?, value: Double?) {
    val press = action ?: return
    onControl?.invoke(press, value)
  }

  /**
   * Starts or stops the playback service, which is what keeps the process and
   * the webview's audio alive once the app is in the background.
   */
  private fun keepAlive(context: Context, wanted: Boolean) {
    val intent = Intent(context, MediaPlaybackService::class.java)
    if (!wanted) {
      context.stopService(intent)
      return
    }

    try {
      ContextCompat.startForegroundService(context, intent)
    } catch (error: Exception) {
      // Android refuses to start a foreground service from the background, and
      // refuses one whose type it will not allow. Neither is worth the app.
      Log.w("Wave", "the playback service could not be started", error)
    }
  }

  private fun session(context: Context): MediaSessionCompat {
    session?.let { return it }

    val created = MediaSessionCompat(context, "Wave")
    created.setCallback(
      object : MediaSessionCompat.Callback() {
        override fun onPlay() = press("play", null)
        override fun onPause() = press("pause", null)
        override fun onStop() = press("stop", null)
        override fun onSkipToNext() = press("next", null)
        override fun onSkipToPrevious() = press("previous", null)
        override fun onSeekTo(position: Long) = press("seekTo", position.toDouble())
        override fun onFastForward() = press("seekBy", SEEK_STEP_MS)
        override fun onRewind() = press("seekBy", -SEEK_STEP_MS)
      }
    )
    created.isActive = true
    session = created
    return created
  }

  private fun metadata(song: Song): MediaMetadataCompat {
    val builder = MediaMetadataCompat.Builder()
      .putString(MediaMetadataCompat.METADATA_KEY_TITLE, song.title.orEmpty())
      .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, song.artist.orEmpty())
      .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, song.album.orEmpty())
      .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, song.durationMs)

    artwork?.let {
      // The lockscreen reads the art off the session, the notification reads its
      // own large icon, so both are given it.
      builder.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it)
      builder.putBitmap(MediaMetadataCompat.METADATA_KEY_ART, it)
    }

    return builder.build()
  }

  private fun state(song: Song): PlaybackStateCompat {
    val actions = PlaybackStateCompat.ACTION_PLAY or
      PlaybackStateCompat.ACTION_PAUSE or
      PlaybackStateCompat.ACTION_PLAY_PAUSE or
      PlaybackStateCompat.ACTION_STOP or
      PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
      PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
      PlaybackStateCompat.ACTION_SEEK_TO or
      PlaybackStateCompat.ACTION_FAST_FORWARD or
      PlaybackStateCompat.ACTION_REWIND

    return PlaybackStateCompat.Builder()
      .setActions(actions)
      .setState(
        if (song.playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED,
        song.positionMs,
        if (song.playing) 1f else 0f
      )
      .build()
  }

  private fun build(context: Context, song: Song): Notification {
    notificationChannel(context)

    val builder = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_wave_notification)
      .setContentTitle(song.title.orEmpty())
      .setContentText(subtitle(song))
      .setContentIntent(open(context))
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setOngoing(song.playing)
      .addAction(button(context, android.R.drawable.ic_media_previous, "Previous", "previous", null))

    if (song.playing) {
      builder.addAction(button(context, android.R.drawable.ic_media_pause, "Pause", "pause", null))
    } else {
      builder.addAction(button(context, android.R.drawable.ic_media_play, "Play", "play", null))
    }

    builder.addAction(button(context, android.R.drawable.ic_media_next, "Next", "next", null))
    builder.addAction(
      button(context, android.R.drawable.ic_media_ff, "Forward 10 seconds", "seekBy", SEEK_STEP_MS)
    )

    artwork?.let { builder.setLargeIcon(it) }

    builder.setStyle(
      MediaStyle()
        .setMediaSession(session?.sessionToken)
        .setShowActionsInCompactView(0, 1, 2)
    )

    return builder.build()
  }

  /** `Artist` on its own, or `Artist - Album` when the song has both. */
  private fun subtitle(song: Song): String {
    val artist = song.artist.orEmpty()
    val album = song.album.orEmpty()
    return when {
      artist.isEmpty() -> album
      album.isEmpty() -> artist
      else -> "$artist - $album"
    }
  }

  private fun open(context: Context): PendingIntent {
    val intent = Intent(context, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    return PendingIntent.getActivity(
      context,
      0,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  /**
   * A notification button, which goes through the playback service rather than
   * straight to the front end: the service is what is alive when the app is
   * not, and the press has to be queued behind whatever it is already doing.
   */
  private fun button(
    context: Context,
    icon: Int,
    title: String,
    press: String,
    value: Double?
  ): NotificationCompat.Action {
    val intent = Intent(context, MediaPlaybackService::class.java)
      .setAction(ACTION_CONTROL)
      .putExtra(EXTRA_PRESS, press)

    if (value != null) {
      intent.putExtra(EXTRA_VALUE, value)
    }

    val pending = PendingIntent.getService(
      context,
      ++requests,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    return NotificationCompat.Action.Builder(icon, title, pending).build()
  }

  private fun notificationChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return
    }

    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) != null) {
      return
    }

    val channel = NotificationChannel(
      CHANNEL_ID,
      context.getString(R.string.notification_channel_playback),
      NotificationManager.IMPORTANCE_LOW
    )
    channel.setShowBadge(false)
    manager.createNotificationChannel(channel)
  }

  /**
   * The cover the library holds, read off disk. It is kept, because the same
   * song is reported once a second for as long as it plays.
   */
  private fun artworkFor(path: String): Bitmap? {
    if (path.isEmpty()) {
      return null
    }
    if (path == artworkPath) {
      return artwork
    }

    artworkPath = path
    artwork = if (File(path).isFile) BitmapFactory.decodeFile(path) else null
    return artwork
  }
}
