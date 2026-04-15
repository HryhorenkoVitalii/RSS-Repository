//! Обрезка однотонного тёмного «хвоста» внизу PNG после скриншота.

use std::io::Cursor;

use image::{DynamicImage, ImageFormat};

fn footer_trim_max_rgb() -> u8 {
    std::env::var("SCREENSHOT_FOOTER_TRIM_MAX_RGB")
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .filter(|n: &u8| *n <= 90)
        .unwrap_or(48u8)
}

fn footer_trim_dark_ratio() -> f32 {
    std::env::var("SCREENSHOT_FOOTER_TRIM_DARK_RATIO")
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .filter(|r: &f32| (*r >= 0.85) && (*r <= 1.0))
        .unwrap_or(0.97f32)
}

fn footer_trim_enabled() -> bool {
    !matches!(
        std::env::var("SCREENSHOT_TRIM_SOLID_FOOTER").as_deref(),
        Ok("0") | Ok("false") | Ok("no") | Ok("off")
    )
}

fn row_is_mostly_dark(
    rgba: &image::RgbaImage,
    y: u32,
    iw: u32,
    max_rgb: u8,
    ratio: f32,
) -> bool {
    let need = ((iw as f32) * ratio).ceil().max(1.0) as u32;
    let mut dark = 0u32;
    for x in 0..iw {
        let p = rgba.get_pixel(x, y);
        if p[0] <= max_rgb && p[1] <= max_rgb && p[2] <= max_rgb {
            dark += 1;
        }
    }
    dark >= need
}

/// Срезать снизу строки, где почти все пиксели тёмные (фон под колонкой контента).
pub fn trim_solid_footer_png(png_bytes: &[u8]) -> Result<Vec<u8>, String> {
    if !footer_trim_enabled() {
        return Ok(png_bytes.to_vec());
    }

    let img = image::load_from_memory(png_bytes).map_err(|e| format!("PNG decode: {e}"))?;
    let rgba = img.to_rgba8();
    let (iw, ih) = rgba.dimensions();
    if ih < 24 || iw < 8 {
        return Ok(png_bytes.to_vec());
    }

    let max_rgb = footer_trim_max_rgb();
    let ratio = footer_trim_dark_ratio();
    let min_keep = (((ih as f32) * 0.12).ceil() as u32).max(48).min(ih);

    let mut bottom = ih;
    while bottom > min_keep {
        let y = bottom - 1;
        if !row_is_mostly_dark(&rgba, y, iw, max_rgb, ratio) {
            break;
        }
        bottom -= 1;
    }

    if bottom >= ih {
        return Ok(png_bytes.to_vec());
    }

    let cropped = image::imageops::crop_imm(&rgba, 0, 0, iw, bottom).to_image();
    let mut buf = Vec::new();
    DynamicImage::from(cropped)
        .write_to(&mut Cursor::new(&mut buf), ImageFormat::Png)
        .map_err(|e| format!("PNG encode: {e}"))?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use image::{ImageBuffer, ImageFormat, Rgba};

    use super::trim_solid_footer_png;

    fn encode_png(img: ImageBuffer<Rgba<u8>, Vec<u8>>) -> Vec<u8> {
        let mut buf = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut Cursor::new(&mut buf), ImageFormat::Png)
            .expect("png encode");
        buf
    }

    #[test]
    fn trim_noop_when_image_too_short() {
        let img = ImageBuffer::from_fn(10, 20, |_, _| Rgba([200u8, 200, 200, 255]));
        let buf = encode_png(img);
        let out = trim_solid_footer_png(&buf).expect("trim");
        assert_eq!(out.len(), buf.len());
    }

    #[test]
    fn trim_removes_uniform_dark_footer() {
        std::env::remove_var("SCREENSHOT_TRIM_SOLID_FOOTER");
        let w = 24u32;
        let h = 100u32;
        let split = 50u32;
        let img = ImageBuffer::from_fn(w, h, |_, y| {
            if y < split {
                Rgba([240u8, 240, 240, 255])
            } else {
                Rgba([8u8, 8, 8, 255])
            }
        });
        let buf = encode_png(img);
        let out = trim_solid_footer_png(&buf).expect("trim");
        assert!(
            out.len() < buf.len(),
            "expected footer bytes removed from PNG"
        );
        let decoded = image::load_from_memory(&out).expect("decode");
        assert_eq!(decoded.height(), split);
    }
}

