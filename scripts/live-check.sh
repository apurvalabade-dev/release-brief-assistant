#!/bin/sh
# Usage: URL=https://release-brief-assistant-97z4.onrender.com sh scripts/live-check.sh
# Creates one release named "live-check (safe to delete)" in the target database.
: "${URL:?Set URL, e.g. URL=https://your-service.onrender.com}"
URL="${URL%/}"
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(eval(process.argv[1]))})' "$1"; }

echo "1. health (first call may take up to a minute if the free service was asleep)"
curl -fsS --max-time 120 --retry 2 --retry-delay 5 "$URL/api/health" || { echo "FAIL: health"; exit 1; }; echo

echo "2. UI is served"
curl -fsS --max-time 60 -o /dev/null -w "   GET / -> %{http_code} %{content_type}\n" "$URL/" || { echo "FAIL: UI"; exit 1; }
curl -fsS --max-time 60 -o /dev/null -w "   GET /releases/1 (deep link) -> %{http_code}\n" "$URL/releases/1"

echo "3. create a release (database write)"
PKG='{"completedFeatures":[{"id":"F-1","title":"CSV export","description":"Export up to 10k rows"}],"bugFixes":[{"id":"B-1","title":"Fix login loop","description":"SSO loop fixed"}],"qaSummary":[{"id":"Q-1","summary":"Export verified","result":"pass","covers":["F-1"]},{"id":"Q-2","summary":"Login suite","result":"pass","covers":["B-1"]}],"knownLimitations":[{"id":"L-1","description":"10k row cap"}],"affectedUserGroups":["Admins"],"noMigrationRequiredConfirmed":true}'
RES=$(curl -fsS --max-time 60 -X POST "$URL/api/releases" -H 'content-type: application/json' -d "{\"name\":\"live-check (safe to delete)\",\"package\":$PKG}") || { echo "FAIL: create release (is DATABASE_URL set and migrated?)"; exit 1; }
RID=$(echo "$RES" | json 'j.release.id')
echo "   release id $RID, ready=$(echo "$RES" | json 'j.checks.ready')"

echo "4. generate AI summaries (real model: roughly a minute; 502 = provider problem)"
START=$(date +%s)
OUT=$(curl -sS --max-time 240 -w '\n%{http_code}' -X POST "$URL/api/releases/$RID/versions/1/generate" -H 'content-type: application/json' -d '{}')
CODE=$(echo "$OUT" | tail -n1); BODY=$(echo "$OUT" | sed '$d')
echo "   HTTP $CODE in $(( $(date +%s) - START ))s"
if [ "$CODE" = "201" ]; then
  echo "$BODY" | json '"   model=" + j.analysis.model + ", statements=" + j.statements.length + ", all draft=" + j.statements.every(s=>s.status==="draft") + ", all cited=" + j.statements.every(s=>s.citations.length>0)'
else
  echo "$BODY" | head -c 400; echo; echo "   (provider overloaded or key/model wrong: check Render logs and env vars)"; exit 1
fi

echo "5. the brief is refused while statements are still drafts (guardrail)"
curl -sS --max-time 60 -o /dev/null -w "   POST brief -> %{http_code} (expect 409)\n" -X POST "$URL/api/releases/$RID/versions/1/brief" -H 'content-type: application/json' -d '{"audience":"stakeholder"}'
echo "ALL CHECKS PASSED"
