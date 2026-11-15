package com.wave.app

internal object MediaSeek {
  const val REWIND = "com.wave.app.REWIND_10"
  const val FORWARD = "com.wave.app.FORWARD_10"
  const val STEP_MS = 10_000.0

  fun offset(action: String?): Double? = when (action) {
    REWIND -> -STEP_MS
    FORWARD -> STEP_MS
    else -> null
  }
}
