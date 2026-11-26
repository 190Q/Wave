package com.wave.app.eq

data class WaveEqRuleContext(
  val sourceId: String? = null,
  val album: String? = null,
  val artist: String? = null,
  val genre: String? = null,
  val activeOutputIds: List<String> = emptyList(),
) {
  fun key(): String = (listOf(sourceId.orEmpty(), album.orEmpty(), artist.orEmpty(), genre.orEmpty()) +
    activeOutputIds).joinToString("\u0000")
}

enum class WaveEqRuleKind(val value: String) {
  PLAYLIST("playlist"), ALBUM("album"), ARTIST("artist"), GENRE("genre"), DEVICE("device"),
}

data class WaveEqContextRule(val kind: WaveEqRuleKind, val value: String, val presetId: String)

data class WaveEqPreset(val id: String, val settings: WaveEqSettings)

data class WaveEqManualSelection(val presetId: String, val contextKey: String)

data class WaveEqRuleState(
  val settings: WaveEqSettings,
  val activePresetId: String? = null,
  val manual: WaveEqManualSelection? = null,
  val appliedSignature: String? = null,
  val awaitingInitialOutput: Boolean = false,
)

data class WaveEqRuleMatch(val kind: WaveEqRuleKind, val value: String, val presetId: String) {
  val signature: String get() = "${kind.value}\u0000$presetId"
}

data class WaveEqRuleResult(
  val state: WaveEqRuleState,
  val rule: WaveEqRuleMatch?,
  val appliedPresetId: String? = null,
)

object WaveEqRules {
  fun resolve(
    context: WaveEqRuleContext,
    presets: List<WaveEqPreset>,
    contextRules: List<WaveEqContextRule>,
    deviceRules: Map<String, String>,
    state: WaveEqRuleState,
  ): WaveEqRuleResult {
    val key = context.key()
    var next = state
    if (next.awaitingInitialOutput && context.activeOutputIds.isNotEmpty()) {
      next = next.copy(awaitingInitialOutput = false)
      val manual = next.manual
      if (manual != null) {
        next = next.copy(manual = manual.copy(contextKey = key))
      } else {
        val initial = match(context, presets, contextRules, deviceRules)
        if (initial != null && initial.first.presetId == next.activePresetId) {
          return WaveEqRuleResult(next.copy(appliedSignature = initial.first.signature), initial.first)
        }
      }
    }
    if (next.manual != null && next.manual.contextKey != key) {
      next = next.copy(manual = null)
    }
    val selected = if (next.manual == null) match(context, presets, contextRules, deviceRules) else null
    val signature = selected?.first?.signature ?: ""
    if (signature == next.appliedSignature) return WaveEqRuleResult(next, selected?.first)
    next = next.copy(appliedSignature = signature)
    if (selected == null) return WaveEqRuleResult(next, null)
    val (rule, preset) = selected
    val settings = preset.settings.copy(enabled = true, bands = preset.settings.bands.map { it.copy() })
    return WaveEqRuleResult(next.copy(settings = settings, activePresetId = preset.id), rule, preset.id)
  }

  // Use for a fresh session; restore persisted rule state with resolve instead.
  fun seed(
    context: WaveEqRuleContext,
    presets: List<WaveEqPreset>,
    contextRules: List<WaveEqContextRule>,
    deviceRules: Map<String, String>,
    state: WaveEqRuleState,
  ): WaveEqRuleResult {
    val next = state.copy(awaitingInitialOutput = context.activeOutputIds.isEmpty())
    val selected = match(context, presets, contextRules, deviceRules)
    if (selected != null && selected.first.presetId != next.activePresetId) {
      return resolve(context, presets, contextRules, deviceRules, next.copy(appliedSignature = null))
    }
    return WaveEqRuleResult(next.copy(appliedSignature = selected?.first?.signature ?: ""), selected?.first)
  }

  private fun match(
    context: WaveEqRuleContext,
    presets: List<WaveEqPreset>,
    contextRules: List<WaveEqContextRule>,
    deviceRules: Map<String, String>,
  ): Pair<WaveEqRuleMatch, WaveEqPreset>? {
    val candidates = listOf(
      WaveEqRuleKind.PLAYLIST to context.sourceId,
      WaveEqRuleKind.ALBUM to context.album,
      WaveEqRuleKind.ARTIST to context.artist,
      WaveEqRuleKind.GENRE to context.genre,
    )
    for ((kind, value) in candidates) {
      if (value.isNullOrEmpty()) continue
      val rule = contextRules.firstOrNull { it.kind == kind && it.value == value } ?: continue
      val preset = presets.firstOrNull { it.id.isNotEmpty() && it.id == rule.presetId } ?: continue
      return WaveEqRuleMatch(kind, value, preset.id) to preset
    }
    for (outputId in context.activeOutputIds) {
      val presetId = deviceRules[outputId].orEmpty()
      val preset = presets.firstOrNull { it.id.isNotEmpty() && it.id == presetId } ?: continue
      return WaveEqRuleMatch(WaveEqRuleKind.DEVICE, outputId, preset.id) to preset
    }
    return null
  }
}
