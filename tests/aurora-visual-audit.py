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


def audit_live_dom_contrast(page, label: str) -> None:
    js = r"""() => {
    const parseColor = (str) => {
    if (!str || str === 'none' || str === 'transparent') return null;
    let m = str.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i);
    if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] !== undefined ? +m[4] : 1 };
    m = str.match(/^#([0-9a-f]{3,8})$/i);
    if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
    }
    return null;
    };
    const blend = (fg, bg) => {
    const a = fg.a;
    return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
    };
    const relLum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const contrast = (c1, c2) => {
    const l1 = relLum(c1), l2 = relLum(c2);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    const extractGradientColors = (bgImg) => {
    if (!bgImg || !bgImg.includes('gradient')) return [];
    const matches = bgImg.match(/rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}/g) || [];
    return matches.map(parseColor).filter(Boolean);
    };
    const getBgCandidates = (el) => {
    const chain = [];
    let cur = el;
    while (cur && cur.nodeType === 1) { chain.unshift(cur); cur = cur.parentElement; }
    let bgs = [{ r: 255, g: 255, b: 255, a: 1 }];
    for (const node of chain) {
    const st = window.getComputedStyle(node);
    const bgc = parseColor(st.backgroundColor);
    if (bgc && bgc.a > 0) bgs = bgs.map(b => blend(bgc, b));
    const stops = extractGradientColors(st.backgroundImage);
    if (stops.length > 0) {
    const next = [];
    for (const b of bgs) for (const s of stops) next.push(blend(s, b));
    bgs = next.slice(0, 16);
    }
    }
    return bgs;
    };
    const isVisible = (el) => {
    let cur = el;
    while (cur && cur.nodeType === 1) {
    const st = window.getComputedStyle(cur);
    if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) return false;
    cur = cur.parentElement;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
    };
    const failures = [];
    const els = document.querySelectorAll('body *');
    for (const el of els) {
    if (!isVisible(el)) continue;
    const st = window.getComputedStyle(el);
    const tag = el.tagName.toLowerCase();
    const inZone = !!el.closest('header, nav, .aurora-hero');
    const isSvg = tag === 'svg';
    const isInteractive = ['button', 'a', 'input', 'select', 'textarea'].includes(tag) || el.getAttribute('role') === 'button';
    const hasDirectText = Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim().length > 0);
    if (!hasDirectText && !(inZone && (isSvg || isInteractive))) continue;
    let fg = parseColor(st.color);
    if (isSvg) {
    const fill = parseColor(st.fill);
    const stroke = parseColor(st.stroke);
    if (fill && fill.a > 0) fg = fill;
    else if (stroke && stroke.a > 0) fg = stroke;
    }
    if (!fg || fg.a === 0) continue;
    const fs = parseFloat(st.fontSize) || 16;
    const fw = parseInt(st.fontWeight, 10) || (st.fontWeight === 'bold' ? 700 : 400);
    const isLarge = fs >= 24 || (fs >= 18.66 && fw >= 700);
    const req = (!hasDirectText && (isSvg || isInteractive)) || isLarge ? 3.0 : 4.5;
    const bgs = getBgCandidates(el);
    let minRatio = Infinity, worstBg = bgs[0];
    for (const bg of bgs) {
    const effFg = fg.a < 1 ? blend(fg, bg) : fg;
    const r = contrast(effFg, bg);
    if (r < minRatio) { minRatio = r; worstBg = bg; }
    }
    if (minRatio < req) {
    const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    const cls = (el.className && typeof el.className === 'string') ? el.className.trim().slice(0, 40) : '';
    failures.push(`${tag}#${el.id || ''}.${cls} "${txt}" fg=rgb(${Math.round(fg.r)},${Math.round(fg.g)},${Math.round(fg.b)}) bg=rgb(${Math.round(worstBg.r)},${Math.round(worstBg.g)},${Math.round(worstBg.b)}) ratio=${minRatio.toFixed(2)} < ${req}`);
    }
    }
    return failures;
    }"""
    failures = page.evaluate(js)
    if failures:
        raise AssertionError(f"Live DOM WCAG AA contrast failed [{label}]:\n" + "\n".join(failures))
    print(f"[WCAG AA LIVE DOM] {label}: OK")

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
                    audit_live_dom_contrast(page, "01-login-light-desktop")

                    ctx_mobile = browser.new_context(viewport={"width": 390, "height": 844})
                    m_page = ctx_mobile.new_page()
                    m_page.goto(BASE_URL, wait_until="networkidle")
                    set_theme(m_page, True)
                    assert_no_horizontal_overflow(m_page, "02-login-dark-mobile")
                    m_page.screenshot(path=str(SCREENSHOT_DIR / "02-login-dark-mobile.png"), full_page=True)
                    audit_live_dom_contrast(m_page, "02-login-dark-mobile")
                    ctx_mobile.close()

                    login_demo(page)
                    set_theme(page, False)
                    page.screenshot(path=str(SCREENSHOT_DIR / "03-dashboard-light-desktop.png"), full_page=True)
                    audit_live_dom_contrast(page, "03-dashboard-light-desktop")
                    set_theme(page, True)
                    page.screenshot(path=str(SCREENSHOT_DIR / "04-dashboard-dark-desktop.png"), full_page=True)
                    audit_live_dom_contrast(page, "04-dashboard-dark-desktop")

                    page.set_viewport_size({"width": 390, "height": 844})
                    set_theme(page, False)
                    assert_no_horizontal_overflow(page, "05-dashboard-light-mobile")
                    page.screenshot(path=str(SCREENSHOT_DIR / "05-dashboard-light-mobile.png"), full_page=True)
                    audit_live_dom_contrast(page, "05-dashboard-light-mobile")
                    set_theme(page, True)
                    assert_no_horizontal_overflow(page, "06-dashboard-dark-mobile")
                    page.screenshot(path=str(SCREENSHOT_DIR / "06-dashboard-dark-mobile.png"), full_page=True)
                    audit_live_dom_contrast(page, "06-dashboard-dark-mobile")
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
