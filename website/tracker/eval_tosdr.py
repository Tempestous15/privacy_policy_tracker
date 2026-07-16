#!/usr/bin/env python3
"""
eval_tosdr.py

Evaluation harness for topic_classifier.py: runs the LLM classifier
against N real, ToS;DR-annotated services (via tosdr_ground_truth.py) and
reports how often its classifications agree with ToS;DR's own curators,
per topic and overall.

Scope note: this only benchmarks the policy-text classifier (step 1)
against ToS;DR's real annotations. It does not touch tracker_radar's
behavioral scoring (step 2) or compare the two (step 3) -- see
topic_classifier.py's module docstring for how the three steps relate.

Usage:
    python3 -m tracker.eval_tosdr --n 20
    python3 -m tracker.eval_tosdr --n 50 --out eval_report.json --model claude-sonnet-4-5

Requires the dataset fetched with points/documents included:
    python3 tracker/fetch_tosdr_dataset.py --include-points-and-documents
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from typing import Any

from . import topic_classifier
from . import tosdr_ground_truth
from . import tosdr_topics


def diff_service(
    service: tosdr_ground_truth.EvalService,
    topics: list[dict[str, Any]],
    model: str,
    api_key: str | None,
) -> dict[str, Any]:
    """Classify one service's real policy text and diff the result against
    its real ToS;DR ground truth, topic by topic."""
    findings = topic_classifier.classify_policy_topics(
        service.policy_text, topics, model=model, api_key=api_key,
    )

    # A topic_id -> set of classifications the model predicted for it.
    # Normally one finding per topic (the prompt asks for that), but this
    # stays a set rather than assuming exactly one, for the same reason
    # ground_truth is a set: don't let an occasional double-finding from
    # the model silently overwrite instead of being accounted for.
    predicted_by_topic: dict[int, set[str]] = defaultdict(set)
    for f in findings:
        predicted_by_topic[f["topic_id"]].add(f["classification"])

    comparisons = []
    model_flagged_with_no_tosdr_case = []

    all_topic_ids = set(service.ground_truth) | set(predicted_by_topic)
    for topic_id in all_topic_ids:
        gt = service.ground_truth.get(topic_id)
        pred = predicted_by_topic.get(topic_id)

        if gt:
            # Scored comparison -- ToS;DR has real ground truth here,
            # whether or not the model predicted anything for this topic.
            agree = bool(pred) and not gt.isdisjoint(pred)
            comparisons.append({
                "topic_id": topic_id,
                "ground_truth": sorted(gt),
                "predicted": sorted(pred) if pred else None,
                "agree": agree,
            })
        elif pred:
            # Model found something ToS;DR has no case for on this service
            # at all -- NOT a scoring error. Could be a real gap in
            # ToS;DR's coverage, could be a model false positive. Surfaced
            # separately rather than discarded or counted against accuracy.
            model_flagged_with_no_tosdr_case.append({
                "topic_id": topic_id,
                "predicted": sorted(pred),
            })

    return {
        "service_id": service.service_id,
        "service_name": service.name,
        "comparisons": comparisons,
        "model_flagged_topics_with_no_tosdr_case": model_flagged_with_no_tosdr_case,
    }


def summarize(service_results: list[dict[str, Any]]) -> dict[str, Any]:
    """Aggregate agreement rate overall and per real (ground-truth) class,
    plus precision per predicted class, across every scored comparison."""
    total = 0
    agreements = 0

    # recall-style: of comparisons where ground truth included class X, how
    # often did the model's prediction match ANY of the ground-truth values.
    per_actual_class = {c: {"total": 0, "agree": 0} for c in topic_classifier.VALID_CLASSIFICATIONS}
    # precision-style: of comparisons where the model predicted class X, how
    # often was X actually in the ground truth.
    per_predicted_class = {c: {"total": 0, "agree": 0} for c in topic_classifier.VALID_CLASSIFICATIONS}

    model_gap_count = 0
    missed_count = 0  # ground truth existed, model predicted nothing at all for that topic

    for result in service_results:
        model_gap_count += len(result["model_flagged_topics_with_no_tosdr_case"])
        for c in result["comparisons"]:
            total += 1
            if c["agree"]:
                agreements += 1
            if c["predicted"] is None:
                missed_count += 1

            for actual_class in c["ground_truth"]:
                if actual_class not in per_actual_class:
                    continue  # defensive -- shouldn't happen given topic_classifier's own validation
                per_actual_class[actual_class]["total"] += 1
                if c["agree"]:
                    per_actual_class[actual_class]["agree"] += 1

            for predicted_class in (c["predicted"] or []):
                if predicted_class not in per_predicted_class:
                    continue
                per_predicted_class[predicted_class]["total"] += 1
                if predicted_class in c["ground_truth"]:
                    per_predicted_class[predicted_class]["agree"] += 1

    def _rate(agree: int, total: int) -> float | None:
        return round(agree / total, 3) if total else None

    return {
        "services_evaluated": len(service_results),
        "scored_comparisons": total,
        "overall_agreement_rate": _rate(agreements, total),
        "topics_model_missed_entirely": missed_count,
        "model_flagged_topics_with_no_tosdr_case_total": model_gap_count,
        "recall_by_ground_truth_class": {
            c: {"n": v["total"], "recall": _rate(v["agree"], v["total"])}
            for c, v in per_actual_class.items()
        },
        "precision_by_predicted_class": {
            c: {"n": v["total"], "precision": _rate(v["agree"], v["total"])}
            for c, v in per_predicted_class.items()
        },
    }


def run_eval(
    n: int = 20,
    model: str = topic_classifier.DEFAULT_MODEL,
    api_key: str | None = None,
) -> dict[str, Any]:
    topics = tosdr_topics.load_topics()
    services = tosdr_ground_truth.load_eval_services(n)

    if not services:
        print(
            "No eval-ready services found (need approved, topic-tagged ToS;DR points AND "
            "matching privacy-policy text). Check that fetch_tosdr_dataset.py was run with "
            "--include-points-and-documents.",
            file=sys.stderr,
        )
        return {"services_evaluated": 0, "results": []}

    results = []
    for i, service in enumerate(services, start=1):
        print(f"[{i}/{len(services)}] classifying {service.name!r} (service_id={service.service_id}) ...",
              file=sys.stderr)
        try:
            result = diff_service(service, topics, model, api_key)
        except topic_classifier.SummarizerError as e:
            print(f"  skipped -- classification failed: {e}", file=sys.stderr)
            continue
        results.append(result)

    return {
        "summary": summarize(results),
        "results": results,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--n", type=int, default=20, help="Number of ToS;DR-annotated services to evaluate against")
    parser.add_argument("--model", default=topic_classifier.DEFAULT_MODEL)
    parser.add_argument("--out", help="Write full JSON report here instead of just printing the summary")
    args = parser.parse_args()

    report = run_eval(n=args.n, model=args.model)

    print(json.dumps(report["summary"], indent=2))

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2)
        print(f"\nFull report (including per-service, per-topic detail) written to {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
