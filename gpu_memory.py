"""Physical VRAM use of ComfyUI's GPU, read through NVML.

ComfyUI's /system_stats derives free VRAM from cuMemGetInfo, which
comfy-aimdo hooks so evictable model weights count as free. NVML reports
what the driver has actually allocated (all processes) — the figure Task
Manager and nvidia-smi show. The library ships with the NVIDIA driver and is
loaded through ctypes, so no Python package is needed; without it (other GPU
vendors, CPU mode) callers fall back to /system_stats.
"""

import ctypes
import sys
import threading

import torch

NVML_SUCCESS = 0


class _MemoryInfo(ctypes.Structure):
    """nvmlMemory_v2_t: `used` leaves out the driver-reserved area, as
    nvidia-smi and Task Manager do (v1 counts it as used)."""
    _fields_ = [
        ("version", ctypes.c_uint),
        ("total", ctypes.c_ulonglong),
        ("reserved", ctypes.c_ulonglong),
        ("free", ctypes.c_ulonglong),
        ("used", ctypes.c_ulonglong),
    ]


# NVML_STRUCT_VERSION(Memory, 2)
_MEMORY_V2 = ctypes.sizeof(_MemoryInfo) | (2 << 24)

_lock = threading.Lock()
_lib = None  # the initialised library, or False once loading failed


def _nvml():
    global _lib
    if _lib is None:
        _lib = False
        name = "nvml.dll" if sys.platform == "win32" else "libnvidia-ml.so.1"
        try:
            lib = ctypes.CDLL(name)
            lib.nvmlDeviceGetMemoryInfo_v2  # drivers since 510
        except (OSError, AttributeError):
            return None
        lib.nvmlInit_v2.restype = ctypes.c_int
        lib.nvmlDeviceGetHandleByUUID.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
        lib.nvmlDeviceGetHandleByUUID.restype = ctypes.c_int
        lib.nvmlDeviceGetMemoryInfo_v2.argtypes = [ctypes.c_void_p, ctypes.POINTER(_MemoryInfo)]
        lib.nvmlDeviceGetMemoryInfo_v2.restype = ctypes.c_int
        if lib.nvmlInit_v2() == NVML_SUCCESS:
            _lib = lib
    return _lib or None


def device_memory(device):
    """(used, total) bytes of a torch CUDA device, or None when NVML cannot tell."""
    if getattr(device, "type", None) != "cuda":
        return None
    # ROCm builds also report "cuda"; their devices have no NVML handle.
    uuid = getattr(torch.cuda.get_device_properties(device), "uuid", None)
    if uuid is None:
        return None
    with _lock:
        lib = _nvml()
        if lib is None:
            return None
        handle = ctypes.c_void_p()
        if lib.nvmlDeviceGetHandleByUUID(f"GPU-{uuid}".encode(), ctypes.byref(handle)) != NVML_SUCCESS:
            return None
        info = _MemoryInfo(version=_MEMORY_V2)
        if lib.nvmlDeviceGetMemoryInfo_v2(handle, ctypes.byref(info)) != NVML_SUCCESS:
            return None
    return info.used, info.total
