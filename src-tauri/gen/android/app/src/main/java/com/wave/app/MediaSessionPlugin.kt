package com.wave.app

import android.Manifest
import android.app.Activity
import android.os.Build
import android.util.Log
import android.view.View
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/** The song the front end is playing, in the shape `media_session.rs` sends it. */
@InvokeArg
class Song {
  var title: String? = null
  var artist: String? = null
  var album: String? = null
  var durationMs: Long = 0
  var positionMs: Long = 0
  var playing: Boolean = false
  var artworkPath: String? = null
}

@InvokeArg
class SongArgs {
  var song: Song? = null
}

@InvokeArg
class EventsArgs {
  lateinit var channel: Channel
}

/**
 * The phone's own media session.
 *
 * Playback stays in the webview's audio element, so this plugin plays nothing.
 * It puts what that element is doing where Android can see it, in a
 * MediaSessionCompat with a media style notification, and reports the buttons
 * the notification, the lockscreen and a headset are pressed with back to Rust.
 *
 * It also reads the window insets, which is what the front end needs to keep
 * its own furniture clear of the status bar and the gesture bar.
 */
@TauriPlugin(
  permissions = [
    Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS])
  ]
)
class MediaSessionPlugin(private val activity: Activity) : Plugin(activity) {
  private var channel: Channel? = null
  private var webView: WebView? = null
  private var insets: Insets? = null
  private var startScript: ScriptHandler? = null

  override fun load(webView: WebView) {
    this.webView = webView
    MediaPlayback.onControl = { action, value -> report(action, value) }
    watchInsets()
  }

  override fun onResume(activity: AppCompatActivity) {
    // The page is up by now, so this is the push that lands: the listener's
    // first pass usually runs before the page exists at all.
    readInsets()
    pushInsets()
  }

  /** The channel the button presses go back on. */
  @Command
  fun startEvents(invoke: Invoke) {
    channel = invoke.parseArgs(EventsArgs::class.java).channel
    invoke.resolve()
  }

  /** Shows a song, or takes the notification down when there is none. */
  @Command
  fun setNowPlaying(invoke: Invoke) {
    val song = invoke.parseArgs(SongArgs::class.java).song
    if (song == null) {
      MediaPlayback.clear(activity)
      invoke.resolve()
      return
    }

    if (song.playing) {
      askForNotifications()
    }

    MediaPlayback.show(activity, song)
    invoke.resolve()
  }

  /** Takes the notification down, for when the app is on its way out. */
  @Command
  fun stopSession(invoke: Invoke) {
    MediaPlayback.clear(activity)
    invoke.resolve()
  }

  private fun report(action: String, value: Double?) {
    val payload = JSObject()
    payload.put("action", action)
    if (value != null) {
      payload.put("value", value)
    }
    channel?.send(payload)
  }

  /**
   * The notification is where the session shows itself, and Android 13 and
   * later only put one up once the user has allowed it. The answer is not
   * waited for: a refused notification costs the notification, nothing else.
   */
  private fun askForNotifications() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
      return
    }
    if (getPermissionState("notifications") == PermissionState.GRANTED) {
      return
    }

    ActivityCompat.requestPermissions(
      activity,
      arrayOf(Manifest.permission.POST_NOTIFICATIONS),
      0
    )
  }

  private fun watchInsets() {
    val view = activity.findViewById<View>(android.R.id.content) ?: return

    ViewCompat.setOnApplyWindowInsetsListener(view) { listened, windowInsets ->
      readInsets(windowInsets, listened.resources.displayMetrics.density)
      pushInsets()
      windowInsets
    }
  }

  /** The insets as they stand now, for a push the listener did not cause. */
  private fun readInsets() {
    val view = activity.window.decorView
    val windowInsets = ViewCompat.getRootWindowInsets(view) ?: return
    readInsets(windowInsets, view.resources.displayMetrics.density)
  }

  /** The bars and the cutout, in CSS pixels, which is what the page reads. */
  private fun readInsets(windowInsets: WindowInsetsCompat, density: Float) {
    val bars = windowInsets.getInsets(
      WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
    )
    insets = Insets.of(
      (bars.left / density).toInt(),
      (bars.top / density).toInt(),
      (bars.right / density).toInt(),
      (bars.bottom / density).toInt()
    )
  }

  /**
   * Writes the insets into the page, twice over.
   *
   * `window.__WAVE_INSETS__` and the `wave:insets` event on `window` are the
   * contract with src/lib/device.ts, which reads the global when it starts and
   * follows the event afterwards. The page is usually loaded after the first
   * pass, so the values are also registered as a script that runs at the start
   * of every document, which is what the page reads when it comes up.
   */
  private fun pushInsets() {
    val values = insets ?: return
    val view = webView ?: return
    val script = insetsScript(values)

    try {
      if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
        startScript?.remove()
        startScript = WebViewCompat.addDocumentStartJavaScript(view, script, setOf("*"))
      }
    } catch (error: Exception) {
      Log.w("Wave", "the insets could not be registered at document start", error)
    }

    view.evaluateJavascript(script, null)
  }

  private fun insetsScript(values: Insets): String =
    "window.__WAVE_INSETS__={top:${values.top},right:${values.right}," +
      "bottom:${values.bottom},left:${values.left}};" +
      "window.dispatchEvent(new Event('wave:insets'));"
}
