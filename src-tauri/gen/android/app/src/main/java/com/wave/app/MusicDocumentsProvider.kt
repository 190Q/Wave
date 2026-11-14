package com.wave.app

import android.database.Cursor
import android.database.MatrixCursor
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsProvider
import android.webkit.MimeTypeMap
import java.io.File
import java.io.FileNotFoundException

class MusicDocumentsProvider : DocumentsProvider() {
  companion object {
    const val ROOT_ID = "songs"
    private val ROOT_COLUMNS = arrayOf(
      DocumentsContract.Root.COLUMN_ROOT_ID,
      DocumentsContract.Root.COLUMN_DOCUMENT_ID,
      DocumentsContract.Root.COLUMN_TITLE,
      DocumentsContract.Root.COLUMN_ICON,
      DocumentsContract.Root.COLUMN_FLAGS,
      DocumentsContract.Root.COLUMN_MIME_TYPES,
    )
    private val DOCUMENT_COLUMNS = arrayOf(
      DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME,
      DocumentsContract.Document.COLUMN_MIME_TYPE,
      DocumentsContract.Document.COLUMN_FLAGS,
      DocumentsContract.Document.COLUMN_SIZE,
      DocumentsContract.Document.COLUMN_LAST_MODIFIED,
    )
  }

  override fun onCreate(): Boolean = true

  override fun queryRoots(projection: Array<out String>?): Cursor {
    val result = MatrixCursor(projection ?: ROOT_COLUMNS)
    result.newRow().apply {
      add(DocumentsContract.Root.COLUMN_ROOT_ID, ROOT_ID)
      add(DocumentsContract.Root.COLUMN_DOCUMENT_ID, ROOT_ID)
      add(DocumentsContract.Root.COLUMN_TITLE, "Wave music")
      add(DocumentsContract.Root.COLUMN_ICON, context!!.applicationInfo.icon)
      add(DocumentsContract.Root.COLUMN_FLAGS, 0)
      add(DocumentsContract.Root.COLUMN_MIME_TYPES, "*/*")
    }
    return result
  }

  override fun queryDocument(documentId: String, projection: Array<out String>?): Cursor {
    val result = MatrixCursor(projection ?: DOCUMENT_COLUMNS)
    addDocument(result, documentId, fileFor(documentId))
    return result
  }

  override fun queryChildDocuments(
    parentDocumentId: String,
    projection: Array<out String>?,
    sortOrder: String?,
  ): Cursor {
    val parent = fileFor(parentDocumentId)
    if (!parent.isDirectory) throw FileNotFoundException("Not a directory")
    val result = MatrixCursor(projection ?: DOCUMENT_COLUMNS)
    for (entry in parent.listFiles().orEmpty().sortedBy { it.name.lowercase() }) {
      val id = "$parentDocumentId/${entry.name}"
      try {
        addDocument(result, id, fileFor(id))
      } catch (_: FileNotFoundException) {
        continue
      }
    }
    return result
  }

  override fun isChildDocument(parentDocumentId: String, documentId: String): Boolean {
    return try {
      val parent = fileFor(parentDocumentId)
      val child = fileFor(documentId)
      parent.isDirectory && child.path.startsWith(parent.path + File.separator)
    } catch (_: FileNotFoundException) {
      false
    }
  }

  override fun openDocument(
    documentId: String,
    mode: String,
    signal: CancellationSignal?,
  ): ParcelFileDescriptor {
    if (mode != "r") throw FileNotFoundException("Music is read-only")
    val file = fileFor(documentId)
    if (!file.isFile) throw FileNotFoundException("Not a file")
    return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
  }

  private fun fileFor(documentId: String): File {
    val root = File(context!!.applicationInfo.dataDir, "library/songs")
    return MusicDocumentPaths.resolve(root, documentId)
  }

  private fun addDocument(cursor: MatrixCursor, id: String, file: File) {
    val mime = if (file.isDirectory) {
      DocumentsContract.Document.MIME_TYPE_DIR
    } else {
      MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension.lowercase())
        ?: "application/octet-stream"
    }
    cursor.newRow().apply {
      add(DocumentsContract.Document.COLUMN_DOCUMENT_ID, id)
      add(DocumentsContract.Document.COLUMN_DISPLAY_NAME, if (id == ROOT_ID) "Wave music" else file.name)
      add(DocumentsContract.Document.COLUMN_MIME_TYPE, mime)
      add(DocumentsContract.Document.COLUMN_FLAGS, 0)
      add(DocumentsContract.Document.COLUMN_SIZE, if (file.isFile) file.length() else null)
      add(DocumentsContract.Document.COLUMN_LAST_MODIFIED, file.lastModified())
    }
  }
}
