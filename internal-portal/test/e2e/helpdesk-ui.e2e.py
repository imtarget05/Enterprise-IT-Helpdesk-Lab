"""UI e2e journeys cho IT Asset & Helpdesk Portal (W3 Task 6.4).

Vì sao là Playwright python thuần: webapp-testing skill chỉ định dùng script
python với `sync_playwright`, và `with_server.py` không đủ cho yêu cầu này —
nó `Popen(shell=True)` + `terminate()` (SIGTERM rơi vào `/bin/sh`, node mồ côi)
và chỉ poll cổng TCP chứ không poll `/api/health`. Vì vậy vòng đời server do
`scripts/test-ui-e2e.sh` tự quản lý; script này chỉ lo phần browser.

Nguyên tắc của journey:
  * không gọi network ngoài (Google Fonts và mọi origin khác bị chặn ở tầng
    `context.route`), nếu vẫn có request ngoài thì đó là defect phải fail;
  * token chỉ được nằm trong sessionStorage — không localStorage, không URL,
    không console;
  * anonymous ở lab mode KHÔNG được coi là tải thành công;
  * console error / pageerror / requestfailed = fail;
  * screenshot chỉ ghi dưới $QA_ROOT.
"""

import json
import os
import re
import sys
import urllib.error
import urllib.request

from playwright.sync_api import sync_playwright

BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:3000").rstrip("/")
QA_ROOT = os.environ.get("QA_ROOT", "")
AUTH_MODE = os.environ.get("AUTH_MODE", "legacy").lower()
TOKEN_KEY = "it-portal-token"
VIEWER = ("viewer", "qa-viewer-password")
ADMIN = ("admin", "qa-admin-password")

if not QA_ROOT:
    print("QA_ROOT chưa được set — screenshot sẽ không có chỗ lưu an toàn.")
    sys.exit(2)
SHOT_DIR = os.path.join(QA_ROOT, "screenshots", "w3-{}".format(AUTH_MODE))
os.makedirs(SHOT_DIR, exist_ok=True)

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print("  {} {}{}".format("PASS" if ok else "FAIL", name, " — " + detail if detail else ""))
    return bool(ok)


def same_origin(url):
    return url.startswith(BASE_URL)


PROTECTED_PATHS = ("/api/assets", "/api/tickets", "/api/dashboard/stats", "/api/licenses")


class Recorder:
    """Thu console / pageerror / requestfailed / request+response để assert.

    QUY TẮC (review Important 1): KHÔNG xoá danh sách nào giữa các journey.
    Mọi list đều tích luỹ suốt run; muốn soi một phase thì đánh dấu
    `mark_phase()` rồi assert bằng `assert_phase_clean()` (delta) — xoá list là
    cách làm mất bằng chứng ở phase trước, và chính bản RED cũ đã in ra
    `console errors : []` trong khi 4 journey đang lỗi.
    """

    def __init__(self, page):
        self.console_all = []      # (type, text) — MỌI loại, để dò rò token
        self.console_errors = []   # (type, text) chỉ loại error
        self.page_errors = []
        self.failed = []
        self.blocked = []
        self.requests = []
        self.responses = []        # (method, url, status, headers)
        self.marks = {}            # label -> (n_console_err, n_page_err, n_failed)
        page.on("console", lambda m: self._console(m))
        page.on("pageerror", lambda e: self.page_errors.append(str(e)))
        page.on("requestfailed", lambda r: self._request_failed(r))
        page.on("request", lambda r: self.requests.append(r))
        page.on("response", lambda r: self._response(r))

    def _console(self, msg):
        entry = (msg.type, msg.text)
        self.console_all.append(entry)
        if msg.type == "error":
            self.console_errors.append(entry)

    def _request_failed(self, request):
        failure = request.failure
        self.failed.append((request.url, failure))

    def _response(self, response):
        try:
            self.responses.append(
                (response.request.method, response.url, response.status, dict(response.headers))
            )
        except Exception:  # pragma: no cover - response đã bị đóng
            self.responses.append(("?", response.url, -1, {}))

    def api_calls(self, predicate=lambda path: True):
        return [(m, u, st, h) for m, u, st, h in self.responses if "/api/" in u and predicate(u)]

    def auth_headers(self):
        out = []
        for request in self.requests:
            if request.url.startswith(BASE_URL + "/api/"):
                try:
                    out.append((request.url, request.headers.get("authorization", "")))
                except Exception:  # pragma: no cover
                    out.append((request.url, ""))
        return out

    def console_errors_unexplained(self, since_e=0, since_r=0):
        """Console error CHỈ được chấp nhận khi nó là bản ghi của một API verdict
        không-thành-công đã được recorder ghi nhận (401 login sai, 403 viewer bị
        chặn...). Chromium tự log mọi response >=400 vào console, nên "zero console
        error" theo nghĩa đen là bất khả thi với journey login sai / viewer 403 —
        nhưng "không có console error nào KHÔNG giải thích được" vẫn bắt được
        lỗi JS thật (TypeError, CORS, font, 500...)."""
        expected = {}
        for _m, _u, st, _h in self.responses[since_r:]:
            expected[st] = expected.get(st, 0) + 1
        unexplained = []
        for kind, text in self.console_errors[since_e:]:
            match = re.search(r"status of (\d{3})", text)
            code = int(match.group(1)) if match else None
            if code is not None and expected.get(code, 0) > 0:
                expected[code] -= 1
            else:
                unexplained.append((kind, text))
        return unexplained, expected

    def protected_200(self, since=0):
        return [
            (m, u)
            for m, u, st, _ in self.responses[since:]
            if st == 200 and any(p in u for p in PROTECTED_PATHS)
        ]

    def mark_phase(self, label):
        self.marks[label] = (
            len(self.console_errors),
            len(self.page_errors),
            len(self.failed),
            len(self.responses),
        )

    def phase_delta(self, label):
        c0, p0, f0, r0 = self.marks.get(label, (0, 0, 0, 0))
        return {
            "console": self.console_errors[c0:],
            "page": self.page_errors[p0:],
            "failed": self.failed[f0:],
            "responses": self.responses[r0:],
        }


def assert_phase_clean(rec, label):
    """Verdict cho đúng phase vừa chạy — không được nuốt lỗi của phase trước."""
    delta = rec.phase_delta(label)
    unexplained, _expected = rec.console_errors_unexplained(
        since_e=len(rec.console_errors) - len(delta["console"]), since_r=len(rec.responses) - len(delta["responses"])
    )
    check(
        "phase[{}]: không console error không giải thích được".format(label),
        not unexplained,
        str(unexplained[:3]),
    )
    check("phase[{}]: không page error".format(label), not delta["page"], str(delta["page"][:3]))
    check("phase[{}]: không request failed".format(label), not delta["failed"], str(delta["failed"][:3]))
    return delta

    def auth_headers(self):
        out = []
        for request in self.requests:
            if request.url.startswith(BASE_URL + "/api/"):
                try:
                    out.append((request.url, request.headers.get("authorization", "")))
                except Exception:  # pragma: no cover
                    out.append((request.url, ""))
        return out



def install_network_guard(context, recorder):
    """Chỉ cho phép same-origin + data:/blob:. Mọi origin khác bị abort và ghi lại."""

    def handler(route):
        url = route.request.url
        if same_origin(url) or url.startswith("data:") or url.startswith("blob:"):
            route.continue_()
        else:
            recorder.blocked.append(url)
            route.abort()

    context.route("**/*", handler)


def no_horizontal_overflow(page):
    return page.evaluate(
        "() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"
    )


def storage_snapshot(page):
    return page.evaluate(
        "key => ({"
        "session: Object.keys(sessionStorage),"
        "local: Object.keys(localStorage),"
        "sessionValue: sessionStorage.getItem(key),"
        "localValue: localStorage.getItem(key)"
        "})",
        TOKEN_KEY,
    )


def submit_credentials(page, user, password):
    page.fill("#auth-username", user)
    page.fill("#auth-password", password)
    page.click("#btn-login")


def login(page, user, password):
    submit_credentials(page, user, password)
    page.wait_for_function(
        "() => document.documentElement.getAttribute('data-auth') === 'authenticated'",
        timeout=15000,
    )


def logout(page):
    page.click("#btn-logout")
    page.wait_for_function(
        "() => document.documentElement.getAttribute('data-auth') !== 'authenticated'",
        timeout=15000,
    )


def show_tab(page, tab):
    """Chỉ bật tab được render trong DOM khi pane có class .active (CSS: .tab-pane{display:none})."""
    page.click('.nav-item[data-tab="{}"]'.format(tab))
    page.wait_for_selector("#{}".format(tab), state="visible", timeout=15000)


def wait_dashboard(page):
    page.wait_for_function(
        "() => { const el = document.getElementById('stat-total-assets');"
        " return el && el.textContent.trim() !== '' && el.textContent.trim() !== '0'; }",
        timeout=20000,
    )


def open_ticket_modal_and_submit(page, title, requester="QA Bot", dept="IT Support"):
    show_tab(page, "tab-tickets")
    page.click("#btn-add-ticket")
    page.fill("#t-title", title)
    page.fill("#t-requester", requester)
    page.fill("#t-dept", dept)
    page.click("#ticket-form button[type=submit]")


def journey_legacy(page, rec):
    print("[legacy] Journey 1 — dashboard, tạo ticket, reload, không auth panel")
    page.goto(BASE_URL, wait_until="load")
    wait_dashboard(page)
    check("legacy: dashboard tải số liệu từ API", page.locator("#recent-tickets-list .ticket-item").count() > 0)
    show_tab(page, "tab-assets")
    page.wait_for_selector("#assets-tbody tr", timeout=20000)
    check("legacy: bảng tài sản có dữ liệu", page.locator("#assets-tbody tr").count() > 0)
    check(
        "legacy: /api/health trả authMode=legacy",
        page.evaluate("async () => (await (await fetch('/api/health')).json()).authMode") == "legacy",
    )
    check(
        "legacy: auth panel tồn tại nhưng bị ẩn",
        page.locator("#auth-panel").count() == 1 and not page.locator("#auth-panel").is_visible(),
    )
    check("legacy: không có nút logout hiện", page.locator("#btn-logout").count() == 0 or not page.locator("#btn-logout").is_visible())

    title = "QA E2E legacy ticket {}".format(os.getpid())
    open_ticket_modal_and_submit(page, title)
    page.wait_for_selector(".toast-success", timeout=15000)
    check("legacy: toast thành công sau khi tạo ticket", page.locator(".toast-success").count() > 0)
    page.wait_for_function(
        "t => document.getElementById('tickets-tbody').innerText.includes(t)", arg=title, timeout=15000
    )

    page.reload(wait_until="load")
    wait_dashboard(page)
    show_tab(page, "tab-tickets")
    page.wait_for_selector("#tickets-tbody tr", timeout=20000)
    check(
        "legacy: reload vẫn thấy ticket đã tạo (dữ liệu bền vững)",
        title in page.locator("#tickets-tbody").inner_text(),
    )
    page.screenshot(path=os.path.join(SHOT_DIR, "01-legacy-dashboard.png"), full_page=True)
    return title


def journey_viewport(page, rec, label):
    for name, width, height in (("desktop", 1440, 900), ("mobile", 390, 844)):
        page.set_viewport_size({"width": width, "height": height})
        page.wait_for_timeout(400)
        check("{} {}: không tràn ngang".format(label, name), no_horizontal_overflow(page))
        page.screenshot(
            path=os.path.join(SHOT_DIR, "02-{}-{}.png".format(label, name)), full_page=True
        )
    page.set_viewport_size({"width": 1440, "height": 900})


def journey_lab_anonymous(page, rec):
    print("[lab] Journey 2 — anonymous phải thấy login form, không được coi là thành công")
    page.goto(BASE_URL, wait_until="load")
    page.wait_for_selector("#auth-panel", state="visible", timeout=20000)
    check("lab: auth panel hiện khi anonymous", page.locator("#auth-panel").is_visible())
    check("lab: login form hiện", page.locator("#login-form").is_visible())
    check(
        "lab: data-auth=anonymous",
        page.evaluate("() => document.documentElement.getAttribute('data-auth')") == "anonymous",
    )
    protected_200 = rec.protected_200()
    check("lab: anonymous KHÔNG tải được dữ liệu protected", not protected_200, str(protected_200))
    check(
        "lab: không có toast lỗi khi anonymous (chưa gửi request sai)",
        page.locator(".toast-error").count() == 0,
    )
    check("lab: không có token trong storage", storage_snapshot(page)["sessionValue"] is None)
    page.screenshot(path=os.path.join(SHOT_DIR, "03-lab-anonymous.png"), full_page=True)


def journey_lab_wrong_login(page, rec):
    print("[lab] Journey 3 — login sai không được lưu token")
    submit_credentials(page, VIEWER[0], "wrong-password-123")
    # Login sai: verdict hợp lệ là #auth-error hiện ra, KHÔNG phải state authenticated.
    page.wait_for_selector("#auth-error", state="visible", timeout=15000)
    check("lab: hiện lỗi khi login sai", page.locator("#auth-error").is_visible())
    snap = storage_snapshot(page)
    check("lab: login sai không tạo token", snap["sessionValue"] is None and snap["localValue"] is None)
    check(
        "lab: login sai không tạo key token nào trong storage",
        not any("token" in k.lower() for k in snap["session"] + snap["local"]),
        str(snap),
    )
    page.screenshot(path=os.path.join(SHOT_DIR, "04-lab-wrong-login.png"), full_page=True)


def journey_lab_viewer(page, rec, title_prefix):
    print("[lab] Journey 4-6 — viewer login, token lifecycle, reload, logout")
    login(page, VIEWER[0], VIEWER[1])
    rec.mark_phase("lab-viewer:sau-login")
    wait_dashboard(page)
    show_tab(page, "tab-assets")
    page.wait_for_selector("#assets-tbody tr", timeout=20000)
    check("lab: sau login bảng tài sản có dữ liệu", page.locator("#assets-tbody tr").count() > 0)
    snap = storage_snapshot(page)
    check("lab: token nằm trong sessionStorage", bool(snap["sessionValue"]))
    check("lab: token KHÔNG nằm trong localStorage", snap["localValue"] is None, str(snap["local"]))
    check("lab: key token chỉ nằm trong sessionStorage", TOKEN_KEY in snap["session"])
    check("lab: không có key token trong localStorage", TOKEN_KEY not in snap["local"])
    token = snap["sessionValue"]
    check("lab: token không nằm trong URL", token not in page.url and "token" not in page.url.lower(), page.url)
    # Minor 5: dò rò token trong MỌI loại console (log/info/warning/error), không
    # chỉ type=error — app có thể lỡ tay console.log token ở mức info.
    leaked = [entry for entry in rec.console_all if token and token in entry[1]]
    check("lab: token không bị in ra console (mọi loại message)", not leaked, str(leaked[:2]))

    page.wait_for_timeout(500)
    # /api/auth/login trả 401 là verdict ĐÚNG cho credential sai (journey trước), nên
    # assertion này chỉ soi endpoint dữ liệu/phiên sau khi đã đăng nhập.
    statuses = [
        (url, status)
        for _, url, status, _ in rec.api_calls()
        if not url.endswith("/api/auth/login")
    ]
    check(
        "lab: không có 401 sau khi đã login",
        not [s for s in statuses if s[1] == 401],
        str([s for s in statuses if s[1] == 401]),
    )
    protected = [
        (url, auth) for url, auth in rec.auth_headers() if any(p in url for p in PROTECTED_PATHS)
    ]
    check("lab: request protected đã gọi", len(protected) > 0, str(len(protected)))
    check(
        "lab: request protected mang Authorization: Bearer",
        all(auth == "Bearer " + token for _, auth in protected),
        str([a for _, a in protected][:3]),
    )
    check("lab: hiện user đang đăng nhập", VIEWER[0] in (page.locator("#auth-user").inner_text() or ""))
    page.screenshot(path=os.path.join(SHOT_DIR, "05-lab-viewer-logged-in.png"), full_page=True)

    # Journey: viewer chỉ đọc — tạo ticket phải bị chặn (403), không phải im lặng.
    denied_title = title_prefix + " viewer-deny"
    open_ticket_modal_and_submit(page, denied_title)
    # Không để việc "chờ toast" nuốt mất verdict HTTP: nếu API trả 200 (mutation
    # role matrix) thì toast sẽ không bao giờ hiện, và journey phải vẫn chấm
    # được đúng cái assertion 403 bên dưới thay vì timeout.
    try:
        page.wait_for_selector(".toast-error", timeout=8000)
    except Exception:  # noqa: BLE001 — thiếu toast cũng là một verdict FAIL
        pass
    check("lab: viewer tạo ticket bị từ chối (toast lỗi)", page.locator(".toast-error").count() > 0)
    # Important 2: lọc theo METHOD + PATH. `GET /api/audit` cũng trả 403 vì
    # VIEWER thiếu audit:read, nên assertion "có 403 nào đó" là xanh dù POST
    # /api/tickets có trả 200 — đúng lỗi mà report vẫn dùng làm bằng chứng.
    ticket_posts = [
        (url, status)
        for method, url, status, _ in rec.api_calls()
        if method == "POST" and url.endswith("/api/tickets")
    ]
    check(
        "lab: POST /api/tickets bị chặn 403 (viewer chỉ có quyền read)",
        bool(ticket_posts) and all(status == 403 for _, status in ticket_posts),
        str(ticket_posts),
    )
    check(
        "lab: viewer không tạo được ticket nào (không có 201 cho POST /api/tickets)",
        not [p for p in ticket_posts if p[1] == 201],
        str(ticket_posts),
    )
    check(
        "lab: ticket bị chặn không xuất hiện trong danh sách",
        denied_title not in page.locator("#tickets-tbody").inner_text(),
        page.locator("#tickets-tbody").inner_text()[:120],
    )

    rec.mark_phase("lab-viewer:viewer-403")
    assert_phase_clean(rec, "lab-viewer:viewer-403")

    # Journey: reload giữ session trong tab
    rec.mark_phase("lab-viewer:reload")
    page.reload(wait_until="load")
    wait_dashboard(page)
    check(
        "lab: reload vẫn đã đăng nhập",
        page.evaluate("() => document.documentElement.getAttribute('data-auth')") == "authenticated",
    )
    check("lab: token vẫn trong sessionStorage sau reload", storage_snapshot(page)["sessionValue"] == token)

    # Journey: logout → gọi POST /api/auth/logout, xoá token, protected GET → 401
    rec.mark_phase("lab-viewer:logout")
    logout(page)
    check("lab: sau logout data-auth != authenticated", page.evaluate("() => document.documentElement.getAttribute('data-auth')") != "authenticated")
    logged_out = [u for u in rec.requests if "/api/auth/logout" in u.url]
    check("lab: logout gọi POST /api/auth/logout", any(r.method == "POST" for r in logged_out), str([(r.url, r.method) for r in logged_out]))
    check("lab: logout gửi Bearer", all(r.headers.get("authorization") == "Bearer " + token for r in logged_out))
    snap = storage_snapshot(page)
    check("lab: logout xoá token khỏi sessionStorage", snap["sessionValue"] is None, str(snap))
    check("lab: sau logout không có token ở localStorage", snap["localValue"] is None)

    # Important 3: trước khi reload, dữ liệu của phiên cũ KHÔNG được nằm lại
    # sau panel đăng nhập (tài sản/ticket của người dùng vừa rời đi).
    check(
        "lab: logout xoá sạch bảng tài sản đã render",
        "Chưa có thiết bị nào" in page.locator("#assets-tbody").inner_text(),
        page.locator("#assets-tbody").inner_text()[:80],
    )
    check(
        "lab: logout xoá sạch bảng ticket đã render",
        "Chưa có ticket nào" in page.locator("#tickets-tbody").inner_text(),
        page.locator("#tickets-tbody").inner_text()[:80],
    )
    check(
        "lab: logout đưa bộ đếm tài sản/ticket về 0",
        "0 thiết bị" in page.locator("#assets-count").inner_text()
        and "0 ticket" in page.locator("#tickets-count").inner_text(),
        "{} / {}".format(
            page.locator("#assets-count").inner_text(), page.locator("#tickets-count").inner_text()
        ),
    )
    check(
        "lab: logout xoá tên user khỏi header",
        page.locator("#auth-user").inner_text().strip() in ("", "Chưa đăng nhập"),
        page.locator("#auth-user").inner_text(),
    )
    check(
        "lab: logout xoá bảng bản quyền đã render",
        "Chưa có dữ liệu bản quyền" in page.locator("#licenses-tbody").inner_text(),
        page.locator("#licenses-tbody").inner_text()[:80],
    )

    status = 0
    try:
        with urllib.request.urlopen(BASE_URL + "/api/assets") as resp:  # noqa: S310 - loopback QA
            status = resp.status
    except urllib.error.HTTPError as err:
        status = err.code
    check("lab: protected GET sau logout trả 401", status == 401, "status={}".format(status))

    page.reload(wait_until="load")
    page.wait_for_selector("#auth-panel", state="visible", timeout=20000)
    check("lab: reload sau logout quay về login form", page.locator("#auth-panel").is_visible())
    return token


def journey_lab_expired_token(page, rec, label):
    print("[lab] Journey 8 — token hỏng trong sessionStorage: UI phải tự về unauthorized")
    page.evaluate("k => sessionStorage.setItem(k, 'qa.invalid.token.value')", TOKEN_KEY)
    rec.mark_phase(label)
    since = len(rec.responses)
    page.reload(wait_until="load")
    page.wait_for_selector("#auth-panel", state="visible", timeout=20000)
    check(
        "lab: token hỏng → data-auth=unauthorized (không phải anonymous)",
        page.evaluate("() => document.documentElement.getAttribute('data-auth')") == "unauthorized",
        page.evaluate("() => document.documentElement.getAttribute('data-auth')"),
    )
    check("lab: token hỏng → panel đăng nhập hiện", page.locator("#auth-panel").is_visible())
    check(
        "lab: token hỏng → token bị xoá khỏi sessionStorage",
        storage_snapshot(page)["sessionValue"] is None,
        str(storage_snapshot(page)),
    )
    check(
        "lab: token hỏng → có thông báo phiên hết hạn",
        "hết hạn" in (page.locator("#auth-error").inner_text() or "").lower(),
        page.locator("#auth-error").inner_text()[:120],
    )
    ok200 = rec.protected_200(since=since)
    check("lab: token hỏng → không endpoint protected nào trả 200", not ok200, str(ok200))
    # clearProtectedViews() để lại ĐÚNG MỘT hàng placeholder ("Chưa có thiết bị
    # nào.") — đó không phải dữ liệu. Verdict là: không còn hàng dữ liệu nào.
    body_text = page.locator("#assets-tbody").inner_text()
    check(
        "lab: token hỏng → chỉ còn hàng rỗng, không có dữ liệu tài sản",
        "Chưa có thiết bị nào" in body_text and page.locator("#assets-tbody tr").count() == 1,
        "rows={} text={}".format(page.locator("#assets-tbody tr").count(), body_text[:80]),
    )
    assert_phase_clean(rec, label)
    page.screenshot(path=os.path.join(SHOT_DIR, "07-lab-expired-token.png"), full_page=True)


def journey_lab_admin(page, rec, title_prefix):
    print("[lab] Journey 7 — admin đủ quyền tạo ticket")
    login(page, ADMIN[0], ADMIN[1])
    wait_dashboard(page)
    title = title_prefix + " admin-ticket"
    open_ticket_modal_and_submit(page, title)
    page.wait_for_selector(".toast-success", timeout=15000)
    check("lab: admin tạo ticket thành công", page.locator(".toast-success").count() > 0)
    page.wait_for_function(
        "t => document.getElementById('tickets-tbody').innerText.includes(t)", arg=title, timeout=15000
    )
    check("lab: ticket của admin xuất hiện trong danh sách", title in page.locator("#tickets-tbody").inner_text())
    page.screenshot(path=os.path.join(SHOT_DIR, "06-lab-admin-ticket.png"), full_page=True)
    return title


def main():
    prefix = "QA E2E {} {}".format(AUTH_MODE, os.getpid())
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()
        rec = Recorder(page)
        install_network_guard(context, rec)
        def attempt(name, fn, *args):
            # Một journey hỏng không được che mất các journey còn lại: ghi nhận
            # lỗi rồi đi tiếp để log RED/GREEN nêu đủ phạm vi hỏng.
            try:
                return fn(*args)
            except Exception as exc:  # noqa: BLE001 - journey harness cần nhánh này
                check(name, False, "{}: {}".format(type(exc).__name__, str(exc).splitlines()[0][:180]))
                return None

        def phase(label, fn, *args):
            rec.mark_phase(label)
            attempt("journey " + label, fn, *args)
            assert_phase_clean(rec, label)

        try:
            if AUTH_MODE == "legacy":
                phase("legacy", journey_legacy, page, rec)
                phase("legacy-viewport", journey_viewport, page, rec, "legacy")
            else:
                phase("lab-anonymous", journey_lab_anonymous, page, rec)
                phase("lab-anonymous-viewport", journey_viewport, page, rec, "lab-anonymous")
                phase("lab-wrong-login", journey_lab_wrong_login, page, rec)
                phase("lab-viewer", journey_lab_viewer, page, rec, prefix)
                phase("lab-logged-out-viewport", journey_viewport, page, rec, "lab-logged-out")
                phase("lab-admin", journey_lab_admin, page, rec, prefix)
                phase("lab-admin-viewport", journey_viewport, page, rec, "lab-admin")
                phase("lab-expired-token", journey_lab_expired_token, page, rec, "lab-expired-token")
        finally:
            print("  -- diagnostics (TICH LUY ca run) --")
            print("  console messages:", json.dumps(rec.console_all, ensure_ascii=False)[:800])
            print("  console errors :", json.dumps(rec.console_errors, ensure_ascii=False)[:800])
            print("  page errors    :", json.dumps(rec.page_errors, ensure_ascii=False)[:800])
            print("  failed requests:", json.dumps(rec.failed, ensure_ascii=False)[:800])
            print("  blocked (ngoài origin):", json.dumps(rec.blocked, ensure_ascii=False)[:800])
            # Verdict TỔNG cho cả run (không reset) — đây mới là điều report claim.
            total_unexplained, _left = rec.console_errors_unexplained(0, 0)
            check(
                "e2e[TOTAL]: không console error không giải thích được trong cả run",
                not total_unexplained,
                str(total_unexplained[:3]),
            )
            check("e2e[TOTAL]: không page error trong cả run", not rec.page_errors, str(rec.page_errors[:3]))
            check("e2e[TOTAL]: không request failed trong cả run", not rec.failed, str(rec.failed[:3]))
            check("e2e[TOTAL]: không phát sinh request ra ngoài origin", not rec.blocked, str(rec.blocked[:3]))
            context.close()
            browser.close()

    failed = [r for r in results if not r[1]]
    print("\n{}journeys: {} pass / {} fail (mode={})".format(AUTH_MODE, len(results) - len(failed), len(failed), AUTH_MODE))
    for name, _, detail in failed:
        print("  FAILED: {} — {}".format(name, detail))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
