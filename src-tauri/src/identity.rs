use std::fs;
use std::io::Read;
use std::path::Path;
use std::time::UNIX_EPOCH;

/// The namespace track ids are derived in. Fixed for good: changing it would
/// renumber every song in every library.
const NAMESPACE: uuid::Uuid = uuid::Uuid::from_bytes([
    0x5c, 0x1a, 0x9e, 0x3b, 0x7f, 0x24, 0x4d, 0x18, 0x9a, 0x6c, 0x2b, 0x8f, 0x0d, 0x5e, 0x7a, 0x41,
]);

/// How much is hashed at a time. Large enough that a big file is not a syscall
/// per kilobyte, small enough to stay out of the way.
const HASH_BUFFER: usize = 64 * 1024;

/// The id a piece of audio earns. Derived from its content, so importing the
/// same audio twice lands on the same track rather than a second copy, and an
/// interrupted migration that is run again produces the same ids.
pub fn id_for_hash(hash: &str) -> String {
    uuid::Uuid::new_v5(&NAMESPACE, hash.as_bytes()).to_string()
}

/// A fresh id, for a song whose content is not what identifies it: a directory
/// adopted from outside the library, for instance.
pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// True when `value` could be an id this module minted, so a directory name can
/// be trusted instead of being replaced.
pub fn is_id(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok()
}

/// BLAKE3 over a file, read in chunks so a long song never sits in memory.
pub fn content_hash(path: &Path) -> Result<String, String> {
    let mut file =
        fs::File::open(path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    let mut hasher = Hasher::new();
    let mut buffer = vec![0u8; HASH_BUFFER];

    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| format!("could not read {}: {e}", path.display()))?;
        if read == 0 {
            return Ok(hasher.finish());
        }
        hasher.update(&buffer[..read]);
    }
}

/// A hash taken as bytes go past, so a file can be hashed while it is copied
/// rather than read twice.
pub struct Hasher(blake3::Hasher);

impl Hasher {
    pub fn new() -> Self {
        Self(blake3::Hasher::new())
    }

    pub fn update(&mut self, bytes: &[u8]) {
        self.0.update(bytes);
    }

    pub fn finish(self) -> String {
        self.0.finalize().to_hex().to_string()
    }
}

impl Default for Hasher {
    fn default() -> Self {
        Self::new()
    }
}

/// What a file looked like when the catalog last saw it. The size and the
/// modification time together are enough to tell an untouched file from one
/// that has been edited or replaced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Stamp {
    pub bytes: u64,
    pub modified_ms: i64,
}

pub fn stamp(metadata: &fs::Metadata) -> Stamp {
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0);

    Stamp {
        bytes: metadata.len(),
        modified_ms,
    }
}

pub fn stamp_of(path: &Path) -> Result<Stamp, String> {
    let metadata =
        fs::metadata(path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    Ok(stamp(&metadata))
}

/// Milliseconds since the epoch, for the catalog's own timestamps.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// The id Wave minted before the catalog existed: FNV-1a over the lowercased
/// library-relative path. Kept character for character, because a library built
/// by an older version can only be renumbered if its old ids can be reproduced.
pub fn legacy_id(relative_path: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in relative_path.to_lowercase().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("wave-identity-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The values an older version produced for these paths, computed
    /// independently. If either side ever drifts, an existing library stops
    /// being migratable, so this is worth pinning down.
    #[test]
    fn reproduces_the_ids_an_older_version_minted() {
        assert_eq!(legacy_id("songs/Hey Jude.mp3"), "649b22d1e20675c6");
        assert_eq!(legacy_id("songs/15 Step.flac"), "1a0b8f46f6bbd5e2");
    }

    #[test]
    fn the_legacy_id_folds_case_as_the_old_one_did() {
        assert_eq!(
            legacy_id("songs/Hey Jude.mp3"),
            legacy_id("songs/hey jude.MP3")
        );
        assert_ne!(
            legacy_id("songs/Hey Jude.mp3"),
            legacy_id("songs/Hey Jude.flac")
        );
    }

    #[test]
    fn an_id_survives_being_read_back() {
        let id = id_for_hash("a hash");
        assert!(is_id(&id));
        assert_eq!(id, id_for_hash("a hash"));
        assert_ne!(id, id_for_hash("another hash"));
        // A fresh id is a real one too, and is not the same twice.
        assert!(is_id(&new_id()));
        assert_ne!(new_id(), new_id());
        // A file name is not an id.
        assert!(!is_id("Hey Jude.mp3"));
        assert!(!is_id(""));
    }

    #[test]
    fn hashes_a_file_and_the_same_bytes_hashed_as_they_go_past() {
        let dir = scratch("hash");
        let path = dir.join("song.bin");
        fs::write(&path, b"0123456789").unwrap();

        let read = content_hash(&path).unwrap();

        let mut streamed = Hasher::new();
        streamed.update(b"01234");
        streamed.update(b"56789");
        assert_eq!(streamed.finish(), read);

        // A different file is a different hash, and a missing one is an error.
        fs::write(&path, b"0123456788").unwrap();
        assert_ne!(content_hash(&path).unwrap(), read);
        assert!(content_hash(&dir.join("missing.bin")).is_err());
    }

    #[test]
    fn a_stamp_follows_the_file() {
        let dir = scratch("stamp");
        let path = dir.join("song.bin");
        fs::write(&path, b"0123456789").unwrap();

        let first = stamp_of(&path).unwrap();
        assert_eq!(first.bytes, 10);
        assert!(first.modified_ms > 0);

        fs::write(&path, b"a longer file").unwrap();
        assert_ne!(stamp_of(&path).unwrap(), first);
    }
}
