package com.wave.app.eq

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

enum class WaveEqKind {
  PEAKING, LOW_SHELF, HIGH_SHELF, LOW_PASS, HIGH_PASS, BAND_PASS, NOTCH,
}

data class WaveEqBand(
  val id: String,
  val kind: WaveEqKind,
  val frequency: Double,
  val gainDb: Double,
  val q: Double,
  val enabled: Boolean = true,
)

data class WaveEqSettings(
  val enabled: Boolean = false,
  val bands: List<WaveEqBand> = emptyList(),
  val autoPreamp: Boolean = true,
  val preampDb: Double = 0.0,
  val limiter: Boolean = true,
)

// Adapted from AfterTune, copyright 2026 Sutikshan Mishra, and Chromium, copyright 2010 Google Inc.
// Licence terms are in assets/third_party_licenses.
internal data class WaveEqCoefficients(
  val b0: Double,
  val b1: Double,
  val b2: Double,
  val a1: Double,
  val a2: Double,
) {
  fun magnitudeDb(frequency: Double, sampleRate: Double): Double {
    val w = 2.0 * PI * frequency / sampleRate
    val c1 = cos(w)
    val s1 = sin(w)
    val c2 = cos(2.0 * w)
    val s2 = sin(2.0 * w)
    val nr = b0 + b1 * c1 + b2 * c2
    val ni = -(b1 * s1 + b2 * s2)
    val dr = 1.0 + a1 * c1 + a2 * c2
    val di = -(a1 * s1 + a2 * s2)
    val magnitude = sqrt((nr * nr + ni * ni) / (dr * dr + di * di))
    return 20.0 * log10(max(magnitude, 0.0001))
  }

  companion object {
    val IDENTITY = WaveEqCoefficients(1.0, 0.0, 0.0, 0.0, 0.0)

    fun forBand(band: WaveEqBand, sampleRate: Double): WaveEqCoefficients {
      if (!band.enabled) return IDENTITY
      val frequency = finiteClamp(band.frequency, 20.0, min(20_000.0, sampleRate * 0.49))
      val q = finiteClamp(band.q, 0.05, 24.0)
      val gain = finiteClamp(band.gainDb, -24.0, 24.0)
      val w = 2.0 * PI * frequency / sampleRate
      val c = cos(w)
      val s = sin(w)
      val a = 10.0.pow(gain / 40.0)
      val alpha = s / (2.0 * if (band.kind == WaveEqKind.LOW_PASS || band.kind == WaveEqKind.HIGH_PASS) 10.0.pow(q / 20.0) else q)
      val shelf = sqrt(2.0 * a) * s
      fun normalized(b0: Double, b1: Double, b2: Double, a0: Double, a1: Double, a2: Double) =
        WaveEqCoefficients(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0)
      return when (band.kind) {
        WaveEqKind.PEAKING -> normalized(1 + alpha * a, -2 * c, 1 - alpha * a, 1 + alpha / a, -2 * c, 1 - alpha / a)
        WaveEqKind.LOW_PASS -> normalized((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + alpha, -2 * c, 1 - alpha)
        WaveEqKind.HIGH_PASS -> normalized((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + alpha, -2 * c, 1 - alpha)
        WaveEqKind.BAND_PASS -> normalized(alpha, 0.0, -alpha, 1 + alpha, -2 * c, 1 - alpha)
        WaveEqKind.NOTCH -> normalized(1.0, -2 * c, 1.0, 1 + alpha, -2 * c, 1 - alpha)
        WaveEqKind.LOW_SHELF -> normalized(
          a * (a + 1 - (a - 1) * c + shelf),
          2 * a * (a - 1 - (a + 1) * c),
          a * (a + 1 - (a - 1) * c - shelf),
          a + 1 + (a - 1) * c + shelf,
          -2 * (a - 1 + (a + 1) * c),
          a + 1 + (a - 1) * c - shelf,
        )
        WaveEqKind.HIGH_SHELF -> normalized(
          a * (a + 1 + (a - 1) * c + shelf),
          -2 * a * (a - 1 + (a + 1) * c),
          a * (a + 1 + (a - 1) * c - shelf),
          a + 1 - (a - 1) * c + shelf,
          2 * (a - 1 - (a + 1) * c),
          a + 1 - (a - 1) * c - shelf,
        )
      }
    }
  }
}

internal fun finiteClamp(value: Double, low: Double, high: Double): Double =
  if (value.isFinite()) value.coerceIn(low, high) else low

object WaveEqResponse {
  fun curve(settings: WaveEqSettings, sampleRate: Int): FloatArray {
    require(sampleRate > 0)
    val result = FloatArray(512)
    if (!settings.enabled) return result
    val coefficients = settings.bands.filter { it.enabled }.map {
      WaveEqCoefficients.forBand(it, sampleRate.toDouble())
    }
    val low = ln(20.0)
    val high = ln(min(20_000.0, sampleRate * 0.49))
    for (i in result.indices) {
      val frequency = exp(low + (high - low) * i / (result.size - 1)).toFloat().toDouble()
      result[i] = coefficients.sumOf { it.magnitudeDb(frequency, sampleRate.toDouble()) }.toFloat()
    }
    return result
  }

  fun autoPreampDb(settings: WaveEqSettings, sampleRate: Int): Double {
    if (!settings.enabled || !settings.autoPreamp) return 0.0
    var peak = 0.0
    for (db in curve(settings, sampleRate)) peak = max(peak, db.toDouble())
    return if (peak > 0.0) -peak - 0.5 else 0.0
  }
}
