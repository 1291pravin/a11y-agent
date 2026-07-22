// Filter raw AQA issues to the "Need fix" bucket (exclude "Check manually").
// AQA's runFlowIssues(..., manual=false) returns actionable issues; the manual=true
// bucket is never fetched. Some responses still mix categories via properties.

const CHECK_MANUALLY = /check\s*manually|manual\s*review|^manual$/i;
const NEED_FIX = /need\s*fix|needfix|actionable/i;

export function isNeedFixIssue(issue) {
  const props = (issue.properties || []).map((x) => String(x).trim());
  const propText = props.join(' ').toLowerCase();

  if (issue.checkManually === true || issue.manualReview === true) return false;
  if (issue.manual === true) return false;

  const category = String(
    issue.category || issue.issueCategory || issue.reviewCategory || issue.fixType || '',
  ).toLowerCase();
  if (category.includes('check') && category.includes('manual')) return false;
  if (category === 'manual' || category === 'check_manually') return false;

  if (props.some((p) => CHECK_MANUALLY.test(p))) return false;
  if (CHECK_MANUALLY.test(propText)) return false;

  if (issue.needFixTitle) return true;
  if (props.some((p) => NEED_FIX.test(p))) return true;
  if (category.includes('need') && category.includes('fix')) return true;

  // Issues from manual=false with no manual markers are treated as need-fix.
  return true;
}

export function filterNeedFixIssues(issues) {
  return issues.filter(isNeedFixIssue);
}
