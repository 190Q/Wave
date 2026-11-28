package com.wave.app

import android.media.AudioDeviceInfo
import com.wave.app.eq.WaveEqEngine
import com.wave.app.eq.WaveEqSettings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HeadphoneBoostTest {
  @Test fun boostFollowsTheActualHeadphoneRoute() {
    val headphones = listOf(
      AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
      AudioDeviceInfo.TYPE_WIRED_HEADSET,
      AudioDeviceInfo.TYPE_USB_HEADSET,
      AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
      AudioDeviceInfo.TYPE_BLE_HEADSET,
    )
    for (type in headphones) {
      assertTrue(headphoneBoostActive(true, listOf(type)))
      assertFalse(headphoneBoostActive(false, listOf(type)))
    }
    assertFalse(headphoneBoostActive(true, emptyList()))
    assertFalse(headphoneBoostActive(true, listOf(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER)))
    assertFalse(headphoneBoostActive(true, listOf(headphones.first(), AudioDeviceInfo.TYPE_BUILTIN_SPEAKER)))
  }

  @Test fun boostRaisesTheSignalAndReturnsToBypass() {
    val settings = headphoneBoostSettings(true)
    assertTrue(settings.limiter)
    val engine = WaveEqEngine()
    engine.setSettings(settings)
    engine.configure(48_000, 1)
    val boosted = FloatArray(24_000) { 0.1f }
    engine.process(boosted, boosted.size)
    assertTrue(boosted.last() > 0.14f)
    assertTrue(boosted.last() < 0.16f)

    engine.setSettings(headphoneBoostSettings(false))
    val settled = FloatArray(24_000) { 0.1f }
    engine.process(settled, settled.size)
    assertEquals(0.1f, settled.last(), 0.00001f)
    assertTrue(engine.canBypass())
  }

  @Test fun boostDoesNotChangeTheEqualiserSettings() {
    val equaliserSettings = WaveEqSettings(enabled = true, autoPreamp = false, preampDb = -6.0, limiter = false)
    val equaliser = WaveEqEngine().also { it.setSettings(equaliserSettings); it.configure(48_000, 1) }
    val boost = WaveEqEngine().also { it.setSettings(headphoneBoostSettings(true)); it.configure(48_000, 1) }
    val samples = FloatArray(24_000) { 0.1f }
    equaliser.process(samples, samples.size)
    boost.process(samples, samples.size)
    assertEquals(-6.0, equaliser.preampDb, 0.0)
    assertTrue(samples.last() in 0.07f..0.08f)
  }
}
