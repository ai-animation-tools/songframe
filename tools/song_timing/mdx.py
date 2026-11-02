"""Выделение вокала MDX-Net через ONNX/NumPy без изменения временной шкалы. @link README.md"""

import subprocess

import numpy as np

from tools.transcribe_local.hardware import cpu_threads

RATE = 44100
FFT = 7680
HOP = 1024
BINS = 3072
FRAMES = 256
CHUNK = HOP * (FRAMES - 1)
TRIM = FFT // 2
STRIDE = CHUNK - 2 * TRIM


def stft(signal, fft=FFT, hop=HOP):
    """Центрированное преобразование с периодическим Hann; порядок каналов совпадает с MDX."""
    padded = np.pad(signal, ((0, 0), (fft // 2, fft // 2)), mode="reflect")
    frames = np.lib.stride_tricks.sliding_window_view(padded, fft, axis=-1)[:, ::hop]
    window = np.hanning(fft + 1)[:-1].astype(np.float32)
    spectrum = np.fft.rfft(frames * window, axis=-1).transpose(0, 2, 1)
    return np.stack((spectrum.real, spectrum.imag), axis=1).reshape(1, 4, fft // 2 + 1, -1).astype(np.float32)


def istft(spectrum, length, fft=FFT, hop=HOP):
    """Обратное преобразование с нормализацией перекрытия сохраняет длину, включая тишину."""
    padded = np.zeros((4, fft // 2 + 1, spectrum.shape[-1]), dtype=np.float32)
    padded[:, : spectrum.shape[-2]] = spectrum[0]
    complex_frames = padded.reshape(2, 2, fft // 2 + 1, -1)
    frames = np.fft.irfft(complex_frames[:, 0] + 1j * complex_frames[:, 1], n=fft, axis=1)
    window = np.hanning(fft + 1)[:-1].astype(np.float32)
    size = hop * (frames.shape[-1] - 1) + fft
    signal = np.zeros((2, size), dtype=np.float32)
    weight = np.zeros(size, dtype=np.float32)
    for index in range(frames.shape[-1]):
        begin = index * hop
        signal[:, begin : begin + fft] += frames[:, :, index] * window
        weight[begin : begin + fft] += window**2
    signal /= np.maximum(weight, 1e-8)
    return signal[:, fft // 2 : fft // 2 + length]


def session(path):
    import onnxruntime as ort

    ort.disable_telemetry_events()
    options = ort.SessionOptions()
    options.intra_op_num_threads = cpu_threads()
    return ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])


def separate(signal, model, progress=print, recipe=None):
    """Контекст каждого блока отбрасываем симметрично; ни один блок не обрезает вступление или хвост."""
    recipe = recipe or dict(fft=FFT, hop=HOP, bins=BINS, frames=FRAMES, compensate=1.021, primary_stem="Vocals")
    fft, hop, bins = recipe["fft"], recipe["hop"], recipe["bins"]
    chunk_size, trim = hop * (recipe["frames"] - 1), fft // 2
    stride = chunk_size - 2 * trim
    if stride <= 0 or signal.ndim != 2 or signal.shape[0] != 2 or not np.isfinite(signal).all():
        raise ValueError("Неверный сигнал или параметры модели вокала.")
    total = signal.shape[-1]
    padded = np.pad(signal, ((0, 0), (trim, trim + stride)))
    result = np.zeros_like(signal)
    name = model.get_inputs()[0].name
    count = (total + stride - 1) // stride
    for index, start in enumerate(range(0, total, stride)):
        chunk = padded[:, start : start + chunk_size]
        spectrum = stft(chunk, fft, hop)[:, :, :bins]
        spectrum[:, :, :3] = 0
        predicted = model.run(None, {name: spectrum})[0]
        if predicted.shape != spectrum.shape or not np.isfinite(predicted).all():
            raise ValueError("Модель вокала вернула неверный спектр.")
        decoded = istft(predicted, chunk_size, fft, hop) * recipe["compensate"]
        size = min(stride, total - start)
        result[:, start : start + size] = decoded[:, trim : trim + size]
        progress(f"Выделение вокала: {index + 1}/{count}")
    # У некоторых весов основной выход — инструментал: вокал является остатком исходного stereo.
    # Вычитаем в исходной шкале амплитуд, без нормализации пиков или сдвига времени.
    if recipe["primary_stem"] == "Instrumental":
        result = signal - result
    elif recipe["primary_stem"] != "Vocals":
        raise ValueError("Неизвестный основной выход модели вокала.")
    return result


def decode_stereo(source):
    """Декодируем полный трек без обрезки и нормализации; временная шкала совпадает с оригиналом."""
    decoded = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(source), "-f", "f32le", "-ac", "2", "-ar", str(RATE), "pipe:1"],
        check=True,
        capture_output=True,
    )
    stereo = np.frombuffer(decoded.stdout, dtype=np.float32).reshape(-1, 2).T.copy()
    if not stereo.shape[-1] or not np.isfinite(stereo).all():
        raise ValueError("Исходная запись не содержит корректного аудио.")
    return stereo
