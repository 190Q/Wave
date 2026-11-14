package com.wave.app

import java.io.File
import java.io.FileNotFoundException
import java.io.IOException

internal object MusicDocumentPaths {
  fun resolve(songs: File, documentId: String): File {
    val rootId = MusicDocumentsProvider.ROOT_ID
    val relative = when {
      documentId == rootId -> ""
      documentId.startsWith("$rootId/") -> documentId.substring(rootId.length + 1)
      else -> throw FileNotFoundException("Invalid document")
    }
    if (documentId != rootId && relative.split('/').any {
      it.isEmpty() || it == "." || it == ".." || it.contains('\\')
    }) {
      throw FileNotFoundException("Invalid document")
    }
    val root: File
    val file: File
    try {
      root = songs.canonicalFile
      file = File(root, relative).canonicalFile
    } catch (_: IOException) {
      throw FileNotFoundException("Invalid document")
    }
    if ((file != root && !file.path.startsWith(root.path + File.separator)) || !file.exists()) {
      throw FileNotFoundException("Document not found")
    }
    return file
  }
}
