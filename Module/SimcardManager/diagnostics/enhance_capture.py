"""Offline, phase-preserving noise reduction for listening comparisons.

Usage: bundled-python diagnostics/enhance_capture.py CAPTURE_DIRECTORY
Noise is estimated from quiet frames, which are not guaranteed to be speech-free.
No claim of intelligibility improvement is made by the numeric diagnostics.
"""
import json
import sys
import wave
from pathlib import Path

import numpy as np

root = Path(sys.argv[1])
analysis = json.loads((root / "call-connected-analysis.json").read_text())
rate = analysis["trial_playback_rate"]
x = np.fromfile(root / "call-connected.pcm", dtype="<i2").astype(float) / 32768
n, hop = 1024, 256
window = np.hanning(n)
padding = n
data = np.pad(x, (padding, padding + n))
starts = np.arange(0, len(data) - n + 1, hop)
frames = np.stack([data[s:s+n] for s in starts])
spectrum = np.fft.rfft(frames * window, axis=1)
power = abs(spectrum) ** 2
freq = np.fft.rfftfreq(n, 1 / rate)
valid = (starts >= padding) & (starts + n <= padding + len(x))
band = (freq >= 180) & (freq <= 3600)
energy = power[:, band].mean(axis=1)
quiet = valid & (energy <= np.quantile(energy[valid], 0.20))
active = valid & (energy >= np.quantile(energy[valid], 0.75))
noise = np.maximum(power[quiet].mean(axis=0), 1e-15)

def smooth_bins(a):
    padded = np.pad(a, ((0, 0), (2, 2)), mode="edge")
    return sum(weight * padded[:, i:i+a.shape[1]]
               for i, weight in enumerate([1/9, 2/9, 3/9, 2/9, 1/9]))

# Raised-cosine edges avoid an abrupt frequency cutoff.
band_gain = np.ones_like(freq)
band_gain[freq <= 100] = 0
sel = (freq > 100) & (freq < 200)
band_gain[sel] = 0.5 - 0.5 * np.cos(np.pi * (freq[sel] - 100) / 100)
sel = (freq > 3300) & (freq < 3800)
band_gain[sel] = 0.5 + 0.5 * np.cos(np.pi * (freq[sel] - 3300) / 500)
band_gain[freq >= 3800] = 0

def reconstruct(spec):
    out = np.zeros(len(data))
    weights = np.zeros(len(data))
    for start, frame in zip(starts, np.fft.irfft(spec, n=n, axis=1)):
        out[start:start+n] += frame * window
        weights[start:start+n] += window ** 2
    out /= np.maximum(weights, 1e-12)
    return out[padding:padding+len(x)]

outputs = {"reference": reconstruct(spectrum * band_gain)}
metrics = {}
for label, strength, floor in [("gentle", 1.0, 0.25), ("strong", 1.7, 0.10)]:
    # Wiener-like amplitude mask with a floor to retain weak consonants.
    mask = np.sqrt(np.maximum(1 - strength * noise / np.maximum(power, 1e-15), floor ** 2))
    mask = smooth_bins(mask)
    for i in range(1, len(mask)):
        # Open quickly for speech, close more slowly to avoid chattering.
        retention = np.where(mask[i] > mask[i-1], 0.25, 0.75)
        mask[i] = retention * mask[i-1] + (1-retention) * mask[i]
    outputs[label] = reconstruct(spectrum * mask * band_gain)
    weights = power * band_gain ** 2
    metrics[label] = {
        "quiet_frame_attenuation_db_same_gain": float(10*np.log10(
            np.sum((weights * mask ** 2)[quiet]) / np.sum(weights[quiet]))),
        "active_frame_attenuation_db_same_gain": float(10*np.log10(
            np.sum((weights * mask ** 2)[active]) / np.sum(weights[active]))),
    }

# Give all variants identical gain, so louder does not masquerade as cleaner.
peak = max(float(np.max(abs(y))) for y in outputs.values())
gain = min(40.0, 0.85 / max(peak, 1e-12))
for label, y in outputs.items():
    y = y * gain
    assert len(y) == len(x) and np.isfinite(y).all() and np.max(abs(y)) < 1
    with wave.open(str(root / f"enhanced-{label}.wav"), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(np.round(y * 32767).astype("<i2").tobytes())

report = {"sample_rate_assumed": rate, "duration_seconds": len(x)/rate,
          "quiet_frames": int(quiet.sum()), "common_gain": gain,
          "metrics": metrics,
          "note": "Quiet frames are inferred, not labeled. Attenuation is not an SNR or intelligibility measurement."}
(root / "enhancement-report.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
