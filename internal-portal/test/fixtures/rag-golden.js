'use strict';

/**
 * Golden set for retrieval quality.
 *
 * Every entry names DOCUMENT PATHS that exist in the corpus and genuinely
 * contain the answer. That is the whole discipline of this file: a golden set
 * listing documents that do not exist, or that exist but do not answer the query,
 * produces confident numbers that measure nothing.
 *
 * `relevant` is a set of source FILES, not chunks. Judging "which chunk is
 * correct" would require knowing where an 800-character window happened to split
 * — a property of the chunker, not of the question. Scoring at document level
 * measures retrieval; chunk-level citation quality is a separate question this
 * dataset does not answer.
 *
 * Queries are written in the corpus's own language. The offline hash-TF backend
 * tokenises on `[a-z0-9à-ỹ]+`, so a Vietnamese query against an English document
 * matches only on shared latin tokens — mixing languages in one query would
 * measure the tokenizer, not the retriever.
 *
 * `abstain: true` entries have an empty `relevant` set BY CONSTRUCTION: the
 * corpus has nothing on them. They test abstention and are excluded from MRR,
 * because a query with no gold item cannot be ranked correctly.
 */

const GOLDEN_SET = [
  // --- DNS / Active Directory / DHCP --------------------------------------
  {
    query: 'cấu hình DHCP scope cho mạng công ty',
    relevant: ['docs/02-ad-dns-dhcp-setup.md'],
  },
  {
    query: 'DHCP server cấp phát địa chỉ IP cho client',
    relevant: ['docs/02-ad-dns-dhcp-setup.md'],
  },
  {
    query: 'thêm máy tính mới vào domain AD',
    relevant: ['docs/02-ad-dns-dhcp-setup.md', 'tickets/ticket-014-new-laptop-onboarding-provision.md'],
  },
  {
    query: 'máy tính không vào được domain, lỗi giao tiếp domain controller',
    relevant: ['docs/02-ad-dns-dhcp-setup.md'],
  },

  // --- Network incidents --------------------------------------------------
  {
    query: 'máy tính không truy cập được internet',
    relevant: ['tickets/ticket-001-cannot-access-internet.md'],
  },
  {
    query: 'không phân giải được tên miền DNS',
    relevant: ['tickets/ticket-002-cannot-resolve-dns.md', 'docs/02-ad-dns-dhcp-setup.md'],
  },
  {
    query: 'máy tính không truy cập được thư mục chia sẻ mạng',
    relevant: ['tickets/ticket-004-cannot-access-network-share.md', 'tickets/ticket-018-shared-folder-ntfs-vs-share-perms.md'],
  },
  {
    query: 'máy in mạng báo offline, không in được',
    relevant: ['tickets/ticket-005-network-printer-offline.md'],
  },
  {
    query: 'lỗi xung đột địa chỉ IP, máy tự nhận APIPA',
    relevant: ['tickets/ticket-006-dhcp-ip-conflict-apipa.md'],
  },
  {
    query: 'wifi bị rớt kết nối liên tục',
    relevant: ['tickets/ticket-007-wifi-dropping-connection.md'],
  },
  {
    query: 'điện thoại IP không đăng ký được, VoIP registration failure',
    relevant: ['tickets/ticket-019-voip-ip-phone-registration-failure.md'],
  },
  {
    query: 'kết nối VPN thất bại, không vào được mạng nội bộ',
    relevant: ['tickets/ticket-013-vpn-connection-failure.md'],
  },
  {
    query: 'thiết kế phân vùng mạng VLAN và tường lửa',
    relevant: ['docs/07-vlan-firewall-design.md'],
  },

  // --- Accounts, identity, lifecycle --------------------------------------
  {
    query: 'tài khoản bị khóa, cần đặt lại mật khẩu',
    relevant: ['tickets/ticket-003-account-locked-password-reset.md'],
  },
  {
    query: 'quy trình nghỉ việc, thu hồi quyền truy cập nhân viên',
    relevant: ['tickets/ticket-015-employee-termination-offboarding.md', 'docs/05-onboarding-offboarding-sop.md'],
  },
  {
    query: 'cấp phát laptop và tài khoản cho nhân viên mới',
    relevant: ['tickets/ticket-014-new-laptop-onboarding-provision.md', 'docs/05-onboarding-offboarding-sop.md'],
  },
  {
    query: 'chính sách mật khẩu và khóa tài khoản sau nhiều lần sai',
    relevant: ['docs/03-gpo-security-matrix.md'],
  },
  {
    query: 'USB bị chặn bởi Group Policy',
    relevant: ['tickets/ticket-016-usb-storage-blocked-by-gpo.md', 'docs/03-gpo-security-matrix.md'],
  },

  // --- Endpoint health ----------------------------------------------------
  {
    query: 'ổ đĩa C đầy, dọn dẹp dung lượng',
    relevant: ['tickets/ticket-010-disk-full-c-drive-cleanup.md'],
  },
  {
    query: 'máy tính bị treo màn hình xanh, phân tích lỗi BSOD',
    relevant: ['tickets/ticket-009-bsod-system-crash-analysis.md'],
  },
  {
    query: 'máy tính chạy chậm, hiệu năng kém',
    relevant: ['tickets/ticket-017-slow-pc-performance-troubleshooting.md', 'docs/04-troubleshooting-matrix.md'],
  },

  // --- Data loss, backup, recovery ----------------------------------------
  {
    query: 'nhân viên xoá nhầm file, khôi phục dữ liệu',
    relevant: ['tickets/ticket-012-accidental-file-deletion-shadow-copy.md'],
  },
  {
    query: 'sao lưu thất bại và khôi phục dữ liệu helpdesk',
    relevant: ['tickets/ticket-020-backup-failure-and-recovery-test.md', 'docs/10-backup-restore-dr.md'],
  },
  {
    query: 'quy trình disaster recovery, khôi phục sau sự cố',
    relevant: ['docs/10-backup-restore-dr.md'],
  },

  // --- Security incidents -------------------------------------------------
  {
    query: 'máy tính nhiễm mã độc, cách ly và diệt virus',
    relevant: ['tickets/ticket-011-malware-quarantine-incident.md'],
  },
  {
    query: 'giám sát hệ thống và xử lý sự cố theo runbook',
    relevant: ['docs/09-monitoring-incident-runbook.md'],
  },
  {
    query: 'tích hợp hệ thống MiniERP với portal helpdesk',
    relevant: ['docs/11-minierp-integration.md'],
  },
  {
    query: 'Outlook không kết nối được Exchange',
    relevant: ['tickets/ticket-008-outlook-cannot-connect-exchange.md'],
  },

  // --- ABSTENTION: the corpus has nothing on these -------------------------
  // Not failures. A helpdesk assistant that answers these from general
  // knowledge is fabricating internal procedure — the failure mode the whole
  // governed pipeline exists to prevent.
  {
    query: 'chính sách lương và thưởng của công ty',
    relevant: [],
    abstain: true,
    note: 'No HR compensation policy exists in the corpus.',
  },
  {
    query: 'kế hoạch mở rộng văn phòng chi nhánh sang Đà Nẵng',
    relevant: [],
    abstain: true,
    note: 'No expansion planning document exists in the corpus.',
  },
  {
    query: 'công thức tính thưởng KPI của nhân viên',
    relevant: [],
    abstain: true,
    note: 'No KPI formula document exists in the corpus.',
  },
  {
    query: 'lịch nghỉ lễ tết áp dụng cho toàn bộ nhân viên',
    relevant: [],
    abstain: true,
    note: 'No holiday calendar document exists in the corpus.',
  },
];

/** Queries the corpus cannot answer — the abstention set. */
const ABSTENTION_QUERIES = Object.freeze(GOLDEN_SET.filter((q) => q.abstain).map((q) => q.query));

/** Queries with a known answer — the ranking set. */
const ANSWERABLE_QUERIES = Object.freeze(GOLDEN_SET.filter((q) => !q.abstain));

module.exports = { GOLDEN_SET, ABSTENTION_QUERIES, ANSWERABLE_QUERIES };