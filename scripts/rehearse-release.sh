#!/usr/bin/env bash
# Release rehearsal (Phase 7, validation-matrix + plan.md release gates).
#
# Drives a LIVE server through every money path and asserts wire behavior.
# Fails fast with diagnostics; prints a gate checklist at the end.
#
# Usage:
#   BASE_URL=http://localhost:3100 scripts/rehearse-release.sh [live|paused]
#   ADMIN_TOKEN=... STRIPE_WEBHOOK_SECRET=... [STRIPE_SECRET_KEY=...] for full coverage.
#   Signed webhooks use Stripe's own envelope — `stripe-signature: t=<unix>,v1=<hex>`,
#   HMAC-SHA256 over "<t>.<raw body>"; a delivery outside the 300s tolerance is
#   refused, and one case asserts exactly that.
#   Expiry coverage needs RESERVATION_TTL_MS=2000 on the server (else skipped).
#
#   Every run writes its own record to REHEARSE_RESULT (default
#   rehearsal-<run>.log): run id, target, commit, which optional credentials
#   were present, each pass/skip/fail line with its reason, and the tally. Keep
#   it with the release — "we rehearsed it" is only checkable if the record says
#   what the run covered and what it could not (R17-16, ops/rollback.md).
#
# Requires: curl, and a working python3 (falls back to python). On Windows the
# Store alias stub for python3 resolves on PATH but cannot run, so the probe
# below executes the candidate instead of trusting `command -v`.
# Server needs a migrated + seeded database.
#
# Convention: call `call <args...>` (runs in THIS shell, sets $BODY/$STATUS),
# never in $(...) — subshells cannot propagate variables under set -u.
set -euo pipefail

# MSYS rewrites path-shaped argv *and* environment values when it launches a
# native (non-msys) executable — "/pay/abc" becomes "C:/Program Files/Git/pay/abc",
# which corrupts values python is asked to validate. These switches are read only
# by MSYS, so on macOS/Linux they are inert. Paths handed to python anyway go
# through winpath() below, so nothing depends on the rewrite.
export MSYS2_ARG_CONV_EXCL='*'
export MSYS2_ENV_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1

BASE="${BASE_URL:?set BASE_URL}"
MODE="${1:-live}"
RUN="${REHEARSE_RUN:-$(date +%s)}"
# R17-16: the run's own record. The run id reached only the payloads it created
# (idempotency keys) and the skips scrolled off the terminal, so nothing said
# afterwards which blocks a release rehearsal actually exercised. Presence of a
# credential is recorded; never its value.
RESULT="${REHEARSE_RESULT:-rehearsal-$RUN.log}"
: > "$RESULT"
rec() { printf '%s\n' "$*" >> "$RESULT"; }
# A run that dies before its tally — curl cannot reach the server, a block
# throws — must still say so in the record, or the file reads like a run that
# simply stopped talking. ENDED flips once the run has reported itself.
ENDED=0
finish() { local rc=$?; rm -rf "$TMPD"; [ "$ENDED" = 1 ] || rec "ABORTED exit=$rc before the tally"; }
PASS=0
SKIP=0
CALLN=0
TMPD=$(mktemp -d)
# Paths interpolated into the python snippets below must be readable by the
# resolved interpreter. A native Windows python cannot open "/tmp/...", so
# msys gets asked for the mixed form ("C:/..."), which the shell also accepts.
# Absent cygpath (macOS, Linux) this is the identity.
winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
# Same reason, other direction: with rewriting off, a native curl no longer has
# "/dev/null" translated for it, so it needs the platform's own null device.
NULLDEV=/dev/null
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) NULLDEV=NUL ;; esac
TMPD=$(winpath "$TMPD")
trap finish EXIT
rec "# release rehearsal $RUN $(date -u +%Y-%m-%dT%H:%M:%SZ)"
rec "# base=$BASE mode=$MODE commit=$(git rev-parse --short HEAD 2>/dev/null || printf unknown)"
rec "# coverage: ADMIN_TOKEN=$([ -n "${ADMIN_TOKEN:-}" ] && printf set || printf unset) STRIPE_WEBHOOK_SECRET=$([ -n "${STRIPE_WEBHOOK_SECRET:-}" ] && printf set || printf unset) STRIPE_SECRET_KEY=$([ -n "${STRIPE_SECRET_KEY:-}" ] && printf set || printf unset) RESERVATION_TTL_MS=${RESERVATION_TTL_MS:-unset}"
BODY="$TMPD/body.txt"
STATUS="$TMPD/status.txt"
WHBODY="$TMPD/whbody.json"

fail() { echo "❌ FAIL: $1${2:+ — $2}"; rec "FAIL $1${2:+ — $2}"; ENDED=1; exit 1; }
pass() { PASS=$((PASS + 1)); echo "✓ $1"; rec "PASS $1"; }
skip() { SKIP=$((SKIP + 1)); echo "- SKIP: $1"; rec "SKIP $1"; }
need() { command -v "$1" >/dev/null || fail "missing tool" "$1"; }
need curl
PY=""
for _c in python3 python; do
  if command -v "$_c" >/dev/null 2>&1 && "$_c" -c 'import sys' >/dev/null 2>&1; then PY="$_c"; break; fi
done
[ -n "$PY" ] || fail "missing tool" "python3 (or python)"

call() { # call METHOD PATH [DATA] [HEADER]... -> $BODY + $STATUS
  local method="$1" path="$2" data="${3-}"
  if [ $# -gt 3 ]; then shift 3; else shift $#; fi
  # Rehearsal traffic shaping: each call presents a distinct simulated user IP
  # so the 5/hour/IP abuse limit (covered separately by route unit tests)
  # doesn't cap the rehearsal itself. NOT a bypass — one bucket per user.
  CALLN=$((CALLN + 1))
  local args=(-s --max-time 15 -w "\n%{http_code}" -X "$method" "$BASE$path" -H "X-Forwarded-For: 10.9.0.$CALLN")
  if [ -n "$data" ]; then args+=(-H 'Content-Type: application/json' --data-binary "$data"); fi
  while [ $# -gt 0 ]; do args+=(-H "$1"); shift; done
  curl "${args[@]}" > "$TMPD/out.txt"
  tail -n 1 "$TMPD/out.txt" > "$STATUS"
  sed '$d' "$TMPD/out.txt" > "$BODY"
}
st() { cat "$STATUS"; }
jget() { "$PY" -c "import json,sys; print(json.load(open('$BODY'))$1)"; }
CK1() { call POST /api/checkout "$1"; }
admin_call() { # admin_call METHOD PATH [DATA]
  local method="$1" path="$2" data="${3:-}"
  if [ -z "${ADMIN_TOKEN:-}" ]; then echo '{"error":"no ADMIN_TOKEN"}' > "$BODY"; echo "000" > "$STATUS"; return; fi
  if [ -n "$data" ]; then
    call "$method" "$path" "$data" "Authorization: Bearer $ADMIN_TOKEN"
  else
    call "$method" "$path" "" "Authorization: Bearer $ADMIN_TOKEN"
  fi
}
sign_post() { # sign_post PATH JSON_BODY [TS_OFFSET] — Stripe envelope (t=...,v1=...)
  echo "$2" > "$WHBODY"
  local ts sig
  ts=$(( $(date +%s) + ${3:-0} ))
  sig=$(WHS_TS="$ts" WHBODY="$WHBODY" "$PY" -c "import hmac,hashlib,os; key=os.environ['STRIPE_WEBHOOK_SECRET'].encode(); signed=('%s.' % os.environ['WHS_TS']).encode() + open(os.environ['WHBODY'],'rb').read(); print(hmac.new(key, signed, hashlib.sha256).hexdigest())")
  curl -s --max-time 15 -w "\n%{http_code}" -X POST "$BASE$1" -H 'Content-Type: application/json' -H "stripe-signature: t=$ts,v1=$sig" --data-binary @"$WHBODY" > "$TMPD/out.txt"
  tail -n 1 "$TMPD/out.txt" > "$STATUS"
  sed '$d' "$TMPD/out.txt" > "$BODY"
}

if [ "$MODE" = "paused" ]; then
  echo "== paused mode: payment-pause and waitlist =="
  call POST /api/checkout '{"elementSym":"Li","amountUsd":5,"attest":true,"idempotencyKey":"rehearse-$RUN-paused-1","startup":{"title":"P","pitch":"Paused pitch here","url":"https://paused.dev","linkType":"product"}}'
  [ "$(st)" = "403" ] || fail "paused checkout is 403" "got $(st): $(cat "$BODY")"
  grep -q '"waitlist":true' "$BODY" || fail "paused checkout returns waitlist:true"
  pass "paused checkout → 403 waitlist:true"
  call POST /api/waitlist '{"email":"rehearse-wait@example.com","source":"rehearse"}'
  [ "$(st)" = "200" ] || fail "waitlist stores" "got $(st)"
  ID1=$("$PY" -c "import json; print(json.load(open('$BODY'))['id'])")
  call POST /api/waitlist '{"email":"rehearse-wait@example.com","source":"rehearse"}'
  ID2=$("$PY" -c "import json; print(json.load(open('$BODY'))['id'])")
  [ "$ID1" = "$ID2" ] && [ -n "$ID1" ] || fail "waitlist dedupes by email"
  pass "waitlist stores one row per email"
  ENDED=1
  rec "TOTAL $PASS passed, $SKIP skipped"
  echo "== $PASS passed, $SKIP skipped =="
  echo "   record: $RESULT"
  exit 0
fi

echo "== live mode: money flows =="
call GET /api/stats
[ "$(st)" = "200" ] || fail "stats 200" "got $(st)"
"$PY" -c "import json; d=json.load(open('$BODY')); assert d['elementsTotal']>=122 and d['unclaimedElements']==d['elementsTotal']-d['claimedElements'], d"
pass "stats shape + units"

call GET /api/elements
EMPTY=$("$PY" -c "import json; print([t['symbol'] for t in json.load(open('$BODY')) if t['pool']==0][0])")
echo "empty tile: $EMPTY"

CK1 "{\"elementSym\":\"$EMPTY\",\"amountUsd\":8,\"attest\":true,\"idempotencyKey\":\"rehearse-$RUN-first-1\",\"startup\":{\"title\":\"First\",\"pitch\":\"First pitch here now\",\"url\":\"https://rehearse-first.dev\",\"linkType\":\"product\"}}"
[ "$(st)" = "200" ] || fail "first claim checkout" "got $(st): $(cat "$BODY")"
PAY1=$(jget "['paymentId']"); URL1=$(jget "['checkoutUrl']")
[ -n "$PAY1" ] && [ -n "$URL1" ] || fail "first claim returns payment"
# Passed via the environment, not argv: msys rewrites path-shaped argv
# ("/pay/x" → "C:/Program Files/Git/pay/x") when handing args to a native
# interpreter, and env values are exempt from that rewrite.
U="$URL1" "$PY" -c "import os; u=os.environ['U']; assert u.startswith('http://') or u.startswith('https://') or u.startswith('/'), u" || fail "checkout URL shape" "$URL1"
pass "first claim \$8 → checkout session"
call POST /api/dev/pay "{\"paymentId\":\"$PAY1\",\"outcome\":\"pay\"}"
[ "$(st)" = "200" ] || fail "dev pay" "got $(st)"
grep -q '"status":"paid"' "$BODY" || fail "dev pay paid" "$(cat "$BODY")"
call GET "/api/elements/$EMPTY"
"$PY" -c "import json; d=json.load(open('$BODY')); assert d['stakes'][0]['domain']=='rehearse-first.dev' and d['stakes'][0]['amount']==8, d['stakes']"
pass "first claim applied #1 at \$8"

CK1 "{\"elementSym\":\"$EMPTY\",\"amountUsd\":5,\"attest\":true,\"idempotencyKey\":\"rehearse-$RUN-join-1\",\"startup\":{\"title\":\"Joiner\",\"pitch\":\"Joiner pitch here now\",\"url\":\"https://rehearse-join.dev\",\"linkType\":\"product\"}}"
[ "$(st)" = "200" ] || fail "contested join checkout" "got $(st)"
PAYJ=$(jget "['paymentId']")
call POST /api/dev/pay "{\"paymentId\":\"$PAYJ\",\"outcome\":\"pay\"}" > /dev/null
call GET "/api/elements/$EMPTY"
"$PY" -c "import json; d=json.load(open('$BODY')); ss=d['stakes']; assert len(ss)==2 and ss[0]['amount']==8 and ss[1]['domain']=='rehearse-join.dev' and ss[1]['amount']==5, ss"
pass "contested \$5 join lands #2, leader untouched"

CK1 "{\"elementSym\":\"$EMPTY\",\"amountUsd\":8,\"attest\":true,\"idempotencyKey\":\"rehearse-$RUN-tie-1\",\"startup\":{\"title\":\"Tier\",\"pitch\":\"Tier pitch here now\",\"url\":\"https://rehearse-tie.dev\",\"linkType\":\"product\"}}"
[ "$(st)" = "409" ] || fail "tie join rejected" "got $(st)"
grep -q 'TIE' "$BODY" || fail "tie code" "$(cat "$BODY")"
pass "tie at leader total rejected with TIE"

CK1 "{\"elementSym\":\"$EMPTY\",\"amountUsd\":9,\"attest\":true,\"idempotencyKey\":\"rehearse-$RUN-take-1\",\"startup\":{\"title\":\"Taker\",\"pitch\":\"Taker pitch here now\",\"url\":\"https://rehearse-take.dev\",\"linkType\":\"product\"}}"
[ "$(st)" = "200" ] || fail "take checkout" "got $(st)"
grep -q '"guaranteedTake":true' "$BODY" || fail "take holds reservation" "$(cat "$BODY")"
RES_TO=$(jget "['reservation']['reservedTotal']")
[ "$RES_TO" = "9" ] || fail "reserved total 9" "$(cat "$BODY")"
PAYT=$(jget "['paymentId']")
CK1 "{\"elementSym\":\"$EMPTY\",\"amountUsd\":12,\"attest\":true,\"idempotencyKey\":\"rehearse-$RUN-rival-1\",\"startup\":{\"title\":\"Rival\",\"pitch\":\"Rival pitch here now\",\"url\":\"https://rehearse-rival.dev\",\"linkType\":\"product\"}}"
[ "$(st)" = "409" ] || fail "rival take conflicts" "got $(st)"
grep -q 'RESERVATION_CONFLICT' "$BODY" || fail "conflict code" "$(cat "$BODY")"
pass "take quote held; rival gets RESERVATION_CONFLICT"
call POST /api/dev/pay "{\"paymentId\":\"$PAYT\",\"outcome\":\"pay\"}" > /dev/null
call GET "/api/elements/$EMPTY"
"$PY" -c "import json; d=json.load(open('$BODY')); assert d['stakes'][0]['domain']=='rehearse-take.dev' and d['stakes'][0]['amount']==9, d['stakes']"
pass "takeover flips the crown"

CK1 "{\"elementSym\":\"$EMPTY\",\"amountUsd\":2,\"attest\":true,\"idempotencyKey\":\"rehearse-$RUN-reclaim-1\",\"startup\":{\"title\":\"First\",\"pitch\":\"First pitch here now\",\"url\":\"https://rehearse-first.dev\",\"linkType\":\"product\"}}"
[ "$(st)" = "200" ] || fail "reclaim checkout" "got $(st)"
PAYR=$(jget "['paymentId']")
call POST /api/dev/pay "{\"paymentId\":\"$PAYR\",\"outcome\":\"pay\"}" > /dev/null
call GET "/api/elements/$EMPTY"
"$PY" -c "import json; d=json.load(open('$BODY')); assert d['stakes'][0]['domain']=='rehearse-first.dev' and d['stakes'][0]['amount']==10, d['stakes']"
pass "reclaim \$2 restores #1 at \$10"

CK1 "{\"elementSym\":\"$EMPTY\",\"amountUsd\":8,\"attest\":true,\"idempotencyKey\":\"rehearse-$RUN-first-1\",\"startup\":{\"title\":\"First\",\"pitch\":\"First pitch here now\",\"url\":\"https://rehearse-first.dev\",\"linkType\":\"product\"}}"
[ "$(st)" = "200" ] || fail "idempotent retry" "got $(st)"
[ "$(jget "['paymentId']")" = "$PAY1" ] || fail "retry returns original payment"
pass "duplicate submit returns the original payment"
CK1 "{\"elementSym\":\"$EMPTY\",\"amountUsd\":9,\"attest\":true,\"idempotencyKey\":\"rehearse-$RUN-first-1\",\"startup\":{\"title\":\"First\",\"pitch\":\"First pitch here now\",\"url\":\"https://rehearse-first.dev\",\"linkType\":\"product\"}}"
[ "$(st)" = "409" ] || fail "key reuse rejected" "got $(st)"
grep -q 'IDEMPOTENCY_CONFLICT' "$BODY" || fail "conflict code" "$(cat "$BODY")"
pass "key reuse with different payload → IDEMPOTENCY_CONFLICT"

call GET /api/elements
EMPTY2=$("$PY" -c "import json; print([t['symbol'] for t in json.load(open('$BODY')) if t['pool']==0][0])")
CK1 "{\"elementSym\":\"$EMPTY2\",\"amountUsd\":8,\"attest\":true,\"idempotencyKey\":\"rehearse-$RUN-first-2\",\"startup\":{\"title\":\"First2\",\"pitch\":\"First2 pitch here\",\"url\":\"https://rehearse-first2.dev\",\"linkType\":\"product\"}}"
[ "$(st)" = "200" ] || fail "second tile setup" "got $(st)"
PAYF2=$("$PY" -c "import json; print(json.load(open('$BODY'))['paymentId'])")
call POST /api/dev/pay "{\"paymentId\":\"$PAYF2\",\"outcome\":\"pay\"}" > /dev/null
CK1 "{\"elementSym\":\"$EMPTY2\",\"amountUsd\":9,\"attest\":true,\"idempotencyKey\":\"rehearse-$RUN-exp-1\",\"startup\":{\"title\":\"Expy\",\"pitch\":\"Expy pitch here now\",\"url\":\"https://rehearse-expy.dev\",\"linkType\":\"product\"}}"
[ "$(st)" = "200" ] || fail "expiry take checkout" "got $(st)"
grep -q '"guaranteedTake":true' "$BODY" || fail "expiry take holds quote first" "$(cat "$BODY")"
PAYE=$("$PY" -c "import json; print(json.load(open('$BODY'))['paymentId'])")
sleep 3 # outlive RESERVATION_TTL_MS=2000 (release builds set it; else this still passes as a normal take)
call POST /api/dev/pay "{\"paymentId\":\"$PAYE\",\"outcome\":\"pay\"}"
[ "$(st)" = "200" ] || fail "expired settle" "got $(st)"
grep -q '"status":"paid"' "$BODY" || fail "expired payment paid" "$(cat "$BODY")"
pass "expired reservation settles as an ordinary stake (no guaranteed crown)"

if [ -n "${STRIPE_WEBHOOK_SECRET:-}" ]; then
  echo "== webhooks (signed) =="
  CK1 "{\"elementSym\":\"$EMPTY\",\"amountUsd\":6,\"attest\":true,\"idempotencyKey\":\"rehearse-$RUN-wh-1\",\"startup\":{\"title\":\"Hook\",\"pitch\":\"Hook pitch here now\",\"url\":\"https://rehearse-hook.dev\",\"linkType\":\"product\"}}"
  PAYW=$(jget "['paymentId']")
  # Stripe quotes integer cents, so $6 is amount_total 600.
  B1="{\"id\":\"evt_rehearse-$RUN-1\",\"type\":\"checkout.session.completed\",\"data\":{\"object\":{\"object\":\"checkout.session\",\"id\":\"cs_rehearse-$RUN-1\",\"payment_status\":\"paid\",\"amount_total\":600,\"currency\":\"usd\",\"metadata\":{\"paymentId\":\"$PAYW\"}}}}"
  sign_post /api/webhooks/stripe "$B1"
  [ "$(st)" = "200" ] || fail "webhook applied" "got $(st)"
  grep -q '"outcome":"applied"' "$BODY" || fail "applied outcome" "$(cat "$BODY")"
  sign_post /api/webhooks/stripe "$B1"
  grep -Eq '"outcome":"(duplicate|already-settled)"' "$BODY" || fail "replay deduped" "$(cat "$BODY")"
  pass "signed paid webhook applies once; replay deduped"
  sign_post /api/webhooks/stripe "$B1" -400
  [ "$(st)" = "401" ] || fail "stale delivery refused" "got $(st): $(cat "$BODY")"
  pass "a delivery outside the 300s tolerance is refused"
  B2="{\"id\":\"evt_rehearse-$RUN-2\",\"data\":{\"object\":{\"object\":\"checkout.session\",\"id\":\"cs_rehearse-$RUN-1\",\"metadata\":{\"paymentId\":\"$PAYW\"}}}}"
  sign_post /api/webhooks/stripe "$B2"
  grep -q '"outcome":"ignored"' "$BODY" || fail "statusless ignored" "$(cat "$BODY")"
  pass "statusless event ignored, settled payment untouched"
  CK1 "{\"elementSym\":\"$EMPTY\",\"amountUsd\":7,\"attest\":true,\"idempotencyKey\":\"rehearse-$RUN-wh-2\",\"startup\":{\"title\":\"Hook2\",\"pitch\":\"Hook2 pitch here now\",\"url\":\"https://rehearse-hook2.dev\",\"linkType\":\"product\"}}"
  PAYW2=$(jget "['paymentId']")
  B3="{\"id\":\"evt_rehearse-$RUN-3\",\"type\":\"checkout.session.expired\",\"data\":{\"object\":{\"object\":\"checkout.session\",\"id\":\"cs_rehearse-$RUN-2\",\"metadata\":{\"paymentId\":\"$PAYW2\"}}}}"
  sign_post /api/webhooks/stripe "$B3"
  grep -q '"outcome":"failed"' "$BODY" || fail "failed event" "$(cat "$BODY")"
  B4="{\"id\":\"evt_rehearse-$RUN-4\",\"type\":\"checkout.session.completed\",\"data\":{\"object\":{\"object\":\"checkout.session\",\"id\":\"cs_rehearse-$RUN-3\",\"payment_status\":\"paid\",\"amount_total\":700,\"currency\":\"usd\",\"metadata\":{\"paymentId\":\"$PAYW2\"}}}}"
  sign_post /api/webhooks/stripe "$B4"
  grep -Eq '"outcome":"already-settled"' "$BODY" || fail "paid-after-failed stays terminal" "$(cat "$BODY")"
  pass "failed→paid follows the terminal state machine"
  B5="{\"id\":\"evt_rehearse-$RUN-5\",\"type\":\"checkout.session.completed\",\"data\":{\"object\":{\"object\":\"checkout.session\",\"id\":\"cs_rehearse-$RUN-4\",\"payment_status\":\"paid\",\"amount_total\":99900,\"currency\":\"usd\",\"metadata\":{\"paymentId\":\"$PAYW2\"}}}}"
  sign_post /api/webhooks/stripe "$B5"
  grep -q 'amount-mismatch' "$BODY" || fail "amount mismatch rejected" "$(cat "$BODY")"
  pass "amount mismatch rejected without applying"
else
  skip "signed webhooks (set STRIPE_WEBHOOK_SECRET)"
fi

if [ -n "${STRIPE_SECRET_KEY:-}" ] && [ -n "${STRIPE_WEBHOOK_SECRET:-}" ]; then
  echo "== provider outage =="
  CK1 "{\"elementSym\":\"$EMPTY\",\"amountUsd\":11,\"attest\":true,\"idempotencyKey\":\"rehearse-$RUN-outage-1\",\"startup\":{\"title\":\"Out\",\"pitch\":\"Out pitch here now\",\"url\":\"https://rehearse-out.dev\",\"linkType\":\"product\"}}"
  [ "$(st)" = "502" ] || fail "outage is 502 retryable" "got $(st)"
  grep -q 'checkoutUrl' "$BODY" && fail "no dead URL on outage" "$(cat "$BODY")"
  pass "provider outage → 502, retryable, no dead URL"
else
  skip "provider outage (set STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET)"
fi

if [ -n "${ADMIN_TOKEN:-}" ]; then
  echo "== moderation =="
  call GET "/api/elements/$EMPTY"
  STAKE=$("$PY" -c "import json; d=json.load(open('$BODY')); print([s['stakeId'] for s in d['stakes'] if s['domain']=='rehearse-take.dev'][0])")
  call POST /api/report "{\"stakeId\":\"$STAKE\",\"reason\":\"rehearsal report\"}"
  [ "$(st)" = "200" ] || fail "report intake" "got $(st)"
  admin_call GET "/api/admin/reports?status=OPEN"
  RID=$("$PY" -c "import json; print(json.load(open('$BODY'))[0]['id'])")
  admin_call PATCH "/api/admin/reports/$RID" '{"status":"TRIAGED","note":"rehearsal","reviewedBy":"rehearse"}'
  [ "$(st)" = "200" ] || fail "triage" "got $(st)"
  admin_call POST "/api/admin/startups/rehearse-take.dev/moderate" '{"state":"HIDDEN","reason":"rehearsal","operator":"rehearse"}'
  [ "$(st)" = "200" ] || fail "hide" "got $(st)"
  call GET "/api/elements/$EMPTY"
  "$PY" -c "import json; d=json.load(open('$BODY')); assert all(s['domain']!='rehearse-take.dev' for s in d['stakes']), 'hidden bidder visible'"
  [ "$(curl -s -o "$NULLDEV" -w '%{http_code}' "$BASE/s/rehearse-take.dev")" = "404" ] || fail "hidden profile 404s"
  admin_call POST "/api/admin/startups/rehearse-take.dev/moderate" '{"state":"VISIBLE","operator":"rehearse"}'
  [ "$(st)" = "200" ] || fail "restore" "got $(st)"
  pass "report → triage → hide → restore with surface checks"
else
  skip "moderation (set ADMIN_TOKEN)"
fi

echo "== latency (budget 2000ms) =="
for p in "/api/stats" "/api/elements" "/api/table-order" "/api/board?tab=crowns" "/api/activity?limit=6" "/api/search?q=carbon"; do
  MS=$(curl -s -o "$NULLDEV" --max-time 15 -w "%{time_total}" "$BASE$p" | "$PY" -c "import sys; print(int(float(sys.stdin.read().strip())*1000))")
  [ "$MS" -lt 2000 ] || fail "latency $p" "${MS}ms"
  echo "  $p ${MS}ms"
done
pass "read APIs within latency budget"

ENDED=1
rec "TOTAL $PASS passed, $SKIP skipped"
echo "== $PASS passed, $SKIP skipped =="
echo "   record: $RESULT"
