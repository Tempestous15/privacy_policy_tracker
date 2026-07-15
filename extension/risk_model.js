// Unified per-site risk model with two channels that are deliberately
// never blended into one score:
//
//   - "disclosed" -- what the site's privacy policy states: ToS;DR's
//     community rating/points (tosdr.js) and/or the local lexicon scan of
//     the policy text (redflags-engine.js). Both are readings of the
//     policy itself.
//   - "observed" -- what's technically detectable happening on the site,
//     independent of anything the policy claims (tracker_radar_client.js).
//
// A browser extension cannot see a company's actual internal data
// handling -- only public disclosures and technically observable network
// behavior. Keeping these channels separate (rather than combining them
// into a single score) is intentional: a blended score would imply a
// certainty about "what a site does with your data" that neither source
// can actually support on its own. Do not add a combined/blended score to
// this file -- see root README.md "Two-channel risk model".

const RISK_LEVEL_ORDER = { low: 0, medium: 1, high: 2 };

// Maps a ToS;DR letter grade onto the same low/medium/high scale used for
// observedLevel below, so the two are coarsely comparable. ToS;DR's scale
// is A (best) through E (worst); "N/A" means "reviewed, not yet graded" --
// returns null rather than guessing in that case, same as an unreviewed
// service (no data in, no data out).
function disclosedLevelFromTosdrRating(rating) {
  if (!rating) return null;
  const r = String(rating).toUpperCase();
  if (r === "A" || r === "B") return "low";
  if (r === "C") return "medium";
  if (r === "D" || r === "E") return "high";
  return null;
}

// tracker_radar's riskScore is already 0-100 (see tracker_radar/README.md
// "The scoring rule") -- this just buckets it onto the same 3-level scale
// used above. riskScore is null when tracker_radar/score.py withholds it
// for thin dataset coverage (see its coverage-handling section); that null
// must stay null here too, never defaulted to "low".
function observedLevelFromRiskScore(riskScore) {
  if (riskScore === null || riskScore === undefined) return null;
  if (riskScore < 25) return "low";
  if (riskScore < 60) return "medium";
  return "high";
}

// Compares the two channels' levels. Returns one of:
//   { comparable: false }                     -- one or both sides unknown
//   { comparable: true, agree: true }          -- same or adjacent bucket
//   { comparable: true, agree: false, note }   -- >=2 buckets apart, i.e.
//                                                  a real mismatch worth
//                                                  surfacing to the user
//
// This is a deliberately coarse 3-bucket comparison, not a numeric diff --
// the two scores come from unrelated methodologies (community policy
// review vs. weighted tracker categories) with different scales and
// error bars, so treating a small gap as "disagreement" would overstate
// how precisely comparable they really are.
function compareChannels(disclosedLevel, observedLevel) {
  if (!disclosedLevel || !observedLevel) return { comparable: false };
  const gap = Math.abs(RISK_LEVEL_ORDER[disclosedLevel] - RISK_LEVEL_ORDER[observedLevel]);
  if (gap < 2) return { comparable: true, agree: true };
  const note =
    disclosedLevel === "low"
      ? "The stated policy looks relatively clean, but we detected a high level of tracking activity on this site."
      : "We detected relatively little tracking activity on this site, despite the stated policy raising more red flags.";
  return { comparable: true, agree: false, note };
}

window.SiteRiskModel = {
  disclosedLevelFromTosdrRating,
  observedLevelFromRiskScore,
  compareChannels,
  RISK_LEVEL_ORDER,
};
