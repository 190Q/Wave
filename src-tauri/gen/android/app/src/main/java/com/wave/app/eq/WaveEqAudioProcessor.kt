package com.wave.app.eq

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import java.nio.ByteBuffer
import kotlin.math.roundToInt

// Adapted from AfterTune, copyright 2026 Sutikshan Mishra; licence is in assets/third_party_licenses.
@OptIn(UnstableApi::class)
class WaveEqAudioProcessor : BaseAudioProcessor() {
  private val engine = WaveEqEngine()
  private var scratch = FloatArray(0)
  private var tailFrames = 0
  private var primeFrames = 0
  private var audioStarted = false
  @Volatile var active = false
    private set

  val preampDb: Double get() = engine.preampDb
  val enabled: Boolean get() = engine.enabled

  fun setSettings(settings: WaveEqSettings) = engine.setSettings(settings)

  override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
    if (inputAudioFormat.encoding != C.ENCODING_PCM_16BIT && inputAudioFormat.encoding != C.ENCODING_PCM_FLOAT) {
      throw AudioProcessor.UnhandledAudioFormatException(inputAudioFormat)
    }
    return inputAudioFormat
  }

  override fun queueInput(inputBuffer: ByteBuffer) {
    val format = inputAudioFormat
    val bytesPerSample = if (format.encoding == C.ENCODING_PCM_FLOAT) 4 else 2
    val frames = inputBuffer.remaining() / (bytesPerSample * format.channelCount)
    if (frames == 0) return
    super.getOutput()
    val transition = engine.updateSettings()
    val tail = transition?.tail ?: EMPTY_SAMPLES
    val skippedTailFrames = minOf(primeFrames, tail.size / format.channelCount)
    if (tail.isNotEmpty()) primeFrames = 0
    if (transition?.startedLimiter == true && audioStarted) primeFrames = engine.delayFrames
    val samples = frames * format.channelCount
    if (scratch.size < samples) scratch = FloatArray(samples)
    if (format.encoding == C.ENCODING_PCM_FLOAT) {
      for (i in 0 until samples) scratch[i] = inputBuffer.float
    } else {
      for (i in 0 until samples) scratch[i] = inputBuffer.short / 32768f
    }
    engine.processCurrent(scratch, frames)
    audioStarted = true
    val skippedFrames = minOf(primeFrames, frames)
    primeFrames -= skippedFrames
    writeOutput(tail, skippedTailFrames * format.channelCount, tail.size, scratch, skippedFrames * format.channelCount, samples, format.encoding)
  }

  override fun onFlush() {
    tailFrames = 0
    primeFrames = 0
    audioStarted = false
    val format = inputAudioFormat
    active = format.sampleRate > 0 && format.channelCount > 0
    if (active) engine.configure(format.sampleRate, format.channelCount)
  }

  override fun onReset() {
    active = false
    tailFrames = 0
    primeFrames = 0
    audioStarted = false
    scratch = FloatArray(0)
  }

  override fun onQueueEndOfStream() {
    tailFrames = engine.tailFrames()
  }

  override fun getOutput(): ByteBuffer {
    val pending = super.getOutput()
    if (pending.hasRemaining() || tailFrames == 0) return pending
    val samples = tailFrames * inputAudioFormat.channelCount
    if (scratch.size < samples) scratch = FloatArray(samples)
    scratch.fill(0f, 0, samples)
    engine.drainTail(scratch, tailFrames)
    val skippedSamples = minOf(primeFrames, tailFrames) * inputAudioFormat.channelCount
    tailFrames = 0
    primeFrames = 0
    writeOutput(scratch, skippedSamples, samples, EMPTY_SAMPLES, 0, 0, inputAudioFormat.encoding)
    return super.getOutput()
  }

  override fun isEnded(): Boolean = tailFrames == 0 && super.isEnded()

  private fun writeOutput(first: FloatArray, firstStart: Int, firstEnd: Int, second: FloatArray, secondStart: Int, secondEnd: Int, encoding: Int) {
    val floatOutput = encoding == C.ENCODING_PCM_FLOAT
    val count = firstEnd - firstStart + secondEnd - secondStart
    if (count == 0) return
    val output = replaceOutputBuffer(count * if (floatOutput) 4 else 2)
    fun write(samples: FloatArray, start: Int, end: Int) {
      for (i in start until end) {
        if (floatOutput) output.putFloat(samples[i])
        else output.putShort((samples[i] * 32768f).roundToInt().coerceIn(-32768, 32767).toShort())
      }
    }
    write(first, firstStart, firstEnd)
    write(second, secondStart, secondEnd)
    output.flip()
  }

  private companion object {
    val EMPTY_SAMPLES = FloatArray(0)
  }
}
