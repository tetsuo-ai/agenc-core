"""Sample text from a trained mini-GPT checkpoint."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Optional

import numpy as np

from .config import GPTConfig
from .data import CharTokenizer

ROOT = Path(__file__).resolve().parent.parent


def _parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Generate text from mini-GPT checkpoint")
    p.add_argument(
        "--ckpt",
        type=str,
        default=str(ROOT / "checkpoints" / "best.pt"),
        help="Path to .pt (torch) or .npz (numpy) checkpoint",
    )
    p.add_argument("--prompt", type=str, default="ROMEO:\n")
    p.add_argument("--tokens", type=int, default=300)
    p.add_argument("--temperature", type=float, default=0.8)
    p.add_argument("--top-k", type=int, default=40)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--backend", type=str, default="auto", choices=["auto", "torch", "numpy"])
    return p.parse_args(argv)


def _detect_backend(ckpt: Path, preference: str) -> str:
    if preference in {"torch", "numpy"}:
        return preference
    if ckpt.suffix == ".pt":
        return "torch"
    if ckpt.suffix == ".npz":
        return "numpy"
    # try sidecar json
    side = ckpt.with_suffix(".json")
    if side.is_file():
        meta = json.loads(side.read_text(encoding="utf-8"))
        return meta.get("backend", "numpy")
    # default: prefer torch file names
    if ckpt.is_file():
        return "torch"
    # maybe numpy best.npz
    alt = ckpt.with_suffix(".npz")
    if alt.is_file():
        return "numpy"
    raise FileNotFoundError(f"Checkpoint not found: {ckpt}")


def generate_torch(
    ckpt: Path,
    prompt: str,
    tokens: int,
    temperature: float,
    top_k: int,
    seed: int,
) -> str:
    import torch

    from .model_torch import GPT

    device = "cuda" if torch.cuda.is_available() else "cpu"
    payload = torch.load(ckpt, map_location=device, weights_only=False)
    cfg = GPTConfig.from_dict(payload["config"])
    tok = CharTokenizer.from_meta(payload["tokenizer"])
    model = GPT(cfg).to(device)
    model.load_state_dict(payload["model"])
    model.eval()

    torch.manual_seed(seed)
    ids = tok.encode(prompt)
    if not ids:
        ids = [0]
    idx = torch.tensor([ids], dtype=torch.long, device=device)
    out = model.generate(idx, max_new_tokens=tokens, temperature=temperature, top_k=top_k or None)
    return tok.decode(out[0].tolist())


def generate_numpy(
    ckpt: Path,
    prompt: str,
    tokens: int,
    temperature: float,
    top_k: int,
    seed: int,
) -> str:
    from .model_numpy import NumpyGPT

    # accept .npz or .json sidecar path
    path = ckpt
    if path.suffix == ".pt":
        path = path.with_suffix(".npz")
    model, payload = NumpyGPT.load(path)
    tok_meta = payload.get("meta", {}).get("tokenizer")
    if tok_meta is None:
        # fallback tokenizer.json beside ckpt
        tj = path.parent / "tokenizer.json"
        if not tj.is_file():
            raise FileNotFoundError("tokenizer meta missing in checkpoint")
        tok_meta = json.loads(tj.read_text(encoding="utf-8"))
    tok = CharTokenizer.from_meta(tok_meta)

    rng = np.random.default_rng(seed)
    ids = tok.encode(prompt)
    if not ids:
        ids = [0]
    idx = np.array([ids], dtype=np.int64)
    out = model.generate(
        idx,
        max_new_tokens=tokens,
        temperature=temperature,
        top_k=top_k or None,
        rng=rng,
    )
    return tok.decode(out[0])


def main(argv: Optional[list[str]] = None) -> int:
    args = _parse_args(argv)
    ckpt = Path(args.ckpt)
    # resolve default if best.pt missing but best.npz exists
    if not ckpt.is_file():
        alt_npz = ckpt.with_suffix(".npz")
        alt_pt = ckpt.with_suffix(".pt")
        if alt_npz.is_file():
            ckpt = alt_npz
        elif alt_pt.is_file():
            ckpt = alt_pt
        else:
            # try latest
            for name in ("best.pt", "best.npz", "latest.pt", "latest.npz"):
                cand = ROOT / "checkpoints" / name
                if cand.is_file():
                    ckpt = cand
                    break
            else:
                print(f"error: checkpoint not found: {args.ckpt}", file=sys.stderr)
                return 1

    backend = _detect_backend(ckpt, args.backend)
    print(f"loading {ckpt} ({backend}) ...", file=sys.stderr)
    if backend == "torch":
        try:
            text = generate_torch(
                ckpt, args.prompt, args.tokens, args.temperature, args.top_k, args.seed
            )
        except ImportError:
            print("torch not available; try a numpy .npz checkpoint", file=sys.stderr)
            return 1
    else:
        text = generate_numpy(
            ckpt, args.prompt, args.tokens, args.temperature, args.top_k, args.seed
        )

    sys.stdout.write(text)
    if not text.endswith("\n"):
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
