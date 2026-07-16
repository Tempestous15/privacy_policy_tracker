"""
tosdr_ground_truth.py

Loads and joins ToS;DR's Zenodo dataset export (cases.csv, services.csv,
points.csv, documents.csv -- see fetch_tosdr_dataset.py) into per-service
ground truth: real ToS;DR classifications per topic, plus the service's
actual privacy-policy text to classify against.

Pure data loading -- no LLM calls, no Django. eval_tosdr.py is the only
caller; topic_classifier.py never imports this module (it takes plain
policy text + a topic list, and doesn't care where either came from).

Key relationship, since it's easy to get backwards: cases.csv has NO
service_id -- a "case" (e.g. "sells data to third parties") is a shared,
global definition. points.csv is what actually links a service to a case
(service_id + case_id per row), representing "this specific service's
policy was found to match this case." So a service's real ground truth is
reached via points.csv, joined to cases.csv on case_id.
"""

from __future__ import annotations

import csv
import json
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

DATASET_DIR = Path(__file__).parent / "tosdr_dataset"
CACHE_PATH = DATASET_DIR / "_service_documents_cache.json"

# points.csv statuses other than "approved" represent drafts, disputes, or
# declined edits -- not settled ToS;DR conclusions, so they're excluded
# from ground truth.
APPROVED_STATUS = "approved"

# documents.csv holds every document type ToS;DR tracked for a service
# (privacy policy, terms of service, cookie policy, ...) -- this project
# only classifies against privacy policy text, so documents are matched by
# name containing one of these (case-insensitive).
PRIVACY_DOCUMENT_NAME_HINTS = ("privacy",)

_bump_csv_field_size_limit = None  # set below


def _ensure_large_csv_fields() -> None:
    """documents.csv contains full policy text per field, which routinely
    exceeds Python csv's default ~131072-byte field size limit. Raise it
    as high as the platform allows (the classic halving-retry pattern,
    since sys.maxsize overflows the underlying C long on some platforms)."""
    global _bump_csv_field_size_limit
    if _bump_csv_field_size_limit is not None:
        return
    max_int = sys.maxsize
    while True:
        try:
            csv.field_size_limit(max_int)
            break
        except OverflowError:
            max_int = int(max_int / 10)
    _bump_csv_field_size_limit = True


class DatasetFileNotFoundError(Exception):
    """Raised when a required tosdr_dataset/*.csv file hasn't been fetched yet."""


@dataclass
class EvalService(object):
    """One service ready for the eval harness: its real policy text, plus
    ToS;DR's real ground-truth classification per topic."""

    service_id: int
    name: str
    is_comprehensively_reviewed: bool
    policy_text: str
    # topic_id -> set of real ToS;DR classifications for that topic on
    # this service. Usually one classification per topic; kept as a set
    # (not a single value) because ToS;DR occasionally has more than one
    # approved case under the same topic for one service, and the eval
    # harness treats matching *any* of them as agreement rather than
    # penalizing ToS;DR's own internal multiplicity.
    ground_truth: dict[int, set[str]] = field(default_factory=dict)


def _require(path: Path) -> Path:
    if not path.exists():
        raise DatasetFileNotFoundError(
            f"{path} not found. Run: python3 tracker/fetch_tosdr_dataset.py --include-points-and-documents"
        )
    return path


def _load_cases(dataset_dir: Path) -> dict[int, dict[str, Any]]:
    """id -> {classification, topic_id, title}"""
    path = _require(dataset_dir / "cases.csv")
    cases: dict[int, dict[str, Any]] = {}
    with path.open(encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            try:
                cases[int(row["id"])] = {
                    "classification": (row.get("classification") or "").strip().lower(),
                    "topic_id": int(row["topic_id"]) if row.get("topic_id") else None,
                    "title": (row.get("title") or "").strip(),
                }
            except (ValueError, KeyError):
                continue  # malformed row -- skip rather than fail the whole load
    return cases


def _load_services(dataset_dir: Path) -> dict[int, dict[str, Any]]:
    """id -> {name, is_comprehensively_reviewed}"""
    path = _require(dataset_dir / "services.csv")
    services: dict[int, dict[str, Any]] = {}
    with path.open(encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            try:
                services[int(row["id"])] = {
                    "name": (row.get("name") or "").strip(),
                    "is_comprehensively_reviewed": str(row.get("is_comprehensively_reviewed", "")).strip().lower() == "true",
                }
            except (ValueError, KeyError):
                continue
    return services


def _load_approved_case_ids_by_service(dataset_dir: Path) -> dict[int, set[int]]:
    """service_id -> {case_id, ...}, points.csv rows with status == approved
    and a real case_id only."""
    path = _require(dataset_dir / "points.csv")
    by_service: dict[int, set[int]] = defaultdict(set)
    _ensure_large_csv_fields()
    with path.open(encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            status = (row.get("status") or "").strip().lower()
            if status != APPROVED_STATUS:
                continue
            service_id_raw, case_id_raw = row.get("service_id"), row.get("case_id")
            if not service_id_raw or not case_id_raw:
                continue
            try:
                by_service[int(service_id_raw)].add(int(case_id_raw))
            except ValueError:
                continue
    return by_service


def _is_privacy_document(name: str) -> bool:
    lowered = (name or "").lower()
    return any(hint in lowered for hint in PRIVACY_DOCUMENT_NAME_HINTS)


def _build_privacy_text_index(dataset_dir: Path, candidate_service_ids: set[int]) -> dict[int, str]:
    """Single streaming pass over documents.csv (large -- ~268 MB), keeping
    only privacy-policy text for services already known to have approved
    ground truth (candidate_service_ids). Everything else is discarded row
    by row rather than held in memory.

    If a service has multiple privacy-named documents, the longest text
    wins (a reasonable proxy for "the real policy" over a stub/redirect
    page some crawls pick up).
    """
    path = _require(dataset_dir / "documents.csv")
    _ensure_large_csv_fields()
    index: dict[int, str] = {}
    with path.open(encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            service_id_raw = row.get("service_id")
            if not service_id_raw:
                continue
            try:
                service_id = int(service_id_raw)
            except ValueError:
                continue
            if service_id not in candidate_service_ids:
                continue
            if not _is_privacy_document(row.get("name", "")):
                continue
            text = (row.get("text") or "").strip()
            if not text:
                continue
            if len(text) > len(index.get(service_id, "")):
                index[service_id] = text
    return index


def _load_or_build_privacy_text_index(dataset_dir: Path, candidate_service_ids: set[int]) -> dict[int, str]:
    """Wraps _build_privacy_text_index with an on-disk cache -- the full
    documents.csv streaming pass is the slow part of loading eval data
    (hundreds of MB), and re-running the eval (e.g. after tweaking the
    classification prompt) shouldn't pay that cost every time.
    """
    if CACHE_PATH.exists():
        try:
            cached = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
            cached_index = {int(k): v for k, v in cached.items()}
            if candidate_service_ids <= cached_index.keys():
                return {sid: cached_index[sid] for sid in candidate_service_ids}
        except (json.JSONDecodeError, ValueError, OSError):
            pass  # corrupt/stale cache -- fall through and rebuild

    print("tosdr_ground_truth: scanning documents.csv for privacy-policy text "
          "(one-time cost, cached afterward)...", file=sys.stderr)
    index = _build_privacy_text_index(dataset_dir, candidate_service_ids)
    try:
        CACHE_PATH.write_text(json.dumps(index), encoding="utf-8")
    except OSError:
        pass  # cache is a pure optimization -- fine to skip silently if disk write fails
    return index


def load_eval_services(
    n: int,
    dataset_dir: Path | None = None,
    prefer_comprehensively_reviewed: bool = True,
) -> list[EvalService]:
    """Select up to `n` services that have both real ToS;DR ground truth
    (approved points linked to cases) and actual privacy-policy text to
    classify against.

    Services flagged is_comprehensively_reviewed in ToS;DR's own data are
    preferred first (their annotations are ToS;DR's own highest-confidence
    ones), then filled out with other annotated services if `n` isn't
    reached that way.

    Raises:
        DatasetFileNotFoundError: one of the required CSVs hasn't been
            fetched (run fetch_tosdr_dataset.py --include-points-and-documents).
    """
    dataset_dir = dataset_dir or DATASET_DIR

    cases = _load_cases(dataset_dir)
    services = _load_services(dataset_dir)
    approved_case_ids_by_service = _load_approved_case_ids_by_service(dataset_dir)

    # Only services with at least one approved point referencing a real,
    # topic-tagged case are eval candidates.
    candidate_ids = {
        sid for sid, case_ids in approved_case_ids_by_service.items()
        if any(cases.get(cid, {}).get("topic_id") is not None for cid in case_ids)
        and sid in services
    }

    ranked_ids = sorted(
        candidate_ids,
        key=lambda sid: (
            not (services[sid]["is_comprehensively_reviewed"] if prefer_comprehensively_reviewed else False),
            -len(approved_case_ids_by_service[sid]),
        ),
    )

    # Oversample before checking for real policy text -- not every
    # annotated service has a matching privacy document in documents.csv.
    text_index = _load_or_build_privacy_text_index(dataset_dir, set(ranked_ids[: max(n * 5, 50)]))

    eval_services: list[EvalService] = []
    for sid in ranked_ids:
        if len(eval_services) >= n:
            break
        policy_text = text_index.get(sid)
        if not policy_text:
            continue  # annotated in ToS;DR but no privacy-policy text on hand -- skip, don't guess

        ground_truth: dict[int, set[str]] = defaultdict(set)
        for case_id in approved_case_ids_by_service[sid]:
            case = cases.get(case_id)
            if not case or case["topic_id"] is None or not case["classification"]:
                continue
            ground_truth[case["topic_id"]].add(case["classification"])

        if not ground_truth:
            continue

        eval_services.append(EvalService(
            service_id=sid,
            name=services[sid]["name"],
            is_comprehensively_reviewed=services[sid]["is_comprehensively_reviewed"],
            policy_text=policy_text,
            ground_truth=dict(ground_truth),
        ))

    return eval_services
