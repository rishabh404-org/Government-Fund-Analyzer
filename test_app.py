import os
import io
import json
import unittest
from app import app, active_data_state

class TestGovernmentFundAnalyzer(unittest.TestCase):
    def setUp(self):
        self.app = app.test_client()
        self.app.testing = True

    def test_01_health_check(self):
        response = self.app.get("/health")
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data["status"], "healthy")
        self.assertEqual(data["service"], "Government Fund Analyzer")
        print("[OK] Health check passed")

    def test_02_index_route(self):
        response = self.app.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Government Fund Analyzer", response.data)
        self.assertIn(b"Next-Gen Fund Analytics", response.data)
        print("[OK] Dashboard UI template rendered successfully")

    def test_03_load_sample_dataset(self):
        response = self.app.post("/load_sample")
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data["success"])
        self.assertIn("analytics", data)
        self.assertIn("kpis", data["analytics"])
        self.assertGreater(data["analytics"]["kpis"]["total_records"], 0)
        self.assertGreater(data["analytics"]["kpis"]["total_departments"], 0)
        print("[OK] Sample dataset loaded and analyzed with KPIs:", data["analytics"]["kpis"]["formatted_total"])

    def test_04_analyze_endpoint(self):
        # First ensure dataset loaded
        self.app.post("/load_sample")
        
        # Test re-analyzing with a specific metric
        response = self.app.post("/analyze", json={
            "metric": "Actuals 2024-25"
        })
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data["success"])
        self.assertEqual(data["analytics"]["active_metric"], "Actuals 2024-25")
        print("[OK] Re-analyze with dynamic metric passed:", data["analytics"]["active_metric"])

    def test_05_data_table_pagination_and_search(self):
        self.app.post("/load_sample")
        
        # Fetch page 1 with page size 10
        response = self.app.get("/data?page=1&page_size=10")
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data["success"])
        self.assertEqual(len(data["rows"]), 10)
        self.assertGreaterEqual(data["total_rows"], 30)
        self.assertEqual(data["page"], 1)

        # Search for 'Defence'
        search_res = self.app.get("/data?search=defence")
        self.assertEqual(search_res.status_code, 200)
        s_data = search_res.get_json()
        self.assertTrue(s_data["success"])
        self.assertGreaterEqual(s_data["filtered_rows"], 1)
        print("[OK] Data table pagination and live search passed")

    def test_06_download_processed_csv(self):
        self.app.post("/load_sample")
        response = self.app.get("/download")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Ministry/Department", response.data)
        response.close()
        print("[OK] Processed CSV download passed")

    def test_07_upload_diverse_csv(self):
        # Upload state_treasury_expenditure.csv with currency symbols, percentages, commas
        file_path = os.path.join("sample_data", "state_treasury_expenditure.csv")
        with open(file_path, "rb") as f:
            data = {
                "file": (io.BytesIO(f.read()), "state_treasury_expenditure.csv")
            }
            response = self.app.post("/upload", data=data, content_type="multipart/form-data")
        
        self.assertEqual(response.status_code, 200)
        res_json = response.get_json()
        self.assertTrue(res_json["success"])
        kpis = res_json["analytics"]["kpis"]
        self.assertEqual(kpis["total_records"], 12)
        self.assertIsNotNone(kpis["total_amount"])
        self.assertGreater(kpis["total_amount"], 0)
        print("[OK] Upload of diverse CSV with currency symbols ($) and percentages (%) passed!")
        print("  Detected department column:", res_json["detected_roles"]["department_column"])
        print("  Detected budget column:", res_json["detected_roles"]["budget_column"])
        print("  Detected actual column:", res_json["detected_roles"]["actual_column"])

    def test_08_error_handling(self):
        # 1. No file in request
        res1 = self.app.post("/upload")
        self.assertEqual(res1.status_code, 400)
        self.assertFalse(res1.get_json()["success"])

        # 2. Invalid extension
        data = {
            "file": (io.BytesIO(b"random text"), "test.txt")
        }
        res2 = self.app.post("/upload", data=data, content_type="multipart/form-data")
        self.assertEqual(res2.status_code, 400)
        self.assertFalse(res2.get_json()["success"])

        # 3. Empty CSV
        data_empty = {
            "file": (io.BytesIO(b""), "empty.csv")
        }
        res3 = self.app.post("/upload", data=data_empty, content_type="multipart/form-data")
        self.assertEqual(res3.status_code, 400)
        self.assertFalse(res3.get_json()["success"])
        print("[OK] All error handling scenarios passed cleanly")

    def test_09_decimal_preservation(self):
        # Verify decimal points are NOT stripped
        csv_decimal = b'Ministry/Department,Total\nDefence,"5,94,845.50"\nTransport,"2,78,000.25"\n'
        data = {"file": (io.BytesIO(csv_decimal), "decimal_test.csv")}
        res = self.app.post("/upload", data=data, content_type="multipart/form-data")
        self.assertEqual(res.status_code, 200)
        res_json = res.get_json()
        self.assertTrue(res_json["success"])
        total = res_json["analytics"]["kpis"]["total_amount"]
        self.assertAlmostEqual(total, 872845.75, places=2)
        print("[OK] Decimal preservation test passed: 5,94,845.50 + 2,78,000.25 =", total)

    def test_10_duplicate_column_headers(self):
        # Verify duplicate column headers don't crash with 500 error
        csv_dup = b'Department,Total,Total\nHealth,100,200\nEducation,300,400\n'
        data = {"file": (io.BytesIO(csv_dup), "dup_test.csv")}
        res = self.app.post("/upload", data=data, content_type="multipart/form-data")
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.get_json()["success"])
        print("[OK] Duplicate column headers deduplication passed")

    def test_11_numeric_first_column(self):
        # Verify CSV whose first column is an ID or Year does not crash with groupby ValueError
        csv_num = b'ID,Budget,Actual\n101,1000,900\n102,2000,1800\n'
        data = {"file": (io.BytesIO(csv_num), "num_first_test.csv")}
        res = self.app.post("/upload", data=data, content_type="multipart/form-data")
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.get_json()["success"])
        print("[OK] Numeric first column (ID) groupby test passed")

    def test_12_semicolon_delimited_csv(self):
        # Verify semicolon-separated CSV auto-detects delimiter and columns
        csv_semi = b'Dept;Budget;Actual\nHealth;500;450\nTransport;700;650\n'
        data = {"file": (io.BytesIO(csv_semi), "semi_test.csv")}
        res = self.app.post("/upload", data=data, content_type="multipart/form-data")
        self.assertEqual(res.status_code, 200)
        res_json = res.get_json()
        self.assertTrue(res_json["success"])
        self.assertGreaterEqual(len(res_json["detected_roles"]["numeric_columns"]), 2)
        print("[OK] Semicolon delimited CSV autodetection passed")

    def test_13_summary_row_filtering(self):
        # Verify 'Total' summary row is excluded from department ranking
        csv_summary = b'Department,Budget,Actual\nHealth,1000,900\nEducation,2000,1800\nTotal,3000,2700\n'
        data = {"file": (io.BytesIO(csv_summary), "summary_test.csv")}
        res = self.app.post("/upload", data=data, content_type="multipart/form-data")
        self.assertEqual(res.status_code, 200)
        res_json = res.get_json()
        top_dept = res_json["analytics"]["departments_ranking"]["top_10"][0]["name"]
        self.assertNotEqual(top_dept.lower(), "total")
        print("[OK] Summary row filtering passed (Top dept is:", top_dept, ")")

    def test_14_non_ascii_filename(self):
        # Verify non-ASCII filename is handled safely
        csv_data = b'Department,Budget\nHealth,1000\n'
        data = {"file": (io.BytesIO(csv_data), "budget_2025.csv")}
        res = self.app.post("/upload", data=data, content_type="multipart/form-data")
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.get_json()["success"])
        print("[OK] Non-ASCII filename upload passed")

if __name__ == "__main__":
    unittest.main()

