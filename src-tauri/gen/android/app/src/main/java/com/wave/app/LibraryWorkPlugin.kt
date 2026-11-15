package com.wave.app

import android.app.Activity
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class LibraryWorkArgs {
  lateinit var id: String
  var label: String = ""
}

@TauriPlugin
class LibraryWorkPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun begin(invoke: Invoke) {
    val args = invoke.parseArgs(LibraryWorkArgs::class.java)
    activity.runOnUiThread {
      LibraryWork.begin(activity.applicationContext, args.id, args.label)
      invoke.resolve()
    }
  }

  @Command
  fun end(invoke: Invoke) {
    val args = invoke.parseArgs(LibraryWorkArgs::class.java)
    activity.runOnUiThread {
      LibraryWork.end(args.id)
      invoke.resolve()
    }
  }

  override fun onResume(activity: AppCompatActivity) {
    LibraryWork.resume(activity.applicationContext)
  }

  override fun onPause(activity: AppCompatActivity) {
    LibraryWork.background()
  }
}
