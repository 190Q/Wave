package com.wave.app

import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat

internal class LibraryTasks {
  private val tasks = linkedMapOf<String, String>()

  fun add(id: String, label: String) {
    tasks[id] = label
  }

  fun remove(id: String) {
    tasks.remove(id)
  }

  fun label(): String? = tasks.values.lastOrNull()
}

internal object LibraryWork {
  private val tasks = LibraryTasks()
  private var service: LibraryWorkService? = null
  private var starting = false

  fun begin(context: Context, id: String, label: String) {
    tasks.add(id, label)
    start(context)
  }

  fun end(id: String) {
    tasks.remove(id)
    val running = service ?: return
    val label = tasks.label()
    if (label == null) {
      service = null
      running.finish()
    } else {
      running.update(label)
    }
  }

  fun resume(context: Context) {
    if (tasks.label() != null) {
      start(context)
    }
  }

  fun background() {
    if (tasks.label() != null) {
      service?.hold()
    }
  }

  fun started(running: LibraryWorkService): String? {
    starting = false
    service = running
    return tasks.label()
  }

  fun stopped(running: LibraryWorkService) {
    if (service === running) {
      service = null
    }
  }

  private fun start(context: Context) {
    val label = tasks.label() ?: return
    val running = service
    if (running != null) {
      running.update(label)
      return
    }
    if (starting) {
      return
    }

    starting = true
    try {
      ContextCompat.startForegroundService(context, Intent(context, LibraryWorkService::class.java))
    } catch (error: Exception) {
      starting = false
      Log.w("Wave", "library work could not start a foreground service", error)
    }
  }
}
