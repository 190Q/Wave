package com.wave.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MediaSeekTest {
  @Test
  fun customActionsSeekTenSecondsInTheRequestedDirection() {
    assertEquals(-10_000.0, MediaSeek.offset(MediaSeek.REWIND)!!, 0.0)
    assertEquals(10_000.0, MediaSeek.offset(MediaSeek.FORWARD)!!, 0.0)
    assertNull(MediaSeek.offset("unknown"))
    assertNull(MediaSeek.offset(null))
  }
}
