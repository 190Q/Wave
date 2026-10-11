use std::collections::HashMap;
use std::fs;
use std::path::Path;

use tauri::{AppHandle, Manager, State};

use crate::state::{self, Store};

/// How far each channel is shifted to form a bucket key. 4 bits per channel
/// gives 4096 buckets, which is plenty at this resolution.
const BUCKET_SHIFT: u8 = 4;

/// Below this luma a bucket is treated as background black.
const LUMA_FLOOR: f32 = 24.0;
/// Above this luma a bucket is treated as background white.
const LUMA_CEILING: f32 = 232.0;

/// A bucket's running totals: pixel count, then the summed channels.
type Bucket = (u64, u64, u64, u64);

const ACCENT_CANDIDATES: usize = 12;
const ACCENT_MIN_BRIGHTNESS: f32 = 80.0;
pub fn dominant_colours(path: &Path) -> Result<Vec<String>, String> {
    let image = image::open(path).map_err(|e| format!("could not decode {}: {e}", path.display()))?;

    // 64x64 is small enough to be fast and large enough that a cover's accent
    // colours still survive the downscale.
    let small = image
        .resize_exact(64, 64, image::imageops::FilterType::Triangle)
        .to_rgb8();

    let mut vivid: HashMap<u16, Bucket> = HashMap::new();
    let mut everything: HashMap<u16, Bucket> = HashMap::new();

    for pixel in small.pixels() {
        let [r, g, b] = pixel.0;
        accumulate(&mut everything, bucket_key(r, g, b), r, g, b);

        let luma = 0.2126 * f32::from(r) + 0.7152 * f32::from(g) + 0.0722 * f32::from(b);
        if (LUMA_FLOOR..=LUMA_CEILING).contains(&luma) {
            accumulate(&mut vivid, bucket_key(r, g, b), r, g, b);
        }
    }

    // A genuinely monochrome cover can empty the vivid set; fall back to
    // everything rather than returning nothing.
    let pool = if vivid.is_empty() { &everything } else { &vivid };

    let mut ranked: Vec<Bucket> = pool.values().copied().collect();
    if ranked.is_empty() {
        return Err(format!("{} contained no pixels", path.display()));
    }

    ranked.sort_by(|a, b| score(*b).total_cmp(&score(*a)));
    ranked.truncate(ACCENT_CANDIDATES);

    Ok(ranked.iter().map(|bucket| average_hex(*bucket)).collect())
}

fn usable_accent(candidates: &[String]) -> Option<String> {
    let first = candidates.first()?;

    if let Some(found) = candidates.iter().find(|hex| brightness(hex) >= ACCENT_MIN_BRIGHTNESS) {
        return Some(found.clone());
    }

    let mut lifted = first.clone();
    for _ in 0..8 {
        lifted = lighten(&lifted, 0.12);
        if brightness(&lifted) >= ACCENT_MIN_BRIGHTNESS {
            break;
        }
    }
    Some(lifted)
}

/// Perceived brightness, 0 to 255.
fn brightness(hex: &str) -> f32 {
    let (r, g, b) = parse_hex(hex);
    0.2126 * f32::from(r) + 0.7152 * f32::from(g) + 0.0722 * f32::from(b)
}

fn parse_hex(hex: &str) -> (u8, u8, u8) {
    let digits = hex.trim_start_matches('#');
    let channel = |start: usize| u8::from_str_radix(digits.get(start..start + 2).unwrap_or("00"), 16).unwrap_or(0);
    (channel(0), channel(2), channel(4))
}

fn to_hex(r: u8, g: u8, b: u8) -> String {
    format!("#{r:02x}{g:02x}{b:02x}")
}

/// Blends toward white by `amount`, 0 to 1.
fn lighten(hex: &str, amount: f32) -> String {
    let (r, g, b) = parse_hex(hex);
    let blend = |channel: u8| {
        (f32::from(channel) + (255.0 - f32::from(channel)) * amount)
            .round()
            .clamp(0.0, 255.0) as u8
    };
    to_hex(blend(r), blend(g), blend(b))
}

fn bucket_key(r: u8, g: u8, b: u8) -> u16 {
    (u16::from(r >> BUCKET_SHIFT) << 8)
        | (u16::from(g >> BUCKET_SHIFT) << 4)
        | u16::from(b >> BUCKET_SHIFT)
}

fn accumulate(pool: &mut HashMap<u16, Bucket>, key: u16, r: u8, g: u8, b: u8) {
    let entry = pool.entry(key).or_insert((0, 0, 0, 0));
    entry.0 += 1;
    entry.1 += u64::from(r);
    entry.2 += u64::from(g);
    entry.3 += u64::from(b);
}

/// Frequency weighted by saturation, so a large dull region loses to a
/// smaller vivid one.
fn score(bucket: Bucket) -> f32 {
    let (count, r, g, b) = bucket;
    if count == 0 {
        return 0.0;
    }
    let count = count as f32;
    let (r, g, b) = (r as f32 / count, g as f32 / count, b as f32 / count);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let saturation = if max <= 0.0 { 0.0 } else { (max - min) / max };
    count * (0.5 + saturation)
}

fn average_hex(bucket: Bucket) -> String {
    let (count, r, g, b) = bucket;
    let count = count.max(1) as f64;
    let channel = |sum: u64| (sum as f64 / count).round().clamp(0.0, 255.0) as u8;
    format!("#{:02x}{:02x}{:02x}", channel(r), channel(g), channel(b))
}

#[tauri::command]
pub fn artwork_colour(
    app: AppHandle,
    store: State<'_, Store>,
    track_id: String,
    path: String,
) -> Result<String, String> {

    if let Some(cached) = store.snapshot().artwork_colours.get(&track_id) {
        if brightness(cached) >= ACCENT_MIN_BRIGHTNESS {
            return Ok(cached.clone());
        }
    }

    let candidates = dominant_colours(Path::new(&path))?;
    let colour = usable_accent(&candidates).ok_or_else(|| format!("{path} had no usable colour"))?;

    let next = store.update(|state| {
        state.artwork_colours.insert(track_id, colour.clone());
    });
    // Failing to cache is not a reason to withhold the colour we just computed.
    let _ = state::save(&app, &next);
    Ok(colour)
}

const ARTWORK_MAX_EDGE: u32 = 640;

#[tauri::command]
pub fn artwork_bytes(app: AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = fs::read(&path).map_err(|e| format!("could not read {path}: {e}"))?;
    Ok(tauri::ipc::Response::new(cached_thumbnail(&app, &path, &bytes)))
}

fn cached_thumbnail(app: &AppHandle, path: &str, bytes: &[u8]) -> Vec<u8> {
    let Some(cache) = app.path().app_cache_dir().ok().map(|dir| dir.join("thumbs")) else {
        return bytes.to_vec();
    };
    if fs::create_dir_all(&cache).is_err() {
        return bytes.to_vec();
    }

    let target = cache.join(format!("{}-{}.jpg", cache_key(path), bytes.len()));
    if let Ok(cached) = fs::read(&target) {
        return cached;
    }

    let Some(encoded) = thumbnail(bytes) else {
        return bytes.to_vec();
    };
    let _ = fs::write(&target, &encoded);
    encoded
}

const COVER_CELL: u32 = 256;

#[tauri::command]
pub fn cover_bytes(app: AppHandle, paths: Vec<String>) -> Result<tauri::ipc::Response, String> {
    if paths.is_empty() {
        return Err("no artwork to compose".to_string());
    }

    let cache = app.path().app_cache_dir().ok().map(|dir| dir.join("covers"));
    let target = cache
        .as_ref()
        .map(|dir| dir.join(format!("{}.jpg", cache_key(&cover_signature(&paths)))));

    if let Some(target) = &target {
        if let Ok(cached) = fs::read(target) {
            return Ok(tauri::ipc::Response::new(cached));
        }
    }

    let composed = compose_cover(cache.as_deref(), &paths).ok_or_else(|| "could not compose a cover".to_string())?;

    if let (Some(dir), Some(target)) = (&cache, &target) {
        let _ = fs::create_dir_all(dir);
        let _ = fs::write(target, &composed);
    }

    Ok(tauri::ipc::Response::new(composed))
}

fn cover_signature(paths: &[String]) -> String {
    paths.iter().take(4).cloned().collect::<Vec<_>>().join("|")
}

fn file_key(path: &str) -> String {
    let size = fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    format!("{}-{size}", cache_key(path))
}

fn square_thumb(cache: Option<&Path>, path: &str) -> Option<Vec<u8>> {
    let target = cache.map(|dir| dir.join(format!("{}-sq.jpg", file_key(path))));

    if let Some(target) = &target {
        if let Ok(cached) = fs::read(target) {
            return Some(cached);
        }
    }

    let image = image::open(path).ok()?;
    let filled = image.resize_to_fill(COVER_CELL, COVER_CELL, image::imageops::FilterType::Triangle);

    let mut out = Vec::new();
    filled
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Jpeg)
        .ok()?;

    if let Some(target) = &target {
        let _ = fs::create_dir_all(target.parent()?);
        let _ = fs::write(target, &out);
    }

    Some(out)
}

fn compose_cover(cache: Option<&Path>, paths: &[String]) -> Option<Vec<u8>> {
    let cells: Vec<image::DynamicImage> = paths
        .iter()
        .take(4)
        .filter_map(|path| square_thumb(cache, path))
        .filter_map(|bytes| image::load_from_memory(&bytes).ok())
        .collect();

    if cells.is_empty() {
        return None;
    }

    let (columns, order): (u32, Vec<usize>) = match cells.len() {
        1 => (1, vec![0]),
        2 => (2, vec![0, 1]),
        3 => (2, vec![0, 1, 2, 0]),
        _ => (2, vec![0, 1, 2, 3]),
    };
    let rows = (order.len() as u32).div_ceil(columns);

    let mut canvas = image::RgbImage::new(columns * COVER_CELL, rows * COVER_CELL);

    for (position, index) in order.iter().enumerate() {
        let filled = cells[*index].to_rgb8();
        let x = (position as u32 % columns) * COVER_CELL;
        let y = (position as u32 / columns) * COVER_CELL;
        image::imageops::replace(&mut canvas, &filled, i64::from(x), i64::from(y));
    }

    let mut out = Vec::new();
    image::DynamicImage::ImageRgb8(canvas)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Jpeg)
        .ok()?;
    Some(out)
}

/// FNV-1a over the lowercased path, matching how tracks are identified.
fn cache_key(path: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in path.to_lowercase().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn thumbnail(bytes: &[u8]) -> Option<Vec<u8>> {
    let image = image::load_from_memory(bytes).ok()?;
    let scaled = if image.width().max(image.height()) > ARTWORK_MAX_EDGE {
        image.resize(
            ARTWORK_MAX_EDGE,
            ARTWORK_MAX_EDGE,
            image::imageops::FilterType::Triangle,
        )
    } else {
        image
    };

    let mut out = Vec::new();
    scaled
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Jpeg)
        .ok()?;
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A small source image on disk, so the tests exercise real decoding.
    fn test_image(dir: &Path, name: &str, colour: [u8; 3]) -> String {
        let path = dir.join(name);
        let mut image = image::RgbImage::new(96, 96);
        for pixel in image.pixels_mut() {
            *pixel = image::Rgb(colour);
        }
        image.save(&path).expect("could not write a test image");
        path.to_string_lossy().into_owned()
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("wave-artwork-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn skips_accents_that_are_too_dark() {
        let candidates = vec!["#0a0a0a".to_string(), "#121212".to_string(), "#d94f3d".to_string()];
        assert_eq!(usable_accent(&candidates).as_deref(), Some("#d94f3d"));
    }

    #[test]
    fn keeps_the_most_prominent_usable_accent() {
        let candidates = vec!["#d94f3d".to_string(), "#3ba55d".to_string()];
        assert_eq!(usable_accent(&candidates).as_deref(), Some("#d94f3d"));
    }

    #[test]
    fn lifts_an_accent_when_every_candidate_is_dark() {
        let candidates = vec!["#080808".to_string(), "#101010".to_string()];
        let chosen = usable_accent(&candidates).expect("a colour is always returned");
        assert!(brightness(&chosen) >= ACCENT_MIN_BRIGHTNESS);
    }

    #[test]
    fn encodes_a_thumbnail() {
        let dir = scratch("thumb");
        let path = test_image(&dir, "a.png", [200, 30, 30]);
        let bytes = fs::read(&path).unwrap();

        let encoded = thumbnail(&bytes);
        assert!(encoded.is_some(), "jpeg encoding is unavailable");
        assert!(image::load_from_memory(&encoded.unwrap()).is_ok());
    }

    #[test]
    fn square_thumb_writes_to_the_cache() {
        let dir = scratch("square");
        let path = test_image(&dir, "b.png", [30, 200, 90]);

        let first = square_thumb(Some(&dir), &path);
        assert!(first.is_some(), "square thumb encoding failed");

        let written = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().ends_with("-sq.jpg"))
            .count();
        assert_eq!(written, 1, "square thumb was not cached to disk");

        // Second call must come from the cache, not a re-encode.
        assert_eq!(square_thumb(Some(&dir), &path), first);
    }

    #[test]
    fn composes_a_two_by_two_cover() {
        let dir = scratch("cover");
        let paths: Vec<String> = (0..4)
            .map(|index| test_image(&dir, &format!("c{index}.png"), [40 * index as u8, 90, 200]))
            .collect();

        let composed = compose_cover(Some(&dir), &paths);
        assert!(composed.is_some(), "cover composition failed");

        let decoded = image::load_from_memory(&composed.unwrap()).unwrap();
        assert_eq!(decoded.width(), COVER_CELL * 2);
        assert_eq!(decoded.height(), COVER_CELL * 2);
    }
}
