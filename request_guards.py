"""Request safety helpers for ComfyUI-Drawer HTTP routes."""

from urllib.parse import urlparse

from aiohttp import web


def _host_without_default_port(value):
    parsed = urlparse("//" + str(value or ""))
    host = (parsed.hostname or "").lower()
    port = parsed.port
    if port is None:
        return host
    return f"{host}:{port}"


def _source_host(value):
    parsed = urlparse(str(value or ""))
    if not parsed.scheme or not parsed.netloc:
        return ""
    host = (parsed.hostname or "").lower()
    port = parsed.port
    if port is None:
        return host
    return f"{host}:{port}"


def require_same_origin(request):
    """Reject browser cross-origin state-changing requests.

    ComfyUI has its own origin middleware, but Drawer mutates local files and
    sidecars. Keeping this check local makes the extension safer when ComfyUI is
    LAN-exposed or launched with custom CORS settings.
    """
    sec_fetch_site = request.headers.get("Sec-Fetch-Site", "").lower()
    if sec_fetch_site in ("cross-site", "none"):
        raise web.HTTPForbidden(text="Cross-origin request denied")

    host = _host_without_default_port(request.headers.get("Host", ""))
    if not host:
        return

    source = request.headers.get("Origin") or request.headers.get("Referer")
    if not source:
        return

    source_host = _source_host(source)
    if source_host and source_host != host:
        raise web.HTTPForbidden(text="Cross-origin request denied")
