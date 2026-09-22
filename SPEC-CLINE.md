# PROJECT SPEC — 05-Enterprise-IT-Helpdesk-Lab

## 1. Goal

Build một enterprise IT lab + support workflow phù hợp phỏng vấn:

- IT Helpdesk
- IT Support
- Internal IT
- Junior System Administrator

Core skills:

- Windows Server
- Active Directory
- DNS
- DHCP
- Group Policy
- file sharing
- permissions
- LAN troubleshooting
- endpoint/user lifecycle
- backup/restore
- IT asset management
- ticket handling

AI là add-on hỗ trợ technician, không thay core troubleshooting.

---

# 2. Lab Topology

```text
                Internet/NAT
                    |
                    v
                 Router
                    |
              Virtual LAN
          +---------+----------+
          |                    |
          v                    v
 Windows Server           Windows Client
   DC01                      CLIENT01
          |
          +-- AD DS
          +-- DNS
          +-- DHCP
          +-- GPO
          +-- File Share
```

Optional:

- second client;
- Ubuntu utility server;
- monitoring node.

---

# 3. Domain Design

Example:

```text
corp.local
```

OUs:

```text
CORP
├── Users
│   ├── HR
│   ├── Accounting
│   ├── Sales
│   └── IT
├── Computers
│   ├── Workstations
│   └── Servers
└── Groups
```

Groups examples:

```text
GG_HR
GG_ACCOUNTING
GG_IT
GG_FILE_HR_RW
GG_FILE_ACCOUNTING_RW
```

---

# 4. Active Directory Tasks

Must demonstrate:

- create user;
- disable user;
- reset password;
- unlock account;
- group membership;
- OU organization;
- join workstation to domain.

---

# 5. DNS

Must demonstrate:

- forward lookup;
- domain client resolution;
- `nslookup`;
- common DNS failure.

Incident example:

```text
Can ping 8.8.8.8
Cannot open google.com
```

Diagnosis:

- DNS config;
- resolver reachability;
- wrong DNS server;
- cache.

---

# 6. DHCP

Must demonstrate:

- scope;
- lease;
- gateway option;
- DNS option;
- client renew.

Incident:

```text
Client gets APIPA 169.254.x.x
```

Diagnosis:

- DHCP service;
- scope;
- link;
- VLAN/network;
- firewall.

---

# 7. File Server + Permissions

Shares:

```text
\\DC01\HR
\\DC01\Accounting
\\DC01\Public
```

Requirements:

- NTFS permissions;
- share permissions;
- group-based access;
- least privilege.

Demo:

```text
HR user -> HR share read/write
Accounting user -> denied HR confidential folder
```

---

# 8. Group Policy

Implement practical policies:

- password policy;
- mapped drive;
- desktop/control policy;
- optional USB restriction;
- Windows update policy if lab supports it.

Document every GPO:

- business purpose;
- scope;
- expected effect;
- rollback.

---

# 9. User Lifecycle

## Onboarding

Checklist:

1. create AD account;
2. add correct groups;
3. assign device;
4. register asset;
5. email/account checklist;
6. map share;
7. verify login;
8. handover.

## Offboarding

1. disable account;
2. revoke group/access;
3. recover asset;
4. preserve required data;
5. document completion.

---

# 10. Ticket System / Internal App

Build a simple internal application.

Modules:

```text
Users
Assets
Tickets
Knowledge Base
Maintenance Records
Software Licenses
```

Ticket statuses:

- OPEN
- IN_PROGRESS
- WAITING_USER
- RESOLVED
- CLOSED

Priority:

- LOW
- MEDIUM
- HIGH
- CRITICAL

---

# 11. Asset Management

Fields:

```text
assetTag
type
brand
model
serialNumber
assignedUser
department
purchaseDate
warrantyEnd
status
notes
```

Asset lifecycle:

```text
IN_STOCK
ASSIGNED
REPAIR
RETIRED
```

---

# 12. Ticket Runbooks

Create at least 15 incident documents:

```text
INC-001-no-internet.md
INC-002-dns-failure.md
INC-003-dhcp-apipa.md
INC-004-account-locked.md
INC-005-forgot-password.md
INC-006-share-permission.md
INC-007-printer-offline.md
INC-008-disk-full.md
INC-009-email-issue.md
INC-010-wifi-disconnect.md
INC-011-malware-suspected.md
INC-012-deleted-file.md
INC-013-backup-restore.md
INC-014-new-employee.md
INC-015-offboarding.md
```

Template:

```text
Problem
Impact
Initial Questions
Diagnostics
Root Cause
Resolution
Verification
Prevention
```

---

# 13. Backup / Restore

Lab must demonstrate at least one real restore scenario.

Examples:

- restore deleted shared file;
- restore app database;
- configuration backup.

Document:

- backup target;
- schedule assumption;
- retention;
- restore steps;
- verification.

---

# 14. AI Add-on — Helpdesk Copilot

Build only after core lab + ticket knowledge base exists.

## Features

1. Ticket classification.
2. Ticket summarization.
3. Suggested diagnostic steps.
4. RAG over internal runbooks.

Flow:

```text
Ticket
  |
  v
Classifier
  |
  +-- category
  +-- priority suggestion
  |
  v
Retrieve runbook chunks
  |
  v
OpenAI
  |
  v
Suggested diagnostics
```

AI does NOT:

- reset user passwords automatically;
- change AD permissions;
- run destructive commands;
- close tickets autonomously.

---

# 15. RAG Knowledge Base

Sources:

```text
knowledge-base/
  active-directory.md
  dns.md
  dhcp.md
  file-permissions.md
  printer.md
  onboarding.md
  offboarding.md
  backup-restore.md
  security.md
  incidents/
```

Metadata:

```text
category
severity
system
updatedAt
source
```

Must show citations/source references in AI answer if feasible.

---

# 16. AI Ticket Output

Example:

```json
{
  "category": "NETWORK_DNS",
  "prioritySuggestion": "MEDIUM",
  "summary": "User has IP connectivity but DNS resolution fails.",
  "diagnosticSteps": [
    "Run ipconfig /all",
    "Verify configured DNS server",
    "Run nslookup",
    "Test DNS server reachability"
  ],
  "knowledgeSources": [
    "knowledge-base/dns.md"
  ]
}
```

---

# 17. Security

- role-based ticket access;
- asset data protected;
- audit admin actions;
- AI gets sanitized context;
- no password/token in prompt;
- no secrets committed.

---

# 18. Implementation Phases

## Phase 0 — Lab Plan

Document:

- topology;
- IP scheme;
- VM resources;
- snapshots.

## Phase 1 — Windows Server

- AD DS;
- DNS;
- domain;
- client join.

## Phase 2 — DHCP + GPO

- DHCP scope;
- GPOs;
- testing.

## Phase 3 — File Server

- shares;
- permissions;
- groups.

## Phase 4 — Ticket + Asset App

- CRUD;
- roles;
- assignment;
- status flow.

## Phase 5 — Incident Practice

- 15 incidents;
- resolution evidence.

## Phase 6 — Backup/Restore

- execute at least one restore.

## Phase 7 — AI Copilot

- classification;
- RAG;
- suggested troubleshooting.

---

# 19. Demo Scenarios

## Demo A — New Employee

- create AD user;
- group assignment;
- client login;
- mapped drive;
- asset assigned.

## Demo B — DNS Failure

- intentionally wrong DNS;
- reproduce;
- diagnose;
- fix;
- verify.

## Demo C — Permission

- user denied share;
- inspect group;
- fix correctly;
- verify.

## Demo D — Ticket + AI

- submit DNS ticket;
- AI categorizes;
- retrieves DNS runbook;
- suggests checks;
- technician resolves.

## Demo E — Restore

- delete a test file;
- restore;
- verify.

---

# 20. Out of Scope

Do not prioritize:

- Kubernetes;
- complex cloud architecture;
- custom ML training;
- autonomous admin agent;
- large microservice system.

---

# 21. Definition of Done

- domain works;
- client joins;
- DNS works;
- DHCP works;
- GPO demonstrated;
- file permissions demonstrated;
- user lifecycle documented;
- ticket app usable;
- asset assignment works;
- 15 incidents documented;
- at least one backup restore demonstrated;
- optional AI uses internal KB and remains advisory.
