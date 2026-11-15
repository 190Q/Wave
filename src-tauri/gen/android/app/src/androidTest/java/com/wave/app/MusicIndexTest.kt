package com.wave.app

import android.database.MatrixCursor
import android.os.Build
import android.provider.MediaStore
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MusicIndexTest {
  @Test
  fun readsInternalAndExternalCollectionsAndPreservesVolumeUris() {
    val collections = mutableListOf<String>()
    val files = indexedMusic { uri, columns ->
      collections.add(uri.toString())
      MatrixCursor(columns).apply {
        fun row(id: Long, name: String?, mime: String?, volume: String) {
          val values = mutableListOf<Any?>(id, name, mime)
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) values.add(volume)
          addRow(values)
        }
        if (uri == MediaStore.Audio.Media.EXTERNAL_CONTENT_URI) {
          row(1, "outside-music.mp3", "audio/mpeg", "external_primary")
          row(2, "sd-card.flac", "audio/flac", "0123-4567")
        } else {
          row(3, null, null, "internal")
        }
      }
    }

    assertEquals(listOf(
      MediaStore.Audio.Media.EXTERNAL_CONTENT_URI.toString(),
      MediaStore.Audio.Media.INTERNAL_CONTENT_URI.toString()
    ), collections)
    assertEquals(listOf("outside-music.mp3", "sd-card.flac", "track-3"), files.map { it.name })
    assertEquals("audio/flac", files[1].mime)
    val externalVolume = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) "external_primary" else "external"
    val sdVolume = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) "0123-4567" else "external"
    assertEquals("content://media/$externalVolume/audio/media/1", files[0].uri)
    assertEquals("content://media/$sdVolume/audio/media/2", files[1].uri)
    assertEquals("content://media/internal/audio/media/3", files[2].uri)
  }

  @Test
  fun failedQueriesAreReportedRatherThanTreatedAsEmpty() {
    assertThrows(IllegalStateException::class.java) {
      indexedMusic { _, _ -> null }
    }
  }
}
