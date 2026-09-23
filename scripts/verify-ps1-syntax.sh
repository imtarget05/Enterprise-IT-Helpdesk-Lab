#!/usr/bin/env bash
# =============================================================================
#  Kiểm tra CÚ PHÁP PowerShell bằng AST parser chính thức (không cần Windows).
#
#  Ưu tiên: 1) pwsh có sẵn trên máy   2) Docker image mcr.microsoft.com/powershell
#  Thoát code: 0 = tất cả file parse hợp lệ, 1 = có lỗi cú pháp / không có runner.
#
#  Usage: bash scripts/verify-ps1-syntax.sh [đường_dẫn_thư_mục_chứa_ps1]
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Docker requires an absolute path for volume mounts — resolve it immediately.
TARGET_DIR="$(cd "${1:-$SCRIPT_DIR}" && pwd)"
IMAGE="mcr.microsoft.com/powershell:lts-alpine"

if ! ls "$TARGET_DIR"/*.ps1 >/dev/null 2>&1; then
  echo "✖ Không tìm thấy file .ps1 nào trong $TARGET_DIR" >&2
  exit 1
fi

# Script PowerShell: parse từng file bằng Language.Parser, in lỗi kèm dòng
PS_CMD='
$fail = 0
foreach ($f in (Get-ChildItem $env:PS_TARGET_DIR -Filter *.ps1 | Sort-Object Name)) {
  $tokens = $null; $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors.Count -gt 0) {
    $fail = 1
    Write-Host ("FAIL  {0}" -f $f.Name)
    foreach ($e in $errors) {
      Write-Host ("        dòng {0}: {1}" -f $e.Extent.StartLineNumber, $e.Message)
    }
  } else {
    Write-Host ("OK    {0}  ({1} tokens, 0 lỗi parse)" -f $f.Name, $tokens.Count)
  }
}
exit $fail
'

if command -v pwsh >/dev/null 2>&1; then
  echo ">> Dùng pwsh tại: $(command -v pwsh)"
  PS_TARGET_DIR="$TARGET_DIR" pwsh -NoProfile -Command "$PS_CMD"
  exit $?
fi

if command -v docker >/dev/null 2>&1 && docker info --format '{{.ServerVersion}}' >/dev/null 2>&1; then
  echo ">> pwsh không có, dùng container $IMAGE"
  docker run --rm -v "$TARGET_DIR:/scripts:ro" -e PS_TARGET_DIR=/scripts "$IMAGE" \
    pwsh -NoProfile -Command "$PS_CMD"
  exit $?
fi

if command -v docker >/dev/null 2>&1; then
  echo "⚠  Docker có cài nhưng daemon đang tắt — bật Docker Desktop rồi chạy lại để parse AST." >&2
fi
echo "✖ Cần pwsh hoặc Docker daemon để parse AST PowerShell." >&2
echo "  Fallback (luôn chạy được): npm test --prefix internal-portal  → linter tĩnh + mutation test." >&2
exit 2
