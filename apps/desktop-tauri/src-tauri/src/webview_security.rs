//! Native privilege and navigation limits for the shell's separate Host WebView.

use url::Url;

/// The Host is a desktop-owned HTTP listener on an explicit loopback port.
pub fn validate_host_url(url: &Url) -> Result<(), String> {
    if url.scheme() != "http"
        || !matches!(url.host_str(), Some("127.0.0.1") | Some("[::1]"))
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Desktop Host must use an explicit loopback HTTP origin".into());
    }
    Ok(())
}

/// Auth redirects and client routes stay on the exact Host origin, including port.
pub fn allows_host_navigation(host: &Url, target: &Url) -> bool {
    validate_host_url(host).is_ok()
        && target.origin() == host.origin()
        && target.username().is_empty()
        && target.password().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_owned_host_routes_and_rejects_other_origins() {
        let host = Url::parse("http://127.0.0.1:17890/login?token=fixture").unwrap();
        for target in [
            "http://127.0.0.1:17890/",
            "http://127.0.0.1:17890/session/example",
        ] {
            assert!(allows_host_navigation(&host, &Url::parse(target).unwrap()));
        }
        for target in [
            "http://127.0.0.1:17891/",
            "http://localhost:17890/",
            "https://127.0.0.1:17890/",
            "http://user@127.0.0.1:17890/",
            "https://example.com/",
            "tauri://localhost/shell.html",
            "javascript:alert(1)",
            "data:text/html,example",
            "file:///tmp/example.html",
        ] {
            assert!(
                !allows_host_navigation(&host, &Url::parse(target).unwrap()),
                "{target}"
            );
        }
    }

    #[test]
    fn refuses_unowned_boot_origins() {
        for target in [
            "http://127.0.0.1/",
            "http://localhost:17890/",
            "https://example.com:17890/",
            "http://user:password@127.0.0.1:17890/",
        ] {
            assert!(
                validate_host_url(&Url::parse(target).unwrap()).is_err(),
                "{target}"
            );
        }
        assert!(validate_host_url(&Url::parse("http://[::1]:17890/").unwrap()).is_ok());
    }
}
