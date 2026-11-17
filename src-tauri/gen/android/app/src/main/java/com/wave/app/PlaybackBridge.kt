package com.wave.app

import android.util.Log
import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

internal sealed class PlaybackUpdate {
  data class NowPlaying(val song: Song?) : PlaybackUpdate()
  data class Queue(val tracks: List<QueueTrack>) : PlaybackUpdate()
}

internal fun registerPlaybackBridge(view: WebView, receive: (PlaybackUpdate) -> Unit) {
  if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
  val origins = mutableSetOf("http://tauri.localhost", "https://tauri.localhost")
  if (BuildConfig.DEBUG) {
    origins.add("http://localhost:1420")
    origins.add("http://10.0.2.2:1420")
  }
  try {
    WebViewCompat.addWebMessageListener(view, "wavePlayback", origins) { _, message, _, mainFrame, _ ->
      if (!mainFrame) return@addWebMessageListener
      try {
        val json = JSONObject(message.data ?: return@addWebMessageListener)
        when (json.getString("type")) {
          "song" -> {
            if (!json.has("song")) return@addWebMessageListener
            val data = if (json.isNull("song")) null else json.getJSONObject("song")
            val song = data?.let {
              Song().apply {
                title = it.optString("title")
                artist = it.optString("artist")
                album = it.optString("album")
                durationMs = it.optLong("durationMs").coerceAtLeast(0)
                positionMs = it.optLong("positionMs").coerceAtLeast(0)
                playing = it.optBoolean("playing")
                artworkPath = it.optString("artwork")
                colour = it.optString("colour")
              }
            }
            receive(PlaybackUpdate.NowPlaying(song))
          }
          "queue" -> {
            val tracks = json.getJSONArray("tracks")
            val queue = (0 until minOf(tracks.length(), 50)).map { index ->
              val data = tracks.getJSONObject(index)
              QueueTrack().apply {
                id = data.optString("id")
                title = data.optString("title")
                artist = data.optString("artist")
                durationMs = data.optLong("durationMs").coerceAtLeast(0)
              }
            }
            receive(PlaybackUpdate.Queue(queue))
          }
        }
      } catch (error: Exception) {
        Log.w("Wave", "invalid playback update", error)
      }
    }
  } catch (error: Exception) {
    Log.w("Wave", "the playback bridge could not be registered", error)
  }
}
