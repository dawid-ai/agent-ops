import { describe, expect, it } from 'vitest';
import { allowedCall, attachmentName } from '../src/allow';

describe('IPC allowlist', () => {
  it('passes the calls the page makes', () => {
    expect(allowedCall('GET', '/api/health')).toBe(true);
    expect(allowedCall('GET', '/api/waits')).toBe(true);
    expect(allowedCall('GET', '/api/runs/01ABC/procs')).toBe(true);
    expect(allowedCall('POST', '/api/runs/01ABC/procs')).toBe(true);
    expect(allowedCall('POST', '/api/waits')).toBe(false);
    expect(allowedCall('GET', '/api/inbox?as=human%3Adawid&markRead=1')).toBe(true);
    expect(allowedCall('GET', '/api/tasks?all')).toBe(true);
    expect(allowedCall('GET', '/api/tasks/demo%2FAO-0001')).toBe(true);
    expect(allowedCall('GET', '/api/runs/01ABC/log?tail=262144')).toBe(true);
    expect(allowedCall('POST', '/api/tasks')).toBe(true);
    expect(allowedCall('POST', '/api/tasks/AO-0001/verdict')).toBe(true);
    expect(allowedCall('POST', '/api/runs/01ABC/kill')).toBe(true);
    expect(allowedCall('POST', '/api/decisions/D-0001/vote')).toBe(true);
    expect(allowedCall('POST', '/api/channels/dev')).toBe(true);
  });

  it('passes the settings, schedules, standup and status-change calls', () => {
    expect(allowedCall('GET', '/api/kb?q=git&topic=windows')).toBe(true);
    expect(allowedCall('POST', '/api/kb')).toBe(false);
    expect(allowedCall('GET', '/api/doctor')).toBe(true);
    expect(allowedCall('GET', '/api/report?days=30')).toBe(true);
    expect(allowedCall('POST', '/api/notify/test')).toBe(true);
    expect(allowedCall('GET', '/api/machines')).toBe(true);
    expect(allowedCall('GET', '/api/notify/test')).toBe(false);
    expect(allowedCall('GET', '/api/activity?limit=400')).toBe(true);
    expect(allowedCall('POST', '/api/roots/site/mirror')).toBe(true);
    expect(allowedCall('GET', '/api/roots/site/mirror')).toBe(false);
    expect(allowedCall('POST', '/api/doctor')).toBe(false);
    expect(allowedCall('GET', '/api/kb/git/rebase-first?root=site')).toBe(true);
    expect(allowedCall('GET', '/api/kb/git/rebase-first/more')).toBe(false);
    for (const a of ['start', 'block', 'review', 'assign', 'retype']) {
      expect(allowedCall('POST', `/api/tasks/AO-0001/${a}`)).toBe(true);
    }
    expect(allowedCall('POST', '/api/channels')).toBe(true);
    expect(allowedCall('GET', '/api/settings')).toBe(true);
    expect(allowedCall('POST', '/api/settings')).toBe(true);
    expect(allowedCall('GET', '/api/schedules')).toBe(true);
    expect(allowedCall('POST', '/api/schedules')).toBe(true);
    expect(allowedCall('POST', '/api/schedules/daily-standup/run')).toBe(true);
    expect(allowedCall('POST', '/api/schedules/daily-standup/delete')).toBe(true);
    expect(allowedCall('POST', '/api/schedules/daily-standup/edit')).toBe(false);
    expect(allowedCall('GET', '/api/standup?hours=24')).toBe(true);
    expect(allowedCall('POST', '/api/standup')).toBe(false);
  });

  it('refuses shutdown, unknown routes and other methods', () => {
    expect(allowedCall('POST', '/api/shutdown')).toBe(false);
    expect(allowedCall('GET', '/api/shutdown')).toBe(false);
    expect(allowedCall('POST', '/api/tasks/AO-0001/delete')).toBe(false);
    expect(allowedCall('POST', '/api/runs')).toBe(true);
    expect(allowedCall('POST', '/api/runs?x=1')).toBe(false);
    expect(allowedCall('GET', '/api/tasks/a/b/c')).toBe(false);
    expect(allowedCall('GET', '/other')).toBe(false);
    expect(allowedCall('DELETE', '/api/tasks')).toBe(false);
    expect(allowedCall('GET', 42)).toBe(false);
  });
});

describe('IPC allowlist: paths the URL parser rewrites', () => {
  it('refuses dot segments, backslashes and stripped characters that reach unlisted routes', () => {
    for (const p of [
      '/api/kb/../usage',
      '/api/kb/../events',
      '/api/kb/%2e%2e/usage',
      '/api/kb/.%2E/usage',
      '/api/tasks/..',
      '/api/tasks/.',
      '/api/runs/x/../../usage',
      '/api/tasks/..\\usage',
      '/api/kb/.\t./usage',
      '/api/kb/.\n./usage',
      '/api/tasks/AO 1',
    ]) {
      expect(allowedCall('GET', p), p).toBe(false);
    }
    expect(allowedCall('POST', '/api/runs/../shutdown/kill')).toBe(false);
  });

  it('still passes encoded IDs and dots inside a segment or the query', () => {
    expect(allowedCall('GET', '/api/tasks/demo%2FAO-0001')).toBe(true);
    expect(allowedCall('GET', '/api/tasks/v2.1')).toBe(true);
    expect(allowedCall('GET', '/api/tasks/...')).toBe(true);
    expect(allowedCall('GET', '/api/search?q=..%2Fusage')).toBe(true);
    expect(allowedCall('GET', '/api/search?q=../usage')).toBe(true);
  });
});

describe('IPC allowlist: roles and the directory', () => {
  it('passes reading the directory and role files, and saving a role', () => {
    expect(allowedCall('GET', '/api/directory')).toBe(true);
    expect(allowedCall('POST', '/api/directory')).toBe(false);
    expect(allowedCall('GET', '/api/roles/claude%3Awriter')).toBe(true);
    expect(allowedCall('POST', '/api/roles')).toBe(true);
    expect(allowedCall('POST', '/api/roles/claude%3Awriter')).toBe(false);
    expect(allowedCall('GET', '/api/roles/claude%3Awriter/more')).toBe(false);
  });
});

describe('IPC allowlist: chat', () => {
  it('passes reading the chat, sending, stopping and starting over', () => {
    expect(allowedCall('GET', '/api/chat')).toBe(true);
    expect(allowedCall('POST', '/api/chat')).toBe(true);
    expect(allowedCall('POST', '/api/chat/stop')).toBe(true);
    expect(allowedCall('POST', '/api/chat/reset')).toBe(true);
    expect(allowedCall('GET', '/api/chat/stop')).toBe(false);
    expect(allowedCall('POST', '/api/chat/delete')).toBe(false);
  });
});

describe('IPC allowlist: signed-out banner', () => {
  it('passes reading the sign-in state and Resume, nothing else on those routes', () => {
    expect(allowedCall('GET', '/api/usage')).toBe(true);
    expect(allowedCall('POST', '/api/signin/resume')).toBe(true);
    expect(allowedCall('POST', '/api/usage')).toBe(false);
    expect(allowedCall('GET', '/api/signin/resume')).toBe(false);
    expect(allowedCall('POST', '/api/signin/other')).toBe(false);
    expect(allowedCall('GET', '/api/usage/x')).toBe(false);
  });
});

describe('IPC allowlist: search', () => {
  it('passes reading search results only', () => {
    expect(allowedCall('GET', '/api/search?q=tray%20agent%3Acodex&limit=8')).toBe(true);
    expect(allowedCall('POST', '/api/search')).toBe(false);
    expect(allowedCall('GET', '/api/search/x')).toBe(false);
  });

  it('passes image uploads; images load through the ops-att scheme, not the bridge', () => {
    expect(allowedCall('POST', '/api/attachments')).toBe(true);
    expect(allowedCall('GET', '/api/attachments')).toBe(false);
    expect(allowedCall('GET', '/api/attachments/01M6J3V01Z93MGX79812GGJG33.png')).toBe(false);
  });
});

describe('attachment URLs', () => {
  const name = '01M6J3V01Z93MGX79812GGJG33.png';
  it('reads the name from an ops-att URL', () => {
    expect(attachmentName(`ops-att://file/${name}`)).toBe(name);
    expect(attachmentName('ops-att://file/01M6J3V01Z93MGX79812GGJG33.webp')).toBe(
      '01M6J3V01Z93MGX79812GGJG33.webp',
    );
  });

  it('refuses every other URL', () => {
    for (const url of [
      `ops-att://other/${name}`,
      `ops-att://file/${name}?x=1`,
      `ops-att://file/${name}#x`,
      `ops-att://file/sub/${name}`,
      'ops-att://file/..%2Fconfig.yml',
      'ops-att://file/../config.yml',
      `ops-att://file/${name.toLowerCase()}`,
      'ops-att://file/01M6J3V01Z93MGX79812GGJG33.svg',
      `https://example.com/${name}`,
      `file:///C:/${name}`,
      'not a url',
    ]) {
      expect(attachmentName(url), url).toBeNull();
    }
  });
});
