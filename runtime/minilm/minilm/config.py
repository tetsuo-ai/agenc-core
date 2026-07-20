"""Model and training hyperparameters for the char-level mini-GPT."""

from __future__ import annotations

from dataclasses import asdict, dataclass, fields
from typing import Any


@dataclass
class GPTConfig:
    """Architecture knobs. Defaults target ~2M parameters at V≈65."""

    vocab_size: int = 65
    block_size: int = 128
    n_layer: int = 4
    n_head: int = 4
    n_embd: int = 192
    dropout: float = 0.0
    bias: bool = True  # Linear/LayerNorm bias (nanoGPT-style)

    def __post_init__(self) -> None:
        if self.n_embd % self.n_head != 0:
            raise ValueError(
                f"n_embd ({self.n_embd}) must be divisible by n_head ({self.n_head})"
            )
        if self.block_size < 1:
            raise ValueError("block_size must be >= 1")
        if self.n_layer < 1:
            raise ValueError("n_layer must be >= 1")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "GPTConfig":
        allowed = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in d.items() if k in allowed})


@dataclass
class TrainConfig:
    """Default training loop settings (CPU-friendly demo)."""

    steps: int = 2000
    batch_size: int = 32
    learning_rate: float = 3e-4
    weight_decay: float = 0.0
    beta1: float = 0.9
    beta2: float = 0.999
    grad_clip: float = 1.0
    eval_interval: int = 100
    eval_batches: int = 20
    seed: int = 42
    train_frac: float = 0.9
    log_file: str = "logs/loss.csv"
    ckpt_dir: str = "checkpoints"
    backend: str = "auto"  # auto | torch | numpy


def estimate_params(cfg: GPTConfig) -> int:
    """
    Closed-form param count with tied output head (no extra C×V for lm_head).

    token_emb: V*C
    pos_emb:   T*C
    per block:
      ln1, ln2: 2 * (C + C*bias) each → counted as 2C (weight) [+ 2C bias]
      attn: QKV = 3*C*C (+ 3*C bias), proj = C*C (+ C bias)
      mlp:  C*(4C) + (4C)*C (+ biases)
    final ln_f: C (+ bias)
    lm_head tied → 0
    """
    V, T, C, L = cfg.vocab_size, cfg.block_size, cfg.n_embd, cfg.n_layer
    bias = 1 if cfg.bias else 0

    emb = V * C + T * C
    # attention
    attn = (3 * C * C + 3 * C * bias) + (C * C + C * bias)
    # mlp
    mlp = (C * 4 * C + 4 * C * bias) + (4 * C * C + C * bias)
    # two LayerNorms per block
    lns = 2 * (C + C * bias)
    block = attn + mlp + lns
    ln_f = C + C * bias
    return emb + L * block + ln_f


def format_params(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.2f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)
