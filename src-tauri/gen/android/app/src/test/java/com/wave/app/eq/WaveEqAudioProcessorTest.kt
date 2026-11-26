package com.wave.app.eq

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

class WaveEqAudioProcessorTest {
  private fun buffer(size: Int) = ByteBuffer.allocateDirect(size).order(ByteOrder.nativeOrder())

  @Test fun bypassKeepsPcm16SamplesAndConsumesOnlyCompleteFrames() {
    val processor = WaveEqAudioProcessor()
    processor.configure(AudioProcessor.AudioFormat(48_000, 2, C.ENCODING_PCM_16BIT))
    processor.flush()
    assertTrue(processor.isActive)
    val input = buffer(6).putShort(32767).putShort((-32768).toShort()).putShort(123).apply { flip() }
    processor.queueInput(input)
    assertEquals(4, input.position())
    val output = processor.output
    assertEquals(32767.toShort(), output.short)
    assertEquals((-32768).toShort(), output.short)
  }

  @Test fun compressorTailIsAvailableAfterPendingOutput() {
    val processor = WaveEqAudioProcessor()
    processor.setSettings(WaveEqSettings(enabled = true, autoPreamp = false, limiter = true))
    processor.configure(AudioProcessor.AudioFormat(48_000, 1, C.ENCODING_PCM_FLOAT))
    processor.flush()
    val input = buffer(4).putFloat(0.5f).apply { flip() }
    processor.queueInput(input)
    processor.queueEndOfStream()
    assertFalse(processor.isEnded)
    assertEquals(0f, processor.output.float, 0f)
    val tail = processor.output
    assertEquals(288 * 4, tail.remaining())
    tail.position(tail.limit() - 4)
    assertTrue(tail.float > 0.1f)
    assertTrue(processor.isEnded)
  }

  @Test fun disablingLimiterBeforePrimeCompletesKeepsBufferedFrames() {
    val processor = WaveEqAudioProcessor()
    val settings = WaveEqSettings(enabled = true, autoPreamp = false, limiter = false)
    processor.setSettings(settings)
    processor.configure(AudioProcessor.AudioFormat(48_000, 1, C.ENCODING_PCM_FLOAT))
    processor.flush()
    fun push(frames: Int, value: Float): ByteBuffer {
      val input = buffer(frames * 4)
      repeat(frames) { input.putFloat(value) }
      input.flip()
      processor.queueInput(input)
      return processor.output
    }

    assertEquals(400, push(100, 0.1f).remaining())
    processor.setSettings(settings.copy(limiter = true))
    assertEquals(0, push(10, 0.2f).remaining())
    processor.setSettings(settings)
    val result = push(20, 0.3f)
    assertEquals(30 * 4, result.remaining())
    assertTrue(result.float > 0f)
  }

  @Test fun changingLimiterPreservesEveryInputFrame() {
    val processor = WaveEqAudioProcessor()
    val settings = WaveEqSettings(enabled = true, autoPreamp = false, limiter = false)
    processor.setSettings(settings)
    processor.configure(AudioProcessor.AudioFormat(48_000, 1, C.ENCODING_PCM_FLOAT))
    processor.flush()
    var outputFrames = 0
    fun push(frames: Int, value: Float) {
      val input = buffer(frames * 4)
      repeat(frames) { input.putFloat(value) }
      input.flip()
      processor.queueInput(input)
      val output = processor.output
      outputFrames += output.remaining() / 4
      while (output.hasRemaining()) assertTrue(output.float.isFinite())
    }

    push(1000, 0.2f)
    processor.setSettings(settings.copy(limiter = true))
    push(50, 0.4f)
    assertEquals(1000, outputFrames)
    push(300, 0.4f)
    assertEquals(1062, outputFrames)
    processor.setSettings(settings)
    push(100, 0.6f)
    assertEquals(1450, outputFrames)
    processor.setSettings(settings.copy(limiter = true))
    push(10, 0.3f)
    processor.queueEndOfStream()
    val tail = processor.output
    outputFrames += tail.remaining() / 4
    assertEquals(1460, outputFrames)
    assertTrue(processor.isEnded)
  }
}
