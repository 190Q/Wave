package com.wave.app

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import androidx.activity.result.ActivityResult
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MusicPickerTest {
  @Test
  fun filePickerShowsAllTypesAndAllowsMultipleDocuments() {
    val intent = musicPickerIntent(false)
    assertEquals(Intent.ACTION_OPEN_DOCUMENT, intent.action)
    assertEquals("*/*", intent.type)
    assertNull(intent.getStringArrayExtra(Intent.EXTRA_MIME_TYPES))
    assertTrue(intent.hasCategory(Intent.CATEGORY_OPENABLE))
    assertTrue(intent.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false))
    assertTrue(intent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
    assertInitialStorage(intent)
  }

  @Test
  fun folderPickerOpensTheStorageTree() {
    val intent = musicPickerIntent(true)
    assertEquals(Intent.ACTION_OPEN_DOCUMENT_TREE, intent.action)
    assertNull(intent.type)
    assertFalse(intent.hasCategory(Intent.CATEGORY_OPENABLE))
    assertTrue(intent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
    assertInitialStorage(intent)
  }

  @Suppress("DEPRECATION")
  private fun assertInitialStorage(intent: Intent) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      assertEquals(
        DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:"),
        intent.getParcelableExtra<Uri>(DocumentsContract.EXTRA_INITIAL_URI)
      )
    }
  }

  @Test
  fun returnsSingleAndMultipleUrisAndTreatsCancellationAsEmpty() {
    val first = Uri.parse("content://documents/one")
    val second = Uri.parse("content://documents/two")
    val single = Intent().setData(first)
    val clip = ClipData.newRawUri("audio", first).apply { addItem(ClipData.Item(second)) }
    val multiple = Intent().apply { clipData = clip }

    assertEquals(listOf(first.toString()), pickedFileUris(ActivityResult(Activity.RESULT_OK, single)))
    assertEquals(listOf(first.toString(), second.toString()), pickedFileUris(ActivityResult(Activity.RESULT_OK, multiple)))
    assertEquals(emptyList<String>(), pickedFileUris(ActivityResult(Activity.RESULT_CANCELED, single)))
    assertEquals(emptyList<String>(), pickedFileUris(ActivityResult(Activity.RESULT_OK, null as Intent?)))
  }
}
