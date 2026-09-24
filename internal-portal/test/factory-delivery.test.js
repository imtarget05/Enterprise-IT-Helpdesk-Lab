'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'internal-portal', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');
const openapi = fs.readFileSync(path.join(PUBLIC, 'openapi.yaml'), 'utf8');
const dockerfile = fs.readFileSync(path.join(ROOT, 'internal-portal', 'Dockerfile'), 'utf8');
const compose = fs.readFileSync(path.join(ROOT, 'internal-portal', 'docker-compose.yml'), 'utf8');
const rootDockerignorePath = path.join(ROOT, '.dockerignore');
const rootDockerignore = fs.existsSync(rootDockerignorePath) ? fs.readFileSync(rootDockerignorePath, 'utf8') : '';

test('operations/runbooks tabs expose their DOM and client loaders', () => {
  for (const id of ['tab-operations', 'tab-runbooks', 'operations-monitoring-list', 'operations-itsm-list', 'operations-access-list', 'btn-refresh-operations']) {
    assert.ok(html.includes(`id="${id}"`), `thiếu UI contract #${id}`);
  }
  for (const endpoint of ['/api/monitoring/status', '/api/problems', '/api/changes', '/api/access-requests', '/api/audit']) {
    assert.ok(js.includes(endpoint), `UI chưa gọi endpoint ${endpoint}`);
  }
  assert.match(js, /async function fetchOperations\s*\(/);
  assert.match(js, /function renderOperations\s*\(/);
  for (const cls of ['runbook-grid', 'runbook-card', 'operations-list']) {
    assert.ok(css.includes(`.${cls}`), `thiếu CSS .${cls}`);
  }
  for (const href of [
    '/docs/07-vlan-firewall-design.md', '/docs/08-ad-identity-security.md', '/docs/09-monitoring-incident-runbook.md',
    '/docs/10-backup-restore-dr.md', '/docs/11-minierp-integration.md', '/scenarios/factory/scenario-01-dhcp-apipa.md',
  ]) assert.ok(html.includes(`href="${href}"`), `UI thiếu tài liệu link ${href}`);
});

test('OpenAPI exposes authentication, ITSM, monitoring, MiniERP and audit contracts', () => {
  for (const route of [
    '/api/auth/login:', '/api/auth/me:', '/api/tickets/{id}/timeline:', '/api/tickets/{id}/transition:',
    '/api/problems:', '/api/changes:', '/api/access-requests:', '/api/monitoring/status:',
    '/api/monitoring/checks/{id}/run:', '/api/integrations/minierp/incidents:', '/api/audit:',
  ]) assert.ok(openapi.includes(route), `OpenAPI thiếu ${route}`);
  for (const tag of ['Auth', 'ITSM', 'Monitoring', 'Integrations', 'Audit']) {
    assert.ok(new RegExp(`name: ${tag}`).test(openapi), `OpenAPI thiếu tag ${tag}`);
  }
  assert.match(openapi, /externalRef/);
  assert.match(openapi, /idempotent/);
});

test('factory delivery has the required runbooks and twelve reproducible scenarios', () => {
  const docs = [
    '07-vlan-firewall-design.md', '08-ad-identity-security.md', '09-monitoring-incident-runbook.md',
    '10-backup-restore-dr.md', '11-minierp-integration.md',
  ];
  for (const name of docs) assert.ok(fs.existsSync(path.join(ROOT, 'docs', name)), `thiếu docs/${name}`);
  const scenarioDir = path.join(ROOT, 'scenarios', 'factory');
  const files = fs.readdirSync(scenarioDir).filter((name) => /^scenario-\d{2}-.+\.md$/.test(name)).sort();
  assert.equal(files.length, 12, `cần đúng 12 scenario factory, nhận ${files.length}`);
  for (const name of files) {
    const source = fs.readFileSync(path.join(scenarioDir, name), 'utf8');
    for (const heading of ['## Mục tiêu', '## Điều kiện', '## Thao tác', '## Kết quả mong đợi', '## Evidence']) {
      assert.ok(source.includes(heading), `${name} thiếu ${heading}`);
    }
  }
});

test('Docker image includes the factory runbooks and scenario documents', () => {
  assert.match(dockerfile, /COPY docs \/app\/docs/);
  assert.match(dockerfile, /COPY scenarios \/app\/scenarios/);
  assert.match(dockerfile, /COPY internal-portal\/public \/app\/internal-portal\/public/);
  assert.match(dockerfile, /COPY internal-portal\/test-api\.sh \/app\/internal-portal\/test-api\.sh/);
  assert.match(dockerfile, /COPY internal-portal\/Dockerfile \/app\/internal-portal\/Dockerfile/);
  if (rootDockerignore) {
    assert.match(rootDockerignore, /internal-portal\/data/);
    assert.match(rootDockerignore, /\*\*\/node_modules/);
  }
  assert.match(compose, /context: \.\./);
  assert.match(compose, /dockerfile: internal-portal\/Dockerfile/);
});

test('operations PowerShell scripts contain safety and evidence controls', () => {
  const required = {
    'Backup-HelpdeskData.ps1': ['Get-FileHash', 'Retention', 'ShouldProcess'],
    'Restore-HelpdeskData.ps1': ['Get-FileHash', 'ShouldProcess', 'checksum mismatch'],
    'Backup-ADConfiguration.ps1': ['Backup-GPO', 'Export-DhcpServer', 'manifest.json'],
    'Disable-CompanyUser.ps1': ['Disable-ADAccount', 'Remove-ADGroupMember', 'ShouldProcess', 'EndsWith'],
    'Test-PrintScanHealth.ps1': ['Test-NetConnection', 'Invoke-WebRequest', 'USB keyboard-wedge'],
    'Restore-HelpdeskData.ps1': ['EvidencePath', 'restored'],
  };
  for (const [name, markers] of Object.entries(required)) {
    const source = fs.readFileSync(path.join(ROOT, 'scripts', name), 'utf8');
    for (const marker of markers) assert.ok(source.includes(marker), `${name} thiếu marker ${marker}`);
  }
});
