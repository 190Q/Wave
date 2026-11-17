package com.wave.app

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
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
