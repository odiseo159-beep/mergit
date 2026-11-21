import test from 'node:test';
import assert from 'node:assert/strict';
import { pointsAtRepo, pointsAtIssue, LINEA_BOUNTY, closedIssues, bountyForIssue, logsOf } from '../bounties.mjs';

/**
 * Helper to mock the global fetch function.
 * It returns a sequence of responses defined by `pages`.
 */
function mockFetch(pages) {
  let callCount = 0;
  global.fetch = async (url, opts) => {
    const page = pages[callCount++];
    if (!page) {
      return { ok: false, status: 500, json: async () => ({}) };
    }
    return {
      ok: true,
      json: async () => page,
    };
  };
}

// ---------------------------------------------------------------------------
// pointsAtRepo
// ---------------------------------------------------------------------------
test('pointsAtRepo – exact repository match', () => {
  const repo = 'https://github.com/odiseo159-beep/mergit';
  assert.ok(pointsAtRepo(repo, 'odiseo159-beep/mergit'));
});

test('pointsAtRepo – same name but different suffix does NOT match', () => {
  const repo = 'https://github.com/odiseo159-beep/mergit-demo';
  assert.equal(pointsAtRepo(repo, 'odiseo159-beep/mergit'), false);
});

test('pointsAtRepo – different domain does NOT match', () => {
  const repo = 'https://gitlab.com/odiseo159-beep/mergit';
  assert.equal(pointsAtRepo(repo, 'odiseo159-beep/mergit'), false);
});

test('pointsAtRepo – free‑text description does NOT match', () => {
  const repo = 'My personal project called mergit';
  assert.equal(pointsAtRepo(repo, 'odiseo159-beep/mergit'), false);
});

// ---------------------------------------------------------------------------
// pointsAtIssue
// ---------------------------------------------------------------------------
test('pointsAtIssue – exact issue number match', () => {
  const text = 'Fixes #10';
  assert.ok(pointsAtIssue(text, 10));
});

test('pointsAtIssue – does not match similar numbers', () => {
  const text = 'Fixes #1';
  assert.equal(pointsAtIssue(text, 10), false);
});

test('pointsAtIssue – dot in owner name is literal', () => {
  const text = 'Fixes owner.name/repo#5';
  // Assuming the function extracts the numeric part only
  assert.ok(pointsAtIssue(text, 5));
});

// ---------------------------------------------------------------------------
// LINEA_BOUNTY regex
// ---------------------------------------------------------------------------
test('LINEA_BOUNTY – matches Bounty line with Windows CRLF', () => {
  const body = 'Some description\r\nBounty: #42\r\nMore text';
  const match = body.match(LINEA_BOUNTY);
  assert.ok(match);
  assert.equal(match[1], '42');
});

test('LINEA_BOUNTY – does not capture when embedded in a sentence', () => {
  const body = 'We should consider a Bounty: #99 for future work.';
  const match = body.match(LINEA_BOUNTY);
  assert.equal(match, null);
});

// ---------------------------------------------------------------------------
// closedIssues
// ---------------------------------------------------------------------------
test('closedIssues – detects all close keywords', () => {
  const body = `
    This PR fixes #12\n    Also resolves #13\n    and closes #14\n  `;
  const ids = closedIssues(body);
  assert.deepEqual(ids.sort(), [12, 13, 14]);
});

// ---------------------------------------------------------------------------
// bountyForIssue
// ---------------------------------------------------------------------------
const sampleBounties = [
  { id: 1, issue: 5, funders: ['alice'] },
  { id: 2, issue: 5, funders: ['bob'] },
  { id: 3, issue: 6, funders: ['alice'] },
];

test('bountyForIssue – single exact match returns bounty', () => {
  const result = bountyForIssue(6, sampleBounties);
  assert.deepEqual(result, { id: 3, issue: 6, funders: ['alice'] });
});

test('bountyForIssue – no match returns reason string', () => {
  const result = bountyForIssue(99, sampleBounties);
  assert.equal(typeof result, 'string');
  assert.match(result, /no bounty found/i);
});

test('bountyForIssue – ambiguous matches return nothing and reason', () => {
  const result = bountyForIssue(5, sampleBounties);
  assert.equal(result, undefined);
});

test('bountyForIssue – funders filter narrows candidates', () => {
  const result = bountyForIssue(5, sampleBounties, { funder: 'alice' });
  assert.deepEqual(result, { id: 1, issue: 5, funders: ['alice'] });
});

// ---------------------------------------------------------------------------
// logsOf – pagination and error handling
// ---------------------------------------------------------------------------
test('logsOf – follows next_page_params across pages', async () => {
  const pages = [
    { logs: [{ id: 1 }], next_page_params: { page: 2 } },
    { logs: [{ id: 2 }], next_page_params: null },
  ];
  mockFetch(pages);
  const logs = await logsOf('https://api.example.com/logs');
  assert.deepEqual(logs, [{ id: 1 }, { id: 2 }]);
});

test('logsOf – throws when a page fails', async () => {
  const pages = [
    { logs: [{ id: 1 }], next_page_params: { page: 2 } },
    null, // simulate failure on second page
  ];
  mockFetch(pages);
  await assert.rejects(async () => {
    await logsOf('https://api.example.com/logs');
  }, /failed to fetch logs/i);
});
