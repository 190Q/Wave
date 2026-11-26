package com.wave.app.eq

import kotlin.math.exp
import kotlin.math.pow

// Adapted from AfterTune, copyright 2026 Sutikshan Mishra; licence is in assets/third_party_licenses.
internal class WaveEqEngine {
  @Volatile private var sampleRate = 48_000
  @Volatile private var target = prepare(WaveEqSettings(), sampleRate)
  private var applied: Prepared? = null
  private var channels = 2
  private var filters = emptyList<Filter>()
  private var compressor = WaveCompressor(sampleRate, channels)
  private var dry = FloatArray(channels)
  private var dryDelay = FloatArray(compressor.delayFrames * channels)
  private var dryIndex = 0
  private var limiterActive = false
  private var hasCompressedInput = false
  private var preamp = 1.0
  private var targetPreamp = 1.0
  private var mix = 0.0
  private var smoothing = 0.0
  @Volatile var preampDb: Double = 0.0
    private set
  @Volatile var enabled: Boolean = false
    private set

  fun setSettings(settings: WaveEqSettings) {
    target = prepare(settings.copy(bands = settings.bands.toList()), sampleRate)
  }

  private data class Prepared(
    val settings: WaveEqSettings,
    val rate: Int,
    val coefficients: List<WaveEqCoefficients>,
    val preampDb: Double,
  )

  private fun prepare(settings: WaveEqSettings, rate: Int): Prepared {
    val coefficients = settings.bands.map { WaveEqCoefficients.forBand(it, rate.toDouble()) }
    val preampDb = if (settings.enabled) WaveEqResponse.autoPreampDb(settings, rate) +
      (if (settings.preampDb.isFinite()) settings.preampDb else 0.0) else 0.0
    return Prepared(settings, rate, coefficients, preampDb)
  }

  fun configure(rate: Int, channelCount: Int) {
    require(rate > 0 && channelCount > 0)
    sampleRate = rate
    channels = channelCount
    dry = FloatArray(channelCount)
    filters = emptyList()
    compressor = WaveCompressor(rate, channelCount)
    dryDelay = FloatArray(compressor.delayFrames * channelCount)
    dryIndex = 0
    limiterActive = false
    hasCompressedInput = false
    smoothing = exp(-1.0 / (0.015 * rate))
    applied = null
    val snapshot = target
    applySettings(if (snapshot.rate == rate) snapshot else prepare(snapshot.settings, rate), snap = true)
    applied = snapshot
  }

  fun reset() {
    configure(sampleRate, channels)
  }

  fun process(samples: FloatArray, frames: Int) {
    updateSettings()
    processCurrent(samples, frames)
  }

  data class Transition(val startedLimiter: Boolean, val tail: FloatArray)

  val delayFrames: Int get() = compressor.delayFrames

  fun updateSettings(): Transition? {
    val snapshot = target
    if (snapshot === applied) return null
    val wasActive = limiterActive
    val willBeActive = snapshot.settings.enabled && snapshot.settings.limiter
    val tail = if (wasActive && !willBeActive) FloatArray(tailFrames() * channels) else FloatArray(0)
    if (tail.isNotEmpty()) drainTail(tail, tail.size / channels)
    applySettings(if (snapshot.rate == sampleRate) snapshot else prepare(snapshot.settings, sampleRate), snap = false)
    applied = snapshot
    return Transition(!wasActive && limiterActive, tail)
  }

  fun processCurrent(samples: FloatArray, frames: Int) {
    val targetMix = if (applied?.settings?.enabled == true) 1.0 else 0.0
    for (frame in 0 until frames) {
      val offset = frame * channels
      for (channel in 0 until channels) dry[channel] = samples[offset + channel]
      for (filter in filters) filter.process(samples, offset)
      preamp = targetPreamp + (preamp - targetPreamp) * smoothing
      mix = targetMix + (mix - targetMix) * smoothing
      for (channel in 0 until channels) samples[offset + channel] = (samples[offset + channel] * preamp).toFloat()
      if (limiterActive) {
        compressor.processFrame(samples, offset)
        hasCompressedInput = true
      }
      for (channel in 0 until channels) {
        val bypass = if (limiterActive) {
          val index = dryIndex * channels + channel
          val delayed = dryDelay[index]
          dryDelay[index] = dry[channel]
          delayed
        } else dry[channel]
        samples[offset + channel] = (bypass + mix * (samples[offset + channel] - bypass)).toFloat()
      }
      if (limiterActive) dryIndex = (dryIndex + 1) % compressor.delayFrames
    }
    if (filters.any { it.retiring && it.rampFinished }) {
      filters = filters.filterNot { it.retiring && it.rampFinished }
    }
  }

  fun tailFrames(): Int = if (limiterActive && hasCompressedInput) compressor.delayFrames else 0

  fun drainTail(samples: FloatArray, frames: Int) {
    for (frame in 0 until frames) {
      val offset = frame * channels
      compressor.processFrame(samples, offset)
      for (channel in 0 until channels) {
        val index = dryIndex * channels + channel
        val bypass = dryDelay[index]
        dryDelay[index] = 0f
        samples[offset + channel] = (bypass + mix * (samples[offset + channel] - bypass)).toFloat()
      }
      dryIndex = (dryIndex + 1) % compressor.delayFrames
    }
    hasCompressedInput = false
  }

  private fun applySettings(prepared: Prepared, snap: Boolean) {
    val settings = prepared.settings
    enabled = settings.enabled
    val old = filters
    val retained = mutableSetOf<Filter>()
    val updated = settings.bands.mapIndexed { index, band ->
      val existing = old.firstOrNull { it.id == band.id && it.kind == band.kind && it !in retained }
      val filter = existing ?: Filter(band.id, band.kind, channels)
      retained.add(filter)
      filter.retiring = false
      filter.setCoefficients(prepared.coefficients[index], snap)
      filter
    }
    val removed = old.filterNot { it in retained }
    for (filter in removed) {
      filter.retiring = true
      filter.setCoefficients(WaveEqCoefficients.IDENTITY, snap)
    }
    filters = updated + removed
    preampDb = prepared.preampDb
    targetPreamp = 10.0.pow(preampDb / 20.0)
    val nextLimiter = settings.enabled && settings.limiter
    if (nextLimiter != limiterActive) {
      compressor.reset()
      dryDelay.fill(0f)
      dryIndex = 0
      hasCompressedInput = false
      limiterActive = nextLimiter
    }
    if (snap) {
      preamp = targetPreamp
      mix = if (settings.enabled) 1.0 else 0.0
    }
  }

  private class Filter(val id: String, val kind: WaveEqKind, channels: Int) {
    private val x1 = DoubleArray(channels)
    private val x2 = DoubleArray(channels)
    private val y1 = DoubleArray(channels)
    private val y2 = DoubleArray(channels)
    private val current = DoubleArray(5).also { it[0] = 1.0 }
    private val step = DoubleArray(5)
    private var ramp = 0
    var retiring = false
    val rampFinished: Boolean get() = ramp == 0

    fun setCoefficients(coefficients: WaveEqCoefficients, snap: Boolean) {
      val next = doubleArrayOf(coefficients.b0, coefficients.b1, coefficients.b2, coefficients.a1, coefficients.a2)
      if (snap) {
        next.copyInto(current)
        ramp = 0
      } else {
        ramp = 128
        for (i in current.indices) step[i] = (next[i] - current[i]) / ramp
      }
    }

    fun process(samples: FloatArray, offset: Int) {
      if (ramp > 0) {
        for (i in current.indices) current[i] += step[i]
        ramp--
      }
      for (channel in x1.indices) {
        val x = samples[offset + channel].toDouble()
        val y = current[0] * x + current[1] * x1[channel] + current[2] * x2[channel] -
          current[3] * y1[channel] - current[4] * y2[channel]
        x2[channel] = x1[channel]
        x1[channel] = x
        y2[channel] = y1[channel]
        y1[channel] = y
        samples[offset + channel] = y.toFloat()
      }
    }
  }
}
