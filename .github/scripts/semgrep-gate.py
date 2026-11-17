"""Reads Semgrep's SARIF report, writes a summary for the GitHub run page,
and fails the job if any finding is rated ERROR (high).
Lower-rated findings are listed for review but don't block the build."""
import json, os, sys

path = sys.argv[1] if len(sys.argv) > 1 else 'semgrep.sarif'
with open(path, encoding='utf-8') as f:
    sarif = json.load(f)

rows, high, reviewed = [], 0, 0
for run in sarif.get('runs', []):
    # Semgrep puts the rating on the rule, not on each result.
    rated = {x['id']: x.get('defaultConfiguration', {}).get('level', 'warning')
             for x in run.get('tool', {}).get('driver', {}).get('rules', [])}
    for r in run.get('results', []):
        if r.get('suppressions'):   # marked with a reviewed "nosemgrep" comment
            reviewed += 1
            continue
        level = r.get('level') or rated.get(r.get('ruleId'), 'error')  # unknown rating: treat as high
        loc = r['locations'][0]['physicalLocation']
        where = f"{loc['artifactLocation']['uri']}:{loc['region']['startLine']}"
        rule = r.get('ruleId', '').split('.')[-1]
        rows.append((level, rule, where))
        if level == 'error':
            high += 1

order = {'error': 0, 'warning': 1, 'note': 2}
rows.sort(key=lambda x: (order.get(x[0], 3), x[2]))
label = {'error': 'High', 'warning': 'Medium', 'note': 'Low'}
lines = [f'## Security scan: {len(rows)} finding(s), {high} high, {reviewed} reviewed and accepted', '']
if rows:
    lines += ['| Level | Rule | Where |', '|---|---|---|']
    lines += [f'| {label.get(l, l)} | {rule} | `{w}` |' for l, rule, w in rows]
out = os.environ.get('GITHUB_STEP_SUMMARY')
if out:
    with open(out, 'a', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
print('\n'.join(lines))
if high:
    print(f'::error::{high} high-rated finding(s). Fix them, or mark a reviewed false positive with a "nosemgrep" comment that says why.')
    sys.exit(1)
