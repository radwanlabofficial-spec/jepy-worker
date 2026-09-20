#!/usr/bin/env python3
"""Wave 0 — read an Overture Places dump and push it into the Worker.

Two modes, because the filter must be measured before it is trusted:

  probe   read the dump and print what is actually in it — the schema, the
          category values that exist, how many rows a bbox yields. Writes
          nothing. This exists because the category strings are the join
          between this script and `niches.overture_categories_json`, and a
          guessed string is a filter that silently matches nothing.

  import  stream the matching rows to the Worker in slices, which stages each
          slice in R2 and upserts its rows into `leads`.

Run on GitHub Actions, not anywhere else. The dump is ~10 GB of parquet and
reading it is a batch job; the Worker cannot do it and a cron trigger's wall
clock would not allow it anyway.

Nothing here writes to D1 directly. The Worker owns the database, the dedup
cascade and the ledger, so that the import is one code path with one set of
counters rather than two implementations that must agree.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

import duckdb

CHUNK_ROWS = 300
POST_ATTEMPTS = 3


def log(message: str) -> None:
    print(f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')}] {message}", flush=True)


def connect(threads: int) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs;")
    # The bucket lives in us-west-2. Setting the region is what lets DuckDB sign
    # (and therefore reach) the request without any credential: Overture's
    # bucket is public read, so no key is set and none is needed.
    con.execute("SET s3_region='us-west-2';")
    con.execute(f"SET threads={threads};")
    return con


def parquet_glob(release: str) -> str:
    return (
        f"s3://overturemaps-us-west-2/release/{release}/theme=places/type=place/part-*.parquet"
    )


def bbox_clause(bbox: tuple[float, float, float, float]) -> str:
    xmin, ymin, xmax, ymax = bbox
    return (
        f"bbox.xmin BETWEEN {xmin} AND {xmax} AND bbox.ymin BETWEEN {ymin} AND {ymax}"
    )


def parse_niches(niches_json: str) -> list[dict]:
    """The niche rows, fetched from D1 rather than hard-coded here.

    Read from the database so that adding a niche is a row and not a deploy, and
    read through the Worker so there is one source of truth rather than a copy in
    this file that drifts.
    """
    niches = json.loads(niches_json)
    if not isinstance(niches, list):
        raise SystemExit("niches payload is not a list — expected the `.data.niches` array")
    return niches


def category_list(niches: list[dict]) -> list[str]:
    values: list[str] = []
    for niche in niches:
        for value in niche.get("overture_categories", []):
            if value not in values:
                values.append(value)
    return values


def category_to_niche(niches: list[dict]) -> dict[str, str]:
    """Overture category -> our niche slug.

    One category can only belong to one niche: the mapping is flattened, and a
    category listed under two niches would make `leads.niche` depend on the order
    the rows came back in. The last writer wins here, and the probe prints the
    mapping so a collision is visible rather than mysterious.
    """
    mapping: dict[str, str] = {}
    for niche in niches:
        for value in niche.get("overture_categories", []):
            mapping[value] = niche["niche_slug"]
    return mapping


def sql_values(values: list[str]) -> str:
    if not values:
        raise SystemExit("no Overture categories to import — niches are empty")
    escaped = ", ".join("'" + v.replace("'", "''") + "'" for v in values)
    return f"({escaped})"


# The projection is the join between the dump and our schema, and each line is
# a decision: `names.primary` because that is the display name; `phones[1]` and
# `websites[1]` because the dumps carry lists and the first entry is the one the
# source trusts most; the bbox centre as the point because a place polygon's
# centroid is not worth computing for a lead; `addresses[1]` for the same reason
# as phones. `basic_category` is kept alongside the taxonomy value so a later
# re-bucketing does not need the dump again.
ROW_SQL = """
SELECT
  id                                AS overture_id,
  names.primary                     AS name,
  taxonomy.primary                  AS category,
  basic_category                    AS basic_category,
  confidence,
  phones[1]                         AS phone,
  websites[1]                       AS website,
  addresses[1].freeform             AS address_line,
  addresses[1].locality             AS city,
  addresses[1].region               AS region,
  addresses[1].postcode            AS postal_code,
  addresses[1].country             AS country_code,
  (bbox.xmin + bbox.xmax) / 2       AS lng,
  (bbox.ymin + bbox.ymax) / 2       AS lat
FROM read_parquet('{glob}')
WHERE {bbox}
  AND taxonomy.primary IN {categories}
  AND confidence >= {min_confidence}
  AND names.primary IS NOT NULL
  AND operating_status IS DISTINCT FROM 'permanently_closed'
"""


def build_query(
    glob: str,
    bbox: tuple[float, float, float, float],
    categories: list[str],
    min_confidence: float,
    limit: int | None,
) -> str:
    query = ROW_SQL.format(
        glob=glob,
        bbox=bbox_clause(bbox),
        categories=sql_values(categories),
        min_confidence=min_confidence,
    )
    if limit:
        # The ORDER BY is not decoration. With a LIMIT and no ordering, a re-run
        # can take a different slice of the same rows, and then the second run
        # inserts leads the first one missed — which reads as a dedup failure
        # when it is really a sampling bug. `id` is stable and unique, so the
        # same LIMIT always yields the same rows, whatever the thread count.
        query += f"\nORDER BY confidence DESC, id\nLIMIT {limit}"
    return query


def domain_of(url: str | None) -> str | None:
    if not url:
        return None
    candidate = url.strip()
    for prefix in ("https://", "http://"):
        if candidate.lower().startswith(prefix):
            candidate = candidate[len(prefix):]
    candidate = candidate.split("/")[0].split("?")[0].lower()
    if candidate.startswith("www."):
        candidate = candidate[4:]
    return candidate or None


def post(worker_url: str, secret: str, path: str, payload: dict) -> dict:
    body = json.dumps(payload).encode()
    last_error: Exception | None = None

    for attempt in range(1, POST_ATTEMPTS + 1):
        request = urllib.request.Request(
            f"{worker_url}{path}",
            data=body,
            headers={
                "Content-Type": "application/json",
                "X-Admin-Secret": secret,
                "User-Agent": "jepy-wave0/1.0",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return json.loads(response.read().decode())
        except urllib.error.HTTPError as error:
            detail = error.read().decode()[:400]
            # 4xx is the caller's fault and retrying repeats it. 5xx and the
            # network are worth another try, and a slice is idempotent anyway
            # because every insert is INSERT OR IGNORE.
            if 400 <= error.code < 500:
                raise SystemExit(f"{path} refused with HTTP {error.code}: {detail}")
            last_error = RuntimeError(f"HTTP {error.code}: {detail}")
        except Exception as error:  # noqa: BLE001 - network shape is not knowable here
            last_error = error

        log(f"    attempt {attempt}/{POST_ATTEMPTS} on {path} failed: {last_error}")
        time.sleep(2 * attempt)

    raise SystemExit(f"{path} failed after {POST_ATTEMPTS} attempts: {last_error}")


def run_probe(con: duckdb.DuckDBPyConnection, args: argparse.Namespace) -> None:
    glob = parquet_glob(args.release)
    bbox = tuple(args.bbox)

    log("schema of one part:")
    # `DESCRIBE` returns six columns (name, type, null, key, default, extra), not
    # two. Take the first two by index rather than unpacking the row, so a future
    # DuckDB that adds a seventh does not break the probe.
    for row in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{glob}') LIMIT 0").fetchall():
        print(f"    {str(row[0]):22s} {row[1]}")

    log("top taxonomy values inside the bbox (all rows, any category):")
    rows = con.execute(
        f"""
        SELECT taxonomy.primary AS category, COUNT(*) AS n
        FROM read_parquet('{glob}')
        WHERE {bbox_clause(bbox)} AND confidence >= 0.6 AND taxonomy.primary IS NOT NULL
        GROUP BY 1 ORDER BY n DESC LIMIT 25
        """
    ).fetchall()
    for category, count in rows:
        print(f"    {category:44s} {count:>8}")

    log("taxonomy values matching video/creative/agency keywords:")
    rows = con.execute(
        f"""
        SELECT taxonomy.primary AS category, COUNT(*) AS n
        FROM read_parquet('{glob}')
        WHERE {bbox_clause(bbox)} AND confidence >= 0.6 AND taxonomy.primary IS NOT NULL
          AND regexp_matches(taxonomy.primary,
              'video|photo|media|creative|advertis|marketing|studio|product|event|wedding')
        GROUP BY 1 ORDER BY n DESC LIMIT 30
        """
    ).fetchall()
    for category, count in rows:
        print(f"    {category:44s} {count:>8}")

    if args.niches_json and args.niches_json.strip() != "[]":
        niches = parse_niches(args.niches_json)
        categories = category_list(niches)
        log("configured niches and the Overture categories they claim:")
        for niche in niches:
            print(f"    {niche['niche_slug']:16s} -> {', '.join(niche['overture_categories'])}")
        log(f"the {len(categories)} configured categories, counted in this bbox:")
        rows = con.execute(
            f"""
            SELECT taxonomy.primary AS category, COUNT(*) AS n
            FROM read_parquet('{glob}')
            WHERE {bbox_clause(bbox)} AND confidence >= {args.min_confidence}
              AND names.primary IS NOT NULL
              AND taxonomy.primary IN {sql_values(categories)}
            GROUP BY 1 ORDER BY n DESC
            """
        ).fetchall()
        total = 0
        for category, count in rows:
            total += count
            print(f"    {category:44s} {count:>8}")
        print(f"    {'TOTAL':44s} {total:>8}")


def run_import(con: duckdb.DuckDBPyConnection, args: argparse.Namespace) -> None:
    if not args.worker_url or not args.admin_secret:
        raise SystemExit("--worker-url and --admin-secret are required for import mode")
    if not args.geo_target_id:
        raise SystemExit("--geo-target-id is required for import mode")

    niches = parse_niches(args.niches_json)
    categories = category_list(niches)
    to_niche = category_to_niche(niches)
    glob = parquet_glob(args.release)
    started = time.time()

    log(f"categories: {', '.join(categories)}")
    log(f"bbox: {args.bbox}")

    opened = post(
        args.worker_url,
        args.admin_secret,
        "/api/admin/import/start",
        {
            "dataset": "overture",
            "release_version": args.release,
            "geo_target_id": args.geo_target_id,
            "min_confidence": args.min_confidence,
            "runner": "gha",
        },
    )
    import_id = opened["data"]["import_id"]
    log(f"ledger opened: {import_id}")

    query = build_query(glob, tuple(args.bbox), categories, args.min_confidence, args.limit)
    log(f"scanning — {'with a deterministic LIMIT of ' + str(args.limit) if args.limit else 'whole bbox'}")

    cursor = con.execute(query)
    columns = [description[0] for description in cursor.description]

    chunk: list[dict] = []
    chunk_index = 0
    total_inserted = 0
    total_deduped = 0
    rows_kept = 0

    def flush(rows: list[dict], index: int) -> tuple[int, int]:
        payload = {
            "import_id": import_id,
            "chunk_index": index,
            "rows_read": len(rows),
            "rows_kept": len(rows),
            "rows": rows,
        }
        response = post(args.worker_url, args.admin_secret, "/api/admin/import/chunk", payload)
        data = response["data"]
        log(f"  chunk {index:>4}  sent {len(rows):>4}  new {data['inserted']:>4}  dup {data['deduped']:>4}")
        return data["inserted"], data["deduped"]

    status = "ok"
    error_text = None
    try:
        for record in cursor.fetchall():
            row = dict(zip(columns, record))

            website = row.pop("website", None)
            row["website_url"] = website
            row["domain"] = domain_of(website)

            # The address's own country is preferred and `US` is the fallback:
            # the bbox decides what is scanned, but a row whose address block is
            # missing would otherwise be stored with no country at all, and a
            # lead with no country cannot be checked against a sending rule.
            row["country_code"] = row.get("country_code") or "US"

            # `basic_category` is the dump's coarse bucket; it rides along into
            # provenance so a later re-bucketing does not need the dump again.
            # `niche` is ours, set from the mapping the niches table defines.
            row["niche"] = to_niche.get(row.get("category") or "", None)

            for key, value in list(row.items()):
                if value is not None and not isinstance(value, (str, int, float, bool)):
                    row[key] = str(value)
            if row.get("confidence") is not None:
                row["confidence"] = float(row["confidence"])
            chunk.append(row)
            if len(chunk) >= CHUNK_ROWS:
                inserted, deduped = flush(chunk, chunk_index)
                total_inserted += inserted
                total_deduped += deduped
                rows_kept += len(chunk)
                chunk_index += 1
                chunk = []
        if chunk:
            inserted, deduped = flush(chunk, chunk_index)
            total_inserted += inserted
            total_deduped += deduped
            rows_kept += len(chunk)
            chunk_index += 1
    except SystemExit as failure:
        status = "failed"
        error_text = str(failure)[:900]
        raise
    finally:
        duration = int(time.time() - started)
        closed = post(
            args.worker_url,
            args.admin_secret,
            "/api/admin/import/finish",
            {
                "import_id": import_id,
                "status": status,
                "error_text": error_text,
                "duration_sec": duration,
            },
        )
        log(f"ledger closed: {json.dumps(closed['data']['ledger'])}")

    log(
        f"done — chunks {chunk_index}, kept {rows_kept}, inserted {total_inserted}, "
        f"deduped {total_deduped}, {int(time.time() - started)}s"
    )
    if rows_kept and total_inserted == 0:
        log("NOTE: nothing new was inserted. On a first run that means the bbox or the")
        log("      category list matched nothing; on a repeat run it is the pass condition.")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["probe", "import"], required=True)
    parser.add_argument("--release", default="2026-08-19.0")
    parser.add_argument("--bbox", nargs=4, type=float, required=True,
                        metavar=("XMIN", "YMIN", "XMAX", "YMAX"))
    parser.add_argument("--min-confidence", type=float, default=0.6)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--geo-target-id", default=None)
    parser.add_argument("--niches-json", default=os.environ.get("NICHES_JSON", "[]"))
    parser.add_argument("--worker-url", default=os.environ.get("WORKER_URL"))
    parser.add_argument("--admin-secret", default=os.environ.get("ADMIN_SECRET"))
    args = parser.parse_args()
    args.panic = None
    if args.limit == 0:
        args.limit = None

    con = connect(args.threads)
    if args.mode == "probe":
        run_probe(con, args)
    else:
        run_import(con, args)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
