import os
import glob
import json

base_dir = r"f:\ANPR\ANPR-Datasets\ANPR-DATA-COLLECT"
captures_dir = r"f:\ANPR\ANPR-Prod\ES-ANPR-CMDS-RTSP-BACKEND-SERVICE\captures"
dataset_298_dir = r"f:\ANPR\ANPR-Datasets\ANPR-DATA-COLLECT\29.8\numberplate"

captures_files = glob.glob(os.path.join(captures_dir, "**", "*_plate.jpg"), recursive=True)
dataset_files = glob.glob(os.path.join(dataset_298_dir, "**", "*.jpg"), recursive=True)
total_sources = len(captures_files) + len(dataset_files)

print(f"Total source images to scan: {total_sources}")

out_dir = os.path.join(base_dir, "NumberPlate")
summary_path = os.path.join(base_dir, "collection_summary.json")

if os.path.exists(out_dir):
    out_files = glob.glob(os.path.join(out_dir, "*.jpg"))
    print(f"Cropped number plates saved so far: {len(out_files)}")
else:
    print("Output directory not created yet.")

if os.path.exists(summary_path):
    print("STATUS: 100% COMPLETED!")
    with open(summary_path, "r") as f:
        data = json.load(f)
        print(f"Total Scanned : {data.get('total_scanned')}")
        print(f"Total Selected: {data.get('total_selected')}")
        print("Reasons Breakdown:")
        print(json.dumps(data.get("reasons_count"), indent=2))
else:
    print("STATUS: Processing in progress...")

