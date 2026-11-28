# Wave on Linux phones

[Back to the README](../README.md)

## Flatpak

The `Wave_x.y.z_aarch64_phone.flatpak` release includes Wave and its download
tools. Install Flatpak for your distribution, download the bundle from the
[releases page](https://github.com/190Q/Wave/releases/latest), and run:

```sh
flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
flatpak install --user ./Wave_x.y.z_aarch64_phone.flatpak
flatpak run com.wave.app
```

Replace `x.y.z` with the version of the downloaded file. The bundle uses the
GNOME 51 Flatpak runtime, which is downloaded from Flathub if needed; the
runtime is not included in the bundle. The first installation therefore needs
network access unless the runtime is already installed. The phone also needs a
working graphical session, audio service and desktop portals. The app can
access files in your home directory for music imports.

Headset buttons and media keys reach Wave through the phone's media-control
service. Make sure **System media controls** is enabled in Wave. To check
Wave's MPRIS connection, play a song and run `playerctl --player=wave
play-pause`; install `playerctl` if it is not already available. If that works
but Bluetooth buttons do not, the phone may need its BlueZ `mpris-proxy`
service running, or its desktop may need media-key bindings. Check whether the
same buttons work with another player before changing system services.

The Flatpak keeps its own library and settings under
`~/.var/app/com.wave.app/`, separate from other Wave installations. New
bundles can install updates from Wave in the same user or system installation.
System-wide updates require graphical administrator authorisation.

An older bundle without this updater must be updated manually once: close Wave,
uninstall the old application and install the new bundle with the command
above. For a user installation, run:

```sh
flatpak uninstall --user com.wave.app
```

For a system installation, use `--system` instead of `--user` in both the
uninstall and install commands. This leaves the app data in place; do not use
`--delete-data` when updating. Back up important data before replacing an
installation.

To update its bundle, Wave can run commands on the host through Flatpak's
`org.freedesktop.Flatpak` interface. This effectively removes the Flatpak
sandbox's security boundary.

## Alpine and postmarketOS musl tarball

On aarch64 musl systems, the Linux installer selects the phone tarball and asks
whether to install missing WebKitGTK, graphics and audio libraries, yt-dlp,
FFmpeg, Deno and its YouTube solver using `apk`. Decline to install them
manually; the installer lists the Alpine package names and continues installing
Wave, which may not run until its dependencies are available. Without a
terminal, dependencies are not installed automatically. Use `--install-deps`
to install them without prompting or `--skip-deps` to leave them for manual
installation. With the one-line installer, pass either option after `sh -s --`,
for example:

```sh
curl -fsSL https://raw.githubusercontent.com/190Q/Wave/main/install.sh | sh -s -- --skip-deps
```

Community repositories must be enabled; `sudo` or `doas` may be required for
installing packages. Run the installer as your normal user, without `sudo` or
`doas` on the installer itself; it uses them when needed for `apk`. To install
a downloaded tarball, extract it and run `sh install.sh --local` from the
extracted directory. Extracting the archive alone does not install Wave. The
archive depends on system packages rather than containing all libraries. The
phone launcher uses the desktop's file chooser portal; on Phosh this provides
an adaptive picker. Alpine controls the available yt-dlp version, which may
need updating as YouTube changes.

By default, the installer places the launcher at `~/.local/bin/wave`, with its
supporting files in the same directory, and creates
`~/.local/share/applications/wave-bin.desktop` and icons under
`~/.local/share/icons/hicolor/`, or in `XDG_DATA_HOME` if set. If
`~/.local/bin` is not on `PATH`, run the launcher by its full path or add the
directory to `PATH`. Running the installer as root instead uses root's `HOME`,
usually `/root`. Set `WAVE_PREFIX` or use `--dir` to change the installation
prefix; `--uninstall` removes Wave but leaves shared packages installed.

WebKit normally uses its installed helpers. If they are elsewhere, set
`WAVE_WEBKIT_HELPER_DIR` to the directory containing `WebKitWebProcess` and
`WebKitNetworkProcess`. Set `WAVE_WEBKIT_BUNDLE_DIR` to the directory
containing `libwebkit2gtkinjectedbundle.so`. Both must match the installed
WebKit library version, and their resolved paths cannot contain `:`. The
launcher redirects its compiled-in paths using a private temporary library
copy, without modifying `/usr/libexec`. If discovery fails,
`WAVE_WEBKIT_LIBRARY` selects the library file, while
`WAVE_WEBKIT_HELPER_TARGET` and `WAVE_WEBKIT_BUNDLE_TARGET` identify its
compiled-in paths. Set these variables in the desktop session environment for
graphical launches; `WEBKIT_EXEC_PATH` is unreliable in production builds.

For a blank screen, launch `wave` in a terminal and check the frontend and
WebKit logs. See the [development guide](development.md#linux-phone-lab) for
testing the downloaded phone app in Docker.
