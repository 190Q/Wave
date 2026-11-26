package com.wave.app

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.audio.AudioCapabilities
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import com.wave.app.eq.WaveEqAudioProcessor
import com.wave.app.eq.WaveEqBand
import com.wave.app.eq.WaveEqKind
import com.wave.app.eq.WaveEqSettings
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

@OptIn(UnstableApi::class)
internal object NativePlayback {
  private const val PREFERENCES = "wave-native-playback"
  private const val STATE = "state"
  private const val POSITION = "position"
  private const val EQUALISER = "equaliser"
  private const val BACKGROUND = "background-playback"
  private const val CHECKPOINT_MS = 2000L

  private val handler = Handler(Looper.getMainLooper())
  private var context: Context? = null
  private var player: ExoPlayer? = null
  private val equaliser = WaveEqAudioProcessor()
  private var equaliserSettings = WaveEqSettings()
  private var saved = JSONObject()
  private var path: String? = null
  private var position = 0L
  private var volume = 1f
  private var listener: ((JSONObject) -> Unit)? = null
  private var listenerOwner: Any? = null
  private var loading = false
  private var pendingPlay = false
  private var pendingSystemPlay = false
  private var backgroundEnabled = true
  private var uiVisible = false
  val wantsPlayback: Boolean get() = pendingPlay || player?.let {
    it.playWhenReady && it.playbackState != Player.STATE_ENDED && it.playerError == null
  } == true
  private val checkpoint = object : Runnable {
    override fun run() {
      if (player?.isPlaying != true) return
      publish()
    }
  }

  fun backgroundEnabled(context: Context): Boolean {
    initialise(context)
    return backgroundEnabled
  }

  fun setBackgroundEnabled(context: Context, enabled: Boolean) {
    initialise(context)
    backgroundEnabled = enabled
    context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit()
      .putBoolean(BACKGROUND, enabled).apply()
    if (!enabled && !uiVisible) pauseInBackground()
  }

  fun setUiVisible(context: Context, visible: Boolean) {
    initialise(context)
    uiVisible = visible
    if (!visible && !backgroundEnabled) pauseInBackground()
  }

  private fun pauseInBackground() {
    if (player != null || pendingPlay) pause()
    context?.let { MediaPlayback.clear(it) }
  }

  fun updateEqualiser(context: Context, message: JSONObject) {
    initialise(context)
    val settings = message.optJSONObject("settings") ?: return
    equaliserSettings = parseEqualiser(settings)
    equaliser.setSettings(equaliserSettings)
    context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit()
      .putString(EQUALISER, settings.toString()).apply()
  }

  private fun parseEqualiser(settings: JSONObject): WaveEqSettings {
    val bands = settings.optJSONArray("bands") ?: JSONArray()
    val parsed = (0 until bands.length()).mapNotNull { index ->
      val band = bands.optJSONObject(index) ?: return@mapNotNull null
      val kind = when (band.optString("kind")) {
        "lowShelf" -> WaveEqKind.LOW_SHELF
        "highShelf" -> WaveEqKind.HIGH_SHELF
        "lowPass" -> WaveEqKind.LOW_PASS
        "highPass" -> WaveEqKind.HIGH_PASS
        "bandPass" -> WaveEqKind.BAND_PASS
        "notch" -> WaveEqKind.NOTCH
        else -> WaveEqKind.PEAKING
      }
      WaveEqBand(band.optString("id", index.toString()), kind, band.optDouble("freq", 20.0),
        band.optDouble("gain", 0.0), band.optDouble("q", 1.0), band.optBoolean("enabled", true))
    }
    return WaveEqSettings(settings.optBoolean("enabled"), parsed, settings.optBoolean("autoPreamp", true),
      settings.optDouble("preampDb", 0.0), settings.optBoolean("limiter", true))
  }

  fun foregroundReady() {
    if (pendingPlay) context?.let { play(it, pendingSystemPlay) }
  }

  fun foregroundFailed() {
    if (!pendingPlay) return
    pendingPlay = false
    pendingSystemPlay = false
    listener?.invoke(JSONObject().put("type", "error"))
  }

  fun updateSessionQueue(context: Context) {
    initialise(context)
    val order = saved.optJSONObject("playback")?.optJSONArray("order") ?: return
    val source = saved.optJSONArray("tracks") ?: JSONArray()
    val byId = HashMap<String, JSONObject>()
    for (index in 0 until source.length()) {
      source.optJSONObject(index)?.let { byId[it.optString("id")] = it }
    }
    val tracks = (0 until order.length()).map { index ->
      val id = order.optString(index)
      val track = byId[id]
      QueueTrack().apply {
        this.id = id
        title = track?.optString("title")
        artist = track?.optString("artist")
        durationMs = track?.optLong("durationMs") ?: 0
      }
    }
    MediaPlayback.setQueue(context, tracks)
  }

  fun initialise(context: Context) {
    if (this.context != null) return
    this.context = context.applicationContext
    val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    backgroundEnabled = preferences.getBoolean(BACKGROUND, true)
    val encoded = preferences.getString(STATE, null)
    saved = try {
      if (encoded == null) JSONObject() else JSONObject(encoded)
    } catch (_: Exception) {
      JSONObject()
    }
    position = preferences.getLong(POSITION, saved.optLong("positionMs", 0)).coerceAtLeast(0)
    val equaliserJson = preferences.getString(EQUALISER, null)
    if (equaliserJson != null) {
      try {
        equaliserSettings = parseEqualiser(JSONObject(equaliserJson))
        equaliser.setSettings(equaliserSettings)
      } catch (error: Exception) {
        Log.w("Wave", "the equaliser settings could not be restored", error)
      }
    }
  }

  fun listen(context: Context, owner: Any, callback: (JSONObject) -> Unit) {
    initialise(context)
    listenerOwner = owner
    listener = callback
  }

  fun unlisten(owner: Any) {
    if (listenerOwner === owner) {
      listenerOwner = null
      listener = null
    }
  }

  fun snapshot(context: Context): JSONObject {
    initialise(context)
    val track = currentTrack()
    val playback = player
    val currentPosition = playback?.currentPosition?.coerceAtLeast(0) ?: position
    val duration = playback?.duration?.takeIf { it > 0 } ?: track?.optLong("durationMs", 0) ?: 0
    return JSONObject()
      .put("available", track != null)
      .put("live", playback?.currentMediaItem != null)
      .put("currentId", track?.optString("id") ?: JSONObject.NULL)
      .put("path", path ?: track?.optString("path") ?: JSONObject.NULL)
      .put("positionMs", currentPosition)
      .put("durationMs", duration)
      .put("playing", playback?.playWhenReady == true &&
        playback.playbackState != Player.STATE_ENDED && playback.playerError == null &&
        playback.playbackSuppressionReason == Player.PLAYBACK_SUPPRESSION_REASON_NONE)
      .put("playback", saved.optJSONObject("playback") ?: JSONObject())
      .put("eqActive", playback?.currentMediaItem != null && equaliser.active && equaliser.enabled)
      .put("eqPreampDb", equaliser.preampDb)
  }

  fun updateQueue(context: Context, message: JSONObject) {
    initialise(context)
    val tracks = message.optJSONArray("tracks") ?: JSONArray()
    val playback = message.optJSONObject("playback") ?: JSONObject()
    saved.put("tracks", tracks)
    saved.put("playback", playback)
    currentTrack()?.let { saved.put("currentId", it.optString("id")) }
    updateSessionQueue(context)
    persist()
    if (path != null) {
      publish()
      if (pendingPlay) play(context, pendingSystemPlay)
    }
  }

  fun load(context: Context, filePath: String, startMs: Long, autoplay: Boolean) {
    initialise(context)
    val startPlaying = autoplay && (backgroundEnabled || uiVisible)
    pendingPlay = startPlaying
    pendingSystemPlay = false
    val file = File(filePath)
    if (!file.isFile) {
      pendingPlay = false
      player?.stop()
      player?.clearMediaItems()
      listener?.invoke(JSONObject().put("type", "error"))
      publish()
      return
    }
    path = file.absolutePath
    position = startMs.coerceAtLeast(0)
    trackForPath(path!!)?.let { saved.put("currentId", it.optString("id")) }
    val playback = ensurePlayer()
    loading = true
    playback.setMediaItem(MediaItem.fromUri(Uri.fromFile(file)))
    playback.seekTo(position)
    playback.playWhenReady = false
    playback.prepare()
    loading = false
    publish()
    persist()
    if (startPlaying) play(context)
  }

  fun play(context: Context, system: Boolean = false) {
    initialise(context)
    if (!backgroundEnabled && !uiVisible) return
    if (currentTrack() == null) return
    if (!MediaPlaybackService.isForeground()) {
      pendingPlay = true
      pendingSystemPlay = system
      publish()
      if (!MediaPlayback.startService(context)) foregroundFailed()
      return
    }
    pendingPlay = true
    if (system) setVolume(currentTrack()?.optDouble("gain", 1.0) ?: 1.0)
    val playback = player
    if (playback?.currentMediaItem == null) {
      val track = currentTrack() ?: return
      volume = track.optDouble("gain", 1.0).toFloat().coerceIn(0f, 1f)
      load(context, track.optString("path"), position, true)
      return
    }
    if (playback.playbackState == Player.STATE_ENDED) playback.seekTo(0)
    if (playback.playbackState == Player.STATE_IDLE) playback.prepare()
    playback.play()
    pendingPlay = false
    pendingSystemPlay = false
    publish()
  }

  fun pause() {
    pendingPlay = false
    pendingSystemPlay = false
    player?.pause()
    publish()
  }

  fun seek(value: Long) {
    position = value.coerceAtLeast(0)
    player?.seekTo(position)
    publish()
  }

  fun setVolume(value: Double) {
    volume = value.toFloat().coerceIn(0f, 1f)
    player?.volume = volume
  }

  fun clear() {
    handler.removeCallbacks(checkpoint)
    pendingPlay = false
    pendingSystemPlay = false
    saved = JSONObject()
    path = null
    position = 0
    player?.stop()
    player?.clearMediaItems()
    persist()
    context?.let { MediaPlayback.clear(it) }
  }

  fun handleControl(context: Context, action: String, value: Double?): Boolean {
    initialise(context)
    if (!backgroundEnabled && !uiVisible) return false
    if (currentTrack() == null) return false
    when (action) {
      "play" -> play(context, true)
      "pause" -> pause()
      "toggle" -> if (player?.playWhenReady == true) pause() else play(context, true)
      "stop" -> { pause(); seek(0) }
      "next" -> step(1)
      "previous" -> step(-1)
      "seekTo" -> seek((value ?: 0.0).toLong())
      "seekBy" -> seek((player?.currentPosition ?: position) + (value ?: 0.0).toLong())
      "skipToQueueItem" -> jump((value ?: -1.0).toInt())
      else -> return false
    }
    return true
  }

  fun recentTrack(context: Context): JSONObject? {
    initialise(context)
    return currentTrack()?.takeIf { File(it.optString("path")).isFile }
  }

  fun release() {
    handler.removeCallbacks(checkpoint)
    pendingPlay = false
    pendingSystemPlay = false
    player?.let {
      position = it.currentPosition.coerceAtLeast(0)
      saved.put("positionMs", position)
      persist()
      it.release()
    }
    player = null
    path = null
  }

  private fun ensurePlayer(): ExoPlayer {
    player?.let { return it }
    val app = context!!
    val renderers = object : DefaultRenderersFactory(app) {
      override fun buildAudioSink(context: Context, enableFloatOutput: Boolean, enableAudioTrackPlaybackParams: Boolean): AudioSink =
        DefaultAudioSink.Builder(context)
          .setAudioCapabilities(AudioCapabilities.DEFAULT_AUDIO_CAPABILITIES)
          .setAudioProcessors(arrayOf(equaliser))
          .setEnableFloatOutput(false)
          .setEnableAudioTrackPlaybackParams(enableAudioTrackPlaybackParams)
          .build()
    }
    val playback = ExoPlayer.Builder(app, renderers).build()
    playback.setAudioAttributes(
      AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(),
      true
    )
    playback.setHandleAudioBecomingNoisy(true)
    playback.volume = volume
    playback.addListener(object : Player.Listener {
      override fun onPlayerError(error: PlaybackException) {
        Log.w("Wave", "native playback failed", error)
        listener?.invoke(JSONObject().put("type", "error"))
      }

      override fun onEvents(player: Player, events: Player.Events) {
        if (loading) return
        if (events.contains(Player.EVENT_PLAYBACK_STATE_CHANGED) &&
          player.playbackState == Player.STATE_ENDED && player.playWhenReady) {
          listener?.invoke(JSONObject().put("type", "ended"))
          step(1, finished = true)
        } else {
          publish()
        }
      }
    })
    player = playback
    return playback
  }

  private fun step(direction: Int, finished: Boolean = false) {
    val playback = saved.optJSONObject("playback") ?: return
    val order = playback.optJSONArray("order") ?: return
    if (order.length() == 0) return
    var cursor = playback.optInt("cursor", 0) + direction
    if (cursor !in 0 until order.length()) {
      if (playback.optString("repeat") != "all") {
        if (finished) pause()
        return
      }
      cursor = if (direction > 0) 0 else order.length() - 1
    }
    jump(cursor)
  }

  private fun jump(cursor: Int) {
    val playback = saved.optJSONObject("playback") ?: return
    val order = playback.optJSONArray("order") ?: return
    if (cursor !in 0 until order.length()) return
    val track = trackForId(order.optString(cursor)) ?: return
    if (!File(track.optString("path")).isFile) {
      pause()
      listener?.invoke(JSONObject().put("type", "error"))
      return
    }
    playback.put("cursor", cursor)
    saved.put("currentId", track.optString("id"))
    volume = track.optDouble("gain", 1.0).toFloat().coerceIn(0f, 1f)
    player?.volume = volume
    context?.let { load(it, track.optString("path"), 0, true) }
  }

  private fun currentTrack(): JSONObject? {
    val activePath = path
    if (activePath != null) return trackForPath(activePath)
    val id = saved.optString("currentId")
    if (id.isNotEmpty()) trackForId(id)?.let { return it }
    val playback = saved.optJSONObject("playback") ?: return null
    val order = playback.optJSONArray("order") ?: return null
    return trackForId(order.optString(playback.optInt("cursor", 0)))
  }

  private fun trackForPath(path: String): JSONObject? = findTrack { it.optString("path") == path }

  private fun trackForId(id: String): JSONObject? = findTrack { it.optString("id") == id }

  private fun findTrack(match: (JSONObject) -> Boolean): JSONObject? {
    val tracks = saved.optJSONArray("tracks") ?: return null
    for (index in 0 until tracks.length()) {
      val track = tracks.optJSONObject(index) ?: continue
      if (match(track)) return track
    }
    return null
  }

  private fun publish() {
    val app = context ?: return
    val state = snapshot(app)
    position = state.optLong("positionMs", 0)
    saved.put("positionMs", position)
    currentTrack()?.let { track ->
      saved.put("currentId", track.optString("id"))
      val order = saved.optJSONObject("playback")?.optJSONArray("order")
      if (order != null) {
        for (index in 0 until order.length()) {
          if (order.optString(index) == track.optString("id")) {
            saved.optJSONObject("playback")?.put("cursor", index)
            break
          }
        }
      }
      if (backgroundEnabled || uiVisible) {
        MediaPlayback.show(app, Song().apply {
          title = track.optString("title")
          artist = track.optString("artist")
          album = track.optString("album")
          artworkPath = track.optString("artwork")
          colour = track.optString("colour")
          durationMs = state.optLong("durationMs", 0)
          positionMs = position
          playing = state.optBoolean("playing")
        })
      }
    }
    app.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().putLong(POSITION, position).apply()
    listener?.invoke(state.put("type", "state"))
    handler.removeCallbacks(checkpoint)
    if (player?.isPlaying == true) handler.postDelayed(checkpoint, CHECKPOINT_MS)
  }

  private fun persist() {
    val app = context ?: return
    try {
      app.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit()
        .putString(STATE, saved.toString()).putLong(POSITION, position).apply()
    } catch (error: Exception) {
      Log.w("Wave", "the native playback state could not be saved", error)
    }
  }
}
