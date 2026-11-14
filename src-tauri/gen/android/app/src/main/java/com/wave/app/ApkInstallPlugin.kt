package com.wave.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File

/** Where the downloaded update is, in the shape update.rs sends it. */
@InvokeArg
class ApkArgs {
  lateinit var path: String
}

/**
 * The one thing Android will not let an app do for itself: replace its own
 * install.
 *
 * The download is handed to the system installer as a content URI from the
 * app's own FileProvider, which already shares the cache directory the
 * download lands in. The installer comes to the front and asks the user to
 * confirm; an install that is turned down leaves the app as it was.
 */
@TauriPlugin
class ApkInstallPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun installApk(invoke: Invoke) {
    val args = invoke.parseArgs(ApkArgs::class.java)
    val apk = File(args.path)

    if (!apk.isFile) {
      invoke.reject("the downloaded update is not there any more")
      return
    }

    try {
      val uri: Uri = FileProvider.getUriForFile(
        activity,
        "${activity.packageName}.fileprovider",
        apk
      )

      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }

      activity.startActivity(intent)
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject("the installer could not be opened: ${error.message}")
    }
  }
}
