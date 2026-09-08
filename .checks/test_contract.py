from __future__ import annotations

import json
import threading
import unittest
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from playwright.sync_api import Page, Route, sync_playwright


API_URL = "https://adsinfra.io/api/leads/satellite"
ROOT = Path(__file__).resolve().parents[1]
SUCCESS_COPY = "Thanks — we’ll review your request and reply by email."


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        return


class HomepageContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ThreadingHTTPServer(
            ("127.0.0.1", 0),
            lambda *args, **kwargs: QuietHandler(*args, directory=str(ROOT), **kwargs),
        )
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server.server_close()
        cls.server_thread.join(timeout=2)

    def open_page(self, *, search_ops: str | None = None) -> Page:
        page = self.browser.new_page()
        # Keep smoke tests from sending events to production analytics.
        page.route(
            "https://search-ops-beacon.aria-24d.workers.dev/analytics/v2.js",
            lambda route: route.abort(),
        )
        if search_ops is not None:
            page.add_init_script(search_ops)
        page.goto(
            f"{self.base_url}/index.html?utm_source=test&utm_medium=browser&utm_campaign=contract",
            wait_until="domcontentloaded",
        )
        page.locator("#contact-form").wait_for(state="visible")
        return page

    @staticmethod
    def fill_form(page: Page, *, message: str = "Please review our current setup.") -> None:
        page.locator("input[name='email']").fill("operator@example.com")
        page.locator("input[name='company']").fill("Example Finance")
        page.locator("select[name='need']").select_option("new_setup")
        page.locator("textarea[name='message']").fill(message)

    @staticmethod
    def submit(page: Page) -> None:
        page.get_by_role("button", name="Request review").click()

    @staticmethod
    def wait_for_status(page: Page, text: str) -> None:
        page.wait_for_function(
            "expected => document.querySelector('#contact-status')?.textContent.includes(expected)",
            arg=text,
            timeout=3000,
        )


    def route_responses(
        self, page: Page, responses: list[tuple[str, int, dict[str, Any] | None]]
    ) -> list[dict[str, Any]]:
        requests: list[dict[str, Any]] = []

        origin = page.url.split("/", 3)[:3]
        origin = "/".join(origin)

        def handle(route: Route) -> None:
            cors_headers = {
                "Access-Control-Allow-Origin": origin,
                "Access-Control-Allow-Methods": "POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type",
            }
            if route.request.method == "OPTIONS":
                route.fulfill(status=204, headers=cors_headers)
                return
            requests.append(json.loads(route.request.post_data or "{}"))
            action, status, payload = responses.pop(0)
            if action == "abort":
                route.abort(error_code="failed")
                return
            route.fulfill(
                status=status,
                headers=cors_headers,
                content_type="application/json",
                body=json.dumps(payload),
            )

        page.route(API_URL, handle)
        return requests

    def test_failure_and_null_responses_never_show_success(self) -> None:
        page = self.open_page()
        requests = self.route_responses(
            page,
            [
                ("respond", 500, {"error": "temporary failure"}),
                ("respond", 202, {"completion_id": None}),
                ("respond", 201, {"ok": True, "completion_id": "11111111-1111-4111-8111-111111111111", "already_completed": True}),
                ("respond", 200, {"ok": True, "completion_id": "11111111-1111-4111-8111-111111111111", "already_completed": False}),
            ],
        )
        self.fill_form(page)
        self.submit(page)
        self.wait_for_status(page, "couldn’t send")
        self.assertNotIn("Thanks", page.locator("#contact-status").inner_text())
        self.assertEqual(page.locator("input[name='email']").input_value(), "operator@example.com")
        self.assertEqual(page.locator("textarea[name='message']").input_value(), "Please review our current setup.")
        self.assertFalse(page.get_by_role("button", name="Request review").is_disabled())
        self.assertEqual(page.locator("#contact-status").get_attribute("role"), "status")

        with page.expect_response(API_URL):
            self.submit(page)
        self.wait_for_status(page, "couldn’t send")
        self.assertNotIn("Thanks", page.locator("#contact-status").inner_text())
        self.assertEqual(len(requests), 2)
        for _ in range(2):
            with page.expect_response(API_URL):
                self.submit(page)
            self.wait_for_status(page, "couldn’t send")
            self.assertEqual(page.locator("input[name='email']").input_value(), "operator@example.com")
        page.close()

    def test_no_javascript_keeps_submit_disabled_and_whatsapp_available(self) -> None:
        page = self.browser.new_page(java_script_enabled=False)
        page.goto(self.base_url + "/index.html", wait_until="domcontentloaded")
        self.assertTrue(page.locator("#contact-form button[type=submit]").is_disabled())
        self.assertTrue(page.locator("noscript a[href='https://wa.me/15083103096']").is_visible())
        page.close()

    def test_ambiguous_retry_reuses_frozen_id_and_body(self) -> None:
        page = self.open_page()
        requests = self.route_responses(
            page,
            [
                ("abort", 0, None),
                ("respond", 201, {"ok": True, "completion_id": "11111111-1111-4111-8111-111111111111", "already_completed": False}),
            ],
        )
        self.fill_form(page)
        self.submit(page)
        self.wait_for_status(page, "couldn’t send")
        self.submit(page)
        self.wait_for_status(page, SUCCESS_COPY)
        self.assertEqual(requests[0], requests[1])
        page.close()

    def test_editing_after_ambiguous_result_creates_new_submission_id(self) -> None:
        page = self.open_page()
        requests = self.route_responses(
            page,
            [
                ("abort", 0, None),
                ("respond", 201, {"ok": True, "completion_id": "22222222-2222-4222-8222-222222222222", "already_completed": False}),
            ],
        )
        self.fill_form(page, message="Original context")
        self.submit(page)
        self.wait_for_status(page, "couldn’t send")
        page.locator("textarea[name='message']").fill("Edited context")
        self.submit(page)
        self.wait_for_status(page, SUCCESS_COPY)
        self.assertNotEqual(requests[0]["submission_id"], requests[1]["submission_id"])
        self.assertNotEqual(requests[0]["message"], requests[1]["message"])
        page.close()

    def test_new_success_and_replay_acknowledge_without_browser_lead_events(self) -> None:
        page = self.open_page(
            search_ops="window.searchOps = { track: event => { window.__leadEvents = (window.__leadEvents || []).concat(event); } };"
        )
        requests = self.route_responses(
            page,
            [
                ("respond", 201, {"ok": True, "completion_id": "33333333-3333-4333-8333-333333333333", "already_completed": False}),
                ("respond", 200, {"ok": True, "completion_id": "33333333-3333-4333-8333-333333333333", "already_completed": True}),
            ],
        )
        self.fill_form(page)
        self.submit(page)
        self.wait_for_status(page, SUCCESS_COPY)
        self.assertRegex(
            requests[0]["submission_id"],
            r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
        )
        self.assertEqual(
            {key: value for key, value in requests[0].items() if key != "submission_id"},
            {
                "email": "operator@example.com",
                "company": "Example Finance",
                "need": "new_setup",
                "message": "Please review our current setup.",
                "website": "",
                "source_path": "/index.html",
                "referrer_host": "",
                "attribution": {
                    "utm_source": "test",
                    "utm_medium": "browser",
                    "utm_campaign": "contract",
                    "utm_content": "",
                    "utm_term": "",
                },
                "form_variant": "contact_form_v1",
            },
        )
        with page.expect_response(API_URL):
            self.submit(page)
        self.wait_for_status(page, SUCCESS_COPY)
        self.assertEqual(requests[0]["submission_id"], requests[1]["submission_id"])
        self.assertEqual(page.evaluate("window.__leadEvents || []"), [])
        page.close()


    def test_whatsapp_secondary_path_is_retained(self) -> None:
        page = self.open_page()
        whatsapp = page.locator("a[href*='wa.me/15083103096']")
        self.assertGreaterEqual(whatsapp.count(), 1)
        self.assertTrue(whatsapp.first.is_visible())
        self.assertIn("wa.me/15083103096", whatsapp.first.get_attribute("href") or "")
        page.close()


if __name__ == "__main__":
    unittest.main()
