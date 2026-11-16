package com.wave.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.support.v4.media.MediaDescriptionCompat
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.media.app.NotificationCompat.MediaStyle
import androidx.media.session.MediaButtonReceiver
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

  private const val KEEP_ALIVE_EVERY_MS = 30_000L

  private const val TILE_SIZE = 256

  /** Where a button press goes. The plugin fills this in when it is loaded. */
  @Volatile
  var onControl: ((String, Double?) -> Unit)? = null

  private var session: MediaSessionCompat? = null
  @Volatile
  private var notification: Notification? = null
  private var artwork: Bitmap? = null
  private val artworkCache = ArtworkCache { path ->
    if (File(path).isFile) BitmapFactory.decodeFile(path) else null
  }
  private var tile: Bitmap? = null
  private var tileKey = ""
  private var requests = 0

  @Volatile
  private var lastSong: Song? = null

  @Volatile
  var playing = false
    private set

  @Volatile
  private var controlsEnabled = true

  private var showingPausedNotification = false

  private var queue: List<QueueTrack> = emptyList()

  private var shown: Shown? = null

  private var keptAt = 0L

  /** The notification the playback service puts up, or null when nothing is on. */
  val current: Notification?
    get() = notification

  val hasEnabledControls: Boolean
    get() = controlsEnabled && lastSong != null

  /** Shows a song, or takes the whole session down when there is none. */
  @Synchronized
  fun show(context: Context, song: Song) {
    val session = session(context)
    lastSong = song
    playing = song.playing
    if (song.playing) showingPausedNotification = false
    MediaPlaybackService.syncPlayback()
    session.setPlaybackState(state(song))

    val wanted = Shown.of(song)
    val due = SystemClock.elapsedRealtime() - keptAt >= KEEP_ALIVE_EVERY_MS
    if (wanted == shown && !due) {
      return
    }

    if (wanted != shown) {
      artwork = artworkCache.get(song.artworkPath.orEmpty())
      session.setMetadata(metadata(song))
      session.isActive = controlsEnabled

      // The foreground service needs a notification before it starts.
      val built = build(context, song, !showingPausedNotification)
      notification = built
      try {
        NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, built)
      } catch (error: SecurityException) {
        Log.w("Wave", "the playback notification could not be shown", error)
      }
      shown = wanted
    }

    keepAlive(context, true)
    keptAt = SystemClock.elapsedRealtime()
  }

  @Synchronized
  fun setControls(context: Context, enabled: Boolean) {
    if (controlsEnabled == enabled) return
    controlsEnabled = enabled
    if (!enabled) showingPausedNotification = false
    session?.isActive = enabled && lastSong != null
    shown = null
    lastSong?.let { show(context, it) }
  }

  @Synchronized
  fun showPausedControls(context: Context) {
    val song = lastSong ?: return
    if (song.playing || !controlsEnabled || showingPausedNotification) return

    val manager = NotificationManagerCompat.from(context)
    if (!manager.areNotificationsEnabled()) return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      manager.getNotificationChannel(CHANNEL_ID)?.importance == NotificationManager.IMPORTANCE_NONE
    ) return

    val built = build(context, song, false)
    try {
      manager.notify(NOTIFICATION_ID, built)
      notification = built
      showingPausedNotification = true
    } catch (error: SecurityException) {
      Log.w("Wave", "the paused playback notification could not be shown", error)
    }
  }

  /** Takes the notification down and stops holding the process up. */
  @Synchronized
  fun clear(context: Context) {
    shown = null
    notification = null
    lastSong = null
    playing = false
    showingPausedNotification = false
    MediaPlaybackService.syncPlayback()
    session?.isActive = false
    NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
    keepAlive(context, false)
  }

  fun setQueue(context: Context, tracks: List<QueueTrack>) {
    queue = tracks
    val session = session(context)
    session.setQueue(queueItems(tracks))
    lastSong?.let { session.setPlaybackState(state(it)) }
  }

  /** Hands a button press to whoever is listening for one. */
  fun press(action: String?, value: Double?) {
    if (!controlsEnabled) return
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

    Log.i("Wave", "audio focus is managed by the WebView")
    val created = MediaSessionCompat(context, "Wave")

    created.setFlags(
      MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS or
        MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS
    )
    created.setMediaButtonReceiver(mediaButton(context))
    created.setSessionActivity(open(context))

    created.setCallback(
      object : MediaSessionCompat.Callback() {
        override fun onPlay() = press("play", null)
        override fun onPause() = press("pause", null)
        override fun onStop() = press("stop", null)
        override fun onSkipToNext() = press("next", null)
        override fun onSkipToPrevious() = press("previous", null)
        override fun onSeekTo(position: Long) = press("seekTo", position.toDouble())
        override fun onFastForward() = press("seekBy", MediaSeek.STEP_MS)
        override fun onRewind() = press("seekBy", -MediaSeek.STEP_MS)
        override fun onSkipToQueueItem(id: Long) = press("skipToQueueItem", id.toDouble())
        override fun onCustomAction(action: String?, extras: Bundle?) {
          MediaSeek.offset(action)?.let { press("seekBy", it) }
        }
      }
    )
    created.isActive = controlsEnabled
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
    var actions = PlaybackStateCompat.ACTION_PLAY or
      PlaybackStateCompat.ACTION_PAUSE or
      PlaybackStateCompat.ACTION_PLAY_PAUSE or
      PlaybackStateCompat.ACTION_STOP or
      PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
      PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
      PlaybackStateCompat.ACTION_SEEK_TO or
      PlaybackStateCompat.ACTION_FAST_FORWARD or
      PlaybackStateCompat.ACTION_REWIND

    if (queue.isNotEmpty()) {
      actions = actions or PlaybackStateCompat.ACTION_SKIP_TO_QUEUE_ITEM
    }

    return PlaybackStateCompat.Builder()
      .setActions(actions)
      .addCustomAction(MediaSeek.REWIND, "Rewind 10 seconds", R.drawable.ic_wave_rewind)
      .addCustomAction(MediaSeek.FORWARD, "Forward 10 seconds", R.drawable.ic_wave_forward)
      .setState(
        if (song.playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED,
        song.positionMs,
        if (song.playing) 1f else 0f
      )
      .build()
  }

  private fun build(context: Context, song: Song, mediaStyle: Boolean): Notification {
    notificationChannel(context)

    if (!controlsEnabled) {
      return NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_wave_notification)
        .setContentTitle("Wave")
        .setContentText(if (song.playing) "Playback active" else "Playback paused")
        .setContentIntent(open(context))
        .setOnlyAlertOnce(true)
        .setShowWhen(false)
        .setOngoing(song.playing)
        .build()
    }

    val colour = colourOf(song)
    val builder = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_wave_notification)
      .setContentTitle(song.title.orEmpty())
      .setContentText(subtitle(song))
      .setContentIntent(open(context))
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setOngoing(song.playing)
      .addAction(button(context, R.drawable.ic_wave_previous, "Previous", "previous", null))

    if (song.playing) {
      builder.addAction(button(context, R.drawable.ic_wave_pause, "Pause", "pause", null))
    } else {
      builder.addAction(button(context, R.drawable.ic_wave_play, "Play", "play", null))
    }

    builder.addAction(button(context, R.drawable.ic_wave_next, "Next", "next", null))
    builder.addAction(
      button(context, R.drawable.ic_wave_rewind, "Rewind 10 seconds", "seekBy", -MediaSeek.STEP_MS)
    )
    builder.addAction(
      button(context, R.drawable.ic_wave_forward, "Forward 10 seconds", "seekBy", MediaSeek.STEP_MS)
    )

    // Android 8 to 12 colour the card from the song; 13 and later ignore both of
    // these and take the colour off the artwork instead.
    if (colour != null) {
      builder.setColor(colour)
      builder.setColorized(true)
    }

    val cover = artwork
    if (cover != null) {
      builder.setLargeIcon(cover)
    } else if (colour != null) {
      // The tile is what gives a song with no cover a colour on 13 and later.
      builder.setLargeIcon(letterTile(song, colour))
    }

    if (mediaStyle) {
      builder.setStyle(
        MediaStyle()
          .setMediaSession(session?.sessionToken)
          .setShowActionsInCompactView(0, 1, 2)
      )
    } else {
      builder.setCategory(NotificationCompat.CATEGORY_TRANSPORT)
    }

    return builder.build()
  }

  /** The play order as the session wants it, with the list index as the queue id. */
  private fun queueItems(tracks: List<QueueTrack>): List<MediaSessionCompat.QueueItem> =
    tracks.mapIndexed { index, track ->
      val extras = Bundle().apply {
        putLong(MediaMetadataCompat.METADATA_KEY_DURATION, track.durationMs)
      }
      val description = MediaDescriptionCompat.Builder()
        .setMediaId(track.id.orEmpty())
        .setTitle(track.title.orEmpty())
        .setSubtitle(track.artist.orEmpty())
        .setExtras(extras)
        .build()
      MediaSessionCompat.QueueItem(description, index.toLong())
    }

  /** The broadcast the platform sends a media button to when no session takes it. */
  private fun mediaButton(context: Context): PendingIntent {
    val intent = Intent(Intent.ACTION_MEDIA_BUTTON)
      .setClass(context, MediaButtonReceiver::class.java)
    return PendingIntent.getBroadcast(
      context,
      0,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  /** A square of the song's colour with its first letter on it, for a song with no cover. */
  private fun letterTile(song: Song, colour: Int): Bitmap {
    val letter = song.title.orEmpty().trim().take(1).uppercase()
    val key = "$colour|$letter"
    val cached = tile
    if (cached != null && key == tileKey) {
      return cached
    }

    val bitmap = Bitmap.createBitmap(TILE_SIZE, TILE_SIZE, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    canvas.drawColor(colour)

    if (letter.isNotEmpty()) {
      val paint = Paint(Paint.ANTI_ALIAS_FLAG)
      paint.color = Color.WHITE
      paint.textAlign = Paint.Align.CENTER
      paint.typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
      paint.textSize = TILE_SIZE * 0.5f
      // Centred on the middle of the square rather than on the baseline.
      val middle = TILE_SIZE / 2f - (paint.descent() + paint.ascent()) / 2f
      canvas.drawText(letter, TILE_SIZE / 2f, middle, paint)
    }

    tile = bitmap
    tileKey = key
    return bitmap
  }

  private fun colourOf(song: Song): Int? {
    val value = song.colour.orEmpty().trim()
    if (value.isEmpty()) {
      return null
    }

    return try {
      Color.parseColor(value)
    } catch (error: IllegalArgumentException) {
      null
    }
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

  private data class Shown(
    val title: String,
    val artist: String,
    val album: String,
    val durationMs: Long,
    val artworkPath: String,
    val colour: String,
    val playing: Boolean,
  ) {
    companion object {
      fun of(song: Song) = Shown(
        song.title.orEmpty(),
        song.artist.orEmpty(),
        song.album.orEmpty(),
        song.durationMs,
        song.artworkPath.orEmpty(),
        song.colour.orEmpty(),
        song.playing,
      )
    }
  }
}
