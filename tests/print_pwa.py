"""Run from repository root after npm run build.

Install Playwright and pypdf, then run playwright install chromium.
An optional CHROMIUM_EXECUTABLE overrides the browser used by Playwright.
"""
import base64
import hashlib
import http.client
import os
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from io import BytesIO

from pypdf import PdfReader
from playwright.sync_api import sync_playwright


def unused_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


class Proxy(BaseHTTPRequestHandler):
    def do_GET(self):
        self.forward()

    def do_POST(self):
        self.forward()

    def forward(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.upstream, timeout=5)
        try:
            headers = dict(self.headers)
            headers["X-Forwarded-Proto"] = "https"
            headers["Connection"] = "close"
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            connection.request(self.command, self.path, body, headers)
            output = connection.getresponse()
            data = output.read()
        finally:
            connection.close()
        self.send_response(output.status)
        for key, value in output.getheaders():
            if key.lower() not in {"connection", "transfer-encoding", "content-length"}:
                self.send_header(key, value)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_):
        pass


def verify(browser, origin):
    context = browser.new_context(viewport={"width": 1440, "height": 900})
    page = context.new_page()
    page.set_default_timeout(8000)
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(origin + "/?autostart=1", wait_until="domcontentloaded")
    page.wait_for_function("() => Boolean(navigator.serviceWorker.controller)")
    print("Service Worker controls the production page", flush=True)
    assert page.locator("html").get_attribute("dir") == "rtl"
    assert page.evaluate("() => fetch('/manifest.webmanifest').then(response => response.json())")["display"] == "standalone"
    assert page.evaluate("() => fetch('/api/health').then(response => response.headers.get('strict-transport-security'))")
    page.get_by_label("تبديل الوضع الداكن والفاتح").click()
    assert page.locator("html").evaluate("node => node.classList.contains('dark')")
    page.get_by_label("القائمة الرئيسية").get_by_role("button", name="الطلبات والتأييد").click()
    actions = page.get_by_role("button", name="المستندات الرسمية وكشف التأييد (A4)")
    assert actions.count() >= 2
    page.locator("#root").evaluate("node => node.append(Object.assign(document.createElement('p'), {textContent: 'UNRELATED_PRIVATE_REQUEST'}))")
    actions.first.click()
    container = page.locator(".official-document-print")
    container.wait_for()
    page.emulate_media(media="print")
    assert page.locator("#root").evaluate("node => getComputedStyle(node).display") == "none"
    for mode, expected_pages in [("الحزمة الكاملة", 3), ("نموذج الطلب الرسمي", 1), ("كشف التأييد الإلكتروني", 1), ("صفحات التوقيعات اليدوية", 1)]:
        page.emulate_media(media="screen")
        container.get_by_role("button", name=mode).click()
        page.emulate_media(media="print")
        page.wait_for_function(f"() => document.querySelectorAll('.print-page-a4').length === {expected_pages}")
        print("Checking PDF mode", mode, flush=True)
        pdf = PdfReader(BytesIO(page.pdf(prefer_css_page_size=True)))
        text = "".join(item.extract_text() for item in pdf.pages)
        assert "UNRELATED_PRIVATE_REQUEST" not in text
        assert len(pdf.pages) == expected_pages and len(text) > 80, (mode, len(pdf.pages))
    page.emulate_media(media="screen")
    page.set_viewport_size({"width": 390, "height": 844})
    page.goto(origin + "/?autostart=1", wait_until="domcontentloaded")
    page.get_by_label("تنقل الهاتف").wait_for()
    assert page.evaluate("document.documentElement.scrollWidth") == 390
    assert not errors, errors
    context.close()


def main():
    with tempfile.TemporaryDirectory(prefix="campus-browser-") as folder:
        location = Path(folder)
        certificate = location / "test.pem"
        private_key = location / "test.key"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                        "-subj", "/CN=localhost", "-days", "1", "-keyout", str(private_key),
                        "-out", str(certificate)], check=True, capture_output=True)
        with ThreadingHTTPServer(("127.0.0.1", 0), Proxy) as proxy:
            proxy.upstream = unused_port()
            origin = f"https://127.0.0.1:{proxy.server_port}"
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls.load_cert_chain(certificate, private_key)
            proxy.socket = tls.wrap_socket(proxy.socket, server_side=True)
            threading.Thread(target=proxy.serve_forever, daemon=True).start()
            env = dict(os.environ, NODE_ENV="production", DBL_ALLOW_DEMO="true",
                       DBL_DATA_DIR=str(location / "data"), DBL_DB_PATH=str(location / "campus.sqlite"),
                       DBL_UPLOADS_DIR=str(location / "uploads"), DBL_RELEASES_DIR=str(location / "releases"),
                       DBL_FORCE_HTTPS="true", TRUST_PROXY="loopback", APP_URL=origin, DBL_SKIP_LISTEN="0",
                       PORT=str(proxy.upstream))
            server = subprocess.Popen(["node", "--import", "tsx", "server.ts"], env=env)
            try:
                for _ in range(60):
                    try:
                        urllib.request.urlopen(f"http://127.0.0.1:{proxy.upstream}/api/health", timeout=1).close()
                        break
                    except OSError:
                        if server.poll() is not None:
                            raise RuntimeError("Server exited during startup")
                        time.sleep(0.1)
                custom_browser = os.getenv("CHROMIUM_EXECUTABLE")
                key_der = subprocess.check_output(["openssl", "pkey", "-in", str(private_key), "-pubout", "-outform", "DER"])
                spki = base64.b64encode(hashlib.sha256(key_der).digest()).decode("ascii")
                flags = [f"--ignore-certificate-errors-spki-list={spki}"]
                if custom_browser:
                    flags.extend(["--no-sandbox", "--single-process", "--no-zygote", "--disable-gpu", "--disable-dev-shm-usage"])
                with sync_playwright() as engine:
                    browser = engine.chromium.launch(
                        executable_path=custom_browser,
                        args=flags
                    )
                    verify(browser, origin)
                    browser.close()
                    print("PASS: HTTPS, PWA, Arabic RTL, dark mode, isolated A4 PDFs and mobile viewport")
            finally:
                server.terminate()
                server.wait(timeout=15)
                proxy.shutdown()


if __name__ == "__main__":
    main()
