package com.wave.app

import java.io.File
import java.io.FileNotFoundException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class MusicDocumentPathsTest {
  @get:Rule
  val temp = TemporaryFolder()

  @Test
  fun resolvesOnlyExistingMusicDocuments() {
    val songs = temp.newFolder("songs")
    val track = File(songs, "track").apply { mkdir() }
    val audio = File(track, "song.wav").apply { writeText("audio") }

    assertEquals(songs.canonicalFile, MusicDocumentPaths.resolve(songs, "songs"))
    assertEquals(audio.canonicalFile, MusicDocumentPaths.resolve(songs, "songs/track/song.wav"))
    assertThrows(FileNotFoundException::class.java) {
      MusicDocumentPaths.resolve(songs, "songs/missing")
    }
  }

  @Test
  fun rejectsTraversalAndOtherRoots() {
    val songs = temp.newFolder("songs")
    temp.newFile("private.txt")
    for (id in listOf("config", "songs/../private.txt", "songs/./track", "songs//track", "songs/..\\private.txt", "songs/")) {
      assertThrows(id, FileNotFoundException::class.java) {
        MusicDocumentPaths.resolve(songs, id)
      }
    }
  }
}
