export function createSongEditor(): HTMLElement {
  const modal = document.createElement("div");
  modal.className = "fullscreen-modal song-editor-modal";
  modal.id = "song-editor-modal";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="fullscreen-panel song-editor-panel" role="dialog" aria-modal="true" aria-labelledby="song-editor-title">
      <header class="fullscreen-head">
        <div class="fullscreen-head-text">
          <h2 id="song-editor-title">Audio &amp; lyrics</h2>
          <p class="settings-hint" id="song-editor-song"></p>
        </div>
        <div class="fullscreen-head-actions">
          <button class="pill" id="song-editor-undo" type="button" title="Undo (Ctrl+Z)">Undo</button>
          <button class="pill" id="song-editor-redo" type="button" title="Redo (Ctrl+Shift+Z)">Redo</button>
          <button class="pill pill-strong" id="song-editor-save" type="button">Save changes</button>
          <button class="pill icon-only" id="song-editor-close" type="button" aria-label="Close">
            <span class="btn-icon" data-icon="close"></span>
          </button>
        </div>
      </header>
      <div class="song-editor-message" id="song-editor-discard" hidden>
        <span>Discard your unsaved changes?</span>
        <button class="pill" id="song-editor-keep" type="button">Keep editing</button>
        <button class="pill pill-danger" id="song-editor-discard-confirm" type="button">Discard</button>
      </div>
      <p class="song-editor-error" id="song-editor-error" role="alert" hidden></p>
      <div class="song-editor-body">
        <section class="song-editor-card song-editor-timeline-panel" aria-label="Audio and lyrics timeline">
          <div class="song-editor-transport">
            <button class="pill pill-strong" id="song-editor-play" type="button">Play</button>
            <span class="song-editor-clock"><span id="song-editor-position">00:00.000</span> / <span id="song-editor-duration">00:00.000</span></span>
            <span class="settings-hint">Preview skips marked cuts.</span>
            <span class="song-editor-spacer"></span>
            <span class="settings-hint" id="song-editor-source"></span>
            <button class="pill" id="song-editor-import-audio" type="button">Import audio</button>
          </div>
          <div class="song-editor-viewport" id="song-editor-viewport" tabindex="0" aria-label="Timeline. Drag the waveform to select a cut.">
            <div class="song-editor-timeline-inner" id="song-editor-timeline-inner">
              <div class="song-editor-ruler" id="song-editor-ruler"></div>
              <div class="song-editor-wave-track" id="song-editor-wave-track">
                <canvas id="song-editor-wave" aria-hidden="true"></canvas>
                <span class="song-editor-wave-status" id="song-editor-wave-status"></span>
                <div class="song-editor-cut-overlay" id="song-editor-cut-overlay"></div>
                <div class="song-editor-selection" id="song-editor-selection" hidden></div>
              </div>
              <div class="song-editor-lyric-track" id="song-editor-lyric-track" aria-label="Timed lyrics"></div>
              <div class="song-editor-playhead" id="song-editor-playhead"></div>
            </div>
          </div>
          <p class="settings-hint song-editor-timeline-hint">Drag the waveform to select a cut, or drag a lyric to retime it. Ctrl + scroll zooms; Shift + scroll moves sideways. Click the waveform to seek and resume following. Space plays or pauses.</p>
        </section>
        <div class="song-editor-lower">
          <section class="song-editor-card song-editor-cuts-panel" aria-labelledby="song-editor-cuts-title">
            <h3 id="song-editor-cuts-title">Cut audio</h3>
            <p class="settings-hint">Select a range above or enter its start and end.</p>
            <div class="song-editor-cut-inputs">
              <label>Start <input id="song-editor-cut-start" value="00:00.000" aria-label="Cut start time" /></label>
              <button class="pill" id="song-editor-mark-start" type="button">Set start</button>
              <label>End <input id="song-editor-cut-end" value="00:00.000" aria-label="Cut end time" /></label>
              <button class="pill" id="song-editor-mark-end" type="button">Set end</button>
              <button class="pill pill-strong" id="song-editor-add-cut" type="button">Add cut</button>
            </div>
            <div class="song-editor-cuts" id="song-editor-cuts"></div>
            <p class="settings-hint song-editor-note">Audio changes keep a backup of the previous file. Cuts are saved as FLAC and lyric timings move with them.</p>
          </section>
          <section class="song-editor-card song-editor-lyrics-panel" aria-labelledby="song-editor-lyrics-title">
            <div class="song-editor-lyrics-head">
              <div><h3 id="song-editor-lyrics-title">Lyrics</h3><p class="settings-hint">Edit text and times, or set a line to the playhead.</p></div>
              <div class="song-editor-lyric-actions">
                <button class="pill" id="song-editor-add-line" type="button">Add line</button>
                <span class="settings-hint">Shift all</span>
                <button class="pill" id="song-editor-shift-back" type="button" aria-label="Shift lyrics back 0.1 seconds">-0.1s</button>
                <button class="pill" id="song-editor-shift-forward" type="button" aria-label="Shift lyrics forward 0.1 seconds">+0.1s</button>
                <button class="pill" id="song-editor-import-lyrics" type="button">Import lyrics</button>
              </div>
            </div>
            <div class="song-editor-lines" id="song-editor-lines">
              <div class="song-editor-lines-content" id="song-editor-lines-content"></div>
            </div>
            <p class="settings-hint song-editor-note">Leave a time blank for an untimed line. Times refer to the original audio until saved.</p>
            <input id="song-editor-lyrics-file" type="file" accept=".lrc,.txt,text/plain" hidden />
          </section>
        </div>
      </div>
    </div>`;
  document.body.append(modal);
  return modal;
}
