'use strict';

/**
 * Playbook rule-based — keyword → runbook ITIL chuẩn cho engine fallback
 * của src/ai.js (dùng khi Ollama chưa chạy / lỗi mạng). Rút từ các kịch bản
 * sự cố trong docs/ + tickets/ của repo nên output luôn đúng chuyên môn.
 */

const DEFAULT_PLAYBOOK = {
  name: 'General IT',
  match: null,
  summary: 'Sự cố IT cần được phân loại thêm — áp dụng quy trình xử lý sự cố chuẩn của Helpdesk.',
  diagnosis: [
    'Xác nhận lại triệu chứng với người báo (khi nào bắt đầu, máy nào, dải nào)',
    'Thu thập thông tin: ipconfig /all, phiên bản OS, ảnh chụp màn hình lỗi',
    'Kiểm tra có sự cố đồng loạt (nhiều user cùng báo) không — nếu có → nghi vấn sự cố hệ thống',
    'Thử tái hiện trên máy khác để khoanh vùng lỗi cá nhân vs hệ thống',
    'Cập nhật tiến độ ticket theo SLA, escalate nếu vượt 30 phút chưa có hướng',
  ],
  rca: 'Chưa đủ dữ liệu để kết luận root cause — cần thông tin thêm từ người báo.',
  prevention: [
    'Ghi rõ runbook sau khi xử lý xong (symptom → diagnosis → root cause → resolution)',
    'Bổ sung kịch bản tương tự vào kho ticket nếu lặp lại',
  ],
};

const PLAYBOOKS = [
  {
    name: 'Network — APIPA / DHCP',
    match: /apipa|169\.254|ip tự động|dhcp|không có mạng|no internet/i,
    summary: 'Máy không nhận được IP hợp lệ từ DHCP (dấu hiệu APIPA 169.254.x.x) → mất kết nối mạng.',
    diagnosis: [
      'ipconfig /all — kiểm tra có dải 169.254.x.x (APIPA) không',
      'ipconfig /release && ipconfig /renew — thử xin lại IP',
      'Ping gateway mặc định — nếu timeout, kiểm tra switch/port và cáp LAN',
      'Kiểm tra dịch vụ DHCP Server (services.msc) và scope đang Active',
      'Thử static IP cùng dải để khoanh vùng lỗi client vs DHCP server',
    ],
    rca: 'Dịch vụ DHCP Server dừng/scope hết lease, hoặc switch/port cáp liên kết client bị lỗi khiến máy không xin được IP.',
    prevention: [
      'Theo dõi DHCP scope usage + đặt cảnh báo hết lease',
      'Ghi lại MAC đã cấp phát, bật DHCP failover giữa 2 server',
      'Vận hành cable management + test port khi thay switch',
    ],
  },
  {
    name: 'Network — DNS',
    match: /dns|phân giải|không truy cập được trang|domain/i,
    summary: 'Không phân giải được tên miền — nghi vấn lỗi cấu hình DNS server hoặc client trỏ sai DNS.',
    diagnosis: [
      'nslookup google.com — kiểm tra server DNS phản hồi',
      'ipconfig /all — xác nhận DNS client trỏ đúng server nội bộ',
      'kiểm tra DNS Server role (dnsmgmt.msc) — Forwarders có hoạt động không',
      'ping bằng IP trực tiếp — phân biệt lỗi DNS vs lỗi định tuyến',
      'Restart dịch vụ DNS server nếu zone trả lời sai/NXDOMAIN tràn lan',
    ],
    rca: 'DNS Server dịch vụ dừng, forwarders sai, hoặc client bị ghi đè DNS (VPN/adapter khác) trỏ sang server không phân giải được tên miền nội bộ.',
    prevention: [
      'Đặt 2 DNS (server chính + secondary) qua GPO/DHCP option 6',
      'Monitoring DNS bằng check nslookup định kỳ, cảnh báo sự kiện DNS lỗi',
      'Ghi nhận thay đổi cấu hình DNS vào changelog',
    ],
  },
  {
    name: 'Active Directory — mật khẩu / lockout',
    match: /mật khẩu|password|khóa tài khoản|lockout|active directory|đăng nhập|login/i,
    summary: 'Lỗi đăng nhập Active Directory — nghi vấn sai mật khẩu hoặc tài khoản bị khóa do sai mật khẩu nhiều lần.',
    diagnosis: [
      'ADUC — kiểm tra account có bị Lockout/Disabled không',
      'Event Viewer → Security 4740 (lockout) — tìm nguồn gửi sai mật khẩu lặp lại',
      'Kiểm tra app/service đang lưu mật khẩu cũ (mail client, mapped drive)',
      'Unlock account + yêu cầu user đổi mật khẩu theo policy',
      'Kiểm tra GPO Password Policy (khóa mật khẩu, ngưỡng lockout)',
    ],
    rca: 'Mật khẩu cũ còn lưu ở thiết bị/app khác liên tục gửi sai → DC khóa tài khoản theo policy lockout.',
    prevention: [
      'Vận hành Credential Manager / rotate credential khi đổi mật khẩu',
      'Cấu hình lockout threshold hợp lý + theo dõi Event 4740 định kỳ',
      'Hướng dẫn user không lưu mật khẩu trên máy dùng chung',
    ],
  },
  {
    name: 'File Server — quyền / share',
    match: /file server|thư mục chung|share|ntfs|quyền truy cập|access denied|không mở được file/i,
    summary: 'Không truy cập được thư mục file server — xung đột quyền Share vs NTFS hoặc group membership sai.',
    diagnosis: [
      'Kết nối \\\\server\\share — kiểm tra quyền Share (Advanced → Share tab)',
      'kiểm tra quyền NTFS (Security tab) — có inherit từ cha không',
      'ADUC — xác nhận user có thuộc group được cấp quyền không',
      'thử access bằng tài khoản admin để khoanh quyền vs kết nối',
      'kiểm tra dung lượng/volume đầy (event disk) nếu open bị treo',
    ],
    rca: 'Quyền Share cho phép nhưng NTFS deny (hoặc ngược lại), hoặc user bị removed khỏi group ACL đã cấp quyền.',
    prevention: [
      'Quy tắc: luôn cấp quyền ở group, không cấp cho từng user',
      'Ghi lại ACL changes vào ticket + review định kỳ hàng quý',
      'Backup + Shadow Copy để user tự khôi phục file phiên bản trước',
    ],
  },
  {
    name: 'Hardware — máy in / thiết bị ngoại vi',
    match: /máy in|printer|in ấn|không in được/i,
    summary: 'Máy in không phản hồi — nghi vấn driver, queue treo hoặc kết nối printer port.',
    diagnosis: [
      'Control Panel → Devices — trạng thái printer có Offline/Paused không',
      'Print Server Properties → cancel all documents (xử lý queue treo)',
      'ping IP máy in — kiểm tra kết nối mạng',
      'cài lại driver đúng phiên bản OS, kiểm tra printer port (TCP/IP)',
      'In trang test từ server in — phân biệt lỗi client vs máy in',
    ],
    rca: 'Queue in treo do job lỗi, driver sai phiên bản, hoặc IP máy in thay đổi (DHCP) nhưng port printer vẫn trỏ cũ.',
    prevention: [
      'Cấp IP tĩnh / DHCP reservation cho máy in',
      'Deploy printer qua GPO thống nhất, ghi model + vị trí vào portal (tài sản)',
      'Đặt lịch clear queue định kỳ, monitor paper/toner',
    ],
  },
  {
    name: 'Security — nghi vấn bảo mật',
    match: /bảo mật|malware|phishing|đánh cắp|usb|lỗi bảo mật|suspicious|đăng nhập lạ/i,
    summary: 'Vấn đề nghi vấn bảo mật — cần cô lập, thu thập bằng chứng trước khi khắc phục.',
    diagnosis: [
      'Ngắt mạng máy bị nghi ngờ (không tắt máy — giữ bằng chứng RAM)',
      'Chạy quét malware offline + kiểm tra process/startup bất thường',
      'Rà soát Event Log đăng nhập lạ (4624/4625 bất thường từ IP lạ)',
      'Đổi mật khẩu tài khoản bị ảnh hưởng từ máy sạch',
      'Báo cáo lên quản trị + ghi nhận ticket mức Critical',
    ],
    rca: 'Phishing/malware qua email-USB hoặc credential rò rỉ cho phép truy cập trái phép.',
    prevention: [
      'Bắt buộc MFA, triển khai email security (anti-phishing)',
      'Cập nhật patch + AV/EDR định kỳ, policy USB storage qua GPO',
      'Training nhận thức bảo mật định kỳ cho người dùng',
    ],
  },
  {
    name: 'Hardware — máy trạm',
    match: /ổ cứng|ram|máy tính|khởi động|bàn phím|màn hình|chết máy|lag|treo/i,
    summary: 'Lỗi phần cứng máy trạm — cần chẩn đoán theo triệu chứng nguồn/đĩa/lưu trữ.',
    diagnosis: [
      'Kiểm tra đèn nguồn, tiếng kêu BIOS — phân biệt lỗi nguồn vs mainboard',
      'Event Viewer → System tìm disk/SMART lỗi (153, 7, 51)',
      'chkdsk /f + kiểm tra SMART (CrystalDiskInfo)',
      'Tháo thiết bị ngoại vi thừa, test RAM (mdsched.exe)',
      'Đổi máy từ kho nếu lỗi phần cứng đã xác nhận (tiến độ SLA)',
    ],
    rca: 'Phần cứng xuống cấp (ổ HDD/SSD hết tuổi thọ, RAM lỗi) hoặc lỗi driver gây treo.',
    prevention: [
      'Ghi rõ warrantyExpiry từng tài sản, thay thế trước khi hết hạn',
      'Monitoring SMART + disk space, dự phòng máy trạm ở kho IT',
      'Cân nhắc nâng SSD/RAM cho máy chậm theo kết quả audit định kỳ',
    ],
  },
  {
    name: 'Software — cài đặt / bản quyền',
    match: /phần mềm|cài đặt|license|bản quyền|outlook|teams|không mở được ứng dụng/i,
    summary: 'Về phần mềm/bản quyền — kiểm tra cài đặt, license và compatibility với phiên bản hiện tại.',
    diagnosis: [
      'Hỏi lại phiên bản + thông báo lỗi chính xác (screenshot)',
      'Kiểm tra license còn seat trống (GET /api/licenses trong portal)',
      'cài lại đúng phiên bản tương thích với OS (gọi từ kho software chuẩn)',
      'Kiểm tra quyền Local Admin khi cài đặt, xem log cài đặt nếu fail',
      'Ghi nhận license đã cấp phát vào portal (audit)',
    ],
    rca: 'Hết seat license, phiên bản phần mềm không tương thích OS, hoặc installer thiếu quyền/dependency.',
    prevention: [
      'Quản lý license tập trung trong portal, cảnh báo utilizationPercent > 90%',
      'Duyệt trước phiên bản software qua thay đổi (change management)',
      'Chuẩn hoá image + catalogue phần mềm được phép cài',
    ],
  },
];

module.exports = { PLAYBOOKS, DEFAULT_PLAYBOOK };
