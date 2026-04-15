//! Screenshot via Chrome DevTools Protocol: clip to main/article so centered layouts do not show huge side gutters.

mod capture_clip;
mod devtools;
mod rpc;

pub use capture_clip::capture_page_clip_png;
