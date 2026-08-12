import os
import sys
import time
import glob
import json
import cv2
import torch
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from ultralytics import YOLO

# ── CONFIGURATION ─────────────────────────────────────────────────────────────
MODEL_PATH = Path(r"f:\ANPR\ANPR-Prod\ES-ANPR-CMDS-AI-BACKEND-SERVICE\models\vehicle_type.pt")
INPUT_DIRS = [
    Path(r"f:\ANPR\ANPR-Datasets\ANPR-DATA-COLLECT\29.8\29.8\NVR154_CH1"),
    Path(r"f:\ANPR\ANPR-Datasets\ANPR-DATA-COLLECT\29.8\29.8\NVR154_CH2"),
    Path(r"f:\ANPR\ANPR-Datasets\ANPR-DATA-COLLECT\29.8\29.8\NVR154_CH3"),
]
OUTPUT_DIR = Path(r"f:\ANPR\ANPR-Datasets\ANPR-DATA-COLLECT\Twowheeler4")

CONF_THRESHOLD = 0.25       # Confidence threshold for two-wheeler detection
EXPANSION_SIDE = 0.05       # 5% padding on left/right/bottom
EXPANSION_TOP = 0.10        # 10% padding on top for rider headroom
BATCH_SIZE = 32             # Batch size for YOLO model inference
NUM_IO_WORKERS = 8          # Thread pool size for saving cropped images

# ── CLASSES ───────────────────────────────────────────────────────────────────
TWO_WHEELER_KEYWORDS = {'motorcycle', 'scooter', 'bike', 'two_wheeler', 'bicycle', 'two-wheeler'}

def get_two_wheeler_class_ids(model_names: dict) -> set:
    """Returns class IDs that represent two-wheelers."""
    class_ids = set()
    for cid, name in model_names.items():
        if any(kw in str(name).lower() for kw in TWO_WHEELER_KEYWORDS):
            class_ids.add(cid)
    return class_ids

def expand_box(x1: int, y1: int, x2: int, y2: int, img_w: int, img_h: int, exp_side: float, exp_top: float) -> tuple:
    """
    Expands bounding box by exp_side on left/right/bottom and exp_top on top.
    Clamps coordinates strictly within image boundaries.
    """
    bw = x2 - x1
    bh = y2 - y1
    nx1 = max(0, int(x1 - exp_side * bw))
    ny1 = max(0, int(y1 - exp_top * bh))
    nx2 = min(img_w, int(x2 + exp_side * bw))
    ny2 = min(img_h, int(y2 + exp_side * bh))
    return nx1, ny1, nx2, ny2

def save_crop_task(crop_img, out_path):
    """Worker task to write cropped image file asynchronously."""
    try:
        cv2.imwrite(str(out_path), crop_img)
    except Exception as e:
        print(f"Error saving {out_path}: {e}")

def main():
    print("=" * 80)
    print(" ANPR DATA COLLECT - TWO-WHEELER CROPPING MODEL & PIPELINE (MULTI DIR)")
    print("=" * 80)

    # 1. Validation & Folder Setup
    if not MODEL_PATH.exists():
        print(f"[ERROR] Model file not found at: {MODEL_PATH}")
        sys.exit(1)

    for in_dir in INPUT_DIRS:
        if not in_dir.exists():
            print(f"[ERROR] Input directory not found at: {in_dir}")
            sys.exit(1)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # 2. Find all images
    image_extensions = ('*.jpg', '*.jpeg', '*.png', '*.bmp', '*.webp')
    image_paths = []
    
    for in_dir in INPUT_DIRS:
        print(f" Scanning for images in: {in_dir}")
        for ext in image_extensions:
            image_paths.extend(glob.glob(str(in_dir / "**" / ext), recursive=True))

    total_images = len(image_paths)
    print(f" Total images discovered: {total_images}")

    if total_images == 0:
        print("[WARN] No images found to process!")
        return

    # 3. Load YOLO Model
    print(f"\n Loading YOLO model from: {MODEL_PATH.name}")
    model = YOLO(str(MODEL_PATH))
    two_wheeler_ids = get_two_wheeler_class_ids(model.names)
    print(f" Model classes: {model.names}")
    print(f" Filtered two-wheeler class IDs: {two_wheeler_ids}")

    # 4. Processing Setup
    start_time = time.time()
    total_crops_saved = 0
    processed_images_count = 0

    io_executor = ThreadPoolExecutor(max_workers=NUM_IO_WORKERS)
    futures = []

    print(f"\n Starting batch processing with batch_size={BATCH_SIZE}...")
    print("-" * 80)

    # Process in chunks
    for i in range(0, total_images, BATCH_SIZE):
        batch_paths = image_paths[i:i + BATCH_SIZE]
        
        # Load images for the current batch
        batch_imgs = []
        valid_paths = []
        for p in batch_paths:
            try:
                if os.path.exists(p) and os.path.getsize(p) > 0:
                    img = cv2.imread(p)
                    if img is not None and img.size > 0:
                        batch_imgs.append(img)
                        valid_paths.append(p)
            except Exception as err:
                print(f"  [WARN] Skipping corrupt image {p}: {err}")

        if not batch_imgs:
            processed_images_count += len(batch_paths)
            continue

        # Inference
        results = model.predict(source=batch_imgs, conf=CONF_THRESHOLD, verbose=False, half=False)

        # Process results
        for img_idx, res in enumerate(results):
            img_path = valid_paths[img_idx]
            img = batch_imgs[img_idx]
            img_h, img_w = img.shape[:2]
            base_name = Path(img_path).stem
            dir_name = Path(img_path).parent.name

            boxes = res.boxes
            tw_count_in_img = 0

            for box_idx, box in enumerate(boxes):
                cid = int(box.cls[0].item())
                if cid not in two_wheeler_ids:
                    continue

                conf = float(box.conf[0].item())
                cname = model.names.get(cid, 'two_wheeler')
                x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())

                # Expand box
                ex1, ey1, ex2, ey2 = expand_box(x1, y1, x2, y2, img_w, img_h, EXPANSION_SIDE, EXPANSION_TOP)
                crop = img[ey1:ey2, ex1:ex2]

                if crop.size > 0:
                    tw_count_in_img += 1
                    crop_filename = f"{dir_name}_{base_name}_tw{tw_count_in_img:02d}_{cname}_conf{int(conf*100)}.jpg"
                    out_path = OUTPUT_DIR / crop_filename

                    # Async save
                    fut = io_executor.submit(save_crop_task, crop.copy(), out_path)
                    futures.append(fut)
                    total_crops_saved += 1

            processed_images_count += 1

        # Logging Progress
        if (processed_images_count % 100 == 0) or (processed_images_count == total_images):
            elapsed = time.time() - start_time
            fps = processed_images_count / max(0.1, elapsed)
            remaining_sec = (total_images - processed_images_count) / max(0.1, fps)
            print(f" Progress: {processed_images_count}/{total_images} images ({processed_images_count/total_images*100:.1f}%) | "
                  f"Crops: {total_crops_saved} | Speed: {fps:.1f} img/s | ETA: {remaining_sec/60:.1f} min")

    # Wait for all background IO tasks to complete
    print("\n Finalizing disk write operations...")
    for fut in futures:
        fut.result()
    io_executor.shutdown()

    elapsed_total = time.time() - start_time
    print("\n" + "=" * 80)
    print(" PROCESSING COMPLETE")
    print("=" * 80)
    print(f" Total debug images scanned : {total_images}")
    print(f" Total images processed     : {processed_images_count}")
    print(f" Total two-wheelers cropped : {total_crops_saved}")
    print(f" Output folder              : {OUTPUT_DIR}")
    print(f" Total time taken           : {elapsed_total:.2f} seconds ({elapsed_total/60:.2f} minutes)")
    print(f" Average processing speed   : {processed_images_count / max(0.1, elapsed_total):.1f} images/sec")
    print("=" * 80)

    # Save summary json
    summary_data = {
        "model_path": str(MODEL_PATH),
        "input_dirs": [str(d) for d in INPUT_DIRS],
        "output_dir": str(OUTPUT_DIR),
        "total_debug_images": total_images,
        "processed_images": processed_images_count,
        "two_wheelers_cropped": total_crops_saved,
        "confidence_threshold": CONF_THRESHOLD,
        "expansion_side": EXPANSION_SIDE,
        "expansion_top": EXPANSION_TOP,
        "total_time_sec": round(elapsed_total, 2),
        "completed_at": time.strftime("%Y-%m-%d %H:%M:%S")
    }
    with open(OUTPUT_DIR / "dataset_summary.json", "w", encoding="utf-8") as f:
        json.dump(summary_data, f, indent=2)

if __name__ == "__main__":
    main()
