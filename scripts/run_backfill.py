#!/usr/bin/env python3
"""Drives STEP 9's backfill against a deployed Worker.

The Worker does the work; this only walks the cursor. That split is deliberate
and is the same one the Wave 0 import uses (`scripts/wave0_import.py`): the
normaliser, the cascade and the writes all live in the Worker, so there is one
implementation in the codebase rather than one per runner.

Every call is idempotent, so a run that dies halfway is resumed by running it
again — the chunks already done report `written: 0` and cost nothing.

    ADMIN_SECRET=... python3 scripts/run_backfill.py
    ADMIN_SECRET=... python3 scripts/run_backfill.py --url https://jepy-worker-preview...

Nothing is written to disk and the secret is never echoed.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

DEFAULT_URL = "https://jepy-worker.radwanlab-official.workers.dev"
CHUNK_LIMIT = 500


def call(base: str, secret: str, method: str, path: str, body: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("X-Admin-Secret", secret)
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=os.environ.get("WORKER_URL", DEFAULT_URL))
    ap.add_argument("--limit", type=int, default=CHUNK_LIMIT)
    ap.add_argument("--max-calls", type=int, default=200, help="safety stop")
    args = ap.parse_args()

    secret = os.environ.get("ADMIN_SECRET", "").strip()
    if not secret:
        print("ADMIN_SECRET is not set. Nothing was sent.", file=sys.stderr)
        return 2

    base = args.url.rstrip("/")
    print(f"target      {base}")

    status = call(base, secret, "GET", "/api/admin/normalise/status")
    if status[0] != 200:
        print(f"status call failed: HTTP {status[0]} {json.dumps(status[1])[:200]}", file=sys.stderr)
        return 1
    before = status[1].get("data", {})
    print(f"before      {json.dumps(before)}")
    print(f"normaliser  {before.get('normaliser')}")

    cursor = ""
    totals = {"processed": 0, "written": 0, "updated": 0, "already_correct": 0,
              "nothing_to_normalise": 0, "skipped_manual": 0, "invalid": 0}
    calls = 0
    started = time.time()

    while calls < args.max_calls:
        code, body = call(base, secret, "POST", "/api/admin/normalise/chunk",
                          {"after_id": cursor or None, "limit": args.limit})
        if code != 200:
            print(f"chunk failed: HTTP {code} {json.dumps(body)[:300]}", file=sys.stderr)
            return 1
        d = body.get("data", {})
        calls += 1
        for k in totals:
            totals[k] += d.get(k) or 0
        cursor = d.get("next_after_id") or cursor
        print(f"  call {calls:>3}  after={cursor[:8]:<8} processed={d.get('processed'):>4} "
              f"written={d.get('written'):>4} already={d.get('already_correct'):>4} "
              f"manual={d.get('skipped_manual'):>2} blank={d.get('nothing_to_normalise'):>2} "
              f"invalid={d.get('invalid'):>2}")
        if d.get("done"):
            break
    else:
        print(f"stopped at the {args.max_calls}-call safety limit; re-run to continue", file=sys.stderr)
        return 1

    # One statement, after the walk: the count needs every row normalised first.
    code, body = call(base, secret, "POST", "/api/admin/normalise/shared", {})
    print(f"shared      HTTP {code} {json.dumps(body.get('data', body))[:160]}")

    after = call(base, secret, "GET", "/api/admin/normalise/status")[1].get("data", {})
    print(f"after       {json.dumps(after)}")
    print(f"chunks      {calls} in {time.time() - started:.1f}s")
    print(f"totals      {json.dumps(totals)}")

    # Rows without an E.164 are not all the same thing, and reporting them as one
    # number would hide which is which. Measured on this dataset the split is
    # blank or absent (~9%) and nothing else.
    gap = before.get("leads", 0) - after.get("normalised", 0)
    if gap:
        print(f"\n{gap} of {before.get('leads', 0)} rows hold no E.164. Three different reasons, "
              f"and only one of them is a problem:\n"
              f"  blank or absent phone_raw   -> nothing_to_normalise above\n"
              f"  unparseable                 -> invalid above\n"
              f"  is_manual_edited = 1 (R7)   -> skipped_manual above\n"
              f"Cross-check the three against `leads - normalised` before reading the gap "
              f"as a defect.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
