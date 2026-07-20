"""Resolve compute backend: torch (preferred) or pure NumPy."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

BackendName = Literal["torch", "numpy"]


@dataclass
class BackendInfo:
    name: BackendName
    device: str  # "cpu" | "cuda" | "mps"
    detail: str


def resolve_backend(preference: str = "auto") -> BackendInfo:
    """
    preference: 'auto' | 'torch' | 'numpy'
    """
    pref = (preference or "auto").lower().strip()
    if pref not in {"auto", "torch", "numpy"}:
        raise ValueError(f"Unknown backend preference: {preference!r}")

    if pref == "numpy":
        return BackendInfo(name="numpy", device="cpu", detail="forced NumPy backend")

    # try torch
    try:
        import torch

        if torch.cuda.is_available():
            device = "cuda"
        elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            device = "mps"
        else:
            device = "cpu"
        ver = getattr(torch, "__version__", "?")
        return BackendInfo(
            name="torch",
            device=device,
            detail=f"torch {ver} on {device}",
        )
    except ImportError as e:
        if pref == "torch":
            raise ImportError(
                "PyTorch requested but not installed. "
                "Install with: pip install torch  (Python 3.12 recommended)"
            ) from e
        return BackendInfo(
            name="numpy",
            device="cpu",
            detail=f"torch unavailable ({e}); using NumPy",
        )
