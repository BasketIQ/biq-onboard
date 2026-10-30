"""Public logo ingestion: bounded HTTPS, pinned public address, inert image data."""
import base64
import http.client
import ipaddress
import re
import socket
import ssl
import time
from urllib.parse import urlsplit, urljoin
from xml.etree import ElementTree as ET
from fastapi import HTTPException

MAX_BYTES = 512 * 1024


def image_data_uri(data: bytes, content_type: str) -> str:
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "logo image too large (max 512KB)")
    mime = content_type.split(";")[0].lower()
    signatures = {"image/png": data.startswith(b"\x89PNG\r\n\x1a\n"),
                  "image/jpeg": data.startswith(b"\xff\xd8\xff"),
                  "image/gif": data[:6] in (b"GIF87a", b"GIF89a"),
                  "image/webp": data[:4] == b"RIFF" and data[8:12] == b"WEBP"}
    if mime in ("image/svg", "image/svg+xml"):
        if re.search(br"<!DOCTYPE|<!ENTITY", data, re.I):
            raise HTTPException(415, "SVG declarations are not supported")
        try:
            root = ET.fromstring(data)
        except ET.ParseError:
            raise HTTPException(415, "invalid SVG")
        if root.tag.split("}")[-1] != "svg":
            raise HTTPException(415, "invalid SVG root")
        allowed = {"svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "defs", "linearGradient", "radialGradient", "stop", "clipPath", "title", "desc"}
        for element in root.iter():
            if element.tag.split("}")[-1] not in allowed:
                raise HTTPException(415, "unsupported active SVG content")
            for key, value in element.attrib.items():
                if key.split("}")[-1].lower().startswith("on") or re.search(r"href|style", key, re.I) or re.search(r"url\((?!#[a-zA-Z0-9_-]+\))|javascript:|data:|https?:", value, re.I):
                    raise HTTPException(415, "external or active SVG content is not allowed")
        data = ET.tostring(root, encoding="utf-8")
        mime = "image/svg+xml"
    elif not signatures.get(mime, False):
        raise HTTPException(415, "upload a valid PNG, JPEG, WebP, GIF or static SVG")
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def download_logo(url: str) -> tuple[bytes, str]:
    deadline = time.monotonic() + 15
    for redirects in range(4):
        parsed = urlsplit(url)
        try:
            valid = parsed.scheme == "https" and parsed.hostname and not parsed.username and not parsed.password and parsed.port in (None, 443)
        except ValueError:
            valid = False
        if not valid:
            raise HTTPException(400, "logo URL must be public HTTPS on port 443")
        try:
            records = socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM)
            addresses = [ipaddress.ip_address(r[4][0]) for r in records]
            if not addresses or any(not ip.is_global for ip in addresses):
                raise HTTPException(400, "logo URL must resolve to public addresses")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError()
            # Connect to the validated IP; preserve TLS hostname verification and Host.
            connection = http.client.HTTPSConnection(parsed.hostname, timeout=remaining)
            raw = socket.create_connection((str(addresses[0]), 443), timeout=remaining)
            try:
                connection.sock = ssl.create_default_context().wrap_socket(raw, server_hostname=parsed.hostname)
                connection.request("GET", parsed.path + ("?" + parsed.query if parsed.query else "") or "/", headers={"Accept": "image/*", "User-Agent": "BasketSpark-Identity/1.0"})
                response = connection.getresponse()
                if 300 <= response.status < 400:
                    location = response.getheader("Location")
                    if not location or redirects == 3:
                        raise HTTPException(400, "logo redirect limit exceeded")
                    url = urljoin(url, location)
                    continue
                if response.status != 200:
                    raise HTTPException(502, "logo download failed")
                data = response.read(MAX_BYTES + 1)
                if len(data) > MAX_BYTES:
                    raise HTTPException(413, "logo image too large (max 512KB)")
                return data, response.getheader("Content-Type", "")
            finally:
                connection.close()
                raw.close()
        except HTTPException:
            raise
        except (OSError, ValueError, http.client.HTTPException):
            raise HTTPException(502, "logo download unavailable; upload the image instead")
    raise HTTPException(502, "logo download failed")
