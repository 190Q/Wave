package com.wave.app.eq

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.asin
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin

// Adapted from Chromium, copyright 2011 Google Inc.; licence is in assets/third_party_licenses.
internal class WaveCompressor(private val sampleRate: Int, private val channels: Int) {
  val delayFrames = min((sampleRate * 0.006).toInt(), 1023).coerceAtLeast(1)
  private val delay = FloatArray(delayFrames * channels)
  private var delayIndex = 0
  private var detector = 0.0
  private var gain = 1.0
  private var maxAttackDb = -1.0
  private var divisionRemaining = 0
  private var desired = 0.0
  private var envelopeRate = 0.0
  private val threshold = dbToLinear(-1.0)
  private val makeup = (1.0 / dbToLinear(-0.95)).pow(0.6)

  fun reset() {
    delay.fill(0f)
    delayIndex = 0
    detector = 0.0
    gain = 1.0
    maxAttackDb = -1.0
    divisionRemaining = 0
  }

  fun processFrame(samples: FloatArray, offset: Int) {
    if (divisionRemaining == 0) {
      detector = detector.coerceIn(0.0, 1.0)
      desired = asin(detector) / (PI / 2.0)
      val releasing = desired > gain
      var diff = if (desired == 0.0) {
        if (releasing) -1.0 else 1.0
      } else {
        20.0 * log10(gain / desired)
      }
      if (!diff.isFinite()) diff = if (releasing) -1.0 else 1.0
      if (releasing) {
        maxAttackDb = -1.0
        val x = (diff.coerceIn(-12.0, 0.0) + 12.0) * 0.25
        val x2 = x * x
        val releaseFrames = sampleRate * 0.25 * (
          0.09 +
            (-1.5788320352845888 * 0.09 + 2.3305837032074286 * 0.16 - 0.9141194204840429 * 0.42 + 0.1623677525612032 * 0.98) * x +
            (0.5334142869106424 * 0.09 - 1.272736789213631 * 0.16 + 0.9258856042207512 * 0.42 - 0.18656310191776226 * 0.98) * x2 +
            (0.08783463138207234 * 0.09 - 0.1694162967925622 * 0.16 + 0.08588057951595272 * 0.42 - 0.00429891410546283 * 0.98) * x2 * x +
            (-0.042416883008123074 * 0.09 + 0.1115693827987602 * 0.16 - 0.09764676325265872 * 0.42 + 0.028494263462021576 * 0.98) * x2 * x2
          )
        envelopeRate = dbToLinear(5.0 / releaseFrames)
      } else {
        maxAttackDb = max(maxAttackDb, diff)
        envelopeRate = 1.0 - (0.25 / max(0.5, maxAttackDb)).pow(1.0 / (sampleRate * 0.003))
      }
      divisionRemaining = 32
    }

    var input = 0.0
    for (channel in 0 until channels) input = max(input, abs(samples[offset + channel].toDouble()))
    val shaped = if (input < threshold) input else dbToLinear(-1.0 + 0.05 * (20.0 * log10(input) + 1.0))
    val attenuation = if (input <= 0.0001) 1.0 else shaped / input
    val attenuationDb = max(2.0, -20.0 * log10(attenuation))
    val releaseRate = dbToLinear(attenuationDb / (sampleRate * 0.0025)) - 1.0
    detector += (attenuation - detector) * if (attenuation > detector) releaseRate else 1.0
    detector = detector.coerceIn(0.0, 1.0)
    gain = if (envelopeRate < 1.0) gain + (desired - gain) * envelopeRate else min(1.0, gain * envelopeRate)
    val outputGain = makeup * sin(PI * gain / 2.0)
    for (channel in 0 until channels) {
      val index = delayIndex * channels + channel
      val delayed = delay[index]
      delay[index] = samples[offset + channel]
      samples[offset + channel] = (delayed * outputGain).toFloat()
    }
    delayIndex = (delayIndex + 1) % delayFrames
    divisionRemaining--
  }

  private fun dbToLinear(db: Double) = 10.0.pow(db / 20.0)
}
