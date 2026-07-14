# classifier/

Build-time only -- nothing here is imported by the Django app or the
extension at runtime. It produces a single static artifact,
`dist/redflags-engine.js`, which is copied into `extension/` and
`website/tracker/static/tracker/js/` and loaded there as a plain `<script>`.

## Phase 1 (current): lexicon/heuristics only

`lexicon.py` is the source of truth: a list of categories, each with regex
patterns and a severity. `analyze()` in that file is a pure-Python reference
implementation, useful for sanity-checking rule changes against real policy
text before exporting.

To regenerate the shipped engine after editing `lexicon.py`:

```
python3 export_js.py   # writes dist/redflags-engine.js
./sync.sh               # copies it into extension/ and website static
```

Quick sanity check against a pasted policy:

```
python3 -c "import lexicon, json; print(json.dumps(lexicon.analyze(open('policy.txt').read()), indent=2))"
```

## Phase 2 (future): trained per-category classifier

`train.py` is a skeleton for training a LogisticRegression per category on
the OPP-115 corpus (https://usableprivacy.org/data -- manual download,
non-commercial research license, not fetched automatically by anything
here). Once trained, `export_js.py` would be extended to merge each
category's model (via `m2cgen`) alongside its lexicon patterns in
`dist/redflags-engine.js`, without changing the engine's public
`analyze(text) -> { riskLevel, categories }` contract -- so nothing in
`extension/popup.js` or the website templates needs to change when Phase 2
lands.
