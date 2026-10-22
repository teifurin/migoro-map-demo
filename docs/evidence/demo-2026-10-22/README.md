# Offline regression fixtures / オフライン回帰テスト

`gemini/*.json` contains minimized, previously recorded analysis outputs for synthetic demo inputs. All source images are AI-generated; post text, authors, and observation dates are fictional. These files are not current field observations or a live API status report.

Only the analysis fields needed for offline behavior checks are retained. Request envelopes, diagnostic logs, retry traces, token counts, latency, and model metadata are omitted. The remaining timestamps and fingerprints belong to synthetic test inputs, not personal activity.

Run from the repository root without API access:

```sh
node docs/evidence/scripts/demo-simulate.js
node --test tests/frontend.test.js
```

The regression cases cover adding a new inferred location, asking a person to resolve an ambiguous area, retaining an old-photo result as history, and keeping a whole-site location separate from a sub-area. The fixture results do not measure model accuracy or guarantee identical results from a new API call.

`ui/` contains illustrative screenshots using saved synthetic results. They show an earlier UI and may include historical model labels or an API-key-missing status, not a credential. They do not demonstrate live API availability or current seasonal conditions. Map imagery is attributed to the Geospatial Information Authority of Japan (国土地理院); geocoding data is © OpenStreetMap contributors, ODbL.
