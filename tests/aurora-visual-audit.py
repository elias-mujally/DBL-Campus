import os
import pathlib
import subprocess
import sys
import tempfile
import time
import urllib.request
from playwright.sync_api import sync_playwright

BASE_URL = "http://" + "127.0.0.1:3998"
SCREENSHOT_DIR = pathlib.Path("aurora-screenshots")


def hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    value = hex_color.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))


def relative_luminance(hex_color: str) -> float:
    def channel(c: int) -> float:
        s = c / 255.0
        return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4

    r, g, b = hex_to_rgb(hex_color)
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def contrast_ratio(fg: str, bg: str) -> float:
    l1 = relative_luminance(fg)
    l2 = relative_luminance(bg)
    lighter, darker = max(l1, l2), min(l1, l2)
    return (lighter + 0.05) / (darker + 0.05)


def verify_wcag_aa() -> None:
    pairs = [
        ("light text on bg", "#25234D", "#EEEDF8"),
        ("light text on surface", "#25234D", "#FFFFFF"),
        ("light text on surface-elevated", "#25234D", "#FAF9FE"),
        ("light text-secondary on bg", "#4B4870", "#EEEDF8"),
        ("light text-secondary on surface", "#4B4870", "#FFFFFF"),
        ("light violet on surface", "#635BDB", "#FFFFFF"),
        ("light violet-hover on bg", "#5148C8", "#EEEDF8"),
        ("light teal-text on surface", "#0F766E", "#FFFFFF"),
        ("light teal-text on bg", "#0F766E", "#EEEDF8"),
        ("light amber-text on surface", "#92400E", "#FFFFFF"),
        ("light success on surface", "#15803D", "#FFFFFF"),
        ("light danger on surface", "#B91C1C", "#FFFFFF"),
        ("light info on surface", "#1D4ED8", "#FFFFFF"),
        ("white on indigo", "#FFFFFF", "#25234D"),
        ("white on violet", "#FFFFFF", "#635BDB"),
        ("dark text on bg", "#F1F0FB", "#121126"),
        ("dark text on surface", "#F1F0FB", "#1A1836"),
        ("dark text on surface-elevated", "#F1F0FB", "#222046"),
        ("dark text-secondary on bg", "#C8C5E6", "#121126"),
        ("dark text-secondary on surface", "#C8C5E6", "#1A1836"),
        ("dark text-secondary on surface-elevated", "#C8C5E6", "#222046"),
        ("dark teal-text on bg", "#2DD4BF", "#121126"),
        ("dark teal-text on surface", "#2DD4BF", "#1A1836"),
        ("dark amber-text on bg", "#FBBF24", "#121126"),
        ("dark success on bg", "#4ADE80", "#121126"),
        ("dark danger on bg", "#F87171", "#121126"),
        ("dark info on bg", "#60A5FA", "#121126"),
    ]
    failures = []
    for label, fg, bg in pairs:
        ratio = contrast_ratio(fg, bg)
        print(f"[WCAG AA] {label}: {fg} on {bg} -> {ratio:.2f}:1")
        if ratio < 4.5:
            failures.append(f"{label} ({ratio:.2f}:1 < 4.5:1)")
    if failures:
        raise AssertionError("WCAG AA contrast check failed: " + ", ".join(failures))


def wait_for_server(url: str, timeout: float = 30.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                if resp.status < 500:
                    return
        except Exception:
            time.sleep(0.5)
    raise RuntimeError(f"Server did not become ready at {url} within {timeout}s")


def set_theme(page, dark: bool) -> None:
    page.evaluate(
        """(isDark) => {
            document.documentElement.classList.toggle('dark', isDark);
            try { localStorage.setItem('theme', isDark ? 'dark' : 'light'); } catch (e) {}
        }""",
        dark,
    )
    page.wait_for_timeout(300)


def assert_no_horizontal_overflow(page, label: str) -> None:
    metrics = page.evaluate(
        "() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })"
    )
    sw, cw = metrics["scrollWidth"], metrics["clientWidth"]
    assert sw <= cw + 1, f"{label}: horizontal overflow detected (scrollWidth={sw} > clientWidth={cw})"


def login_demo(page) -> None:
    resp = page.request.post(f"{BASE_URL}/api/auth/demo-login", data={})
    if not resp.ok:
        resp = page.request.post(f"{BASE_URL}/api/auth/demo-login", data={"role": "admin"})
    if resp.ok:
        page.goto(BASE_URL, wait_until="networkidle")
        return
    demo_btn = page.locator("button:has-text('Demo'), button:has-text('تجريبي')").first
    demo_btn.click()
    page.wait_for_load_state("networkidle")


def main() -> None:
    verify_wcag_aa()
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="dbl-aurora-audit-") as tmpdir:
        tmp = pathlib.Path(tmpdir)
        env = dict(
            os.environ,
            NODE_ENV="development",
            DBL_ALLOW_DEMO="true",
            DBL_FORCE_HTTPS="false",
            DISABLE_HMR="true",
            DBL_DATA_DIR=str(tmp / "data"),
            DBL_DB_PATH=str(tmp / "campus.sqlite"),
            DBL_UPLOADS_DIR=str(tmp / "uploads"),
            DBL_RELEASES_DIR=str(tmp / "releases"),
            DBL_SESSION_SECRET="aurora-visual-audit-test-secret-0123456789",
            SESSION_SECRET="aurora-visual-audit-test-secret-0123456789",
            DBL_SKIP_LISTEN="0",
            PORT="3998",
        )
        server = subprocess.Popen(["node", "--import", "tsx", "server.ts"], env=env)
        try:
            wait_for_server(BASE_URL)
            with sync_playwright() as p:
                browser = p.chromium.launch()
                try:
                    ctx_desktop = browser.new_context(viewport={"width": 1440, "height": 900})
                    page = ctx_desktop.new_page()
                    page.goto(BASE_URL, wait_until="networkidle")
                    set_theme(page, False)
                    page.screenshot(path=str(SCREENSHOT_DIR / "01-login-light-desktop.png"), full_page=True)

                    ctx_mobile = browser.new_context(viewport={"width": 390, "height": 844})
                    m_page = ctx_mobile.new_page()
                    m_page.goto(BASE_URL, wait_until="networkidle")
                    set_theme(m_page, True)
                    assert_no_horizontal_overflow(m_page, "02-login-dark-mobile")
                    m_page.screenshot(path=str(SCREENSHOT_DIR / "02-login-dark-mobile.png"), full_page=True)
                    ctx_mobile.close()

                    login_demo(page)
                    set_theme(page, False)
                    page.screenshot(path=str(SCREENSHOT_DIR / "03-dashboard-light-desktop.png"), full_page=True)
                    set_theme(page, True)
                    page.screenshot(path=str(SCREENSHOT_DIR / "04-dashboard-dark-desktop.png"), full_page=True)

                    page.set_viewport_size({"width": 390, "height": 844})
                    set_theme(page, False)
                    assert_no_horizontal_overflow(page, "05-dashboard-light-mobile")
                    page.screenshot(path=str(SCREENSHOT_DIR / "05-dashboard-light-mobile.png"), full_page=True)
                    set_theme(page, True)
                    assert_no_horizontal_overflow(page, "06-dashboard-dark-mobile")
                    page.screenshot(path=str(SCREENSHOT_DIR / "06-dashboard-dark-mobile.png"), full_page=True)
                    ctx_desktop.close()
                finally:
                    browser.close()
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=5)


if __name__ == "__main__":
    main()
