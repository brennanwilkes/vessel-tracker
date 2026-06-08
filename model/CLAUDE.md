# Model — CLAUDE.md

M4 scaffold only. No training code exists yet. This directory is created now so the dataset can be collected from day one.

## What the model will be

A small ONNX **object detector** — its only job is "where is the boat in this frame" → bounding box → pixel position → bearing → match to nearest AIS contact at that bearing. **Identity comes from AIS, not from visual recognition of a named vessel.** This is a detector, not a classifier.

## Dataset

- Raw images: stored **outside git** (Cloudflare R2 or owner's local machine). NOT committed.
- `dataset/background/` — owner-supplied empty-view reference photos (committed).
- `dataset/labels.json` — bounding box annotations (committed).

## Training

Manual/local only. No ML CI. Run rarely, then freeze. Steps (to be filled at M4):

```bash
pip install -r requirements.txt
python scripts/prepare_dataset.py
python scripts/train.py
python scripts/export_onnx.py
python scripts/evaluate.py
```

Exported `.onnx` goes in `model/export/` but is **not committed** (too large).

## In-browser inference (M4)

`onnxruntime-web` loaded via CDN on the camera tab only when first activated.
