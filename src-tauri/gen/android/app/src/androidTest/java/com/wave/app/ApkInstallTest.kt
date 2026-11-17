package com.wave.app

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class ApkInstallTest {
  @Test
  fun installSourceSettingsAreScopedToWave() {
    val intent = installSourceSettingsIntent("com.wave.app")
    assertEquals(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, intent.action)
    assertEquals(Uri.parse("package:com.wave.app"), intent.data)
  }

  @Test
  fun apkInstallerCanReadTheContentUri() {
    val uri = Uri.parse("content://com.wave.app.fileprovider/update.apk")
    val intent = apkInstallIntent(uri)
    assertEquals(Intent.ACTION_VIEW, intent.action)
    assertEquals(uri, intent.data)
    assertEquals("application/vnd.android.package-archive", intent.type)
    assertTrue(intent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
  }

  @Test
  fun downloadedApkCanBeSharedFromTheAppCache() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val apk = File.createTempFile("wave-update-test", ".apk", context.cacheDir)
    try {
      apk.writeText("test update")
      val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", apk)
      assertEquals("content", uri.scheme)
      assertEquals("test update", context.contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() })
    } finally {
      apk.delete()
    }
  }
}
