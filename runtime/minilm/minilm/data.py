"""Character tokenizer, corpus loading, and batch sampling."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

# minilm/ package root (parent of minilm/minilm/)
_PKG_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CORPUS = _PKG_ROOT / "data" / "corpus.txt"


@dataclass
class CharTokenizer:
    chars: list[str]
    stoi: dict[str, int]
    itos: dict[int, str]

    @classmethod
    def from_text(cls, text: str) -> "CharTokenizer":
        chars = sorted(set(text))
        stoi = {ch: i for i, ch in enumerate(chars)}
        itos = {i: ch for ch, i in stoi.items()}
        return cls(chars=chars, stoi=stoi, itos=itos)

    @classmethod
    def from_meta(cls, meta: dict[str, Any]) -> "CharTokenizer":
        chars = list(meta["chars"])
        stoi = {ch: int(i) for ch, i in meta["stoi"].items()}
        itos = {int(i): ch for i, ch in meta["itos"].items()}
        return cls(chars=chars, stoi=stoi, itos=itos)

    @property
    def vocab_size(self) -> int:
        return len(self.chars)

    def encode(self, s: str) -> list[int]:
        unk = self.stoi.get(" ", 0)
        return [self.stoi.get(ch, unk) for ch in s]

    def decode(self, ids: list[int] | np.ndarray) -> str:
        return "".join(self.itos[int(i)] for i in ids)

    def to_meta(self) -> dict[str, Any]:
        return {
            "chars": self.chars,
            "stoi": self.stoi,
            "itos": {str(k): v for k, v in self.itos.items()},
        }


@dataclass
class Corpus:
    text: str
    tokenizer: CharTokenizer
    data: np.ndarray  # int64 token ids
    train_data: np.ndarray
    val_data: np.ndarray

    @classmethod
    def load(
        cls,
        path: str | Path | None = None,
        train_frac: float = 0.9,
    ) -> "Corpus":
        path = Path(path) if path else DEFAULT_CORPUS
        if not path.is_file():
            raise FileNotFoundError(f"Corpus not found: {path}")
        text = path.read_text(encoding="utf-8")
        if not text:
            raise ValueError(f"Corpus is empty: {path}")
        tokenizer = CharTokenizer.from_text(text)
        data = np.array(tokenizer.encode(text), dtype=np.int64)
        n = int(len(data) * train_frac)
        if n < 2 or len(data) - n < 2:
            raise ValueError("Corpus too small for train/val split")
        return cls(
            text=text,
            tokenizer=tokenizer,
            data=data,
            train_data=data[:n],
            val_data=data[n:],
        )


def get_batch(
    split_data: np.ndarray,
    batch_size: int,
    block_size: int,
    rng: np.random.Generator,
) -> tuple[np.ndarray, np.ndarray]:
    """Sample (B, T) inputs and next-char targets from a 1-D token array."""
    hi = len(split_data) - block_size - 1
    if hi < 1:
        raise ValueError(
            f"split length {len(split_data)} too small for block_size={block_size}"
        )
    ix = rng.integers(0, hi, size=batch_size)
    x = np.stack([split_data[i : i + block_size] for i in ix])
    y = np.stack([split_data[i + 1 : i + 1 + block_size] for i in ix])
    return x.astype(np.int64), y.astype(np.int64)


def save_tokenizer_meta(tokenizer: CharTokenizer, path: str | Path) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(tokenizer.to_meta(), indent=2), encoding="utf-8")


def load_tokenizer_meta(path: str | Path) -> CharTokenizer:
    meta = json.loads(Path(path).read_text(encoding="utf-8"))
    return CharTokenizer.from_meta(meta)
