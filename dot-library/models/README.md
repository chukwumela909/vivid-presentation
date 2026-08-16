# Models

These files are **not committed** — they are large, and FLAME is license-gated.
dotlib degrades gracefully without any of them (OpenCV Haar detection + a head
lofted from the jawline), but you want all three for the full face sculpture.

## 1. MediaPipe FaceLandmarker — 478 3D landmarks, 52 blendshapes, head pose

```bash
curl -L -o models/face_landmarker.task \
  https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
```

## 2. MediaPipe selfie multiclass segmenter — hair / face-skin / background

```bash
curl -L -o models/selfie_multiclass_256x256.tflite \
  https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite
```

## 3. FLAME statistical head model — the head shell (manual, license-gated)

Cannot be scripted: MPI requires a personal registration.

1. Register (free) at https://flame.is.tue.mpg.de
2. Download **FLAME 2023** and unzip
3. Put the `.pkl` at `models/flame/flame2023.pkl`
   (`flame2023_Open.pkl` and `generic_model.pkl` are also recognized, or set
   `DOTLIB_FLAME_MODEL` to any path)

Do **not** commit or redistribute this file — it is covered by MPI's license.

Check it loaded:

```bash
python -m dotlib.flamehead
```

## Verify everything

```bash
python tests/test_sanity.py
```

Tests skip (rather than fail) for whichever models are missing.
