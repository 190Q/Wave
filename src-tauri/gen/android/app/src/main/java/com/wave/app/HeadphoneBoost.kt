package com.wave.app

import android.media.AudioDeviceInfo
import com.wave.app.eq.WaveEqSettings

internal fun headphoneBoostActive(enabled: Boolean, routes: List<Int>): Boolean =
  enabled && routes.isNotEmpty() && routes.all {
    it == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
      it == AudioDeviceInfo.TYPE_WIRED_HEADSET ||
      it == AudioDeviceInfo.TYPE_USB_HEADSET ||
      it == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP ||
      it == AudioDeviceInfo.TYPE_BLE_HEADSET
  }

internal fun headphoneBoostSettings(active: Boolean): WaveEqSettings =
  WaveEqSettings(enabled = active, autoPreamp = false, preampDb = 3.0, limiter = true)
