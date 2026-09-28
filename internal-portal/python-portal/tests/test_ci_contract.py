"""CI contract check — job Python unittest phải tồn tại và đúng lệnh.

Không chạy CI thật; chỉ assert nội dung workflow (static contract).
"""
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "ci.yml"


class PythonCiJobTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text(encoding="utf-8")

    def test_workflow_exists(self):
        self.assertTrue(WORKFLOW.exists(), f"thiếu workflow: {WORKFLOW}")

    def test_workflow_has_python_unittest_job(self):
        self.assertIn("python-portal-tests:", self.text,
                      "ci.yml phải có job Python cho python-portal")
        self.assertIn("unittest discover", self.text,
                      "job Python phải chạy `python -m unittest discover`")
        self.assertIn("actions/setup-python", self.text)

    def test_python_job_installs_declared_requirements_only(self):
        self.assertIn("python-portal/requirements.txt", self.text,
                      "job Python phải cài đúng requirements.txt khai báo sẵn")
        for line in self.text.splitlines():
            self.assertNotIn("pytest", line.lower(),
                             "không được cài/chạy pytest (test dùng stdlib unittest)")

    def test_python_job_runs_in_isolated_data_dir(self):
        self.assertIn("DATA_FILE=", self.text,
                      "job Python phải trỏ DATA_FILE vào thư mục tạm của runner")
        self.assertNotIn("python-portal/data/db.json", self.text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
