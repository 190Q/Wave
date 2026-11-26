package com.wave.app.eq

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class WaveEqRulesTest {
  private val band = WaveEqBand("one", WaveEqKind.PEAKING, 1000.0, 5.0, 1.0)
  private val edited = WaveEqSettings(enabled = false, bands = listOf(band.copy(gainDb = 3.0)))
  private val presetSettings = WaveEqSettings(
    enabled = false, bands = listOf(band), autoPreamp = false, preampDb = -4.5, limiter = false,
  )
  private val presets = listOf(
    WaveEqPreset("playlist-preset", presetSettings),
    WaveEqPreset("album-preset", presetSettings),
    WaveEqPreset("artist-preset", presetSettings),
    WaveEqPreset("genre-preset", presetSettings),
    WaveEqPreset("device-preset", presetSettings),
    WaveEqPreset("second-device-preset", presetSettings),
  )
  private val context = WaveEqRuleContext("playlist", "album", "artist", "genre", listOf("one", "two"))
  private val rules = listOf(
    WaveEqContextRule(WaveEqRuleKind.GENRE, "genre", "genre-preset"),
    WaveEqContextRule(WaveEqRuleKind.ARTIST, "artist", "artist-preset"),
    WaveEqContextRule(WaveEqRuleKind.ALBUM, "album", "album-preset"),
    WaveEqContextRule(WaveEqRuleKind.PLAYLIST, "playlist", "playlist-preset"),
  )
  private val devices = mapOf("one" to "device-preset", "two" to "second-device-preset")

  private fun resolve(
    context: WaveEqRuleContext = this.context,
    presets: List<WaveEqPreset> = this.presets,
    rules: List<WaveEqContextRule> = this.rules,
    devices: Map<String, String> = this.devices,
    state: WaveEqRuleState = WaveEqRuleState(edited),
  ) = WaveEqRules.resolve(context, presets, rules, devices, state)

  private fun seed(
    context: WaveEqRuleContext = this.context,
    rules: List<WaveEqContextRule> = this.rules,
    devices: Map<String, String> = this.devices,
    state: WaveEqRuleState = WaveEqRuleState(edited),
  ) = WaveEqRules.seed(context, presets, rules, devices, state)

  @Test fun contextRulesHaveFixedPrecedenceAndSkipMissingPresets() {
    val expected = listOf(
      WaveEqRuleKind.PLAYLIST,
      WaveEqRuleKind.ALBUM,
      WaveEqRuleKind.ARTIST,
      WaveEqRuleKind.GENRE,
      WaveEqRuleKind.DEVICE,
    )
    var remaining = presets
    for (kind in expected) {
      val result = resolve(presets = remaining)
      assertEquals(kind, result.rule?.kind)
      remaining = remaining.filterNot { it.id == result.rule?.presetId }
    }
  }

  @Test fun outputRulesFollowTheActiveOutputOrderAndIgnoreInvalidIds() {
    val first = resolve(rules = emptyList())
    assertEquals("one", first.rule?.value)
    assertEquals("device-preset", first.appliedPresetId)
    val reversed = resolve(context = context.copy(activeOutputIds = listOf("two", "one")), rules = emptyList())
    assertEquals("two", reversed.rule?.value)
    assertEquals("second-device-preset", reversed.appliedPresetId)
    val missing = resolve(rules = emptyList(), devices = mapOf("one" to "missing", "two" to "device-preset"))
    assertEquals("two", missing.rule?.value)
    assertEquals("device-preset", missing.appliedPresetId)
  }

  @Test fun contextValuesMatchExactlyAndEmptyValuesDoNotMatch() {
    val unmatched = resolve(
      context = WaveEqRuleContext(sourceId = "", album = "Album", artist = "artist ", genre = null),
      rules = listOf(
        WaveEqContextRule(WaveEqRuleKind.PLAYLIST, "", "playlist-preset"),
        WaveEqContextRule(WaveEqRuleKind.ALBUM, "album", "album-preset"),
        WaveEqContextRule(WaveEqRuleKind.ARTIST, "artist", "artist-preset"),
      ),
      devices = emptyMap(),
    )
    assertNull(unmatched.rule)
    assertSame(edited, unmatched.state.settings)
  }

  @Test fun firstDuplicateContextRuleBlocksLaterDuplicatesWhenItsPresetIsMissing() {
    val duplicates = listOf(
      WaveEqContextRule(WaveEqRuleKind.ALBUM, "album", "missing"),
      WaveEqContextRule(WaveEqRuleKind.ALBUM, "album", "album-preset"),
      WaveEqContextRule(WaveEqRuleKind.ARTIST, "artist", "artist-preset"),
    )
    assertEquals(WaveEqRuleKind.ARTIST, resolve(rules = duplicates).rule?.kind)
  }

  @Test fun appliedRuleCopiesPresetSettingsAndEnablesEqualiser() {
    val mutableBands = mutableListOf(band)
    val source = WaveEqPreset("preset", presetSettings.copy(bands = mutableBands))
    val result = resolve(
      presets = listOf(source),
      rules = listOf(WaveEqContextRule(WaveEqRuleKind.PLAYLIST, "playlist", "preset")),
    )
    assertEquals("preset", result.appliedPresetId)
    assertEquals("preset", result.state.activePresetId)
    assertEquals("playlist\u0000preset", result.state.appliedSignature)
    assertTrue(result.state.settings.enabled)
    assertFalse(result.state.settings.autoPreamp)
    assertEquals(-4.5, result.state.settings.preampDb, 0.0)
    assertFalse(result.state.settings.limiter)
    assertEquals(listOf(band), result.state.settings.bands)
    assertNotSame(mutableBands, result.state.settings.bands)
    mutableBands.clear()
    assertEquals(listOf(band), result.state.settings.bands)
  }

  @Test fun unchangedSignaturePreservesEditsEvenWhenTheRuleValueChanges() {
    val albumRules = listOf(
      WaveEqContextRule(WaveEqRuleKind.ALBUM, "album", "album-preset"),
      WaveEqContextRule(WaveEqRuleKind.ALBUM, "other album", "album-preset"),
    )
    val state = WaveEqRuleState(edited, "album-preset", appliedSignature = "album\u0000album-preset")
    val result = resolve(context = context.copy(album = "other album"), rules = albumRules, state = state)
    assertEquals("other album", result.rule?.value)
    assertNull(result.appliedPresetId)
    assertSame(edited, result.state.settings)
    assertFalse(result.state.settings.enabled)
  }

  @Test fun switchingKindWithTheSamePresetAppliesThePreset() {
    val albumRule = listOf(WaveEqContextRule(WaveEqRuleKind.ALBUM, "album", "album-preset"))
    val state = WaveEqRuleState(edited, "album-preset", appliedSignature = "artist\u0000album-preset")
    val result = resolve(rules = albumRule, state = state)
    assertEquals("album-preset", result.appliedPresetId)
    assertTrue(result.state.settings.enabled)
  }

  @Test fun manualSelectionSuppressesRulesUntilTheEntireContextChanges() {
    val manual = WaveEqManualSelection("manual", context.key())
    val state = WaveEqRuleState(edited, "manual", manual, "playlist\u0000playlist-preset")
    val same = resolve(state = state)
    assertSame(edited, same.state.settings)
    assertEquals(manual, same.state.manual)
    assertEquals("", same.state.appliedSignature)
    assertNull(same.rule)
    val changes = listOf(
      context.copy(sourceId = "new source"),
      context.copy(album = "new album"),
      context.copy(artist = "new artist"),
      context.copy(genre = "new genre"),
      context.copy(activeOutputIds = listOf("two", "one")),
    )
    for (changed in changes) {
      val result = resolve(context = changed, state = same.state)
      assertNull(result.state.manual)
      assertTrue(result.state.settings.enabled)
      assertNotSame(edited, result.state.settings)
    }
  }

  @Test fun noRulePreservesSettingsAndClearsTheAppliedSignature() {
    val state = WaveEqRuleState(edited, "old", appliedSignature = "album\u0000old")
    val result = resolve(rules = emptyList(), devices = emptyMap(), state = state)
    assertSame(edited, result.state.settings)
    assertEquals("old", result.state.activePresetId)
    assertEquals("", result.state.appliedSignature)
    assertNull(result.appliedPresetId)
  }

  @Test fun startupSeedsMatchingActivePresetWithoutOverwritingEdits() {
    val state = WaveEqRuleState(edited, "playlist-preset")
    val result = seed(state = state)
    assertSame(edited, result.state.settings)
    assertEquals("playlist\u0000playlist-preset", result.state.appliedSignature)
    assertNull(result.appliedPresetId)
    assertFalse(result.state.awaitingInitialOutput)
  }

  @Test fun startupAppliesMatchingRuleWhenTheActivePresetDiffers() {
    val result = seed(state = WaveEqRuleState(edited, "old"))
    assertEquals("playlist-preset", result.appliedPresetId)
    assertEquals("playlist-preset", result.state.activePresetId)
    assertTrue(result.state.settings.enabled)
  }

  @Test fun firstDiscoveredOutputSeedsTheRuleWithoutOverwritingEdits() {
    val waiting = seed(
      context = WaveEqRuleContext(),
      rules = emptyList(),
      state = WaveEqRuleState(edited, "device-preset"),
    )
    assertTrue(waiting.state.awaitingInitialOutput)
    val discovered = resolve(
      context = WaveEqRuleContext(activeOutputIds = listOf("one")),
      rules = emptyList(),
      state = waiting.state,
    )
    assertFalse(discovered.state.awaitingInitialOutput)
    assertEquals("device\u0000device-preset", discovered.state.appliedSignature)
    assertSame(edited, discovered.state.settings)
    assertNull(discovered.appliedPresetId)
  }

  @Test fun firstDiscoveredOutputRebasesManualOverride() {
    val empty = WaveEqRuleContext()
    val manual = WaveEqManualSelection("manual", empty.key())
    val waiting = WaveEqRuleState(edited, "manual", manual, "", awaitingInitialOutput = true)
    val discovered = WaveEqRuleContext(activeOutputIds = listOf("one"))
    val result = resolve(context = discovered, state = waiting, rules = emptyList())
    assertEquals(discovered.key(), result.state.manual?.contextKey)
    assertFalse(result.state.awaitingInitialOutput)
    assertNull(result.appliedPresetId)
    assertSame(edited, result.state.settings)
  }

  @Test fun firstDiscoveredOutputAppliesDifferentPreset() {
    val waiting = WaveEqRuleState(edited, "old", appliedSignature = "", awaitingInitialOutput = true)
    val result = resolve(
      context = WaveEqRuleContext(activeOutputIds = listOf("one")),
      rules = emptyList(),
      state = waiting,
    )
    assertEquals("device-preset", result.appliedPresetId)
    assertTrue(result.state.settings.enabled)
  }

  @Test fun keyUsesTheSameNullEmptyAndOrderedOutputEncodingAsTheWebPlayer() {
    assertEquals("source\u0000\u0000artist\u0000genre\u0000a\u0000b", WaveEqRuleContext(
      "source", null, "artist", "genre", listOf("a", "b"),
    ).key())
    assertEquals(WaveEqRuleContext().key(), WaveEqRuleContext("", "", "", "").key())
    assertFalse(context.key() == context.copy(activeOutputIds = listOf("two", "one")).key())
  }
}
