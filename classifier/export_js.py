"""
export_js.py

Generates dist/redflags-engine.js from lexicon.py's CATEGORIES/NEGATION_WORDS.
The JS output is dependency-free (no build step, no npm) and exposes a single
global: window.RedFlagsEngine.analyze(text) -> { riskLevel, categories }.

Phase 2 note: once train.py produces trained per-category classifiers, their
m2cgen-exported scoring functions would be merged in here as an additional
signal alongside the lexicon matches, without changing analyze()'s output
shape -- extension/popup.js and the website template code wouldn't need to
change at all.

Run: python3 export_js.py   (writes dist/redflags-engine.js)
"""

import json
from pathlib import Path

from lexicon import CATEGORIES, NEGATION_WORDS

OUTPUT_PATH = Path(__file__).parent / "dist" / "redflags-engine.js"

TEMPLATE = """\
// GENERATED FILE -- do not edit by hand.
// Source of truth: classifier/lexicon.py. Regenerate with:
//   python3 classifier/export_js.py && classifier/sync.sh
(function (root) {{
  "use strict";

  var CATEGORIES = {categories_json};
  var NEGATION_WORDS = {negation_json};
  var SEVERITY_RANK = {{ none: 0, low: 1, medium: 2, high: 3 }};
  var SENTENCE_SPLIT_RE = /(?<=[.!?])\\s+|\\n+/;

  function isNegated(sentence, matchStart) {{
    var prefix = sentence.slice(0, matchStart).toLowerCase();
    for (var i = 0; i < NEGATION_WORDS.length; i++) {{
      if (prefix.indexOf(NEGATION_WORDS[i]) !== -1) return true;
    }}
    return false;
  }}

  // Scraped policy text overwhelmingly uses "smart" quotes/apostrophes;
  // NEGATION_WORDS is written with straight ones, so without this a denial
  // like "We don’t sell your data" would fail to match "don't" and get
  // flagged as a red flag instead of correctly suppressed.
  function normalizeQuotes(text) {{
    return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  }}

  function analyze(text) {{
    if (!text || !text.trim()) {{
      return {{ riskLevel: "unknown", categories: [] }};
    }}

    text = normalizeQuotes(text);
    var sentences = text.split(SENTENCE_SPLIT_RE);
    var results = [];

    for (var c = 0; c < CATEGORIES.length; c++) {{
      var category = CATEGORIES[c];
      var matches = [];

      for (var s = 0; s < sentences.length; s++) {{
        var sentence = sentences[s];
        for (var p = 0; p < category.patterns.length; p++) {{
          var re = new RegExp(category.patterns[p], "i");
          var m = re.exec(sentence);
          if (m && !isNegated(sentence, m.index)) {{
            var snippet = sentence.trim().slice(0, 200);
            if (snippet && matches.indexOf(snippet) === -1) {{
              matches.push(snippet);
            }}
            break;
          }}
        }}
        if (matches.length >= 3) break;
      }}

      if (matches.length) {{
        results.push({{
          id: category.id,
          label: category.label,
          severity: category.severity,
          matches: matches.slice(0, 3),
        }});
      }}
    }}

    var riskLevel;
    if (!results.length) {{
      riskLevel = "low";
    }} else {{
      var topSeverity = 0;
      for (var r = 0; r < results.length; r++) {{
        topSeverity = Math.max(topSeverity, SEVERITY_RANK[results[r].severity]);
      }}
      riskLevel = {{ 3: "high", 2: "medium", 1: "low" }}[topSeverity] || "low";
    }}

    return {{ riskLevel: riskLevel, categories: results }};
  }}

  root.RedFlagsEngine = {{ analyze: analyze }};
}})(typeof window !== "undefined" ? window : this);
"""


def main() -> None:
    categories_for_js = [
        {
            "id": c["id"],
            "label": c["label"],
            "severity": c["severity"],
            "patterns": c["patterns"],
        }
        for c in CATEGORIES
    ]
    js = TEMPLATE.format(
        categories_json=json.dumps(categories_for_js, indent=2),
        negation_json=json.dumps(list(NEGATION_WORDS)),
    )
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(js)
    print(f"Wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
