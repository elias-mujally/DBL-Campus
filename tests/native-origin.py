"""Check packaged API routing with a synthetic Capacitor browser and old local settings."""
import functools
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

expected = "https://campus.example.net"
handler = functools.partial(SimpleHTTPRequestHandler, directory="dist")
with ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with sync_playwright() as playwright:
        chromium = os.getenv("CHROMIUM_EXECUTABLE")
        flags = ["--no-sandbox", "--single-process", "--no-zygote"] if chromium else []
        browser = playwright.chromium.launch(executable_path=chromium, args=flags)
        page = browser.new_page()
        page.add_init_script("""
          window.Capacitor = { isNativePlatform: () => true };
          localStorage.setItem('dbl_campus_server_url', 'https://localhost');
        """)
        page.route(expected + "/api/**", lambda route: route.fulfill(
            json={"hasProductionRepresentative": True, "demoAccounts": [], "demoEnabled": False},
            headers={"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type",
                     "Access-Control-Allow-Methods": "GET, OPTIONS"}))
        origin = f"http://127.0.0.1:{server.server_port}"
        requests = []
        page.on("request", lambda request: requests.append(request.url))
        with page.expect_response(lambda response: response.url == expected + "/api/auth/status" and response.request.method == "GET") as connection:
            page.goto(origin, wait_until="domcontentloaded")
        assert connection.value.ok
        assert all("/api/" not in url or url.startswith(expected + "/") for url in requests)
        assert page.evaluate("() => navigator.serviceWorker.getRegistrations().then(items => items.length)") == 0
        browser.close()
        print("Native API origin overrides stale local settings and does not register a service worker")
    server.shutdown()
