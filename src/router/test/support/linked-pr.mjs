// PANT-1383: review dispatch and in_progress -> in_review promotion require a
// linked PR. Router mocks that are not testing PR linkage itself default every
// issue to one open PR with a fixed head, so they keep exercising what they test.
export function linkedOpenPr(identifier, head = 'sha-1') {
  return {
    number: 1,
    title: identifier,
    headRefName: `feat/${String(identifier).toLowerCase()}`,
    headRefOid: head,
    state: 'OPEN',
    url: `https://github.com/mdostal/auriga/pull/${encodeURIComponent(identifier)}`,
  };
}

export const linkedOpenPrs = (identifier) => [linkedOpenPr(identifier)];
