package com.wave.app

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebViewFeature
import java.nio.ByteBuffer
import java.nio.ByteOrder
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
