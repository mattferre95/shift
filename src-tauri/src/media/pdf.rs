//! Local PDF import/export through macOS PDFKit. No external executable or
//! network service is required; PDF pages are rasterized at 144 dpi for the
//! existing image batch converter.

use crate::errors::{Result, ShiftError};
use std::ffi::{c_char, CString};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const MAX_PAGES: usize = 200;

extern "C" {
    fn shift_pdf_info(source: *const c_char, pages: *mut usize) -> i32;
    fn shift_pdf_render(source: *const c_char, folder: *const c_char, count: usize) -> i32;
    fn shift_images_to_pdf(
        sources: *const *const c_char,
        count: usize,
        destination: *const c_char,
    ) -> i32;
}

fn path_arg(path: &Path) -> Result<CString> {
    CString::new(path.to_string_lossy().as_bytes())
        .map_err(|_| ShiftError::validation("That filename contains an invalid character."))
}

fn native_error(code: i32, action: &str) -> ShiftError {
    match code {
        1 => ShiftError::new(
            "unreadable_pdf",
            format!("SHIFT couldn't read the {action} source."),
        )
        .hint("The file may be damaged or in an unsupported format."),
        2 => ShiftError::new("locked_pdf", "This PDF is password protected.")
            .hint("Unlock it in Preview before importing it."),
        3 => ShiftError::new("pdf_size", "This PDF has too many or oversized pages."),
        _ => ShiftError::new("pdf_failed", format!("SHIFT couldn't {action} the PDF."))
            .technical(format!("macOS PDFKit returned {code}")),
    }
}

pub fn page_count(source: &Path) -> Result<usize> {
    let source = path_arg(source)?;
    let mut pages = 0;
    let code = unsafe { shift_pdf_info(source.as_ptr(), &mut pages) };
    if code != 0 {
        return Err(native_error(code, "PDF"));
    }
    if pages > MAX_PAGES {
        return Err(ShiftError::new(
            "pdf_page_limit",
            format!("This PDF has more than {MAX_PAGES} pages."),
        )
        .hint("Split it into smaller PDFs first."));
    }
    Ok(pages)
}

pub fn render_pages(source: &Path, directory: &Path, count: usize) -> Result<Vec<PathBuf>> {
    let source = path_arg(source)?;
    let directory_arg = path_arg(directory)?;
    let code = unsafe { shift_pdf_render(source.as_ptr(), directory_arg.as_ptr(), count) };
    if code != 0 {
        return Err(native_error(code, "render"));
    }
    let pages = (1..=count)
        .map(|index| directory.join(format!("page-{index:04}.png")))
        .collect::<Vec<_>>();
    if pages.iter().any(|path| !path.is_file()) {
        return Err(ShiftError::new(
            "pdf_failed",
            "SHIFT couldn't render every PDF page.",
        ));
    }
    Ok(pages)
}

pub fn create_from_images(sources: &[PathBuf], destination: &Path) -> Result<()> {
    if sources.is_empty() || sources.len() > MAX_PAGES {
        return Err(ShiftError::validation(format!(
            "Choose between 1 and {MAX_PAGES} images."
        )));
    }
    let source_args = sources
        .iter()
        .map(|path| path_arg(path))
        .collect::<Result<Vec<_>>>()?;
    let pointers = source_args
        .iter()
        .map(|arg| arg.as_ptr())
        .collect::<Vec<_>>();
    let destination = path_arg(destination)?;
    let code =
        unsafe { shift_images_to_pdf(pointers.as_ptr(), pointers.len(), destination.as_ptr()) };
    if code != 0 {
        return Err(native_error(code, "create"));
    }
    Ok(())
}

/// PDF imports remain available for retries in the current session. Crashed
/// sessions are covered by the existing 24-hour temp-directory pruning.
#[derive(Default)]
pub struct PdfCacheRegistry(Mutex<Vec<PathBuf>>);

impl PdfCacheRegistry {
    pub fn register(&self, path: PathBuf) {
        self.0.lock().unwrap().push(path);
    }
    pub fn clear(&self) {
        for path in self.0.lock().unwrap().drain(..) {
            let _ = std::fs::remove_dir_all(path);
        }
    }
}

pub fn png_dimensions(path: &Path) -> Result<(u32, u32)> {
    use std::io::Read;
    let mut file =
        std::fs::File::open(path).map_err(|e| ShiftError::io("open rendered page", e))?;
    let mut header = [0u8; 24];
    file.read_exact(&mut header)
        .map_err(|e| ShiftError::io("read rendered page", e))?;
    if &header[..8] != b"\x89PNG\r\n\x1a\n" || &header[12..16] != b"IHDR" {
        return Err(ShiftError::new(
            "pdf_failed",
            "SHIFT couldn't read a rendered PDF page.",
        ));
    }
    let width = u32::from_be_bytes(header[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(header[20..24].try_into().unwrap());
    if width == 0 || height == 0 {
        return Err(ShiftError::new(
            "pdf_failed",
            "A rendered PDF page is empty.",
        ));
    }
    Ok((width, height))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    #[test]
    fn two_images_become_two_rendered_pages_in_order() {
        let directory =
            std::env::temp_dir().join(format!("shift-pdf-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let red = directory.join("red.png");
        let blue = directory.join("blue.png");
        std::fs::write(&red, base64::engine::general_purpose::STANDARD.decode(
            "iVBORw0KGgoAAAANSUhEUgAAABQAAAAKCAIAAAA7N+mxAAAAFUlEQVR4nGP4z8BANiJf56jmEaMZADFExzl02osRAAAAAElFTkSuQmCC"
        ).unwrap()).unwrap();
        std::fs::write(&blue, base64::engine::general_purpose::STANDARD.decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAUCAIAAAA7jDsBAAAAFElEQVR4nGNgYPiPF41Kj0pTSRoAhxTHOcrHPKkAAAAASUVORK5CYII="
        ).unwrap()).unwrap();
        let pdf = directory.join("combined.pdf");
        create_from_images(&[red, blue], &pdf).unwrap();
        assert_eq!(page_count(&pdf).unwrap(), 2);
        let pages_dir = directory.join("pages");
        std::fs::create_dir(&pages_dir).unwrap();
        let pages = render_pages(&pdf, &pages_dir, 2).unwrap();
        let first = png_dimensions(&pages[0]).unwrap();
        let second = png_dimensions(&pages[1]).unwrap();
        assert!(
            first.0 > first.1,
            "first page should be landscape: {first:?}"
        );
        assert!(
            second.1 > second.0,
            "second page should be portrait: {second:?}"
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn refuses_empty_image_selection() {
        let error = create_from_images(&[], Path::new("/unused.pdf")).unwrap_err();
        assert_eq!(error.code, "validation");
    }
}
