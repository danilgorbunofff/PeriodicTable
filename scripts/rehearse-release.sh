#!/usr/bin/env bash
# Release rehearsal (Phase 7, validation-matrix + plan.md release gates).
#
# Drives a LIVE server through every money path and asserts wire behavior.
# Fails fast with diagnostics; prints a gate checklist at the end.
#
# Usage:
#   BASE_URL=http://localhost:3100 scripts/rehearse-release.sh [live|paused]
#   ADMIN_TOKEN=... WHOP_WEBHOOK_SECRET=... [WHOP_API_KEY=...] for full coverage.
#   Signed webhooks use the Standard Webhooks envelope (api_version v1 — what
#   Whop actually delivers); one case also re-delivers legacy to guard v2/v5.
#   Expiry coverage needs RESERVATION_TTL_MS=2000 on the server (else skipped).
#
# Requires: curl, python3. Server needs a migrated + seeded database.
#
# Convention: call `call <args...>` (runs in THIS shell, sets $BODY/$STATUS),
# never in $(...) — subshells cannot propagate variables under set -u.
set -euo pipefail

BASE="${BASE_URL:?set BASE_URL}"
MODE="${1:-live}"
RUN="${REHEARSE_RUN:-$(date +%s)}"
PASS=0
SKIP=0
CALLN=0
WH_COUNT=0
TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD" /tmp/whbody.json' EXIT
BODY="$TMPD/body.txt"
STATUS="$TMPD/status.txt"

fail() { echo "❌ FAIL: $1${2:+ — $2}"; exit 1; }
pass() { PASS=$((PASS + 1)); echo "✓ $1"; }
skip() { SKIP=$((SKIP + 1)); echo "- SKIP: $1"; }
need() { command -v "$1" >/dev/null || fail "missing tool" "$1"; }
need curl
need python3

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
jget() { python3 -c "import json,sys; print(json.load(open('$BODY'))$1)"; }
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
sign_post() { # sign_post PATH JSON_BODY — Standard Webhooks envelope (what Whop v1 delivers)
  WH_COUNT=$((WH_COUNT + 1))
  echo "$2" > /tmp/whbody.json
  local id="msg_rehearse_$RUN-$WH_COUNT" ts sig
  ts=$(date +%s)
  sig=$(WHS_ID="$id" WHS_TS="$ts" python3 -c "import hmac,hashlib,os,base64; key=os.environ['WHOP_WEBHOOK_SECRET'].encode(); signed=('%s.%s.' % (os.environ['WHS_ID'], os.environ['WHS_TS'])).encode() + open('/tmp/whbody.json','rb').read(); print('v1,' + base64.b64encode(hmac.new(key, signed, hashlib.sha256).digest()).decode().rstrip('='))")
  curl -s --max-time 15 -w "\n%{http_code}" -X POST "$BASE$1" -H 'Content-Type: application/json' -H "webhook-id: $id" -H "webhook-timestamp: $ts" -H "webhook-signature: $sig" --data-binary @/tmp/whbody.json > "$TMPD/out.txt"
  tail -n 1 "$TMPD/out.txt" > "$STATUS"
  sed '$d' "$TMPD/out.txt" > "$BODY"
}

sign_post_legacy() { # sign_post_legacy PATH JSON_BODY — legacy envelope (v2/v5 resources)
  echo "$2" > /tmp/whbody.json
  local sig
  sig=$(python3 -c "import hmac,hashlib,os; print(hmac.new(os.environ['WHOP_WEBHOOK_SECRET'].encode(), open('/tmp/whbody.json','rb').read(), hashlib.sha256).hexdigest())")
  curl -s --max-time 15 -w "\n%{http_code}" -X POST "$BASE$1" -H 'Content-Type: application/json' -H "x-whop-signature: $sig" --data-binary @/tmp/whbody.json > "$TMPD/out.txt"
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
  ID1=$(python3 -c "import json; print(json.load(open('$BODY'))['id'])")
  call POST /api/waitlist '{"email":"rehearse-wait@example.com","source":"rehearse"}'
  ID2=$(python3 -c "import json; print(json.load(open('$BODY'))['id'])")
  [ "$ID1" = "$ID2" ] && [ -n "$ID1" ] || fail "waitlist dedupes by email"
  pass "waitlist stores one row per email"
  echo "== $PASS passed, $SKIP skipped =="
  exit 0
fi

echo "== live mode: money flows =="
call GET /api/stats
[ "$(st)" = "200" ] || fail "stats 200" "got $(st)"
python3 -c "import json; d=json.load(open('$BODY')); assert d['elementsTotal']>=122 and d['unclaimedElements']==d['elementsTotal']-d['claimedElements'], d"
pass "stats shape + units"

call GET /api/elements
EMPTY=$(python3 -c "import json; print([t['symbol'] for t in json.load(open('$BODY')) if t['pool']==0][0])")
echo "empty tile: $EMPTY"

CK1 "{\"elementSym\":\"$EMPTY\",\"amountUsd\":8,\"attest\":true,\"idempotencyKey\":\"rehearse-$RUN-first-1\",\"startup\":{\"title\":\"First\",\"pitch\":\"First pitch here now\",\"url\":\"https://rehearse-first.dev\",\"linkType\":\"product\"}}"
[ "$(st)" = "200" ] || fail "first claim checkout" "got $(st): $(cat "$BODY")"
PAY1=$(jget "['paymentId']"); URL1=$(jget "['checkoutUrl']")
[ -n "$PAY1" ] && [ -n "$URL1" ] || fail "first claim returns payment"
python3 -c "import sys; u=sys.argv[1]; assert u.startswith('http://') or u.startswith('https://') or u.startswith('/'), u" "$URL1" || fail "checkout URL shape" "$URL1"
pass "first claim \$8 → checkout session"
call POST /api/dev/pay "{\"paymentId\":\"$PAY1\",\"outcome\":\"pay\"}"
[ "$(st)" = "200" ] || fail "dev pay" "got $(st)"
grep -q '"status":"paid"' "$BODY" || fail "dev pay paid" "$(cat "$BODY")"
call GET "/api/elements/$EMPTY"
python3 -c "import json; d=json.load(open('$BODY')); assert d['stakes'][0]['domain']=='rehearse-first.dev' and d['stakes'][0]['amount']==8, d['stakes']"
pass "first claim applied #1 at \$8"

CK1 "{\"elementSym\":\"$EMPTY\",\"amountUsd\":5,\"attest\":true,\"idempotencyKey\":\"rehearse-$RUN-join-1\",\"startup\":{\"title\":\"Joiner\",\"pitch\":\"Joiner pitch here now\",\"url\":\"https://rehearse-join.dev\",\"linkType\":\"product\"}}"
[ "$(st)" = "200" ] || fail "contested join checkout" "got $(st)"
PAYJ=$(jget "['paymentId']")
call POST /api/dev/pay "{\"paymentId\":\"$PAYJ\",\"outcome\":\"pay\"}" > /dev/null
call GET "/api/elements/$EMPTY"
python3 -c "import json; d=json.load(open('$BODY')); ss=d['stakes']; assert len(ss)==2 and ss[0]['amount']==8 and ss[1]['domain']=='rehearse-join.dev' and ss[1]['amount']==5, ss"
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
python3 -c "import json; d=json.load(open('$BODY')); assert d['stakes'][0]['domain']=='rehearse-take.dev' and d['stakes'][0]['amount']==9, d['stakes']"
pass "takeover flips the crown"

CK1 "{\"elementSym\":\"$EMPTY\",\"amountUsd\":2,\"attest\":true,\"idempotencyKey\":\"rehearse-$RUN-reclaim-1\",\"startup\":{\"title\":\"First\",\"pitch\":\"First pitch here now\",\"url\":\"https://rehearse-first.dev\",\"linkType\":\"product\"}}"
[ "$(st)" = "200" ] || fail "reclaim checkout" "got $(st)"
PAYR=$(jget "['paymentId']")
call POST /api/dev/pay "{\"paymentId\":\"$PAYR\",\"outcome\":\"pay\"}" > /dev/null
call GET "/api/elements/$EMPTY"
python3 -c "import json; d=json.load(open('$BODY')); assert d['stakes'][0]['domain']=='rehearse-first.dev' and d['stakes'][0]['amount']==10, d['stakes']"
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
EMPTY2=$(python3 -c "import json; print([t['symbol'] for t in json.load(open('$BODY')) if t['pool']==0][0])")
CK1 "{\"elementSym\":\"$EMPTY2\",\"amountUsd\":8,\"attest\":true,\"idempotencyKey\":\"rehearse-$RUN-first-2\",\"startup\":{\"title\":\"First2\",\"pitch\":\"First2 pitch here\",\"url\":\"https://rehearse-first2.dev\",\"linkType\":\"product\"}}"
[ "$(st)" = "200" ] || fail "second tile setup" "got $(st)"
PAYF2=$(python3 -c "import json; print(json.load(open('$BODY'))['paymentId'])")
call POST /api/dev/pay "{\"paymentId\":\"$PAYF2\",\"outcome\":\"pay\"}" > /dev/null
CK1 "{\"elementSym\":\"$EMPTY2\",\"amountUsd\":9,\"attest\":true,\"idempotencyKey\":\"rehearse-$RUN-exp-1\",\"startup\":{\"title\":\"Expy\",\"pitch\":\"Expy pitch here now\",\"url\":\"https://rehearse-expy.dev\",\"linkType\":\"product\"}}"
[ "$(st)" = "200" ] || fail "expiry take checkout" "got $(st)"
grep -q '"guaranteedTake":true' "$BODY" || fail "expiry take holds quote first" "$(cat "$BODY")"
PAYE=$(python3 -c "import json; print(json.load(open('$BODY'))['paymentId'])")
sleep 3 # outlive RESERVATION_TTL_MS=2000 (release builds set it; else this still passes as a normal take)
call POST /api/dev/pay "{\"paymentId\":\"$PAYE\",\"outcome\":\"pay\"}"
[ "$(st)" = "200" ] || fail "expired settle" "got $(st)"
grep -q '"status":"paid"' "$BODY" || fail "expired payment paid" "$(cat "$BODY")"
pass "expired reservation settles as an ordinary stake (no guaranteed crown)"

if [ -n "${WHOP_WEBHOOK_SECRET:-}" ]; then
  echo "== webhooks (signed) =="
  CK1 "{\"elementSym\":\"$EMPTY\",\"amountUsd\":6,\"attest\":true,\"idempotencyKey\":\"rehearse-$RUN-wh-1\",\"startup\":{\"title\":\"Hook\",\"pitch\":\"Hook pitch here now\",\"url\":\"https://rehearse-hook.dev\",\"linkType\":\"product\"}}"
  PAYW=$(jget "['paymentId']")
  B1="{\"id\":\"rehearse-$RUN-evt-1\",\"type\":\"payment.succeeded\",\"data\":{\"status\":\"succeeded\",\"amount\":6,\"currency\":\"usd\",\"id\":\"cs_rehearse-$RUN\",\"metadata\":{\"paymentId\":\"$PAYW\"}}}"
  sign_post /api/webhooks/whop "$B1"
  [ "$(st)" = "200" ] || fail "webhook applied" "got $(st)"
  grep -q '"outcome":"applied"' "$BODY" || fail "applied outcome" "$(cat "$BODY")"
  sign_post /api/webhooks/whop "$B1"
  grep -Eq '"outcome":"(duplicate|already-settled)"' "$BODY" || fail "replay deduped" "$(cat "$BODY")"
  pass "signed paid webhook applies once; replay deduped"
  sign_post_legacy /api/webhooks/whop "$B1"
  [ "$(st)" = "200" ] || fail "legacy envelope accepted" "got $(st): $(cat "$BODY")"
  pass "legacy envelope still verified (v2/v5 webhooks unregressed)"
  B2="{\"id\":\"rehearse-$RUN-evt-2\",\"data\":{\"metadata\":{\"paymentId\":\"$PAYW\"}}}"
  sign_post /api/webhooks/whop "$B2"
  grep -q '"outcome":"ignored"' "$BODY" || fail "statusless ignored" "$(cat "$BODY")"
  pass "statusless event ignored, settled payment untouched"
  CK1 "{\"elementSym\":\"$EMPTY\",\"amountUsd\":7,\"attest\":true,\"idempotencyKey\":\"rehearse-$RUN-wh-2\",\"startup\":{\"title\":\"Hook2\",\"pitch\":\"Hook2 pitch here now\",\"url\":\"https://rehearse-hook2.dev\",\"linkType\":\"product\"}}"
  PAYW2=$(jget "['paymentId']")
  B3="{\"id\":\"rehearse-$RUN-evt-3\",\"type\":\"payment.failed\",\"data\":{\"status\":\"failed\",\"metadata\":{\"paymentId\":\"$PAYW2\"}}}"
  sign_post /api/webhooks/whop "$B3"
  grep -q '"outcome":"failed"' "$BODY" || fail "failed event" "$(cat "$BODY")"
  B4="{\"id\":\"rehearse-$RUN-evt-4\",\"type\":\"payment.succeeded\",\"data\":{\"status\":\"succeeded\",\"amount\":7,\"currency\":\"usd\",\"metadata\":{\"paymentId\":\"$PAYW2\"}}}"
  sign_post /api/webhooks/whop "$B4"
  grep -Eq '"outcome":"already-settled"' "$BODY" || fail "paid-after-failed stays terminal" "$(cat "$BODY")"
  pass "failed→paid follows the terminal state machine"
  B5="{\"id\":\"rehearse-$RUN-evt-5\",\"type\":\"payment.succeeded\",\"data\":{\"status\":\"succeeded\",\"amount\":999,\"currency\":\"usd\",\"metadata\":{\"paymentId\":\"$PAYW2\"}}}"
  sign_post /api/webhooks/whop "$B5"
  grep -q 'amount-mismatch' "$BODY" || fail "amount mismatch rejected" "$(cat "$BODY")"
  pass "amount mismatch rejected without applying"
else
  skip "signed webhooks (set WHOP_WEBHOOK_SECRET)"
fi

if [ -n "${WHOP_API_KEY:-}" ] && [ -n "${WHOP_WEBHOOK_SECRET:-}" ]; then
  echo "== provider outage =="
  CK1 "{\"elementSym\":\"$EMPTY\",\"amountUsd\":11,\"attest\":true,\"idempotencyKey\":\"rehearse-$RUN-outage-1\",\"startup\":{\"title\":\"Out\",\"pitch\":\"Out pitch here now\",\"url\":\"https://rehearse-out.dev\",\"linkType\":\"product\"}}"
  [ "$(st)" = "502" ] || fail "outage is 502 retryable" "got $(st)"
  grep -q 'checkoutUrl' "$BODY" && fail "no dead URL on outage" "$(cat "$BODY")"
  pass "provider outage → 502, retryable, no dead URL"
else
  skip "provider outage (set WHOP_API_KEY + WHOP_WEBHOOK_SECRET)"
fi

if [ -n "${ADMIN_TOKEN:-}" ]; then
  echo "== moderation =="
  call GET "/api/elements/$EMPTY"
  STAKE=$(python3 -c "import json; d=json.load(open('$BODY')); print([s['stakeId'] for s in d['stakes'] if s['domain']=='rehearse-take.dev'][0])")
  call POST /api/report "{\"stakeId\":\"$STAKE\",\"reason\":\"rehearsal report\"}"
  [ "$(st)" = "200" ] || fail "report intake" "got $(st)"
  admin_call GET "/api/admin/reports?status=OPEN"
  RID=$(python3 -c "import json; print(json.load(open('$BODY'))[0]['id'])")
  admin_call PATCH "/api/admin/reports/$RID" '{"status":"TRIAGED","note":"rehearsal","reviewedBy":"rehearse"}'
  [ "$(st)" = "200" ] || fail "triage" "got $(st)"
  admin_call POST "/api/admin/startups/rehearse-take.dev/moderate" '{"state":"HIDDEN","reason":"rehearsal","operator":"rehearse"}'
  [ "$(st)" = "200" ] || fail "hide" "got $(st)"
  call GET "/api/elements/$EMPTY"
  python3 -c "import json; d=json.load(open('$BODY')); assert all(s['domain']!='rehearse-take.dev' for s in d['stakes']), 'hidden bidder visible'"
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/s/rehearse-take.dev")" = "404" ] || fail "hidden profile 404s"
  admin_call POST "/api/admin/startups/rehearse-take.dev/moderate" '{"state":"VISIBLE","operator":"rehearse"}'
  [ "$(st)" = "200" ] || fail "restore" "got $(st)"
  pass "report → triage → hide → restore with surface checks"
else
  skip "moderation (set ADMIN_TOKEN)"
fi

echo "== latency (budget 2000ms) =="
for p in "/api/stats" "/api/elements" "/api/table-order" "/api/board?tab=crowns" "/api/activity?limit=6" "/api/search?q=carbon"; do
  MS=$(curl -s -o /dev/null --max-time 15 -w "%{time_total}" "$BASE$p" | python3 -c "import sys; print(int(float(sys.stdin.read().strip())*1000))")
  [ "$MS" -lt 2000 ] || fail "latency $p" "${MS}ms"
  echo "  $p ${MS}ms"
done
pass "read APIs within latency budget"

echo "== $PASS passed, $SKIP skipped =="
