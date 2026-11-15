package com.wave.app

internal fun notificationPermissionNeeded(
  supported: Boolean,
  granted: Boolean,
  requested: Boolean,
  deniedBefore: Boolean
): Boolean = supported && !granted && !requested && !deniedBefore

internal fun playbackWakeLockNeeded(foreground: Boolean, playing: Boolean): Boolean =
  foreground && playing

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
