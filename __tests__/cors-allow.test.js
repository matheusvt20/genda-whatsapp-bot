const path = require('path');

describe('isOriginAllowed (CORS)', () => {
  function loadWithEnv(env = {}) {
    const prev = { ...process.env };
    Object.assign(process.env, env);
    jest.resetModules();
    const mod = require(path.join('..', 'cors-allow.js'));
    process.env = prev;
    return mod.isOriginAllowed;
  }

  test('aceita origins definidos em ALLOWED_ORIGINS', () => {
    const isAllowed = loadWithEnv({ ALLOWED_ORIGINS: 'https://foo.com,https://bar.com' });
    expect(isAllowed('https://foo.com')).toBe(true);
    expect(isAllowed('https://bar.com')).toBe(true);
    expect(isAllowed('https://baz.com')).toBe(false);
  });

  test('aceita defaults exatos (usegenda, localhosts)', () => {
    const isAllowed = loadWithEnv({ ALLOWED_ORIGINS: '' });
    expect(isAllowed('https://usegenda.com')).toBe(true);
    expect(isAllowed('https://www.usegenda.com')).toBe(true);
    expect(isAllowed('http://localhost:3000')).toBe(true);
    expect(isAllowed('http://localhost:5173')).toBe(true);
  });

  test('aceita regex de lovable.app/dev', () => {
    const isAllowed = loadWithEnv();
    expect(isAllowed('https://abc.lovable.app')).toBe(true);
    expect(isAllowed('https://stage-123.lovable.dev')).toBe(true);
    expect(isAllowed('https://malicioso.com')).toBe(false);
  });

  test('origin ausente (ex.: curl) é permitido', () => {
    const isAllowed = loadWithEnv();
    expect(isAllowed(undefined)).toBe(true);
    expect(isAllowed(null)).toBe(true);
  });
});
