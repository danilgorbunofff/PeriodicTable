# Takedown Playbook (Phase 5)

## Intake
- Report button on every rank row → `POST /api/report { stakeId, reason }` → `Report` row.
- Rate limit: 10/IP/hr. Always 200 to the reporter.

## Triage (<24h)
1. Open `Report` queue, verify URL vs claim (phishing, trademark, malware).
2. Hide: delete or unlist the `Stake` (keep `ActivityLog` for audit).
3. Email owner (startup.email if present) with reason + counter-notice path.
4. DMCA: hide first, then counter-notice window before restore.

## Comms
- Reporter: no PII back. Owner: exact rule violated + reclaim/refund path.
- Log every action in `Report.detail` (append reason + operator + timestamp).
