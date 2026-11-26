package com.wave.app.eq

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.sin

class WaveEqEngineTest {
  private fun band(kind: WaveEqKind, q: Double = 1.0, gain: Double = 9.0) =
    WaveEqBand("band", kind, 1000.0, gain, q)

  @Test fun filterResponsesMatchWebAudioShapes() {
    val expected = mapOf(
      WaveEqKind.PEAKING to 9.0,
      WaveEqKind.LOW_SHELF to 4.5,
      WaveEqKind.HIGH_SHELF to 4.5,
      WaveEqKind.LOW_PASS to 1.0,
      WaveEqKind.HIGH_PASS to 1.0,
      WaveEqKind.BAND_PASS to 0.0,
      WaveEqKind.NOTCH to -80.0,
    )
    for ((kind, db) in expected) {
      val actual = WaveEqCoefficients.forBand(band(kind), 48_000.0).magnitudeDb(1000.0, 48_000.0)
      assertEquals(kind.name, db, actual, 0.0001)
    }
  }

  @Test fun shelvesIgnoreQAndPassFiltersInterpretQAsDecibels() {
    for (kind in listOf(WaveEqKind.LOW_SHELF, WaveEqKind.HIGH_SHELF)) {
      assertEquals(
        WaveEqCoefficients.forBand(band(kind, 0.05), 48_000.0),
        WaveEqCoefficients.forBand(band(kind, 24.0), 48_000.0),
      )
    }
    for (kind in listOf(WaveEqKind.LOW_PASS, WaveEqKind.HIGH_PASS)) {
      val response = WaveEqCoefficients.forBand(band(kind, 6.0), 48_000.0).magnitudeDb(1000.0, 48_000.0)
      assertEquals(6.0, response, 0.0001)
    }
  }

  @Test fun autoPreampUsesCombinedCurveAndHalfDecibelHeadroom() {
    val settings = WaveEqSettings(enabled = true, bands = listOf(band(WaveEqKind.PEAKING), band(WaveEqKind.PEAKING).copy(id = "two")))
    val peak = WaveEqResponse.curve(settings, 48_000).maxOrNull()!!.toDouble()
    assertTrue(peak > 17.0)
    assertEquals(-peak - 0.5, WaveEqResponse.autoPreampDb(settings, 48_000), 0.00001)
    assertEquals(0.0, WaveEqResponse.autoPreampDb(settings.copy(autoPreamp = false), 48_000), 0.0)
  }

  @Test fun disabledBandAndDisabledEqualiserRemainFlat() {
    val settings = WaveEqSettings(enabled = true, bands = listOf(band(WaveEqKind.PEAKING).copy(enabled = false)), limiter = false)
    val engine = WaveEqEngine()
    engine.setSettings(settings)
    engine.configure(48_000, 1)
    val samples = floatArrayOf(0.5f, -0.25f, 0.125f)
    engine.process(samples, samples.size)
    assertEquals(0.5f, samples[0], 0f)
    assertEquals(-0.25f, samples[1], 0f)
    assertEquals(0.125f, samples[2], 0f)
    assertTrue(WaveEqResponse.curve(settings.copy(enabled = false), 48_000).all { it == 0f })
  }

  @Test fun actualSignalMatchesPeakingResponseAndKeepsChannelsIndependent() {
    val settings = WaveEqSettings(enabled = true, bands = listOf(band(WaveEqKind.PEAKING)), autoPreamp = false, limiter = false)
    val engine = WaveEqEngine()
    engine.setSettings(settings)
    engine.configure(48_000, 2)
    val frames = 48_000
    val samples = FloatArray(frames * 2) { i -> if (i % 2 == 0) (0.05 * sin(2 * PI * 1000 * (i / 2) / 48_000)).toFloat() else 0f }
    engine.process(samples, frames)
    var energyIn = 0.0
    var energyOut = 0.0
    for (i in frames / 2 until frames) {
      val x = 0.05 * sin(2 * PI * 1000 * i / 48_000)
      energyIn += x * x
      energyOut += samples[i * 2] * samples[i * 2]
      assertEquals(0f, samples[i * 2 + 1], 0f)
    }
    assertEquals(9.0, 10.0 * log10(energyOut / energyIn), 0.001)
  }

  @Test fun processingIsIndependentOfBufferBoundaries() {
    val settings = WaveEqSettings(enabled = true, bands = listOf(band(WaveEqKind.LOW_PASS)), limiter = true)
    val input = FloatArray(4000) { (1.5 * sin(2 * PI * 1000 * it / 48_000)).toFloat() }
    val whole = input.copyOf()
    val first = WaveEqEngine().also { it.setSettings(settings); it.configure(48_000, 1) }
    first.process(whole, whole.size)
    val second = WaveEqEngine().also { it.setSettings(settings); it.configure(48_000, 1) }
    val chunks = FloatArray(input.size)
    var offset = 0
    while (offset < input.size) {
      val count = minOf(37, input.size - offset)
      val part = input.copyOfRange(offset, offset + count)
      second.process(part, count)
      part.copyInto(chunks, offset)
      offset += count
    }
    for (i in whole.indices) assertEquals("sample $i", whole[i], chunks[i], 0f)
  }

  @Test fun compressorHasLookaheadAndAttenuatesHighLevelInput() {
    val compressor = WaveCompressor(48_000, 2)
    val frames = 24_000
    val samples = FloatArray(frames * 2) { 2f }
    for (frame in 0 until frames) compressor.processFrame(samples, frame * 2)
    assertTrue(samples.take(compressor.delayFrames * 2).all { it == 0f })
    assertTrue(abs(samples.last()) < 1.3f)
    assertEquals(samples[samples.lastIndex - 1], samples.last(), 0f)
  }

  @Test fun compressorTailRetainsDelayedSamples() {
    val engine = WaveEqEngine()
    engine.setSettings(WaveEqSettings(enabled = true, autoPreamp = false, limiter = true))
    engine.configure(48_000, 1)
    val input = floatArrayOf(0.5f)
    engine.process(input, 1)
    assertEquals(0f, input[0], 0f)
    val tail = FloatArray(engine.tailFrames())
    engine.drainTail(tail, tail.size)
    assertTrue(tail.last() > 0.1f)
    assertEquals(0, engine.tailFrames())
  }

  // Fixtures were rendered by Chrome 158 OfflineAudioContext at 48 kHz.
  @Test fun filterResponsesMatchOfflineWebAudioFixtures() {
    val frequencies = doubleArrayOf(20.0, 100.0, 1000.0, 5000.0, 20_000.0)
    val magnitudes = mapOf(
      WaveEqKind.PEAKING to doubleArrayOf(1.0004915, 1.0124097, 2.8183830, 1.0477133, 1.0003800),
      WaveEqKind.LOW_SHELF to doubleArrayOf(2.8183825, 2.8180380, 1.6788040, 1.0017098, 1.0000001),
      WaveEqKind.HIGH_SHELF to doubleArrayOf(1.0000002, 1.0001224, 1.6788040, 2.8135724, 2.8183827),
      WaveEqKind.LOW_PASS to doubleArrayOf(1.0002404, 1.0060154, 1.1220185, 0.0381213, 0.0003085),
      WaveEqKind.HIGH_PASS to doubleArrayOf(0.0003990, 0.0100317, 1.1220185, 1.0225182, 1.0001860),
      WaveEqKind.BAND_PASS to doubleArrayOf(0.0199754, 0.1003552, 1.0, 0.1966461, 0.0175650),
      WaveEqKind.NOTCH to doubleArrayOf(0.9998004, 0.9949517, 0.0001, 0.9804745, 0.9998457),
    )
    for ((kind, expected) in magnitudes) {
      val coefficients = WaveEqCoefficients.forBand(band(kind), 48_000.0)
      for (i in frequencies.indices) {
        assertEquals("$kind at ${frequencies[i]} Hz", 20 * log10(expected[i]), coefficients.magnitudeDb(frequencies[i], 48_000.0), 0.002)
      }
    }
  }

  // Fixtures use threshold -1 dB, knee 0, ratio 20, attack 3 ms and release 250 ms.
  @Test fun compressorMatchesOfflineWebAudioTransientFixture() {
    val indices = intArrayOf(0, 100, 287, 288, 320, 500, 700, 787, 788, 800, 900, 1024, 1300, 1600, 2000, 2287, 2288, 2300, 2500, 3000, 3500, 4095)
    val expected = doubleArrayOf(
      0.0, 0.0, 0.0, 0.052214529, 0.052604511, 0.056037992, 0.060773406,
      0.062751018, 0.376641095, 0.378261566, 0.391444445, 0.407203138,
      0.440022171, 0.472636253, 0.512086868, 0.548265219, 0.036561616,
      0.036688995, 0.039073221, 0.046301920, 0.054070443, 0.062787145,
    )
    val samples = FloatArray(4096 * 2) { i ->
      val frame = i / 2
      val value = if (frame < 500) 0.25f else if (frame < 2000) 1.5f else 0.1f
      if (i % 2 == 0) value else value * 0.5f
    }
    val compressor = WaveCompressor(48_000, 2)
    for (frame in 0 until 4096) compressor.processFrame(samples, frame * 2)
    for (i in indices.indices) {
      assertEquals("left frame ${indices[i]}", expected[i], samples[indices[i] * 2].toDouble(), 0.0002)
      assertEquals("right frame ${indices[i]}", expected[i] / 2, samples[indices[i] * 2 + 1].toDouble(), 0.0001)
    }
  }

  @Test fun largeProfilesRemainFiniteAcrossSampleRates() {
    val bands = (0 until 40).map { i ->
      WaveEqBand("$i", WaveEqKind.entries[i % WaveEqKind.entries.size], 20.0 * kotlin.math.exp(i * 0.18), if (i % 2 == 0) 12.0 else -12.0, if (i % 2 == 0) 0.05 else 24.0)
    }
    val settings = WaveEqSettings(enabled = true, bands = bands, limiter = false)
    val engine = WaveEqEngine()
    engine.setSettings(settings)
    for (rate in listOf(44_100, 48_000, 96_000)) {
      engine.configure(rate, 2)
      val samples = FloatArray(8192) { if (it == 0) 0.01f else 0f }
      engine.process(samples, samples.size / 2)
      assertTrue("rate $rate", samples.all { it.isFinite() })
      assertTrue(WaveEqResponse.curve(settings, rate).all { it.isFinite() })
      assertTrue(engine.preampDb <= 0.0)
    }
  }

  @Test fun manualPreampAndSettingsChangesTakeEffectWithoutResettingStream() {
    val engine = WaveEqEngine()
    engine.setSettings(WaveEqSettings(enabled = true, autoPreamp = false, preampDb = -6.020599913, limiter = false))
    engine.configure(48_000, 1)
    val initial = FloatArray(100) { 0.8f }
    engine.process(initial, initial.size)
    assertEquals(0.4, initial.last().toDouble(), 0.00001)
    engine.setSettings(WaveEqSettings(enabled = true, autoPreamp = false, preampDb = 0.0, limiter = false))
    val updated = FloatArray(10_000) { 0.8f }
    engine.process(updated, updated.size)
    assertTrue(updated.first() in 0.4f..0.402f)
    assertEquals(0.8, updated.last().toDouble(), 0.00001)
  }

  @Test fun settingsTakeSnapshotOfMutableBands() {
    val bands = mutableListOf(band(WaveEqKind.PEAKING))
    val engine = WaveEqEngine()
    engine.setSettings(WaveEqSettings(enabled = true, bands = bands, autoPreamp = false, limiter = false))
    bands.clear()
    engine.configure(48_000, 1)
    val samples = FloatArray(24_000) { (0.05 * sin(2 * PI * 1000 * it / 48_000)).toFloat() }
    engine.process(samples, samples.size)
    assertTrue(samples.takeLast(1000).maxOrNull()!! > 0.1f)
  }

  @Test fun removingABandFadesItsEffect() {
    val engine = WaveEqEngine()
    val settings = WaveEqSettings(enabled = true, bands = listOf(band(WaveEqKind.LOW_SHELF, gain = 12.0)), autoPreamp = false, limiter = false)
    engine.setSettings(settings)
    engine.configure(48_000, 1)
    val initial = FloatArray(10_000) { 0.1f }
    engine.process(initial, initial.size)
    assertTrue(initial.last() > 0.39f)
    engine.setSettings(settings.copy(bands = emptyList()))
    val after = FloatArray(256) { 0.1f }
    engine.process(after, after.size)
    assertTrue(after.first() > 0.3f)
    assertEquals(0.1, after.last().toDouble(), 0.0001)
  }
}
