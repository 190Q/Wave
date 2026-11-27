package com.wave.app

import android.Manifest
import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.support.v4.media.MediaBrowserCompat
import android.support.v4.media.session.MediaControllerCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.media.MediaBrowserServiceCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NativePlaybackResumptionTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val context = ApplicationProvider.getApplicationContext<Context>()
  private lateinit var client: NativePlaybackClient
  private lateinit var audio: File
  private lateinit var nextAudio: File
  @Volatile private var state = JSONObject()
  @Volatile private var snapshotState = JSONObject()
  @Volatile private var checkpointState = JSONObject()
  @Volatile private var snapshots = 0

  @Before
  fun prepare() {
    assumeTrue(context.packageName.endsWith(".resumptiontest"))
    audio = File(context.cacheDir, "resumption-test.wav")
    nextAudio = File(context.cacheDir, "resumption-next-test.wav")
    writeSilentAudio(audio)
    writeSilentAudio(nextAudio)
    val connected = CountDownLatch(1)
    instrumentation.runOnMainSync {
      client = NativePlaybackClient(context)
      client.connect { receive(JSONObject(it), connected) }
    }
    assertTrue(connected.await(10, TimeUnit.SECONDS))
    instrumentation.runOnMainSync { client.setVisible(true) }
    send(JSONObject().put("type", "background").put("enabled", true))
    send(JSONObject().put("type", "clear"))
    send(JSONObject().put("type", "controls").put("enabled", true))
    send(JSONObject().put("type", "queue")
      .put("tracks", JSONArray()
        .put(JSONObject().put("id", "test").put("path", audio.absolutePath)
          .put("title", "Resumption test").put("artist", "Wave").put("durationMs", 30_000))
        .put(JSONObject().put("id", "next").put("path", nextAudio.absolutePath)
          .put("title", "Next test").put("artist", "Wave").put("durationMs", 30_000)))
      .put("playback", JSONObject().put("order", JSONArray().put("test").put("next")).put("cursor", 0)))
    send(JSONObject().put("type", "load").put("path", audio.absolutePath).put("positionMs", 1_500))
    assertTrue(waitFor { it.optBoolean("live") && it.optString("currentId") == "test" })
  }

  @Test
  fun pausedControlsRemainForegroundAfterTheAppTaskIsRemoved() {
    allowNotifications()
    val scenario = ActivityScenario.launch(PlaybackTestActivity::class.java)
    val browser = connectBrowser()
    try {
      send(JSONObject().put("type", "play"))
      assertTrue(waitFor { it.optBoolean("playing") })
      instrumentation.runOnMainSync {
        client.setVisible(false)
        client.close()
      }
      scenario.onActivity { it.finishAndRemoveTask() }
      Thread.sleep(1_000)
      val controller = MediaControllerCompat(context, browser.sessionToken)
      instrumentation.runOnMainSync { browser.disconnect() }
      instrumentation.runOnMainSync { controller.transportControls.pause() }
      Thread.sleep(1_500)
      assertTrue(waitForPausedControls(controller))
    } finally {
      instrumentation.runOnMainSync { browser.disconnect() }
      scenario.close()
    }
  }

  @Test
  fun mediaOnlyPlaybackKeepsPausedControlsAvailable() {
    allowNotifications()
    instrumentation.runOnMainSync {
      client.setVisible(false)
      client.close()
    }
    val browser = connectBrowser()
    try {
      val controller = MediaControllerCompat(context, browser.sessionToken)
      instrumentation.runOnMainSync { controller.transportControls.play() }
      assertTrue(waitForController { controller.playbackState?.state == PlaybackStateCompat.STATE_PLAYING })
      instrumentation.runOnMainSync { browser.disconnect() }
      instrumentation.runOnMainSync { controller.transportControls.pause() }
      Thread.sleep(1_500)
      assertTrue(waitForPausedControls(controller))
    } finally {
      instrumentation.runOnMainSync { browser.disconnect() }
    }
  }

  private fun writeSilentAudio(file: File) {
    val samples = 240_000
    file.writeBytes(ByteBuffer.allocate(44 + samples).order(ByteOrder.LITTLE_ENDIAN).apply {
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
    }.array())
  }

  @Test
  fun checkpointsOmitTheQueueButReconnectionSnapshotsRetainIt() {
    val connected = CountDownLatch(1)
    instrumentation.runOnMainSync {
      client.connect { receive(JSONObject(it), connected) }
    }
    assertTrue(connected.await(10, TimeUnit.SECONDS))
    assertEquals(2, snapshotState.optJSONObject("playback")?.optJSONArray("order")?.length())
    assertEquals(0, snapshotState.optJSONObject("playback")?.optInt("cursor"))

    val browserConnected = CountDownLatch(1)
    lateinit var browser: MediaBrowserCompat
    instrumentation.runOnMainSync {
      browser = MediaBrowserCompat(context, ComponentName(context, MediaPlaybackService::class.java),
        object : MediaBrowserCompat.ConnectionCallback() {
          override fun onConnected() { browserConnected.countDown() }
        }, Bundle().apply { putBoolean(MediaBrowserServiceCompat.BrowserRoot.EXTRA_RECENT, true) })
      browser.connect()
    }
    try {
      assertTrue(browserConnected.await(10, TimeUnit.SECONDS))
      instrumentation.runOnMainSync {
        MediaControllerCompat(context, browser.sessionToken).transportControls.skipToNext()
      }
      assertTrue(waitFor { it.optString("currentId") == "next" })
      val reconnected = CountDownLatch(1)
      instrumentation.runOnMainSync {
        client.connect { receive(JSONObject(it), reconnected) }
      }
      assertTrue(reconnected.await(10, TimeUnit.SECONDS))
      assertEquals("next", snapshotState.optString("currentId"))
      assertEquals(1, snapshotState.optJSONObject("playback")?.optInt("cursor"))
    } finally {
      instrumentation.runOnMainSync { browser.disconnect() }
    }

    send(JSONObject().put("type", "seek").put("positionMs", 2_500))
    assertTrue(waitFor {
      checkpointState.optString("currentId") == "next" && checkpointState.optLong("positionMs") >= 2_500
    })
    assertTrue(!checkpointState.has("playback"))
  }

  @Test
  fun disabledBackgroundPlaybackPausesAndRejectsResumption() {
    send(JSONObject().put("type", "background").put("enabled", false))
    send(JSONObject().put("type", "play"))
    assertTrue(waitFor { it.optBoolean("playing") })

    val failed = CountDownLatch(1)
    lateinit var browser: MediaBrowserCompat
    instrumentation.runOnMainSync {
      browser = MediaBrowserCompat(context, ComponentName(context, MediaPlaybackService::class.java),
        object : MediaBrowserCompat.ConnectionCallback() {
          override fun onConnectionFailed() { failed.countDown() }
        }, Bundle().apply { putBoolean(MediaBrowserServiceCompat.BrowserRoot.EXTRA_RECENT, true) })
      browser.connect()
    }
    try {
      assertTrue(failed.await(10, TimeUnit.SECONDS))
      instrumentation.runOnMainSync { client.setVisible(false) }
      assertTrue(waitFor { !it.optBoolean("playing") })
      send(JSONObject().put("type", "load").put("path", audio.absolutePath)
        .put("positionMs", 2_000).put("autoplay", true))
      assertTrue(waitFor { it.optLong("positionMs") >= 2_000 && !it.optBoolean("playing") })
      send(JSONObject().put("type", "play"))
      val before = snapshots
      instrumentation.runOnMainSync { client.connect { next ->
        val message = JSONObject(next)
        if (message.optString("type") in listOf("snapshot", "state")) state = message
        if (message.optString("type") == "snapshot") snapshots++
      } }
      val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
      while (snapshots == before && System.nanoTime() < deadline) Thread.sleep(50)
      assertTrue(snapshots > before)
      assertTrue(!state.optBoolean("playing"))

      instrumentation.runOnMainSync { client.setVisible(true) }
      send(JSONObject().put("type", "play"))
      assertTrue(waitFor { it.optBoolean("playing") })
    } finally {
      instrumentation.runOnMainSync { browser.disconnect() }
    }
  }

  @Test
  fun disabledBackgroundPlaybackSurvivesPlaybackProcessRestart() {
    send(JSONObject().put("type", "background").put("enabled", false))
    instrumentation.runOnMainSync { client.setVisible(false) }
    Thread.sleep(1_000)
    val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val process = manager.runningAppProcesses.firstOrNull {
      it.processName == "${context.packageName}:playback"
    }
    assertTrue(process != null && process.pid != android.os.Process.myPid())
    val before = snapshots
    android.os.Process.killProcess(process!!.pid)
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
    while (snapshots == before && System.nanoTime() < deadline) Thread.sleep(50)
    assertTrue(snapshots > before)

    val failed = CountDownLatch(1)
    lateinit var browser: MediaBrowserCompat
    instrumentation.runOnMainSync {
      browser = MediaBrowserCompat(context, ComponentName(context, MediaPlaybackService::class.java),
        object : MediaBrowserCompat.ConnectionCallback() {
          override fun onConnectionFailed() { failed.countDown() }
        }, Bundle().apply { putBoolean(MediaBrowserServiceCompat.BrowserRoot.EXTRA_RECENT, true) })
      browser.connect()
    }
    try {
      assertTrue(failed.await(10, TimeUnit.SECONDS))
      send(JSONObject().put("type", "play"))
      Thread.sleep(500)
      assertTrue(!state.optBoolean("playing"))
    } finally {
      instrumentation.runOnMainSync { browser.disconnect() }
    }
  }

  @After
  fun cleanUp() {
    if (!context.packageName.endsWith(".resumptiontest") || !::client.isInitialized) return
    instrumentation.runOnMainSync { client.setVisible(true) }
    send(JSONObject().put("type", "background").put("enabled", true))
    send(JSONObject().put("type", "clear"))
    instrumentation.runOnMainSync { client.close() }
    audio.delete()
    nextAudio.delete()
  }

  @Test
  fun recentItemIsBrowsableFromTheSeparatePlaybackProcess() {
    val loaded = CountDownLatch(1)
    var item: MediaBrowserCompat.MediaItem? = null
    lateinit var browser: MediaBrowserCompat
    instrumentation.runOnMainSync {
      browser = MediaBrowserCompat(context, ComponentName(context, MediaPlaybackService::class.java),
        object : MediaBrowserCompat.ConnectionCallback() {
          override fun onConnected() {
            browser.subscribe(browser.root, object : MediaBrowserCompat.SubscriptionCallback() {
              override fun onChildrenLoaded(parentId: String, children: MutableList<MediaBrowserCompat.MediaItem>) {
                item = children.firstOrNull()
                loaded.countDown()
              }
            })
          }
        }, Bundle().apply { putBoolean(MediaBrowserServiceCompat.BrowserRoot.EXTRA_RECENT, true) })
      browser.connect()
    }
    try {
      assertTrue(loaded.await(10, TimeUnit.SECONDS))
      assertTrue(item?.isPlayable == true)
      assertEquals("test", item?.mediaId)
      assertEquals("Resumption test", item?.description?.title.toString())
      instrumentation.runOnMainSync {
        MediaControllerCompat(context, browser.sessionToken).transportControls.play()
      }
      assertTrue(waitFor { it.optBoolean("playing") })
    } finally {
      instrumentation.runOnMainSync { browser.disconnect() }
    }
  }

  @Test
  fun playbackContinuesWhenAnActivityClosesAndAnotherClientReconnects() {
    val scenario = ActivityScenario.launch(PlaybackTestActivity::class.java)
    try {
      send(JSONObject().put("type", "equaliser").put("settings", JSONObject()
        .put("enabled", true).put("autoPreamp", true).put("preampDb", 0).put("limiter", true)
        .put("bands", JSONArray().put(JSONObject().put("id", "peak").put("kind", "peaking")
          .put("freq", 1000).put("gain", 6).put("q", 1).put("enabled", true)))))
      send(JSONObject().put("type", "play"))
      assertTrue(waitFor { it.optBoolean("playing") && it.optBoolean("eqActive") })
      assertTrue(waitFor { it.optLong("positionMs") > 1_800 })
      scenario.close()
      val before = state.optLong("positionMs")
      assertTrue(waitFor { it.optBoolean("playing") && it.optLong("positionMs") > before })

      val snapshot = CountDownLatch(1)
      var restored = JSONObject()
      instrumentation.runOnMainSync {
        client.close()
        client = NativePlaybackClient(context)
        client.connect {
          val next = JSONObject(it)
          if (next.optString("type") == "snapshot") {
            restored = next
            snapshot.countDown()
          }
          if (next.optString("type") in listOf("snapshot", "state")) state = next
        }
      }
      assertTrue(snapshot.await(10, TimeUnit.SECONDS))
      assertTrue(restored.optBoolean("playing"))
      assertEquals("test", restored.optString("currentId"))
      assertTrue(restored.optLong("positionMs") >= before)
    } finally {
      scenario.close()
    }
  }

  @Test
  fun playbackProcessRestoresTheSavedTrackAfterItIsStopped() {
    send(JSONObject().put("type", "seek").put("positionMs", 3_000))
    assertTrue(waitFor { it.optLong("positionMs") >= 3_000 })
    Thread.sleep(1_000)
    val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val process = manager.runningAppProcesses.firstOrNull {
      it.processName == "${context.packageName}:playback"
    }
    assertTrue(process != null && process.pid != android.os.Process.myPid())
    val before = snapshots
    android.os.Process.killProcess(process!!.pid)
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
    while (snapshots == before && System.nanoTime() < deadline) Thread.sleep(50)
    assertTrue(snapshots > before)
    assertEquals("test", state.optString("currentId"))
    assertTrue(state.optLong("positionMs") >= 3_000)

    val connected = CountDownLatch(1)
    lateinit var browser: MediaBrowserCompat
    instrumentation.runOnMainSync {
      browser = MediaBrowserCompat(context, ComponentName(context, MediaPlaybackService::class.java),
        object : MediaBrowserCompat.ConnectionCallback() {
          override fun onConnected() { connected.countDown() }
        }, Bundle().apply { putBoolean(MediaBrowserServiceCompat.BrowserRoot.EXTRA_RECENT, true) })
      browser.connect()
    }
    try {
      assertTrue(connected.await(10, TimeUnit.SECONDS))
      instrumentation.runOnMainSync {
        MediaControllerCompat(context, browser.sessionToken).transportControls.play()
      }
      assertTrue(waitFor { it.optBoolean("playing") && it.optLong("positionMs") >= 3_000 })
    } finally {
      instrumentation.runOnMainSync { browser.disconnect() }
    }
  }

  private fun send(message: JSONObject) {
    instrumentation.runOnMainSync { client.send(message) }
  }

  private fun allowNotifications() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.POST_NOTIFICATIONS)
    }
  }

  private fun connectBrowser(): MediaBrowserCompat {
    val connected = CountDownLatch(1)
    lateinit var browser: MediaBrowserCompat
    instrumentation.runOnMainSync {
      browser = MediaBrowserCompat(context, ComponentName(context, MediaPlaybackService::class.java),
        object : MediaBrowserCompat.ConnectionCallback() {
          override fun onConnected() { connected.countDown() }
        }, Bundle().apply { putBoolean(MediaBrowserServiceCompat.BrowserRoot.EXTRA_RECENT, true) })
      browser.connect()
    }
    assertTrue(connected.await(10, TimeUnit.SECONDS))
    return browser
  }

  private fun waitForPausedControls(controller: MediaControllerCompat): Boolean {
    val manager = context.getSystemService(NotificationManager::class.java)
    return waitForController {
      val notification = manager.activeNotifications.firstOrNull {
        it.id == MediaPlayback.NOTIFICATION_ID
      }?.notification
      controller.playbackState?.state == PlaybackStateCompat.STATE_PAUSED &&
        notification != null &&
        notification.flags and Notification.FLAG_FOREGROUND_SERVICE != 0 &&
        notification.extras.containsKey(Notification.EXTRA_MEDIA_SESSION)
    }
  }

  private fun waitForController(condition: () -> Boolean): Boolean {
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
    while (System.nanoTime() < deadline) {
      if (condition()) return true
      Thread.sleep(50)
    }
    return false
  }

  private fun receive(next: JSONObject, connected: CountDownLatch? = null) {
    when (next.optString("type")) {
      "snapshot" -> {
        state = next
        snapshotState = next
        snapshots++
        connected?.countDown()
      }
      "state" -> {
        state = next
        checkpointState = next
      }
    }
  }

  private fun waitFor(condition: (JSONObject) -> Boolean): Boolean {
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
    while (System.nanoTime() < deadline) {
      if (condition(state)) return true
      Thread.sleep(50)
    }
    return false
  }
}
