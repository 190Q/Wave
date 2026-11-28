# Using Wave

[Back to the README](../README.md)

## Moving playlists and music

On desktop, open **Settings → Library → Export playlist**, select a collection
and choose **Export**. On the other device, open **Import → Import Wave
playlist** and choose whether to create a playlist or import only its songs.

A `.wavelist` contains an ordered song list, metadata, available timed
lyrics and copies of audio edited in Wave. Other audio is not included. Wave
matches songs already in the destination library and searches YouTube for
missing audio; downloaded matches may differ from the original recordings.
Entries that cannot be downloaded remain in the playlist and can be retried
with **Download**, or their audio can be imported later.

Edited audio can make an export much larger. It is limited to 4 GiB per song
and 64 GiB per export. Existing lyrics and different recordings on the
destination are left untouched. Older exports can still be imported, but
cannot restore audio edits; older Wave versions cannot read the newer formats.

### Migrating to Android

For the most reliable transfer, copy the music before importing playlists.
Check that titles and artists are tagged in the audio files: matching uses
metadata, and names derived only from filenames may not survive the copy.

1. On desktop, export each playlist from **Settings → Library → Export
   playlist**. You can also export **Liked Songs**.
2. In the same settings section, choose **Open in Explorer** and copy the
   entire `songs` folder, including its subfolders, artwork and lyrics.
3. Install Wave on your phone and transfer the `songs` folder and `.wavelist`
   files to accessible storage, for example over USB. Put `songs` inside a
   folder such as `Music/Wave transfer`.
4. On Android, open **Import → Import folder**, select the copied `songs`
   folder and grant access when prompted. Wait for the import to finish.
5. Open **Import → Import Wave playlist**, select each `.wavelist` and choose
   **As a playlist**. Wave restores included edited audio, matches the other
   songs and searches YouTube for any that are missing.
6. If you exported **Liked Songs**, it is imported as a regular playlist, not
   as likes. Open that playlist, long-press a song and choose **Select all**;
   long-press again and choose **Like** if offered.

Wave copies the audio into its own library, so allow enough space for both
copies during import. After checking the songs and playlists, you can remove
the temporary copy from phone storage. Settings are not transferred. Listening
history can be transferred separately as described below.

The Android file browser's menu can switch between internal storage, SD cards
and other available providers. File selection shows all file types, but only
supported audio formats are imported. Android may restrict access to some
folders, especially other apps' private data and certain storage roots.

## Moving listening history

Import the songs first. Then use **Settings → Wave Swell → Export** on the
source device and **Import** on the destination. Importing a `.waveanalytics`
backup replaces the destination's listening record after confirmation. It
contains listening activity, not audio, playlists, likes or settings. Songs are
matched by ID or unambiguous metadata.

On Android 10 and later, uninstalling Wave through system settings may offer a
checkbox to keep its app data for a later reinstall with the same package and
signing key. The version being uninstalled must already include this option,
so update Wave before uninstalling. This is not a backup: the data stays on
the device and is deleted if the option is not selected.

## Headphone EQ with AutoEq

1. Open the [AutoEq results](https://github.com/jaakkopasanen/AutoEq/tree/master/results)
   and find your exact headphone or headset model, including the matching
   variant such as ANC on or off.
2. Open the model's folder and download the file ending in `ParametricEQ.txt`
   using GitHub's **Download raw file** button.
3. In Wave, open **Settings → Playback → Equaliser**, choose **Open**, then
   select **Import a profile** under **Curves** and pick the downloaded file.
4. Wave saves and enables the profile. Select it under **Curves** to use it
   again later.

Wave imports the filters and calculates its own automatic preamp rather than
using the preamp value in the file. On Android, the equaliser shows presets and
rules rather than the band editor; support depends on the device's webview.

## Spotify setup

Spotify link imports are available on desktop and need your own developer app.

1. Create an app in the [Spotify developer dashboard](https://developer.spotify.com/dashboard).
2. Add `http://127.0.0.1:45678` as a redirect URI in the app's settings.
3. In Wave, open **Import**, paste a Spotify link and choose **Set up → Open
   the config folder**. Enter the app's Client ID and Client Secret in the
   `.env` file:

   ```dotenv
   SPOTIFY_CLIENT_ID=your_client_id
   SPOTIFY_CLIENT_SECRET=your_client_secret
   ```

4. Import the link and sign in when prompted. Spotify's API allows your own
   and collaborative playlists but does not provide its editorial playlists.

Spotify provides the track information; Wave searches YouTube for matching
audio. The import dialog reports missing download tools and can open the
download log. To use your own copies instead of bundled tools, set
`YTDLP_PATH`, `FFMPEG_PATH` or `DENO_PATH` in the same `.env` file.
