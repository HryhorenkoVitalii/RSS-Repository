/// Парсинг порта из строки stderr Chromium (`DevTools listening on ws://127.0.0.1:PORT/...`).
pub(super) fn parse_devtools_port(line: &str) -> Option<u16> {
    let needle = "127.0.0.1:";
    let i = line.find(needle)? + needle.len();
    let rest = &line[i..];
    let end = rest
        .char_indices()
        .find(|(_, c)| !c.is_ascii_digit())
        .map(|(i, _)| i)
        .unwrap_or(rest.len());
    rest[..end].parse().ok()
}

#[cfg(test)]
mod tests {
    use super::parse_devtools_port;

    #[test]
    fn parse_devtools_line() {
        let line = r#"DevTools listening on ws://127.0.0.1:38619/devtools/browser/abc"#;
        assert_eq!(parse_devtools_port(line), Some(38619));
    }

    #[test]
    fn parse_devtools_line_no_match() {
        assert_eq!(parse_devtools_port("random"), None);
    }
}
