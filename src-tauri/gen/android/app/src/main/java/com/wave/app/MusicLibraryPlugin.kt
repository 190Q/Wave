package com.wave.app

import android.Manifest
import android.app.Activity
import android.content.ContentResolver
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.OpenableColumns
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/** The files the picker handed back, in the order they were picked. */
@InvokeArg
class UriList {
  lateinit var uris: MutableList<String>
}

/**
 * What the phone already holds, which is the only music a phone can be given
 * without a download: there is no folder picker to point Wave at a library.
 *
 * It asks for the audio permission, says where the standard music folders are,
 * and puts the name the system keeps for a picked file onto the URI the picker
 * handed back, which is where the file's extension comes from.
 */
@TauriPlugin(
  permissions = [
    Permission(alias = "audio", strings = [Manifest.permission.READ_MEDIA_AUDIO]),
    Permission(alias = "storage", strings = [Manifest.permission.READ_EXTERNAL_STORAGE])
  ]
)
class MusicLibraryPlugin(private val activity: Activity) : Plugin(activity) {
  /** Android 13 asks for audio on its own; everything older asks for storage. */
  private val audioAlias: String
    get() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) "audio" else "storage"

  @Command
  fun requestAudioPermission(invoke: Invoke) {
    if (getPermissionState(audioAlias) == PermissionState.GRANTED) {
      invoke.resolve(granted(true))
      return
    }

    requestPermissionForAlias(audioAlias, invoke, "audioPermissionResult")
  }

  @PermissionCallback
  fun audioPermissionResult(invoke: Invoke) {
    invoke.resolve(granted(getPermissionState(audioAlias) == PermissionState.GRANTED))
  }

  @Command
  fun musicDirectories(invoke: Invoke) {
    val result = JSObject()
    result.put("directories", jsArray(folders()))
    invoke.resolve(result)
  }

  @Command
  fun names(invoke: Invoke) {
    val args = invoke.parseArgs(UriList::class.java)
    val result = JSObject()
    result.put("names", jsArray(args.uris.map { displayName(it) }))
    invoke.resolve(result)
  }

  /**
   * A JSON array from a list. JSArray.from takes only a real Java array and
   * returns null for a list, and a null value drops the key it is put under.
   */
  private fun jsArray(values: List<String>): JSArray {
    val array = JSArray()
    values.forEach { array.put(it) }
    return array
  }

  private fun granted(value: Boolean): JSObject {
    val result = JSObject()
    result.put("granted", value)
    return result
  }

  /** The standard places a phone keeps its music, in the order to import them. */
  private fun folders(): List<String> {
    val kinds = listOf(Environment.DIRECTORY_MUSIC, Environment.DIRECTORY_DOWNLOADS)

    return kinds
      .mapNotNull { Environment.getExternalStoragePublicDirectory(it) }
      .filter { it.isDirectory }
      .map { it.absolutePath }
  }

  /**
   * What the system calls a picked file. A `content://` URI says nothing about
   * a file name, and the library needs the extension to file the song at all,
   * so it is asked of the provider that handed the URI over.
   */
  private fun displayName(uri: String): String {
    val parsed = Uri.parse(uri)

    if (parsed.scheme == ContentResolver.SCHEME_CONTENT) {
      val columns = arrayOf(OpenableColumns.DISPLAY_NAME)
      val found = runCatching {
        activity.contentResolver.query(parsed, columns, null, null, null)
      }.getOrNull()

      found?.use { cursor ->
        if (cursor.moveToFirst()) {
          val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          if (index >= 0 && !cursor.isNull(index)) {
            return cursor.getString(index)
          }
        }
      }
    }

    return parsed.lastPathSegment ?: uri.substringAfterLast('/')
  }
}
