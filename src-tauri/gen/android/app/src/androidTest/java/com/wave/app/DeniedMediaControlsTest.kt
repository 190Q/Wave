package com.wave.app

import android.app.Notification
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DeniedMediaControlsTest {
  @Test
  fun deniedNotificationsLeaveTheMediaStyleControlsInPlace() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    assumeTrue(Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
    assumeTrue(!NotificationManagerCompat.from(context).areNotificationsEnabled())
    InstrumentationRegistry.getInstrumentation().runOnMainSync {
      MediaPlayback.setControls(context, true)
      MediaPlayback.show(context, Song().apply { title = "Track" })
      val notification = MediaPlayback.current
      MediaPlayback.showPausedControls(context)
      assertTrue(notification === MediaPlayback.current)
      assertTrue(notification!!.extras.containsKey(Notification.EXTRA_MEDIA_SESSION))
      assertFalse(NotificationManagerCompat.from(context).areNotificationsEnabled())
    }
    Thread.sleep(1_000)
    InstrumentationRegistry.getInstrumentation().runOnMainSync { MediaPlayback.clear(context) }
  }
}
