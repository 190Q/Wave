package com.wave.app

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.DocumentsContract
import android.util.Log
import android.view.View
import android.webkit.WebView
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.graphics.Insets
import androidx.core.content.FileProvider
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
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.RandomAccessFile
import java.util.WeakHashMap

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
  var colour: String? = null
}

@InvokeArg
class SongArgs {
  var song: Song? = null
}

/** One entry of the play order, in the shape `media_session.rs` sends it. */
@InvokeArg
class QueueTrack {
  var id: String? = null
  var title: String? = null
  var artist: String? = null
  var durationMs: Long = 0
}

@InvokeArg
class QueueArgs {
  var tracks: List<QueueTrack>? = null
}

@InvokeArg
class ControlsArgs {
  var enabled: Boolean = true
}

@InvokeArg
class LogArgs {
  lateinit var name: String
}

/** How long after a pause the webview is put back into its running state. */
private const val KEEP_ALIVE_RETRY_MS = 500L
private const val CONTROL_TIMEOUT_MS = 10_000L
private const val LOG_VIEW_BYTES = 1_048_576L

private val playbackHandler = Handler(Looper.getMainLooper())
private val pendingControls = WeakHashMap<RustWebView, Int>()

internal fun resumePlaybackWebView(view: WebView, action: () -> Unit) {
  playbackHandler.post {
    view.onResume()
    view.resumeTimers()
    action()
  }
}

internal fun dispatchPlaybackControl(view: WebView, action: String, value: Double?) {
  val payload = JSObject()
  payload.put("action", action)
  if (value != null) {
    payload.put("value", value)
  }
  val power = view.context.applicationContext.getSystemService(Context.POWER_SERVICE) as PowerManager
  val wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "wave:media-control").apply {
    setReferenceCounted(false)
    acquire(CONTROL_TIMEOUT_MS)
  }
  val deadline = System.currentTimeMillis() + CONTROL_TIMEOUT_MS
  resumePlaybackWebView(view) {
    val rustView = view as? RustWebView
    if (rustView != null) {
      val pending = pendingControls[rustView] ?: 0
      if (pending == 0) rustView.setPlaybackControlVisible(true)
      pendingControls[rustView] = pending + 1
    }

    var finished = false
    lateinit var finish: Runnable
    finish = Runnable {
      if (!finished) {
        finished = true
        playbackHandler.removeCallbacks(finish)
        if (rustView != null) {
          val pending = (pendingControls[rustView] ?: 1) - 1
          if (pending == 0) {
            pendingControls.remove(rustView)
            rustView.setPlaybackControlVisible(false)
          } else {
            pendingControls[rustView] = pending
          }
        }
        if (wakeLock.isHeld) wakeLock.release()
      }
    }
    playbackHandler.postDelayed(finish, CONTROL_TIMEOUT_MS)
    // Chromium posts its visibility update, so deliver the control on the next turn.
    playbackHandler.post {
      try {
        view.evaluateJavascript(
          "if (Date.now() <= $deadline) window.dispatchEvent(new CustomEvent('wave:media-control',{detail:$payload}));"
        ) { finish.run() }
      } catch (error: Exception) {
        finish.run()
        Log.w("Wave", "the media control could not be delivered", error)
      }
    }
  }
}

/** Reports playback to Android and forwards media controls to the webview. */
@TauriPlugin(
  permissions = [
    Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS])
  ]
)
class MediaSessionPlugin(private val activity: Activity) : Plugin(activity) {
  private var webView: WebView? = null
  private var insets: Insets? = null
  private var startScript: ScriptHandler? = null
  private var playing = false

  /** True once the keep-alive has been said out loud for the current song. */
  private var keepAliveLogged = false

  override fun load(webView: WebView) {
    this.webView = webView
    MediaPlayback.onControl = { action, value -> report(action, value) }
    registerPlaybackBridge(webView) { update ->
      when (update) {
        is PlaybackUpdate.NowPlaying -> showSong(update.song)
        is PlaybackUpdate.Queue -> MediaPlayback.setQueue(activity, update.tracks)
      }
    }
    watchInsets()
  }

  @Command
  fun setControls(invoke: Invoke) {
    MediaPlayback.setControls(activity, invoke.parseArgs(ControlsArgs::class.java).enabled)
    invoke.resolve()
  }

  override fun onResume(activity: AppCompatActivity) {
    // The page is up by now, so this is the push that lands: the listener's
    // first pass usually runs before the page exists at all.
    readInsets()
    pushInsets()
  }

  override fun onPause(activity: AppCompatActivity) {
    keepPlaying()
  }

  override fun onStop(activity: AppCompatActivity) {
    keepPlaying()
  }

  /** Shows a song, or takes the notification down when there is none. */
  @Command
  fun setNowPlaying(invoke: Invoke) {
    showSong(invoke.parseArgs(SongArgs::class.java).song)
    invoke.resolve()
  }

  private fun showSong(song: Song?) {
    if (song == null) {
      playing = false
      keepAliveLogged = false
      MediaPlayback.clear(activity)
      return
    }

    val wasPlaying = playing
    playing = song.playing

    if (song.playing) {
      askForNotifications()
      if (!wasPlaying) {
        keepPlaying()
      }
    } else {
      keepAliveLogged = false
    }

    MediaPlayback.show(activity, song)
  }

  /** Hands over the play order, so the phone's own card can offer the queue. */
  @Command
  fun setQueue(invoke: Invoke) {
    val tracks = invoke.parseArgs(QueueArgs::class.java).tracks ?: emptyList()
    MediaPlayback.setQueue(activity, tracks)
    invoke.resolve()
  }

  /** Takes the notification down, for when the app is on its way out. */
  @Command
  fun stopSession(invoke: Invoke) {
    playing = false
    keepAliveLogged = false
    MediaPlayback.clear(activity)
    invoke.resolve()
  }

  @Command
  fun openMusicFolder(invoke: Invoke) {
    val authority = "${activity.packageName}.documents"
    val tree = DocumentsContract.buildTreeDocumentUri(authority, MusicDocumentsProvider.ROOT_ID)
    val directory = DocumentsContract.buildDocumentUriUsingTree(tree, MusicDocumentsProvider.ROOT_ID)
    val root = DocumentsContract.buildRootUri(authority, MusicDocumentsProvider.ROOT_ID)
    val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
    val rootView = Intent(Intent.ACTION_VIEW).setDataAndType(root, "vnd.android.document/root")
    val directoryView = Intent(Intent.ACTION_VIEW).setDataAndType(directory, DocumentsContract.Document.MIME_TYPE_DIR)
    for (view in listOf(rootView, directoryView)) {
      view.clipData = ClipData.newRawUri("Wave music", tree)
      view.addFlags(flags)
    }
    activity.runOnUiThread {
      try {
        val manager = activity.packageManager
        val rootHandlers = manager.queryIntentActivities(rootView, PackageManager.MATCH_DEFAULT_ONLY)
        val directoryHandlers = manager.queryIntentActivities(directoryView, PackageManager.MATCH_DEFAULT_ONLY)
        if (rootHandlers.isEmpty() && directoryHandlers.isEmpty()) {
          val picker = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
              putExtra(DocumentsContract.EXTRA_INITIAL_URI, directory)
            }
          }
          activity.startActivity(picker)
        } else {
          val base = if (rootHandlers.isNotEmpty()) rootView else directoryView
          val rootComponents = rootHandlers.map { ComponentName(it.activityInfo.packageName, it.activityInfo.name) }.toSet()
          val alternatives = directoryHandlers.mapNotNull {
            val component = ComponentName(it.activityInfo.packageName, it.activityInfo.name)
            if (component in rootComponents || rootHandlers.isEmpty()) null
            else Intent(directoryView).setComponent(component)
          }
          val chooser = Intent.createChooser(base, "Open Wave music")
          if (alternatives.isNotEmpty()) {
            chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, alternatives.toTypedArray())
          }
          activity.startActivity(chooser)
        }
        invoke.resolve()
      } catch (error: Exception) {
        invoke.reject(error.message ?: "Could not open a file manager")
      }
    }
  }

  @Command
  fun openLog(invoke: Invoke) {
    val name = invoke.parseArgs(LogArgs::class.java).name
    if (name != "import.log") {
      invoke.reject("Invalid log name")
      return
    }

    val file = File(activity.cacheDir, "shared-logs/$name")
    val contents = try {
      RandomAccessFile(file, "r").use { input ->
        val size = input.length()
        val start = (size - LOG_VIEW_BYTES).coerceAtLeast(0)
        val bytes = ByteArray((size - start).toInt())
        input.seek(start)
        input.readFully(bytes)
        val prefix = if (start > 0) "Showing the last 1 MB. Open with another app to see the full log.\n\n" else ""
        prefix + bytes.toString(Charsets.UTF_8)
      }
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not read the log")
      return
    }

    activity.runOnUiThread {
      try {
        val padding = (16 * activity.resources.displayMetrics.density).toInt()
        val text = TextView(activity).apply {
          this.text = contents.ifEmpty { "The log is empty." }
          textSize = 12f
          typeface = Typeface.MONOSPACE
          setTextIsSelectable(true)
          setPadding(padding, padding, padding, padding)
        }
        val scroll = ScrollView(activity).apply { addView(text) }
        AlertDialog.Builder(activity)
          .setTitle(name)
          .setView(scroll)
          .setPositiveButton("Close", null)
          .setNeutralButton("Open with...") { _, _ ->
            try {
              val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
              val view = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "text/plain")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
              }
              activity.startActivity(Intent.createChooser(view, "Open log"))
            } catch (error: Exception) {
              Toast.makeText(activity, error.message ?: "Could not open the log", Toast.LENGTH_LONG).show()
            }
          }
          .show()
        invoke.resolve()
      } catch (error: Exception) {
        invoke.reject(error.message ?: "Could not open the log")
      }
    }
  }

  private fun keepPlaying() {
    if (!playing) {
      return
    }

    val view = webView ?: return
    if (!keepAliveLogged) {
      keepAliveLogged = true
      Log.i("Wave", "playback keep-alive: webView.onResume and resumeTimers")
    }

    resumePlaybackWebView(view) {
      playbackHandler.postDelayed({
        if (playing) {
          view.onResume()
          view.resumeTimers()
        }
      }, KEEP_ALIVE_RETRY_MS)
    }
  }

  private fun report(action: String, value: Double?) {
    val view = webView ?: return
    dispatchPlaybackControl(view, action, value)
  }

  /**
   * The notification is where the session shows itself, and Android 13 and
   * later only put one up once the user has allowed it. The answer is not
   * waited for: a refused notification costs the notification, nothing else.
   */
  private fun askForNotifications() {
    activity.runOnUiThread {
      val preferences = activity.getSharedPreferences("wave-media", Activity.MODE_PRIVATE)
      val requested = preferences.getBoolean("notifications-requested", false)
      val deniedBefore = ActivityCompat.shouldShowRequestPermissionRationale(
        activity, Manifest.permission.POST_NOTIFICATIONS
      )
      if (notificationPermissionNeeded(
          Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU,
          getPermissionState("notifications") == PermissionState.GRANTED,
          requested,
          deniedBefore
        )) {
        preferences.edit().putBoolean("notifications-requested", true).apply()
        ActivityCompat.requestPermissions(
          activity,
          arrayOf(Manifest.permission.POST_NOTIFICATIONS),
          0
        )
      }
    }
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
