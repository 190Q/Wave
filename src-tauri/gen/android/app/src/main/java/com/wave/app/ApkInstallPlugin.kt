package com.wave.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File

internal fun installSourceSettingsIntent(packageName: String): Intent =
  Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))

internal fun apkInstallIntent(uri: Uri): Intent = Intent(Intent.ACTION_VIEW).apply {
  setDataAndType(uri, "application/vnd.android.package-archive")
  addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
}

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
    if (BuildConfig.DEBUG) {
      invoke.reject("Release updates cannot be installed from Wave Dev.")
      return
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      !activity.packageManager.canRequestPackageInstalls()) {
      try {
        startActivityForResult(invoke, installSourceSettingsIntent(activity.packageName), "installPermissionResult")
      } catch (error: Exception) {
        invoke.reject("the install permission could not be opened: ${error.message}")
      }
      return
    }
    openInstaller(invoke)
  }

  @ActivityCallback
  fun installPermissionResult(invoke: Invoke, result: ActivityResult) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      !activity.packageManager.canRequestPackageInstalls()) {
      invoke.reject("Allow Wave to install updates, then try again.")
      return
    }
    openInstaller(invoke)
  }

  private fun openInstaller(invoke: Invoke) {
    val apk = File(invoke.parseArgs(ApkArgs::class.java).path)
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

      activity.startActivity(apkInstallIntent(uri))
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject("the installer could not be opened: ${error.message}")
    }
  }
}
