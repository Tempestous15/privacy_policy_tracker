// GENERATED FILE -- do not edit by hand.
// Source of truth: classifier/lexicon.py. Regenerate with:
//   python3 classifier/export_js.py && classifier/sync.sh
(function (root) {
  "use strict";

  var CATEGORIES = [
  {
    "id": "data_selling",
    "label": "Sells or monetizes your data",
    "severity": "high",
    "patterns": [
      "\\bsells?\\b[^.]{0,20}\\b(your|users?'?s?|personal|customer)\\b[^.]{0,20}\\b(data|information)\\b",
      "\\bmonetiz\\w*\\b[^.]{0,30}\\bdata\\b",
      "\\bin exchange for (?:monetary|valuable) consideration\\b",
      "\\bmay sell\\b[^.]{0,30}\\b(?:information|data)\\b"
    ]
  },
  {
    "id": "vague_sharing",
    "label": "Vague third-party sharing",
    "severity": "medium",
    "patterns": [
      "\\baffiliates and (?:business )?partners\\b",
      "\\b(?:affiliates|partners)\\b[^.]{0,30}\\bthird[- ]part(?:y|ies)\\b",
      "\\bthird[- ]part(?:y|ies)\\b[^.]{0,20}\\bfor (?:any|other) purposes?\\b",
      "\\bshare\\w*\\b[^.]{0,30}\\bwith (?:our )?partners\\b",
      "\\bmarketing partners\\b",
      "\\bvendors,?\\s*partners,?\\s*and\\s*affiliates\\b"
    ]
  },
  {
    "id": "indefinite_retention",
    "label": "Indefinite or unclear data retention",
    "severity": "medium",
    "patterns": [
      "\\bas long as (?:necessary|needed)\\b",
      "\\bindefinite(?:ly)?\\b[^.]{0,20}\\bretain\\w*\\b",
      "\\bretain\\w*\\b[^.]{0,30}\\bindefinite(?:ly)?\\b",
      "\\bno (?:fixed|specific|set) retention period\\b"
    ]
  },
  {
    "id": "biometric",
    "label": "Biometric or sensitive data collection",
    "severity": "high",
    "patterns": [
      "\\bbiometric\\w*\\b",
      "\\bfacial recognition\\b",
      "\\bfingerprint\\w*\\b",
      "\\bvoiceprint\\w*\\b",
      "\\bgenetic (?:data|information)\\b"
    ]
  },
  {
    "id": "broad_license",
    "label": "Broad content license grant",
    "severity": "high",
    "patterns": [
      "\\bperpetual,?\\s*(?:irrevocable,?\\s*)?(?:worldwide,?\\s*)?(?:royalty[- ]free,?\\s*)?license\\b",
      "\\birrevocable\\b[^.]{0,30}\\blicense\\b",
      "\\bright to use\\b[^.]{0,30}\\bany purpose\\b",
      "\\bsublicensable\\b"
    ]
  },
  {
    "id": "opt_out_only",
    "label": "Opt-out-only consent (buried opt-out)",
    "severity": "medium",
    "patterns": [
      "\\bunless you opt[- ]out\\b",
      "\\bautomatically enroll\\w*\\b",
      "\\bdefault\\w*\\s+to\\s+(?:on|enabled)\\b",
      "\\bpre[- ]checked\\b"
    ]
  },
  {
    "id": "unilateral_changes",
    "label": "Unilateral policy changes without notice",
    "severity": "medium",
    "patterns": [
      "\\bwithout\\b[^.]{0,20}\\bnotice\\b",
      "\\bsole discretion\\b[^.]{0,30}\\b(?:modify|change)\\b"
    ]
  },
  {
    "id": "arbitration",
    "label": "Binding arbitration / class-action waiver",
    "severity": "high",
    "patterns": [
      "\\bbinding\\b[^.]{0,25}\\barbitration\\b",
      "\\bclass\\s+actions?\\b",
      "\\bwaive\\w*\\b[^.]{0,20}\\bright to a jury trial\\b",
      "\\bindividual basis\\b[^.]{0,30}\\barbitration\\b",
      "\\bmandatory arbitration\\b"
    ]
  },
  {
    "id": "weak_deletion_rights",
    "label": "Weak or limited deletion/access rights",
    "severity": "medium",
    "patterns": [
      "\\bcannot\\b[^.]{0,20}\\bguarantee\\b[^.]{0,20}\\bdeletion\\b",
      "\\bmay retain\\b[^.]{0,30}\\bafter (?:deletion|account closure)\\b",
      "\\bresidual copies\\b",
      "\\bbackup (?:systems|copies)\\b[^.]{0,30}\\bretain\\w*\\b"
    ]
  },
  {
    "id": "tracking_profiling",
    "label": "Extensive tracking / behavioral profiling",
    "severity": "medium",
    "patterns": [
      "\\bbehavioral advertising\\b",
      "\\bcross[- ]device tracking\\b",
      "\\bthird[- ]party (?:analytics|advertising) (?:cookies|sdks?|pixels?)\\b",
      "\\bprofile\\w*\\b[^.]{0,30}\\bbased on your\\b[^.]{0,30}\\bactivity\\b"
    ]
  }
];
  var NEGATION_WORDS = ["not", "never", "no longer", "won't", "will not", "don't", "does not", "doesn't", "without selling", "unless you", "except as", "n't"];
  var SEVERITY_RANK = { none: 0, low: 1, medium: 2, high: 3 };
  var SENTENCE_SPLIT_RE = /(?<=[.!?])\s+|\n+/;

  function isNegated(sentence, matchStart) {
    var prefix = sentence.slice(0, matchStart).toLowerCase();
    for (var i = 0; i < NEGATION_WORDS.length; i++) {
      if (prefix.indexOf(NEGATION_WORDS[i]) !== -1) return true;
    }
    return false;
  }

  // Scraped policy text overwhelmingly uses "smart" quotes/apostrophes;
  // NEGATION_WORDS is written with straight ones, so without this a denial
  // like "We don’t sell your data" would fail to match "don't" and get
  // flagged as a red flag instead of correctly suppressed.
  function normalizeQuotes(text) {
    return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  }

  function analyze(text) {
    if (!text || !text.trim()) {
      return { riskLevel: "unknown", categories: [] };
    }

    text = normalizeQuotes(text);
    var sentences = text.split(SENTENCE_SPLIT_RE);
    var results = [];

    for (var c = 0; c < CATEGORIES.length; c++) {
      var category = CATEGORIES[c];
      var matches = [];

      for (var s = 0; s < sentences.length; s++) {
        var sentence = sentences[s];
        for (var p = 0; p < category.patterns.length; p++) {
          var re = new RegExp(category.patterns[p], "i");
          var m = re.exec(sentence);
          if (m && !isNegated(sentence, m.index)) {
            var snippet = sentence.trim().slice(0, 200);
            if (snippet && matches.indexOf(snippet) === -1) {
              matches.push(snippet);
            }
            break;
          }
        }
        if (matches.length >= 3) break;
      }

      if (matches.length) {
        results.push({
          id: category.id,
          label: category.label,
          severity: category.severity,
          matches: matches.slice(0, 3),
        });
      }
    }

    var riskLevel;
    if (!results.length) {
      riskLevel = "low";
    } else {
      var topSeverity = 0;
      for (var r = 0; r < results.length; r++) {
        topSeverity = Math.max(topSeverity, SEVERITY_RANK[results[r].severity]);
      }
      riskLevel = { 3: "high", 2: "medium", 1: "low" }[topSeverity] || "low";
    }

    return { riskLevel: riskLevel, categories: results };
  }

  root.RedFlagsEngine = { analyze: analyze };
})(typeof window !== "undefined" ? window : this);
