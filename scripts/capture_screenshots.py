#!/usr/bin/env python3
"""Capture shareable BBL feature screenshots."""

import os
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BBL_URL", "http://localhost:5099")
OUT = Path(__file__).resolve().parent.parent / "screenshots" / "share"
OUT.mkdir(parents=True, exist_ok=True)

VIEWPORT = {"width": 1280, "height": 900}


def scroll_to_league(page):
    page.evaluate(
        "window.scrollTo(0, document.getElementById('league-section').offsetTop - 24)"
    )


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport=VIEWPORT, device_scale_factor=2)
    page.goto(BASE)
    page.wait_for_timeout(900)

    print(f"Saving to {OUT}/")

    page.evaluate("window.scrollTo(0, 0)")
    page.wait_for_timeout(300)
    page.screenshot(path=str(OUT / "01-hero.png"))
    print("  01-hero.png")

    scroll_to_league(page)
    page.evaluate("switchTab('open')")
    page.wait_for_timeout(500)
    page.locator("#league-section").screenshot(path=str(OUT / "05-league-open-requests.png"))
    print("  05-league-open-requests.png")

    page.evaluate(
        "window.scrollTo(0, document.getElementById('players-section').offsetTop - 24)"
    )
    page.wait_for_timeout(300)
    page.evaluate("openCardZoom(1)")
    page.wait_for_selector("#card-zoom-overlay.visible", timeout=5000)
    page.wait_for_timeout(400)
    page.locator(".card-zoom-content").screenshot(
        path=str(OUT / "06-player-card-record.png")
    )
    print("  06-player-card-record.png")

    browser.close()

print("Done.")
