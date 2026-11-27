#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Kind {
    AppImage,
    Debian,
    Rpm,
    Musl,
    Flatpak,
    Unknown,
}

pub(super) fn matches_version(kind: Kind, version: &str, name: &str) -> bool {
    let prefix = if kind == Kind::Rpm {
        format!("Wave-{version}-1.")
    } else {
        format!("Wave_{version}_")
    };
    name.starts_with(&prefix)
}

fn validate_asset(info: &super::UpdateInfo, kind: Kind, arch: &str) -> Result<(), String> {
    if !super::valid_asset_name(&info.asset_name)
        || !super::valid_asset_name(&info.version)
        || !matches_name(kind, arch, &info.asset_name)
        || !matches_version(kind, &info.version, &info.asset_name)
    {
        return Err("no compatible installer is available for this release".to_string());
    }
    let expected = format!(
        "https://github.com/190Q/Wave/releases/download/v{}/{}",
        info.version, info.asset_name
    );
    if info.asset_url != expected {
        return Err("the release has an invalid installer address".to_string());
    }
    Ok(())
}

pub(super) fn installer_names(kind: Kind, arch: &str) -> (&'static str, &'static str) {
    match (kind, arch) {
        (Kind::AppImage, "x86_64") => ("_amd64-slim.AppImage", "_amd64.AppImage"),
        (Kind::AppImage, "aarch64") => ("_aarch64-slim.AppImage", "_aarch64.AppImage"),
        (Kind::Debian, "x86_64") => ("_amd64.deb", "_amd64-slim.deb"),
        (Kind::Debian, "aarch64") => ("_arm64.deb", "_arm64-slim.deb"),
        (Kind::Rpm, "x86_64") => (".x86_64.rpm", ".x86_64-slim.rpm"),
        (Kind::Rpm, "aarch64") => (".aarch64.rpm", ".aarch64-slim.rpm"),
        (Kind::Musl, "aarch64") => ("_aarch64_musl.tar.gz", ""),
        (Kind::Flatpak, "aarch64") => ("_aarch64_phone.flatpak", ""),
        _ => ("", ""),
    }
}

fn matches_name(kind: Kind, arch: &str, name: &str) -> bool {
    let (first, second) = installer_names(kind, arch);
    (!first.is_empty() && name.ends_with(first)) || (!second.is_empty() && name.ends_with(second))
}

#[cfg(target_os = "linux")]
mod platform {
    use super::{Kind, matches_name, validate_asset};
    use crate::update::UpdateInfo;
    use std::ffi::OsStr;
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    use std::path::{Path, PathBuf};
    use std::process::{Command, Output, Stdio};
    use tauri::AppHandle;

    pub(crate) enum Installation {
        AppImage(PathBuf),
        Debian(PathBuf),
        Rpm(PathBuf),
        Musl(PathBuf),
        Flatpak,
        Unknown,
    }

    impl Installation {
        pub(crate) fn kind(&self) -> Kind {
            match self {
                Self::AppImage(_) => Kind::AppImage,
                Self::Debian(_) => Kind::Debian,
                Self::Rpm(_) => Kind::Rpm,
                Self::Musl(_) => Kind::Musl,
                Self::Flatpak => Kind::Flatpak,
                Self::Unknown => Kind::Unknown,
            }
        }

        pub(crate) fn supported(&self) -> bool {
            self.kind() != Kind::Unknown
        }
    }

    pub(crate) fn detect() -> Installation {
        if Path::new("/.flatpak-info").exists() {
            return Installation::Flatpak;
        }
        if let Some(path) = std::env::var_os("APPIMAGE").filter(|path| !path.is_empty()) {
            return Installation::AppImage(path.into());
        }
        let Ok(exe) = std::env::current_exe() else {
            return Installation::Unknown;
        };
        if let Some(prefix) = exe.parent().and_then(Path::parent) {
            if prefix.join("share/wave/musl-install").is_file() {
                return Installation::Musl(prefix.to_path_buf());
            }
        }
        if owned_by_wave("dpkg-query", &["-S"], &exe) {
            return Installation::Debian(exe);
        }
        if owned_by_wave("rpm", &["-qf", "--queryformat", "%{NAME}"], &exe) {
            return Installation::Rpm(exe);
        }
        Installation::Unknown
    }

    fn owned_by_wave(command: &str, args: &[&str], exe: &Path) -> bool {
        let Ok(output) = Command::new(command).args(args).arg(exe).output() else {
            return false;
        };
        if !output.status.success() {
            return false;
        }
        let output = String::from_utf8_lossy(&output.stdout);
        if command == "rpm" {
            output.trim().eq_ignore_ascii_case("wave")
        } else {
            output.lines().any(|line| {
                line.split_once(": ")
                    .map(|(package, _)| package.split(':').next() == Some("wave"))
                    .unwrap_or(false)
            })
        }
    }

    pub(crate) fn matches_install(name: &str) -> bool {
        matches_name(detect().kind(), std::env::consts::ARCH, name)
    }

    pub(crate) fn validate_release_asset(info: &UpdateInfo) -> Result<(), String> {
        validate_asset(info, detect().kind(), std::env::consts::ARCH)
    }

    fn private_dir(parent: &Path) -> Result<PathBuf, String> {
        let dir = parent.join(format!("wave-update-{}", uuid::Uuid::new_v4()));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&dir)
            .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        Ok(dir)
    }

    pub(crate) fn download_path(_app: &AppHandle, name: &str) -> Result<PathBuf, String> {
        let parent = if matches!(detect(), Installation::Flatpak) {
            let path = PathBuf::from("/var/cache");
            std::fs::create_dir_all(&path)
                .map_err(|e| format!("could not create {}: {e}", path.display()))?;
            path
        } else {
            std::env::temp_dir()
        };
        Ok(private_dir(&parent)?.join(name))
    }

    pub(crate) fn remove_download(path: &Path) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    fn command_result(command: &mut Command) -> Result<(), String> {
        let output = command
            .output()
            .map_err(|e| format!("the installer could not be started: {e}"))?;
        if output.status.success() {
            return Ok(());
        }
        let message = String::from_utf8_lossy(&output.stderr);
        let message = message.trim();
        let fallback = String::from_utf8_lossy(&output.stdout);
        let message = if message.is_empty() {
            fallback.trim()
        } else {
            message
        };
        if message.is_empty() {
            Err(format!("the installer failed ({})", output.status))
        } else {
            Err(format!(
                "the installer failed: {}",
                message.chars().take(1000).collect::<String>()
            ))
        }
    }

    fn first_tool<'a>(paths: &[&'a str]) -> Option<&'a str> {
        paths.iter().copied().find(|path| Path::new(path).is_file())
    }

    fn install_package(kind: Kind, downloaded: &Path) -> Result<(), String> {
        let (tool, args): (&str, &[&str]) = match kind {
            Kind::Debian => (
                first_tool(&["/usr/bin/apt-get", "/bin/apt-get"])
                    .ok_or("apt-get is required to update this Debian package")?,
                &["install", "-y"],
            ),
            Kind::Rpm => {
                if let Some(tool) = first_tool(&["/usr/bin/dnf", "/bin/dnf"]) {
                    (tool, &["install", "-y"])
                } else if let Some(tool) = first_tool(&["/usr/bin/zypper", "/bin/zypper"]) {
                    (tool, &["--non-interactive", "install"])
                } else {
                    return Err("dnf or zypper is required to update this RPM package".to_string());
                }
            }
            _ => return Err("the package type is not supported".to_string()),
        };
        let mut command = package_command(tool, args, downloaded);
        command_result(&mut command)
    }

    fn package_command(tool: &str, args: &[&str], downloaded: &Path) -> Command {
        let mut command = Command::new("pkexec");
        command.arg(tool).args(args).arg(downloaded);
        command
    }

    fn install_appimage(downloaded: &Path, appimage: &Path) -> Result<(), String> {
        let folder = appimage
            .parent()
            .ok_or("the AppImage has no parent folder")?;
        let stage = private_dir(folder)?;
        let staged = stage.join("wave");
        let result = (|| {
            std::fs::copy(downloaded, &staged)
                .map_err(|e| format!("could not stage the AppImage: {e}"))?;
            std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("could not make the AppImage runnable: {e}"))?;
            std::fs::rename(&staged, appimage)
                .map_err(|e| format!("could not replace {}: {e}", appimage.display()))?;
            Ok(())
        })();
        let _ = std::fs::remove_dir_all(stage);
        result
    }

    fn install_musl(downloaded: &Path, prefix: &Path) -> Result<(), String> {
        let dir = downloaded
            .parent()
            .ok_or("the update has no staging folder")?;
        let unpacked = dir.join("package");
        std::fs::create_dir(&unpacked)
            .map_err(|e| format!("could not prepare the phone installer: {e}"))?;
        let mut extract = Command::new("tar");
        extract
            .arg("-xzf")
            .arg(downloaded)
            .arg("-C")
            .arg(&unpacked)
            .args([
                "wave",
                "wave-bin",
                "wave-webkit.py",
                "install.sh",
                "VERSION",
                "wave.svg",
                "wave-128.png",
                "wave-256.png",
            ]);
        command_result(&mut extract)?;
        for file in [
            "wave",
            "wave-bin",
            "wave-webkit.py",
            "install.sh",
            "VERSION",
            "wave.svg",
            "wave-128.png",
            "wave-256.png",
        ] {
            if !std::fs::symlink_metadata(unpacked.join(file))
                .map(|metadata| metadata.is_file())
                .unwrap_or(false)
            {
                return Err(format!("the phone installer contains an invalid {file}"));
            }
        }
        let mut command = Command::new("sh");
        command
            .arg(unpacked.join("install.sh"))
            .args(["--local", "--skip-deps", "--dir"])
            .arg(prefix)
            .env("WAVE_LOCAL_PACKAGE_DIR", &unpacked);
        command_result(&mut command)
    }

    fn host_spawn() -> Command {
        let mut command = Command::new("flatpak-spawn");
        command.current_dir("/").arg("--host");
        command
    }

    fn host_command<I, S>(args: I) -> Result<Output, String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        host_spawn()
            .args(args)
            .output()
            .map_err(|e| format!("the Flatpak host service could not be started: {e}"))
    }

    fn flatpak_scope() -> Result<String, String> {
        let info = std::fs::read_to_string("/.flatpak-info")
            .map_err(|e| format!("could not read the Flatpak installation: {e}"))?;
        let app_path = info
            .lines()
            .find_map(|line| line.strip_prefix("original-app-path="))
            .or_else(|| info.lines().find_map(|line| line.strip_prefix("app-path=")))
            .ok_or("the Flatpak installation path is missing")?;
        let branch_dir = flatpak_branch_dir(app_path)?;
        let mut scopes = vec!["--user".to_string(), "--system".to_string()];
        if let Ok(output) = host_command([
            "flatpak",
            "list",
            "--app",
            "--columns=application,installation",
        ]) {
            if output.status.success() {
                for line in String::from_utf8_lossy(&output.stdout).lines() {
                    let fields: Vec<_> = line.split('\t').collect();
                    if fields.len() == 2 && fields[0].trim() == "com.wave.app" {
                        let name = fields[1].trim();
                        if !name.is_empty()
                            && name
                                .bytes()
                                .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
                            && name != "user"
                            && name != "system"
                        {
                            scopes.push(format!("--installation={name}"));
                        }
                    }
                }
            }
        }
        for scope in scopes {
            let output = host_command([
                "flatpak",
                "info",
                &scope,
                "--show-location",
                "com.wave.app//stable",
            ])?;
            if output.status.success() {
                let location = String::from_utf8_lossy(&output.stdout);
                if Path::new(location.trim()).parent() == Some(branch_dir) {
                    return Ok(scope);
                }
            }
        }
        Err("could not identify the running Flatpak installation".to_string())
    }

    fn flatpak_branch_dir(app_path: &str) -> Result<&Path, String> {
        Path::new(app_path)
            .parent()
            .and_then(Path::parent)
            .ok_or_else(|| "the Flatpak installation path is invalid".to_string())
    }

    fn flatpak_host_cache_path(info: &str, downloaded: &Path) -> Result<PathBuf, String> {
        let instance_path = info
            .lines()
            .find_map(|line| line.strip_prefix("instance-path="))
            .filter(|path| Path::new(path).is_absolute())
            .ok_or("the Flatpak cache location is missing")?;
        let relative = downloaded
            .strip_prefix("/var/cache")
            .map_err(|_| "the Flatpak update is not in its cache")?;
        Ok(Path::new(instance_path).join("cache").join(relative))
    }

    fn install_flatpak(downloaded: &Path, scope: &str) -> Result<(), String> {
        let info = std::fs::read_to_string("/.flatpak-info")
            .map_err(|e| format!("could not read the Flatpak installation: {e}"))?;
        let host_path = flatpak_host_cache_path(&info, downloaded)?;
        let mut command = flatpak_install_command(&host_path, scope);
        command_result(&mut command)
    }

    fn flatpak_install_command(host_path: &Path, scope: &str) -> Command {
        let mut command = host_spawn();
        if scope != "--user" {
            command.args(["pkexec", "/usr/bin/flatpak"]);
        } else {
            command.arg("flatpak");
        }
        command
            .args([
                "install",
                scope,
                "--bundle",
                "--assumeyes",
                "--noninteractive",
            ])
            .arg(host_path);
        command
    }

    pub(crate) fn install(
        app: &AppHandle,
        downloaded: &Path,
        info: &UpdateInfo,
    ) -> Result<(), String> {
        let installation = detect();
        let kind = installation.kind();
        if !matches_name(kind, std::env::consts::ARCH, &info.asset_name) {
            return Err("the installer no longer matches this copy of Wave".to_string());
        }
        let mut restart = match installation {
            Installation::AppImage(path) => {
                install_appimage(downloaded, &path)?;
                Command::new(path)
            }
            Installation::Debian(path) | Installation::Rpm(path) => {
                install_package(kind, downloaded)?;
                Command::new(path)
            }
            Installation::Musl(prefix) => {
                install_musl(downloaded, &prefix)?;
                Command::new(prefix.join("bin/wave"))
            }
            Installation::Flatpak => {
                let scope = flatpak_scope()?;
                install_flatpak(downloaded, &scope)?;
                let mut command = host_spawn();
                command.args(["flatpak", "run", &scope, "com.wave.app//stable"]);
                command
            }
            Installation::Unknown => {
                return Err("this copy of Wave cannot update itself".to_string());
            }
        };
        let mut child = restart
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("the updated Wave could not be started: {e}"))?;
        std::thread::sleep(std::time::Duration::from_millis(500));
        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("could not check the restarted Wave: {e}"))?
        {
            if !status.success() {
                return Err(format!("the updated Wave could not be started ({status})"));
            }
        }
        super::super::exit_soon(app);
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn installer_commands_preserve_paths_and_installation_scope() {
            let package = Path::new("/tmp/path with spaces/Wave.deb");
            let command = package_command("/usr/bin/apt-get", &["install", "-y"], package);
            assert_eq!(command.get_program(), "pkexec");
            assert_eq!(
                command.get_args().collect::<Vec<_>>(),
                [
                    "/usr/bin/apt-get",
                    "install",
                    "-y",
                    "/tmp/path with spaces/Wave.deb"
                ]
            );
            let command =
                flatpak_install_command(Path::new("/cache/Wave.flatpak"), "--installation=extra");
            assert_eq!(command.get_current_dir(), Some(Path::new("/")));
            assert_eq!(
                command.get_args().collect::<Vec<_>>(),
                [
                    "--host",
                    "pkexec",
                    "/usr/bin/flatpak",
                    "install",
                    "--installation=extra",
                    "--bundle",
                    "--assumeyes",
                    "--noninteractive",
                    "/cache/Wave.flatpak"
                ]
            );
            let user = flatpak_install_command(Path::new("/cache/Wave.flatpak"), "--user");
            assert_eq!(user.get_args().nth(1), Some(OsStr::new("flatpak")));
        }

        #[test]
        fn flatpak_paths_refer_to_the_running_installation_and_host_cache() {
            let path =
                "/home/user/.local/share/flatpak/app/com.wave.app/aarch64/stable/old-commit/files";
            let branch = flatpak_branch_dir(path).unwrap();
            assert_eq!(
                branch,
                Path::new("/home/user/.local/share/flatpak/app/com.wave.app/aarch64/stable")
            );
            assert_eq!(
                Path::new(
                    "/home/user/.local/share/flatpak/app/com.wave.app/aarch64/stable/new-commit"
                )
                .parent(),
                Some(branch)
            );
            assert_ne!(
                Path::new("/var/lib/flatpak/app/com.wave.app/aarch64/stable/new-commit").parent(),
                Some(branch)
            );
            let info = "[Instance]\ninstance-path=/home/user/.var/app/com.wave.app\n";
            assert_eq!(
                flatpak_host_cache_path(info, Path::new("/var/cache/wave-update-id/Wave.flatpak"))
                    .unwrap(),
                Path::new("/home/user/.var/app/com.wave.app/cache/wave-update-id/Wave.flatpak")
            );
            assert!(flatpak_host_cache_path(info, Path::new("/tmp/Wave.flatpak")).is_err());
        }

        #[test]
        fn failed_commands_and_appimage_replacements_preserve_the_original() {
            let mut failed = Command::new("sh");
            failed.args(["-c", "printf 'authorisation denied' >&2; exit 1"]);
            assert!(
                command_result(&mut failed)
                    .unwrap_err()
                    .contains("authorisation denied")
            );
            let root = private_dir(&std::env::temp_dir()).unwrap();
            let appimage = root.join("Wave.AppImage");
            let downloaded = root.join("download");
            std::fs::write(&appimage, "old").unwrap();
            assert!(install_appimage(&downloaded, &appimage).is_err());
            assert_eq!(std::fs::read(&appimage).unwrap(), b"old");
            std::fs::write(&downloaded, "new").unwrap();
            install_appimage(&downloaded, &appimage).unwrap();
            assert_eq!(std::fs::read(&appimage).unwrap(), b"new");
            assert_ne!(
                std::fs::metadata(&appimage).unwrap().permissions().mode() & 0o111,
                0
            );
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}

#[cfg(target_os = "linux")]
pub(super) use platform::{
    detect, download_path, install, matches_install, remove_download, validate_release_asset,
};

#[cfg(test)]
mod tests {
    use super::{Kind, installer_names, matches_name, validate_asset};

    #[test]
    fn assets_match_the_installation_and_architecture() {
        let cases = [
            (Kind::AppImage, "x86_64", "Wave_0.5.0_amd64.AppImage"),
            (Kind::Debian, "aarch64", "Wave_0.5.0_arm64.deb"),
            (Kind::Rpm, "x86_64", "Wave-0.5.0-1.x86_64.rpm"),
            (Kind::Musl, "aarch64", "Wave_0.5.0_aarch64_musl.tar.gz"),
            (Kind::Flatpak, "aarch64", "Wave_0.5.0_aarch64_phone.flatpak"),
        ];
        for (kind, arch, name) in cases {
            assert!(matches_name(kind, arch, name));
            assert!(!matches_name(kind, "unknown", name));
        }
        assert!(!matches_name(
            Kind::Debian,
            "x86_64",
            "Wave_0.5.0_amd64.AppImage"
        ));
        assert_eq!(installer_names(Kind::Unknown, "x86_64"), ("", ""));
    }

    #[test]
    fn installer_must_be_the_matching_github_release_asset() {
        let mut info = super::super::UpdateInfo {
            version: "0.5.1".into(),
            asset_name: "Wave_0.5.1_amd64.deb".into(),
            asset_url: "https://github.com/190Q/Wave/releases/download/v0.5.1/Wave_0.5.1_amd64.deb"
                .into(),
            ..Default::default()
        };
        assert!(validate_asset(&info, Kind::Debian, "x86_64").is_ok());
        assert!(validate_asset(&info, Kind::Rpm, "x86_64").is_err());
        info.version = "0.5.2".into();
        assert!(validate_asset(&info, Kind::Debian, "x86_64").is_err());
        info.version = "0.5.1".into();
        info.asset_url = "https://example.com/Wave_0.5.1_amd64.deb".into();
        assert!(validate_asset(&info, Kind::Debian, "x86_64").is_err());
        info.asset_name = "../Wave_0.5.1_amd64.deb".into();
        assert!(validate_asset(&info, Kind::Debian, "x86_64").is_err());
    }
}
