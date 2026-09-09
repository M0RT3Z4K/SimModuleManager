"""Analyze captured PCM without treating network delivery as an ADC clock measurement."""
import json
import sys
import wave
from pathlib import Path

import numpy as np

root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent
meta = json.loads((root / "call-connected-capture.json").read_text())
raw = np.fromfile(root / "call-connected.pcm", dtype="<i2")
x = raw.astype(np.float64)
points = np.array(meta["delivery_points"])
# Exclude initial HTTP/DMA buffering and estimate sustained delivery rate.
steady = points[points[:, 0] >= 2]
rate = float(np.polyfit(steady[:, 0], steady[:, 1] / 2, 1)[0])
trial_rate = round(rate)
report = {
    "samples": len(x),
    "capture_seconds": meta["elapsed_seconds"],
    "nonzero_samples": int(np.count_nonzero(raw)),
    "min": int(raw.min()),
    "max": int(raw.max()),
    "mean": float(x.mean()),
    "rms": float(np.sqrt(np.mean(x * x))),
    "pcm_clipped_percent": float(100 * np.mean((raw == -32768) | (raw == 32767))),
    "observed_delivery_samples_per_second": rate,
    "configured_playback_samples_per_second": 8000,
    "trial_playback_rate": trial_rate,
    "caveats": [
        "TCP delivery rate is not a direct ADC clock measurement.",
        "PCM clipping does not establish whether the analog input clipped before DC removal.",
        "Trial files assume consecutive mono samples; duplicate or invalid ADC words require raw ADC diagnostics.",
    ],
}

if x.std() > 0:
    report["lag_correlations"] = {
        str(lag): float(np.corrcoef(x[lag:], x[:-lag])[0, 1])
        for lag in (1, 2, 3, 4, 8, 16)
    }
    n = 4096
    frames = x[:len(x) // n * n].reshape(-1, n)
    power = np.mean(abs(np.fft.rfft((frames - frames.mean(axis=1, keepdims=True)) * np.hanning(n), axis=1)) ** 2, axis=0)
    freq = np.fft.rfftfreq(n, 1 / trial_rate)
    report["strongest_bins_hz_at_trial_rate"] = freq[np.argsort(power)[-10:][::-1]].tolist()
    report["power_fraction_by_band_at_trial_rate"] = {
        f"{lo}-{hi}": float(power[(freq >= lo) & (freq < hi)].sum() / power.sum())
        for lo, hi in [(0, 300), (300, 3400), (3400, trial_rate / 2)]
    }

report["one_second_windows_at_trial_rate"] = [
    {"start": start / trial_rate,
     "rms": float(np.sqrt(np.mean(x[start:start + trial_rate] ** 2))),
     "peak": int(np.max(abs(x[start:start + trial_rate])))}
    for start in range(0, len(x), trial_rate)
]

def save(name, data, hz):
    with wave.open(str(root / name), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(hz)
        wav.writeframes(np.clip(data, -32768, 32767).astype("<i2").tobytes())

save("connected-original-8k.wav", x, 8000)
save("connected-rate-trial.wav", x, trial_rate)
# Windowed-sinc bandpass for a listening comparison, without AGC or invented speech.
k = np.arange(513) - 256
h = (2 * 3400 / trial_rate * np.sinc(2 * 3400 / trial_rate * k)
     - 2 * 300 / trial_rate * np.sinc(2 * 300 / trial_rate * k)) * np.hamming(513)
filtered = np.convolve(x, h, mode="same")
gain = min(8.0, 0.7 * 32767 / max(1.0, float(np.max(abs(filtered)))))
report["filtered_rms_before_gain"] = float(np.sqrt(np.mean(filtered ** 2)))
report["filtered_playback_gain"] = gain
save("connected-bandpass-trial.wav", filtered * gain, trial_rate)
(root / "call-connected-analysis.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
