package com.wave.app

import android.app.Service
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.util.Log
import java.io.File
import java.util.UUID
import org.json.JSONObject

internal class NativePlaybackClient(private val context: Context) {
  private var service: Messenger? = null
  private var bound = false
  private val pending = ArrayList<JSONObject>()
  private var receive: ((String) -> Unit)? = null
  private var visible = false
  var connected = false
    private set

  private val replies = Messenger(Handler(Looper.getMainLooper()) { message ->
    val fileName = message.data.getString("file")
    val payload = if (fileName != null && fileName.startsWith("playback-") && !fileName.contains('/')) {
      try {
        val file = File(context.cacheDir, fileName)
        file.readText().also { file.delete() }
      } catch (error: Exception) {
        Log.w("Wave", "native playback state could not be read", error)
        null
      }
    } else message.data.getString("payload")
    payload?.let {
      try {
        receive?.invoke(it)
      } catch (error: Exception) {
        Log.w("Wave", "native playback state could not be delivered", error)
      }
    }
    true
  })

  private val connection = object : ServiceConnection {
    override fun onServiceConnected(name: ComponentName, binder: IBinder) {
      service = Messenger(binder)
      val waiting = pending.toList()
      pending.clear()
      waiting.forEach(::send)
    }

    override fun onServiceDisconnected(name: ComponentName) {
      service = null
      if (connected) pending.add(0, connectMessage())
    }
  }

  private fun connectMessage(): JSONObject =
    JSONObject().put("type", "connect").put("visible", visible)

  fun connect(callback: (String) -> Unit) {
    connected = true
    receive = callback
    send(connectMessage())
  }

  fun setVisible(visible: Boolean) {
    this.visible = visible
    send(JSONObject().put("type", "visibility").put("visible", visible))
  }

  fun send(payload: JSONObject) {
    val target = service
    if (target == null) {
      pending.add(payload)
      if (!bound) {
        bound = context.bindService(
          Intent(context, NativePlaybackConnectionService::class.java),
          connection, Context.BIND_AUTO_CREATE
        )
      }
      return
    }
    try {
      val text = payload.toString()
      val data = Bundle()
      if (text.length > 100_000) {
        val file = File(context.cacheDir, "playback-${UUID.randomUUID()}.json")
        file.writeText(text)
        data.putString("file", file.name)
      } else {
        data.putString("payload", text)
      }
      target.send(Message.obtain().apply {
        this.data = data
        replyTo = replies
      })
    } catch (error: Exception) {
      Log.w("Wave", "native playback command could not be delivered", error)
    }
  }

  fun close() {
    connected = false
    receive = null
    pending.clear()
    if (bound) context.unbindService(connection)
    bound = false
    service = null
  }
}

class NativePlaybackConnectionService : Service() {
  private var owner: IBinder? = null
  private val messenger = Messenger(Handler(Looper.getMainLooper()) { message ->
    try {
      val fileName = message.data.getString("file")
      val text = if (fileName != null && fileName.startsWith("playback-") && !fileName.contains('/')) {
        val file = File(cacheDir, fileName)
        file.readText().also { file.delete() }
      } else {
        message.data.getString("payload") ?: return@Handler true
      }
      val json = JSONObject(text)
      when (json.getString("type")) {
        "connect" -> {
          val reply = message.replyTo ?: return@Handler true
          owner = reply.binder
          NativePlayback.setUiVisible(this, json.optBoolean("visible"))
          NativePlayback.listen(this, reply.binder) { state -> reply.sendState(state) }
          reply.sendState(NativePlayback.snapshot(this).put("type", "snapshot"))
        }
        "visibility" -> NativePlayback.setUiVisible(this, json.optBoolean("visible"))
        "background" -> NativePlayback.setBackgroundEnabled(this, json.optBoolean("enabled", true))
        "controls" -> MediaPlayback.setControls(this, json.optBoolean("enabled", true))
        "queue" -> NativePlayback.updateQueue(this, json)
        "equaliser" -> NativePlayback.updateEqualiser(this, json)
        "load" -> {
          NativePlayback.load(this, json.getString("path"), json.optLong("positionMs"), json.optBoolean("autoplay"))
          acknowledge(message, json)
        }
        "play" -> NativePlayback.play(this)
        "pause" -> NativePlayback.pause()
        "seek" -> {
          NativePlayback.seek(json.optLong("positionMs"))
          acknowledge(message, json)
        }
        "volume" -> NativePlayback.setVolume(json.optDouble("volume", 1.0))
        "clear" -> NativePlayback.clear()
      }
    } catch (error: Exception) {
      Log.w("Wave", "invalid native playback command", error)
    }
    true
  })

  private fun acknowledge(message: Message, command: JSONObject) {
    if (!command.has("commandId")) return
    message.replyTo?.sendState(NativePlayback.snapshot(this, includePlayback = false)
      .put("type", "state").put("commandId", command.optLong("commandId")))
  }

  private fun Messenger.sendState(state: JSONObject) {
    try {
      val text = state.toString()
      val bundle = Bundle()
      if (text.length > 100_000) {
        val file = File(cacheDir, "playback-${UUID.randomUUID()}.json")
        file.writeText(text)
        bundle.putString("file", file.name)
      } else {
        bundle.putString("payload", text)
      }
      send(Message.obtain().apply {
        data = bundle
      })
    } catch (error: Exception) {
      Log.w("Wave", "native playback state could not be delivered", error)
    }
  }

  override fun onBind(intent: Intent): IBinder = messenger.binder

  override fun onDestroy() {
    NativePlayback.setUiVisible(this, false)
    owner?.let { NativePlayback.unlisten(it) }
    owner = null
    super.onDestroy()
  }
}
