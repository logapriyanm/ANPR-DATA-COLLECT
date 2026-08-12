import os
import sys
import glob
import json
import re
import cv2
import numpy as np

# Configure Windows PyTorch DLL paths if present
torch_lib = r'f:\ANPR\ANPR-Prod\ES-ANPR-CMDS-AI-BACKEND-SERVICE\venv\Lib\site-packages\torch\lib'
if os.path.exists(torch_lib):
    try:
        os.add_dll_directory(torch_lib)
    except Exception:
        pass
    os.environ['PATH'] = torch_lib + ';' + os.environ.get('PATH', '')

from ultralytics import YOLO
from paddleocr import TextRecognition

# Target problem characters specified by user
TARGET_LETTERS = set(['H', 'M', 'O', 'J', 'I', 'V', 'Y','B','R','Q'])

# Explicit Kishore ES problem examples (Ground Truth plates)
KISHORE_EXAMPLES = {
    "TN28H9111", "TN34AA4108", "TN34AJ5553", "TN28AL5798", "TN07CZ2333",
    "TN88F1147", "TN28BF672", "TN28AD7066", "TN28BB", "TN88L6433",
    "TN49BJ7888", "TN34AY8284", "TN28DA4290", "TN28BD9991", "TN88E3133",
    "TN48BE9838", "TN47BT2347"
}

def clean_text(text: str) -> str:
    """Strip non-alphanumeric characters and uppercase."""
    if not text:
        return ""
    return re.sub(r'[^A-Z0-9]', '', text.upper())

def has_target_letters(text: str) -> bool:
    """Check if text contains any of H, M, O, J, I, V, Y."""
    text_clean = clean_text(text)
    return any(ch in TARGET_LETTERS for ch in text_clean)

def has_repeated_digits(text: str) -> bool:
    """Check if text contains 2 or 3 same consecutive numbers (e.g. 5553, 3111, 4222, 2555, 8555, 2333, etc.)."""
    text_clean = clean_text(text)
    return bool(re.search(r'(\d)\1', text_clean))

def extract_gt_from_filename(filepath: str) -> str:
    """Extract Ground Truth LPN from filename if present (e.g. 44620_TN88AZ3118_..._plate.jpg)."""
    basename = os.path.basename(filepath)
    parts = basename.split('_')
    if len(parts) >= 2:
        candidate = parts[1].upper()
        # Indian license plate patterns usually start with state code (e.g. TN, KA, MH, DL, etc.)
        if len(candidate) >= 4 and re.match(r'^[A-Z0-9]+$', candidate):
            return candidate
    return ""

def crop_plate_region(img: np.ndarray, yolo_model: YOLO) -> np.ndarray:
    """Crop license plate region using YOLO model. Fall back to full image if already cropped."""
    if img is None or img.size == 0:
        return None
    h, w = img.shape[:2]

    # If already a small cropped plate image, use it directly
    if h < 350 and w < 500:
        return img

    results = yolo_model(img, verbose=False)
    best_crop = None
    best_conf = 0.0

    for r in results:
        boxes = r.boxes
        for b in boxes:
            conf = float(b.conf)
            if conf > best_conf:
                best_conf = conf
                xyxy = b.xyxy.cpu().numpy()[0].astype(int)
                x1, y1, x2, y2 = max(0, xyxy[0] - 5), max(0, xyxy[1] - 5), min(w, xyxy[2] + 5), min(h, xyxy[3] + 5)
                if (x2 - x1) > 10 and (y2 - y1) > 10:
                    best_crop = img[y1:y2, x1:x2]

    if best_crop is not None and best_conf >= 0.25:
        return best_crop
    return img

def run_ocr(crop_img: np.ndarray, rec_engine: TextRecognition) -> str:
    """Run text recognition on cropped plate image with top/bottom line splitting for double-line plates."""
    if crop_img is None or crop_img.size == 0:
        return ""
    
    h, w = crop_img.shape[:2]
    text_parts = []

    # If double line plate (height > 0.35 * width), split into top and bottom halves
    if h > 0.35 * w:
        top_half = crop_img[0:int(h * 0.55), :]
        bot_half = crop_img[int(h * 0.45):h, :]
        for strip in [top_half, bot_half]:
            if strip.size > 0:
                res = rec_engine.predict(strip)
                if res and len(res) > 0 and res[0].get('rec_text'):
                    t = res[0]['rec_text'].strip()
                    if t:
                        text_parts.append(t)
    else:
        res = rec_engine.predict(crop_img)
        if res and len(res) > 0 and res[0].get('rec_text'):
            t = res[0]['rec_text'].strip()
            if t:
                text_parts.append(t)

    return clean_text(" ".join(text_parts))

def main():
    print("=== ANPR Problematic License Plate Harvester ===")
    
    base_dir = r"f:\ANPR\ANPR-Datasets\ANPR-DATA-COLLECT"
    captures_dir = r"f:\ANPR\ANPR-Prod\ES-ANPR-CMDS-RTSP-BACKEND-SERVICE\captures"
    dataset_298_dir = r"f:\ANPR\ANPR-Datasets\ANPR-DATA-COLLECT\29.8\numberplate"
    output_dir = os.path.join(base_dir, "NumberPlate")
    os.makedirs(output_dir, exist_ok=True)

    yolo_path = r"f:\ANPR\ANPR-Prod\ES-ANPR-CMDS-AI-BACKEND-SERVICE\models\license-plate-finetune-v1x.pt"
    print(f"Loading YOLO Model: {yolo_path}")
    yolo = YOLO(yolo_path)

    print("Loading PaddleOCR TextRecognition (PP-OCRv5_server_rec)...")
    rec = TextRecognition(model_name="PP-OCRv5_server_rec")

    # Collect source files
    nvr154_dir = os.path.join(base_dir, "NVR154DATAS")
    nvr154_files = glob.glob(os.path.join(nvr154_dir, "**", "*.jpg"), recursive=True)
    captures_files = glob.glob(os.path.join(captures_dir, "**", "*_plate.jpg"), recursive=True)
    dataset_files = glob.glob(os.path.join(dataset_298_dir, "**", "*.jpg"), recursive=True)
    all_files = nvr154_files + captures_files + dataset_files

    print(f"Total files collected: {len(all_files)} ({len(nvr154_files)} from NVR154DATAS, {len(captures_files)} from captures, {len(dataset_files)} from 29.8/numberplate)")

    matched_records = []
    saved_count = 0

    for idx, filepath in enumerate(all_files, start=1):
        if idx % 50 == 0 or idx == len(all_files):
            print(f"Processing [{idx}/{len(all_files)}] images...")

        img = cv2.imread(filepath)
        if img is None:
            continue

        gt = extract_gt_from_filename(filepath)
        plate_crop = crop_plate_region(img, yolo)
        if plate_crop is None:
            continue

        ocr_pred = run_ocr(plate_crop, rec)

        # Check filter criteria
        reasons = []

        # Rule 1: Contains target letters H, M, O, J, I, V, Y
        if has_target_letters(gt) or has_target_letters(ocr_pred):
            reasons.append("target_letters")

        # Rule 2: Contains repeated numbers (2-3 same consecutive digits like 5553, 3111, 4222, 2555, 8555, 2333, etc.)
        if has_repeated_digits(gt) or has_repeated_digits(ocr_pred):
            reasons.append("repeated_digits")

        # Rule 3: Matches Kishore ES examples
        if gt in KISHORE_EXAMPLES or any(ex in gt for ex in KISHORE_EXAMPLES):
            reasons.append("kishore_example")

        # Rule 4: OCR mismatch / error compared to Ground Truth
        if gt and ocr_pred and clean_text(gt) != clean_text(ocr_pred):
            reasons.append("ocr_mismatch")

        if reasons:
            saved_count += 1
            filename = os.path.basename(filepath)
            dest_filename = f"selected_{saved_count:04d}_{filename}"
            dest_path = os.path.join(output_dir, dest_filename)

            cv2.imwrite(dest_path, plate_crop)

            matched_records.append({
                "id": saved_count,
                "source_file": filepath,
                "saved_file": dest_filename,
                "ground_truth": gt,
                "ocr_prediction": ocr_pred,
                "match_reasons": reasons
            })

    # Save summary report
    summary_path = os.path.join(base_dir, "collection_summary.json")
    summary_data = {
        "total_scanned": len(all_files),
        "total_selected": saved_count,
        "reasons_count": {
            "target_letters": sum(1 for r in matched_records if "target_letters" in r["match_reasons"]),
            "repeated_digits": sum(1 for r in matched_records if "repeated_digits" in r["match_reasons"]),
            "kishore_example": sum(1 for r in matched_records if "kishore_example" in r["match_reasons"]),
            "ocr_mismatch": sum(1 for r in matched_records if "ocr_mismatch" in r["match_reasons"])
        },
        "records": matched_records
    }

    with open(summary_path, "w") as f:
        json.dump(summary_data, f, indent=2)

    print("\n=== Processing Complete ===")
    print(f"Total Scanned : {len(all_files)}")
    print(f"Total Selected: {saved_count}")
    print(f"Saved crops in: {output_dir}")
    print(f"Summary JSON  : {summary_path}")

if __name__ == "__main__":
    main()
