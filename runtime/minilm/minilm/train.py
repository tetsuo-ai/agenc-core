"""Train the char-level mini-GPT (torch or numpy backend)."""

from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from pathlib import Path
from typing import Any, Optional

import numpy as np

from .backend import resolve_backend
from .config import GPTConfig, TrainConfig, estimate_params, format_params
from .data import Corpus, get_batch

# package root = minilm/
ROOT = Path(__file__).resolve().parent.parent


def _parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    tc = TrainConfig()
    gc = GPTConfig()
    p = argparse.ArgumentParser(description="Train char-level mini-GPT")
    p.add_argument("--corpus", type=str, default=str(ROOT / "data" / "corpus.txt"))
    p.add_argument("--steps", type=int, default=tc.steps)
    p.add_argument("--batch-size", type=int, default=tc.batch_size)
    p.add_argument("--lr", type=float, default=tc.learning_rate)
    p.add_argument("--weight-decay", type=float, default=tc.weight_decay)
    p.add_argument("--grad-clip", type=float, default=tc.grad_clip)
    p.add_argument("--eval-interval", type=int, default=tc.eval_interval)
    p.add_argument("--eval-batches", type=int, default=tc.eval_batches)
    p.add_argument("--seed", type=int, default=tc.seed)
    p.add_argument("--block-size", type=int, default=gc.block_size)
    p.add_argument("--n-layer", type=int, default=gc.n_layer)
    p.add_argument("--n-head", type=int, default=gc.n_head)
    p.add_argument("--n-embd", type=int, default=gc.n_embd)
    p.add_argument("--dropout", type=float, default=gc.dropout)
    p.add_argument("--backend", type=str, default="auto", choices=["auto", "torch", "numpy"])
    p.add_argument("--ckpt-dir", type=str, default=str(ROOT / tc.ckpt_dir))
    p.add_argument("--log-file", type=str, default=str(ROOT / tc.log_file))
    p.add_argument("--train-frac", type=float, default=tc.train_frac)
    return p.parse_args(argv)


def _ensure_parents(*paths: str | Path) -> None:
    for path in paths:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        if Path(path).suffix == "":
            Path(path).mkdir(parents=True, exist_ok=True)


def train_torch(args: argparse.Namespace, corpus: Corpus, cfg: GPTConfig) -> None:
    import torch

    from .model_torch import GPT, param_report

    info = resolve_backend("torch")
    device = info.device
    print(f"backend: {info.detail}")

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    rng = np.random.default_rng(args.seed)

    model = GPT(cfg).to(device)
    print(param_report(cfg, model))
    print(f"vocab_size={cfg.vocab_size}  corpus_chars={len(corpus.text):,}")

    optimizer = torch.optim.Adam(
        model.parameters(),
        lr=args.lr,
        betas=(0.9, 0.999),
        weight_decay=args.weight_decay,
    )

    ckpt_dir = Path(args.ckpt_dir)
    ckpt_dir.mkdir(parents=True, exist_ok=True)
    log_path = Path(args.log_file)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    with log_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["step", "train_loss", "val_loss", "lr", "time_s"])

    best_val = float("inf")
    t0 = time.time()
    model.train()

    def eval_loss(split: str, batches: int) -> float:
        model.eval()
        data = corpus.train_data if split == "train" else corpus.val_data
        losses = []
        with torch.no_grad():
            for _ in range(batches):
                xb, yb = get_batch(data, args.batch_size, cfg.block_size, rng)
                xb_t = torch.from_numpy(xb).to(device)
                yb_t = torch.from_numpy(yb).to(device)
                _, loss = model(xb_t, yb_t)
                losses.append(float(loss.item()))
        model.train()
        return float(sum(losses) / max(len(losses), 1))

    def save_ckpt(path: Path, step: int, train_loss: float, val_loss: float) -> None:
        payload = {
            "backend": "torch",
            "model": model.state_dict(),
            "config": cfg.to_dict(),
            "tokenizer": corpus.tokenizer.to_meta(),
            "step": step,
            "train_loss": train_loss,
            "val_loss": val_loss,
            "n_params": model.n_params(),
        }
        torch.save(payload, path)

    running = []
    for step in range(1, args.steps + 1):
        xb, yb = get_batch(corpus.train_data, args.batch_size, cfg.block_size, rng)
        xb_t = torch.from_numpy(xb).to(device)
        yb_t = torch.from_numpy(yb).to(device)

        _, loss = model(xb_t, yb_t)
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        if args.grad_clip and args.grad_clip > 0:
            torch.nn.utils.clip_grad_norm_(model.parameters(), args.grad_clip)
        optimizer.step()

        loss_f = float(loss.item())
        running.append(loss_f)

        if step % args.eval_interval == 0 or step == 1 or step == args.steps:
            train_l = float(sum(running) / len(running))
            running.clear()
            val_l = eval_loss("val", args.eval_batches)
            elapsed = time.time() - t0
            print(
                f"step {step:5d}/{args.steps}  train={train_l:.4f}  val={val_l:.4f}  "
                f"time={elapsed:.1f}s"
            )
            with log_path.open("a", newline="", encoding="utf-8") as f:
                csv.writer(f).writerow(
                    [step, f"{train_l:.6f}", f"{val_l:.6f}", args.lr, f"{elapsed:.3f}"]
                )

            save_ckpt(ckpt_dir / "latest.pt", step, train_l, val_l)
            save_ckpt(ckpt_dir / f"step_{step:05d}.pt", step, train_l, val_l)
            if val_l < best_val:
                best_val = val_l
                save_ckpt(ckpt_dir / "best.pt", step, train_l, val_l)
                # also write tokenizer meta for convenience
                (ckpt_dir / "tokenizer.json").write_text(
                    json.dumps(corpus.tokenizer.to_meta(), indent=2), encoding="utf-8"
                )

    print(f"done. best_val={best_val:.4f}  logs={log_path}  ckpts={ckpt_dir}")


def train_numpy(args: argparse.Namespace, corpus: Corpus, cfg: GPTConfig) -> None:
    from .model_numpy import AdamState, NumpyGPT

    info = resolve_backend("numpy")
    print(f"backend: {info.detail}")

    np.random.seed(args.seed)
    rng = np.random.default_rng(args.seed)

    model = NumpyGPT(cfg, seed=args.seed)
    est = estimate_params(cfg)
    print(
        f"params: actual={model.n_params():,}  estimate={est:,}  "
        f"(~{model.n_params() / 1e6:.2f}M)"
    )
    print(f"vocab_size={cfg.vocab_size}  corpus_chars={len(corpus.text):,}")

    opt = AdamState()
    ckpt_dir = Path(args.ckpt_dir)
    ckpt_dir.mkdir(parents=True, exist_ok=True)
    log_path = Path(args.log_file)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    with log_path.open("w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerow(["step", "train_loss", "val_loss", "lr", "time_s"])

    best_val = float("inf")
    t0 = time.time()

    def eval_loss(split: str, batches: int) -> float:
        data = corpus.train_data if split == "train" else corpus.val_data
        losses = []
        for _ in range(batches):
            xb, yb = get_batch(data, args.batch_size, cfg.block_size, rng)
            _, loss, _ = model.forward(xb, yb)
            assert loss is not None
            losses.append(loss)
        return float(sum(losses) / max(len(losses), 1))

    def save_ckpt(stem: str, step: int, train_loss: float, val_loss: float) -> None:
        meta = {
            "tokenizer": corpus.tokenizer.to_meta(),
            "step": step,
            "train_loss": train_loss,
            "val_loss": val_loss,
        }
        model.save(ckpt_dir / f"{stem}.npz", meta)

    running: list[float] = []
    for step in range(1, args.steps + 1):
        xb, yb = get_batch(corpus.train_data, args.batch_size, cfg.block_size, rng)
        _, loss, cache = model.forward(xb, yb)
        assert loss is not None
        grads = model.backward(cache)
        model.adam_step(
            grads,
            opt,
            lr=args.lr,
            weight_decay=args.weight_decay,
            grad_clip=args.grad_clip,
        )
        running.append(loss)

        if step % args.eval_interval == 0 or step == 1 or step == args.steps:
            train_l = float(sum(running) / len(running))
            running.clear()
            val_l = eval_loss("val", max(1, args.eval_batches // 4))
            elapsed = time.time() - t0
            print(
                f"step {step:5d}/{args.steps}  train={train_l:.4f}  val={val_l:.4f}  "
                f"time={elapsed:.1f}s"
            )
            with log_path.open("a", newline="", encoding="utf-8") as f:
                csv.writer(f).writerow(
                    [step, f"{train_l:.6f}", f"{val_l:.6f}", args.lr, f"{elapsed:.3f}"]
                )
            save_ckpt("latest", step, train_l, val_l)
            save_ckpt(f"step_{step:05d}", step, train_l, val_l)
            if val_l < best_val:
                best_val = val_l
                save_ckpt("best", step, train_l, val_l)
                (ckpt_dir / "tokenizer.json").write_text(
                    json.dumps(corpus.tokenizer.to_meta(), indent=2), encoding="utf-8"
                )

    print(f"done. best_val={best_val:.4f}  logs={log_path}  ckpts={ckpt_dir}")


def main(argv: Optional[list[str]] = None) -> int:
    args = _parse_args(argv)
    corpus = Corpus.load(args.corpus, train_frac=args.train_frac)
    cfg = GPTConfig(
        vocab_size=corpus.tokenizer.vocab_size,
        block_size=args.block_size,
        n_layer=args.n_layer,
        n_head=args.n_head,
        n_embd=args.n_embd,
        dropout=args.dropout,
    )
    est = estimate_params(cfg)
    print(f"config: {cfg}")
    print(f"estimated params: {format_params(est)} ({est:,})")

    info = resolve_backend(args.backend)
    if info.name == "torch":
        train_torch(args, corpus, cfg)
    else:
        if args.backend == "auto":
            print(f"note: {info.detail}")
        train_numpy(args, corpus, cfg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
