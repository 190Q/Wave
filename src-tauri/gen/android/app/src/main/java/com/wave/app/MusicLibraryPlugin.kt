package com.wave.app

import android.Manifest
import android.app.Activity
import android.content.ContentResolver
import android.content.ContentUris
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.OpenableColumns
import androidx.activity.result.ActivityResult
import app.tauri.PermissionState
import app.tauri.annotation.ActivityCallback
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

@InvokeArg
class FolderUri {
  lateinit var uri: String
}

internal data class IndexedMusicFile(val uri: String, val name: String, val mime: String?)

internal fun musicPickerIntent(folder: Boolean): Intent {
  val intent = Intent(if (folder) Intent.ACTION_OPEN_DOCUMENT_TREE else Intent.ACTION_OPEN_DOCUMENT)
  intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
  if (!folder) {
    intent.addCategory(Intent.CATEGORY_OPENABLE)
    intent.type = "*/*"
    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
  }
  if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
    intent.putExtra(
      DocumentsContract.EXTRA_INITIAL_URI,
      DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:")
    )
  }
  return intent
}

internal fun pickedFileUris(result: ActivityResult): List<String> {
  if (result.resultCode != Activity.RESULT_OK) return emptyList()
  val data = result.data ?: return emptyList()
  val clip = data.clipData
  if (clip != null) {
    return (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri?.toString() }
  }
  return listOfNotNull(data.data?.toString())
}

internal fun indexedMusic(resolver: ContentResolver): List<IndexedMusicFile> =
  indexedMusic { uri, columns -> resolver.query(uri, columns, null, null, null) }

internal fun indexedMusic(query: (Uri, Array<String>) -> Cursor?): List<IndexedMusicFile> {
  val files = mutableListOf<IndexedMusicFile>()
  val collections = listOf(
    MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
    MediaStore.Audio.Media.INTERNAL_CONTENT_URI
  )
  for (collection in collections) {
    val columns = mutableListOf(
      MediaStore.Audio.Media._ID,
      MediaStore.Audio.Media.DISPLAY_NAME,
      MediaStore.Audio.Media.MIME_TYPE
    )
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      columns.add(MediaStore.MediaColumns.VOLUME_NAME)
    }
    val cursor = query(collection, columns.toTypedArray())
      ?: throw IllegalStateException("Could not read the music index")
    cursor.use {
      while (it.moveToNext()) {
        val id = it.getLong(0)
        val volume = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) it.getString(3) else null
        val base = if (volume.isNullOrEmpty()) collection else MediaStore.Audio.Media.getContentUri(volume)
        files.add(IndexedMusicFile(
          ContentUris.withAppendedId(base, id).toString(),
          it.getString(1) ?: "track-$id",
          it.getString(2)
        ))
      }
    }
  }
  return files
}

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
  fun musicFiles(invoke: Invoke) {
    Thread {
      try {
        val files = JSArray()
        for (entry in indexedMusic(activity.contentResolver)) {
          val file = JSObject()
          file.put("uri", entry.uri)
          file.put("name", entry.name)
          file.put("mime", entry.mime)
          files.put(file)
        }
        val result = JSObject()
        result.put("files", files)
        invoke.resolve(result)
      } catch (error: Exception) {
        invoke.reject(error.message ?: "Could not read the music index")
      }
    }.start()
  }

  @Command
  fun names(invoke: Invoke) {
    val args = invoke.parseArgs(UriList::class.java)
    val result = JSObject()
    result.put("names", jsArray(args.uris.map { displayName(it) }))
    invoke.resolve(result)
  }

  @Command
  fun pickFiles(invoke: Invoke) {
    try {
      startActivityForResult(invoke, musicPickerIntent(false), "filesResult")
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not open the file picker")
    }
  }

  @ActivityCallback
  fun filesResult(invoke: Invoke, result: ActivityResult) {
    val answer = JSObject()
    answer.put("files", jsArray(pickedFileUris(result)))
    invoke.resolve(answer)
  }

  @Command
  fun pickFolder(invoke: Invoke) {
    try {
      startActivityForResult(invoke, musicPickerIntent(true), "folderResult")
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not open the folder picker")
    }
  }

  @ActivityCallback
  fun folderResult(invoke: Invoke, result: ActivityResult) {
    val answer = JSObject()
    answer.put("uri", if (result.resultCode == Activity.RESULT_OK) result.data?.data?.toString() else null)
    invoke.resolve(answer)
  }

  @Command
  fun folderFiles(invoke: Invoke) {
    Thread {
      try {
        val tree = Uri.parse(invoke.parseArgs(FolderUri::class.java).uri)
        val pending = ArrayDeque<String>()
        val visited = mutableSetOf<String>()
        val files = JSArray()
        pending.add(DocumentsContract.getTreeDocumentId(tree))
        val columns = arrayOf(
          DocumentsContract.Document.COLUMN_DOCUMENT_ID,
          DocumentsContract.Document.COLUMN_DISPLAY_NAME,
          DocumentsContract.Document.COLUMN_MIME_TYPE
        )
        val extensions = setOf(
          "mp3", "flac", "m4a", "m4b", "aac", "ogg", "opus", "wav", "aiff", "aif", "wma",
          "jpg", "jpeg", "png", "webp", "gif", "bmp", "lrc"
        )

        while (pending.isNotEmpty()) {
          val parent = pending.removeFirst()
          if (!visited.add(parent)) continue
          val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parent)
          val cursor = activity.contentResolver.query(children, columns, null, null, null)
            ?: throw IllegalStateException("Could not read a folder")
          cursor.use {
            while (it.moveToNext()) {
              val id = it.getString(0) ?: continue
              val name = it.getString(1) ?: continue
              val mime = it.getString(2)
              if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                pending.add(id)
              } else if (name.substringAfterLast('.', "").lowercase() in extensions) {
                val file = JSObject()
                file.put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, id).toString())
                file.put("parent", parent)
                file.put("name", name)
                files.put(file)
              }
            }
          }
        }
        val answer = JSObject()
        answer.put("files", files)
        invoke.resolve(answer)
      } catch (error: Exception) {
        invoke.reject(error.message ?: "Could not read the selected folder")
      }
    }.start()
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
