//! Общие разборы MRSS (`media:group`, `media:thumbnail`, `media:content`) для Atom-фидов.

use atom_syndication::Entry;

/// Ссылка на запись: `rel="alternate"` или первая ссылка.
pub fn atom_entry_alternate_link(entry: &Entry) -> Option<String> {
    entry
        .links
        .iter()
        .find(|l| l.rel == "alternate" || l.rel.is_empty())
        .or_else(|| entry.links.first())
        .map(|l| l.href.clone())
        .filter(|s| !s.trim().is_empty())
}

/// URL, которые нельзя отдавать в `src` у нативного `<video>` (не прямой медиафайл / не играет в браузере).
pub fn mrss_video_src_unusable_in_native_video_tag(url: &str) -> bool {
    let u = url.to_ascii_lowercase();
    if u.contains("googlevideo.com") {
        return true;
    }
    // MRSS YouTube: `…/v/VIDEOID?version=3` + `type="application/x-shockwave-flash"` — не HLS/MP4.
    if u.contains("youtube.com/v/")
        || u.contains("youtube-nocookie.com/v/")
        || u.contains("music.youtube.com/v/")
    {
        return true;
    }
    // Иногда в `src` попадает страница watch — тоже не медиа.
    if u.contains("youtube.com/watch?") || u.contains("youtube.com/shorts/") {
        return true;
    }
    false
}

/// MRSS `media:content` — URL из групп и корня `media:content`.
pub fn mrss_media_content_urls(entry: &Entry) -> Vec<String> {
    let mut out = Vec::new();
    let push_from_contents =
        |contents: &[atom_syndication::extension::Extension], out: &mut Vec<String>| {
            for c in contents {
                if let Some(u) = c.attrs.get("url") {
                    let u = u.trim();
                    if u.starts_with("http://") || u.starts_with("https://") {
                        out.push(u.to_string());
                    }
                }
            }
        };

    for ns_map in entry.extensions.values() {
        if let Some(groups) = ns_map.get("group") {
            for group in groups {
                if let Some(contents) = group.children.get("content") {
                    push_from_contents(contents, &mut out);
                }
            }
        }
        if let Some(contents) = ns_map.get("content") {
            push_from_contents(contents, &mut out);
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Первый `media:thumbnail` в любом `media:group`.
pub fn mrss_thumbnail_url(entry: &Entry) -> Option<String> {
    for ns_map in entry.extensions.values() {
        if let Some(groups) = ns_map.get("group") {
            for group in groups {
                if let Some(thumbs) = group.children.get("thumbnail") {
                    for thumb in thumbs {
                        if let Some(u) = thumb.attrs.get("url") {
                            let u = u.trim();
                            if !u.is_empty() {
                                return Some(u.to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

/// Первый непустой текст из `media:<local_name>` внутри `media:group` (например `title`, `description`).
pub fn mrss_group_first_text_in_groups(entry: &Entry, local_name: &str) -> Option<String> {
    for ns_map in entry.extensions.values() {
        if let Some(groups) = ns_map.get("group") {
            for group in groups {
                if let Some(elems) = group.children.get(local_name) {
                    for el in elems {
                        if let Some(v) = &el.value {
                            let t = v.trim();
                            if !t.is_empty() {
                                return Some(v.clone());
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

/// Первый непустый `value` у дочернего элемента записи с локальным именем `local_name` (например `videoId` у `yt:videoId`).
pub fn atom_extension_first_value(entry: &Entry, local_name: &str) -> Option<String> {
    for ns_map in entry.extensions.values() {
        if let Some(exts) = ns_map.get(local_name) {
            for e in exts {
                if let Some(v) = &e.value {
                    let t = v.trim();
                    if !t.is_empty() {
                        return Some(v.clone());
                    }
                }
            }
        }
    }
    None
}

/// Добавляет в конец HTML теги `<video>` для проигрываемых MRSS URL (как в обычном Atom-пути).
pub fn append_mrss_native_video_tags(mut html: String, entry: &Entry) -> String {
    for u in mrss_media_content_urls(entry) {
        if html.contains(u.as_str()) {
            continue;
        }
        if mrss_video_src_unusable_in_native_video_tag(&u) {
            continue;
        }
        let src = html_escape::encode_double_quoted_attribute(&u);
        let vid = format!(
            r#"<p><video controls preload="metadata" playsinline src="{src}" style="max-width:100%;height:auto"></video></p>"#
        );
        html = if html.is_empty() {
            vid
        } else {
            format!("{html}{vid}")
        };
    }
    html
}
