package com.wave.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LibraryTasksTest {
  @Test
  fun overlappingTasksRemainActiveUntilTheLastOneFinishes() {
    val tasks = LibraryTasks()
    assertNull(tasks.label())

    tasks.add("scan", "Scanning")
    tasks.add("loudness", "Analysing loudness")
    assertEquals("Analysing loudness", tasks.label())

    tasks.remove("scan")
    assertEquals("Analysing loudness", tasks.label())
    tasks.remove("missing")
    assertEquals("Analysing loudness", tasks.label())
    tasks.remove("loudness")
    assertNull(tasks.label())
  }

  @Test
  fun finishingTheLatestTaskRestoresTheEarlierLabel() {
    val tasks = LibraryTasks()
    tasks.add("scan", "Scanning")
    tasks.add("covers", "Finding covers")
    tasks.remove("covers")
    assertEquals("Scanning", tasks.label())
  }
}
