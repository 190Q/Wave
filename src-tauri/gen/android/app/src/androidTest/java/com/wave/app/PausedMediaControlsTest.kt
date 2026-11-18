package com.wave.app

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.util.Base64
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebViewFeature
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PausedMediaControlsTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val context = ApplicationProvider.getApplicationContext<Context>()

  @Before
  fun allowNotifications() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.POST_NOTIFICATIONS)
    }
    instrumentation.runOnMainSync { MediaPlayback.setControls(context, true) }
  }

  @Test
  fun overlappingControlsStayVisibleUntilAllAreDelivered() {
    val probe = BackgroundPlaybackProbe(3)
    lateinit var view: RustWebView
    val scenario = ActivityScenario.launch(PlaybackTestActivity::class.java)
    try {
      scenario.onActivity { activity ->
        view = RustWebView(activity, emptyArray(), "overlapping-controls-test")
        view.addJavascriptInterface(probe, "test")
        activity.addContentView(view, ViewGroup.LayoutParams(1, 1))
        view.loadDataWithBaseURL("https://tauri.localhost/", """
          <script>
            let controlled = false;
            document.addEventListener("visibilitychange", () => {
              if (controlled && document.hidden) test.hiddenAgain();
            });
            window.addEventListener("wave:media-control", (event) => {
              controlled = true;
              test.control(event.detail.action, document.hidden);
            });
            test.ready();
          </script>
        """.trimIndent(), "text/html", "UTF-8", null)
      }
      assertTrue(probe.ready.await(20, TimeUnit.SECONDS))
      scenario.moveToState(Lifecycle.State.CREATED)
      instrumentation.runOnMainSync {
        dispatchPlaybackControl(view, "play", null)
        dispatchPlaybackControl(view, "next", null)
        dispatchPlaybackControl(view, "pause", null)
      }
      assertTrue(probe.control.await(10, TimeUnit.SECONDS))
      assertEquals(listOf("play", "next", "pause"), probe.actions)
      assertEquals(listOf(false, false, false), probe.hiddenStates)
      assertTrue(probe.hiddenAgain.await(10, TimeUnit.SECONDS))
    } finally {
      instrumentation.runOnMainSync { (view.parent as? ViewGroup)?.removeView(view); view.destroy() }
      scenario.close()
    }
  }

  @Test
  fun expiredControlDoesNotRunAfterANewControlArrives() {
    val probe = BackgroundPlaybackProbe()
    lateinit var view: RustWebView
    val scenario = ActivityScenario.launch(PlaybackTestActivity::class.java)
    try {
      scenario.onActivity { activity ->
        view = RustWebView(activity, emptyArray(), "expired-control-test")
        view.addJavascriptInterface(probe, "test")
        activity.addContentView(view, ViewGroup.LayoutParams(1, 1))
        view.loadDataWithBaseURL("https://tauri.localhost/", """
          <script>
            let controlled = false;
            document.addEventListener("visibilitychange", () => {
              if (controlled && document.hidden) test.hiddenAgain();
            });
            window.addEventListener("wave:media-control", (event) => {
              controlled = true;
              test.control(event.detail.action, document.hidden);
            });
            test.ready();
          </script>
        """.trimIndent(), "text/html", "UTF-8", null)
      }
      assertTrue(probe.ready.await(20, TimeUnit.SECONDS))
      scenario.moveToState(Lifecycle.State.CREATED)
      instrumentation.runOnMainSync { view.evaluateJavascript("test.block()", null) }
      assertTrue(probe.blocked.await(10, TimeUnit.SECONDS))
      instrumentation.runOnMainSync { dispatchPlaybackControl(view, "play", null) }
      Thread.sleep(11_000)
      instrumentation.runOnMainSync { dispatchPlaybackControl(view, "next", null) }
      probe.unblock.countDown()
      assertTrue(probe.control.await(10, TimeUnit.SECONDS))
      assertEquals(listOf("next"), probe.actions)
      assertFalse(probe.hiddenDuringControl)
      assertTrue(probe.hiddenAgain.await(10, TimeUnit.SECONDS))
    } finally {
      probe.unblock.countDown()
      instrumentation.runOnMainSync { (view.parent as? ViewGroup)?.removeView(view); view.destroy() }
      scenario.close()
    }
  }

  @Test
  fun controlsRestoreForegroundAndHiddenParentVisibility() {
    val probe = BackgroundPlaybackProbe(2)
    lateinit var view: RustWebView
    lateinit var parent: FrameLayout
    val scenario = ActivityScenario.launch(PlaybackTestActivity::class.java)
    try {
      scenario.onActivity { activity ->
        parent = FrameLayout(activity)
        view = RustWebView(activity, emptyArray(), "visibility-test")
        view.addJavascriptInterface(probe, "test")
        parent.addView(view, ViewGroup.LayoutParams(1, 1))
        activity.addContentView(parent, ViewGroup.LayoutParams(1, 1))
        view.loadDataWithBaseURL("https://tauri.localhost/", """
          <script>
            let controls = 0;
            document.addEventListener("visibilitychange", () => {
              if (document.hidden && controls === 1) test.hiddenBeforeControl();
              if (document.hidden && controls === 2) test.hiddenAgain();
            });
            window.addEventListener("wave:media-control", (event) => {
              controls++;
              test.control(event.detail.action, document.hidden);
            });
            test.ready();
          </script>
        """.trimIndent(), "text/html", "UTF-8", null)
      }
      assertTrue(probe.ready.await(20, TimeUnit.SECONDS))
      instrumentation.runOnMainSync { dispatchPlaybackControl(view, "play", null) }
      assertTrue(probe.firstControl.await(10, TimeUnit.SECONDS))
      instrumentation.runOnMainSync {
        assertEquals(View.VISIBLE, view.windowVisibility)
        parent.visibility = View.INVISIBLE
      }
      assertTrue(probe.hiddenBeforeControl.await(10, TimeUnit.SECONDS))
      instrumentation.runOnMainSync { dispatchPlaybackControl(view, "next", null) }
      assertTrue(probe.control.await(10, TimeUnit.SECONDS))
      assertEquals(listOf("play", "next"), probe.actions)
      assertEquals(listOf(false, false), probe.hiddenStates)
      assertTrue(probe.hiddenAgain.await(10, TimeUnit.SECONDS))
    } finally {
      instrumentation.runOnMainSync { parent.removeView(view); view.destroy() }
      scenario.close()
    }
  }

  @After
  fun clearPlayback() {
    instrumentation.runOnMainSync {
      MediaPlayback.onControl = null
      MediaPlayback.clear(context)
      MediaPlayback.setControls(context, true)
    }
  }

  @Test
  fun pausedPlaybackKeepsMediaStyleControls() {
    instrumentation.runOnMainSync {
      val song = Song().apply {
        title = "Track"
        artist = "Artist"
        playing = true
      }
      MediaPlayback.show(context, song)
      assertTrue(MediaPlayback.current!!.extras.containsKey(Notification.EXTRA_MEDIA_SESSION))

      song.playing = false
      MediaPlayback.show(context, song)
      val paused = MediaPlayback.current!!
      assertTrue(paused.extras.containsKey(Notification.EXTRA_MEDIA_SESSION))
      assertEquals("Track", paused.extras.getString(Notification.EXTRA_TITLE))
      assertEquals(listOf("Previous", "Play", "Next"), paused.actions.take(3).map { it.title.toString() })

      song.title = "Another track"
      MediaPlayback.show(context, song)
      assertTrue(MediaPlayback.current!!.extras.containsKey(Notification.EXTRA_MEDIA_SESSION))
      assertEquals("Another track", MediaPlayback.current!!.extras.getString(Notification.EXTRA_TITLE))

      song.playing = true
      MediaPlayback.show(context, song)
      assertTrue(MediaPlayback.current!!.extras.containsKey(Notification.EXTRA_MEDIA_SESSION))
      assertEquals("Pause", MediaPlayback.current!!.actions[1].title.toString())
    }
  }

  @Test
  fun pausedPlayActionReachesTheExistingPlaybackService() {
    val pressed = CountDownLatch(1)
    var action: String? = null
    instrumentation.runOnMainSync {
      MediaPlayback.onControl = { name, _ ->
        action = name
        pressed.countDown()
      }
      MediaPlayback.show(context, Song().apply { title = "Track" })
      val play = MediaPlayback.current!!.actions[1]
      assertNotNull(play.actionIntent)
      play.actionIntent.send()
    }
    assertTrue(pressed.await(10, TimeUnit.SECONDS))
    assertEquals("play", action)
  }

  @Test
  fun pausedPlayActionIsDeliveredWhileTheWebViewIsDetached() {
    assumeTrue(WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER))
    val probe = PlaybackProbe()
    lateinit var view: WebView
    instrumentation.runOnMainSync {
      view = WebView(context)
      assertFalse(view.isAttachedToWindow)
      view.settings.javaScriptEnabled = true
      view.settings.mediaPlaybackRequiresUserGesture = false
      view.addJavascriptInterface(probe, "test")
      registerPlaybackBridge(view) { update ->
        when (update) {
          is PlaybackUpdate.NowPlaying -> {
            update.song?.let { MediaPlayback.show(context, it) }
            probe.updated.countDown()
          }
          is PlaybackUpdate.Queue -> {
            probe.queueSize = update.tracks.size
            probe.queue.countDown()
          }
        }
      }
      val sound = Base64.encodeToString(silentWav(), Base64.NO_WRAP)
      view.loadDataWithBaseURL("https://tauri.localhost/", """
        <script>
          const audio = new Audio("data:audio/wav;base64,$sound");
          audio.addEventListener("timeupdate", () => {
            if (audio.currentTime > 0) test.started();
          });
          window.addEventListener("wave:media-control", (event) => {
            test.control(event.detail.action);
            if (event.detail.action === "play") {
              audio.play();
              wavePlayback.postMessage(JSON.stringify({
                type: "song", song: { title: "Track", playing: true, positionMs: 1250 }
              }));
            }
          });
          wavePlayback.postMessage(JSON.stringify({ type: "queue", tracks: [{ id: "one" }] }));
          test.ready();
        </script>
      """.trimIndent(), "text/html", "UTF-8", null)
    }
    try {
      assertTrue(probe.ready.await(20, TimeUnit.SECONDS))
      assertTrue(probe.queue.await(10, TimeUnit.SECONDS))
      assertEquals(1, probe.queueSize)
      instrumentation.runOnMainSync {
        view.onPause()
        MediaPlayback.onControl = { name, value -> dispatchPlaybackControl(view, name, value) }
        MediaPlayback.show(context, Song().apply { title = "Track" })
        MediaPlayback.current!!.actions[1].actionIntent.send()
      }
      assertTrue(probe.control.await(10, TimeUnit.SECONDS))
      assertEquals("play", probe.action)
      assertTrue(probe.started.await(15, TimeUnit.SECONDS))
      assertTrue(probe.updated.await(10, TimeUnit.SECONDS))
      assertTrue(MediaPlayback.playing)
      assertEquals("Pause", MediaPlayback.current!!.actions[1].title.toString())
    } finally {
      instrumentation.runOnMainSync { view.destroy() }
    }
  }

  @Test
  fun untrustedPageCannotAccessThePlaybackBridge() {
    assumeTrue(WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER))
    val probe = PlaybackProbe()
    lateinit var view: WebView
    instrumentation.runOnMainSync {
      view = WebView(context)
      view.settings.javaScriptEnabled = true
      view.addJavascriptInterface(probe, "test")
      registerPlaybackBridge(view) { probe.updated.countDown() }
      view.loadDataWithBaseURL(
        "https://example.invalid/",
        "<script>test.control(typeof window.wavePlayback)</script>",
        "text/html",
        "UTF-8",
        null
      )
    }
    try {
      assertTrue(probe.control.await(10, TimeUnit.SECONDS))
      assertEquals("undefined", probe.action)
      assertEquals(1L, probe.updated.count)
    } finally {
      instrumentation.runOnMainSync { view.destroy() }
    }
  }

  @Test
  fun backgroundedWebViewIsVisibleOnlyWhileDeliveringControls() {
    val probe = BackgroundPlaybackProbe()
    lateinit var view: RustWebView
    val scenario = ActivityScenario.launch(PlaybackTestActivity::class.java)
    try {
      scenario.onActivity { activity ->
        view = RustWebView(activity, emptyArray(), "playback-test")
        view.addJavascriptInterface(probe, "test")
        activity.addContentView(view, ViewGroup.LayoutParams(1, 1))
        val sound = Base64.encodeToString(silentWav(), Base64.NO_WRAP)
        view.loadDataWithBaseURL("https://tauri.localhost/", """
          <script>
            let controlled = false;
            const audio = new Audio("data:audio/wav;base64,$sound");
            audio.addEventListener("timeupdate", () => {
              if (audio.currentTime > 0) test.started();
            });
            document.addEventListener("freeze", () => test.frozen());
            document.addEventListener("visibilitychange", () => {
              if (controlled && document.hidden) test.hiddenAgain();
            });
            window.addEventListener("wave:media-control", (event) => {
              controlled = true;
              test.control(event.detail.action, document.hidden);
              if (event.detail.action === "play") audio.play();
            });
            test.ready();
          </script>
        """.trimIndent(), "text/html", "UTF-8", null)
      }
      assertTrue(probe.ready.await(20, TimeUnit.SECONDS))
      scenario.moveToState(Lifecycle.State.CREATED)
      val freezeSeconds = InstrumentationRegistry.getArguments().getString("freezeTimeoutSeconds")?.toLongOrNull()
      if (freezeSeconds != null) {
        assertTrue("WebView did not freeze", probe.frozen.await(freezeSeconds, TimeUnit.SECONDS))
      }
      instrumentation.runOnMainSync {
        assertTrue(view.isAttachedToWindow)
        assertTrue(view.windowVisibility != View.VISIBLE)
        MediaPlayback.onControl = { name, value -> dispatchPlaybackControl(view, name, value) }
        MediaPlayback.show(context, Song().apply { title = "Track" })
        MediaPlayback.current!!.actions[1].actionIntent.send()
      }
      assertTrue(probe.control.await(10, TimeUnit.SECONDS))
      assertEquals("play", probe.action)
      assertFalse(probe.hiddenDuringControl)
      assertTrue(probe.started.await(15, TimeUnit.SECONDS))
      assertTrue(probe.hiddenAgain.await(10, TimeUnit.SECONDS))
    } finally {
      instrumentation.runOnMainSync { (view.parent as? ViewGroup)?.removeView(view); view.destroy() }
      scenario.close()
    }
  }

  class PlaybackProbe {
    val ready = CountDownLatch(1)
    val control = CountDownLatch(1)
    val started = CountDownLatch(1)
    val updated = CountDownLatch(1)
    val queue = CountDownLatch(1)
    @Volatile var action: String? = null
    @Volatile var queueSize = 0

    @JavascriptInterface fun ready() { ready.countDown() }
    @JavascriptInterface fun control(value: String) {
      action = value
      control.countDown()
    }
    @JavascriptInterface fun started() { started.countDown() }
  }

  class BackgroundPlaybackProbe(expectedControls: Int = 1) {
    val ready = CountDownLatch(1)
    val frozen = CountDownLatch(1)
    val control = CountDownLatch(expectedControls)
    val firstControl = CountDownLatch(1)
    val started = CountDownLatch(1)
    val hiddenBeforeControl = CountDownLatch(1)
    val hiddenAgain = CountDownLatch(1)
    val blocked = CountDownLatch(1)
    val unblock = CountDownLatch(1)
    val actions = Collections.synchronizedList(mutableListOf<String>())
    val hiddenStates = Collections.synchronizedList(mutableListOf<Boolean>())
    @Volatile var action: String? = null
    @Volatile var hiddenDuringControl = true

    @JavascriptInterface fun ready() { ready.countDown() }
    @JavascriptInterface fun frozen() { frozen.countDown() }
    @JavascriptInterface fun started() { started.countDown() }
    @JavascriptInterface fun block() {
      blocked.countDown()
      unblock.await(20, TimeUnit.SECONDS)
    }
    @JavascriptInterface fun control(value: String, hidden: Boolean) {
      action = value
      hiddenDuringControl = hidden
      actions.add(value)
      hiddenStates.add(hidden)
      firstControl.countDown()
      control.countDown()
    }
    @JavascriptInterface fun hiddenBeforeControl() { hiddenBeforeControl.countDown() }
    @JavascriptInterface fun hiddenAgain() { hiddenAgain.countDown() }
  }

  private fun silentWav(): ByteArray {
    val samples = 16_000
    return ByteBuffer.allocate(44 + samples).order(ByteOrder.LITTLE_ENDIAN).apply {
      put("RIFF".toByteArray())
      putInt(36 + samples)
      put("WAVEfmt ".toByteArray())
      putInt(16)
      putShort(1)
      putShort(1)
      putInt(8_000)
      putInt(8_000)
      putShort(1)
      putShort(8)
      put("data".toByteArray())
      putInt(samples)
      repeat(samples) { put(128.toByte()) }
    }.array()
  }

  @Test
  fun pausedForegroundNotificationUsesMediaStyle() {
    instrumentation.runOnMainSync {
      MediaPlayback.show(context, Song().apply { title = "Track" })
    }
    val manager = context.getSystemService(NotificationManager::class.java)
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
    var notification: Notification? = null
    while (System.nanoTime() < deadline) {
      notification = manager.activeNotifications.firstOrNull { it.id == MediaPlayback.NOTIFICATION_ID }?.notification
      if (notification != null && notification.flags and Notification.FLAG_FOREGROUND_SERVICE != 0) break
      Thread.sleep(50)
    }
    assertNotNull(notification)
    assertTrue(notification!!.flags and Notification.FLAG_FOREGROUND_SERVICE != 0)
    assertTrue(notification!!.extras.containsKey(Notification.EXTRA_MEDIA_SESSION))
    assertEquals("Play", notification.actions[1].title.toString())
  }

  @Test
  fun disabledControlsDoNotExposePlaybackActions() {
    instrumentation.runOnMainSync {
      MediaPlayback.show(context, Song().apply { title = "Track" })
      MediaPlayback.setControls(context, false)
      assertTrue(MediaPlayback.current!!.actions.isNullOrEmpty())
    }
  }
}
