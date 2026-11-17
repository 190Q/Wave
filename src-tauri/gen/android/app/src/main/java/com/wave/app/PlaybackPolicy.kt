package com.wave.app

internal fun notificationPermissionNeeded(
  supported: Boolean,
  granted: Boolean,
  requested: Boolean,
  deniedBefore: Boolean
): Boolean = supported && !granted && !requested && !deniedBefore

internal fun playbackWakeLockNeeded(foreground: Boolean, playing: Boolean): Boolean =
  foreground && playing

internal fun artworkSampleSize(width: Int, height: Int, maxEdge: Int): Int {
  if (width <= 0 || height <= 0 || maxEdge <= 0) return 1
  val longest = maxOf(width, height).toLong()
  var sample = 1
  while ((longest + sample - 1) / sample > maxEdge) {
    if (sample > Int.MAX_VALUE / 2) return sample
    sample *= 2
  }
  return sample
}

internal const val PAUSED_CONTROLS_DELAY_MS = 10 * 60_000L

internal class PausedControls(private val delayMs: Long = PAUSED_CONTROLS_DELAY_MS) {
  private var pausedAt: Long? = null

  fun remaining(eligible: Boolean, now: Long): Long? {
    if (!eligible) {
      pausedAt = null
      return null
    }
    val started = pausedAt ?: now.also { pausedAt = it }
    return (delayMs - (now - started).coerceAtLeast(0)).coerceAtLeast(0)
  }
}

internal class PlaybackWakeLock(
  private val acquire: () -> Unit,
  private val release: () -> Unit
) {
  private var held = false

  @Synchronized
  fun sync(foreground: Boolean, playing: Boolean) {
    val wanted = playbackWakeLockNeeded(foreground, playing)
    if (wanted == held) return
    if (wanted) acquire() else release()
    held = wanted
  }
}

internal class ArtworkCache<T>(private val decode: (String) -> T?) {
  private var path: String? = null
  private var value: T? = null

  fun get(next: String): T? {
    if (path != next) {
      path = next
      value = if (next.isEmpty()) null else decode(next)
    }
    return value
  }
}
