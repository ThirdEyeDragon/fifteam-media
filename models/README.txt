The bass separator: Demucs v4 (Hybrid Transformer Demucs, "htdemucs_ft", its bass model d12395a8), by Meta AI
(https://github.com/facebookresearch/demucs), MIT License (LICENSE-demucs.txt).

Converted for the app:
  bass-sep.onnx.gz  the network without its STFT/iSTFT (those run in js/demucs.js), bass output only, attention split
                    two heads at a time (no tensor over ~63 MB, for phone GPUs); weights as external data. Gzipped.
  bass-sep.stages.gz  the same network cut into 16 stages run one after another (tools/stage_model.py), each with
                    its weights at the same places in the external data. ONNX Runtime hands a run's in-between memory
                    back only when the run ends: one run per 7.8 s piece held ~2.4 GB on the graphics chip, stage by
                    stage it holds ~0.3 GB. The stages give exactly the same numbers as the whole (checked: no
                    difference at all on a real piece). Gzipped. (The app uses this; bass-sep.onnx.gz is kept for 1.6.)
  bass-sep.q8       the weights: matrices as int8 with an fp16 scale per 64 weights of each output channel, the rest
                    as fp16 (exactly the published fp16 values). The app expands it to the fp32 external data.
Checked on the 50 MUSDB18 test clips (7 s preview set): bass SDR median 9.12 dB with these weights through the app's own
pipeline, the same as the original PyTorch model (9.12 dB); every clip within -0.04/+0.11 dB.
