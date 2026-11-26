package com.wave.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaybackPolicyTest {
  @Test
  fun artworkIsSampledToFitTheMediaSession() {
    assertEquals(1, artworkSampleSize(512, 256, 512))
    assertEquals(2, artworkSampleSize(513, 400, 512))
    assertEquals(8, artworkSampleSize(4000, 3000, 512))
    assertEquals(16, artworkSampleSize(8192, 1000, 512))
    assertEquals(1 shl 30, artworkSampleSize(Int.MAX_VALUE, 1, 1))
    assertEquals(1, artworkSampleSize(-1, 100, 512))
    assertEquals(1, artworkSampleSize(100, 100, 0))
  }

  @Test
  fun aRemovedTaskStopsAfterPauseButNotDuringPlaybackOrStartup() {
    assertFalse(playbackServiceCanStop(false, false, false))
    assertFalse(playbackServiceCanStop(true, true, false))
    assertFalse(playbackServiceCanStop(true, false, true))
    assertTrue(playbackServiceCanStop(true, false, false))
  }

  @Test
  fun wakeLockIsHeldOnlyForForegroundPlayback() {
    assertTrue(playbackWakeLockNeeded(true, true))
    assertFalse(playbackWakeLockNeeded(true, false))
    assertFalse(playbackWakeLockNeeded(false, true))
    assertFalse(playbackWakeLockNeeded(false, false))
  }

  @Test
  fun pauseReleasesTheRunningServiceLockWithoutRestartingIt() {
    var acquisitions = 0
    var releases = 0
    val lock = PlaybackWakeLock({ acquisitions += 1 }, { releases += 1 })
    lock.sync(true, true)
    lock.sync(true, true)
    assertEquals(1, acquisitions)
    lock.sync(true, false)
    assertEquals(1, releases)
    lock.sync(true, false)
    assertEquals(1, releases)
    lock.sync(true, true)
    assertEquals(2, acquisitions)
    lock.sync(false, true)
    assertEquals(2, releases)
  }

  @Test
  fun permissionIsRequestedOnceAndNotAfterAnEarlierDenial() {
    assertTrue(notificationPermissionNeeded(true, false, false, false))
    assertFalse(notificationPermissionNeeded(true, false, true, false))
    assertFalse(notificationPermissionNeeded(true, false, false, true))
    assertFalse(notificationPermissionNeeded(true, true, false, false))
    assertFalse(notificationPermissionNeeded(false, false, false, false))
  }

  @Test
  fun artworkIsReloadedAfterAFilelessTrack() {
    var decodes = 0
    val cache = ArtworkCache { path ->
      decodes += 1
      "bitmap:$path"
    }
    assertEquals("bitmap:cover.jpg", cache.get("cover.jpg"))
    assertEquals("bitmap:cover.jpg", cache.get("cover.jpg"))
    assertEquals(1, decodes)
    assertNull(cache.get(""))
    assertEquals("bitmap:cover.jpg", cache.get("cover.jpg"))
    assertEquals(2, decodes)
  }

  @Test
  fun missingArtworkIsCachedWithoutLeakingThePreviousCover() {
    var decodes = 0
    val cache = ArtworkCache { path ->
      decodes += 1
      if (path == "missing") null else path
    }
    assertEquals("cover", cache.get("cover"))
    assertNull(cache.get("missing"))
    assertNull(cache.get("missing"))
    assertEquals(2, decodes)
    assertEquals("cover", cache.get("cover"))
    assertEquals(3, decodes)
  }
}
