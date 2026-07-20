# minilm — char-level mini-GPT from scratch

A small language model built from scratch: a char-level mini-GPT
(**1.82M params** — token embedding, 4 transformer blocks with causal
self-attention, layer norm, residual connections, tied output head), a
training loop on a bundled public-domain corpus, cross-entropy loss + Adam,
loss curves logged to CSV, checkpointing, and a `generate` command that
samples from a trained checkpoint.

Backends: **NumPy** (self-contained, works everywhere) and **torch**
(used automatically when a torch wheel is available; GPU if present).

## Layout

```
minilm/
  minilm/
    config.py        GPTConfig (1.82M params) + TrainConfig
    model_torch.py   GPT in torch (nn.Module, causal attention)
    model_numpy.py   GPT in pure NumPy (same architecture, own Adam)
    backend.py       backend resolution (auto | torch | numpy)
    data.py          char tokenizer + batching
    train.py         training loop (loss.csv log + checkpoints)
    generate.py      sampling from a checkpoint
  data/corpus.txt    bundled public-domain corpus (Shakespeare, ~37 KB)
  runs/loss.csv      observed training run (see below)
  runs/ckpt/         checkpoints (best.npz + per-50-step snapshots)
```

## Quickstart

```bash
python -m venv .venv && .venv/bin/pip install numpy   # torch optional

# train (NumPy backend shown; drop --backend for auto/torch)
.venv/bin/python -m minilm.train --backend numpy --steps 300 \
    --eval-interval 50 --log-file runs/loss.csv --ckpt-dir runs/ckpt

# generate from the best checkpoint
.venv/bin/python -m minilm.generate --backend numpy \
    --ckpt runs/ckpt/best.npz --prompt "ROMEO:\n" --tokens 400
```

## Observed training run (NumPy backend, CPU)

300 steps, batch 32, block 128, lr 3e-4, corpus 37,354 chars (59 unique):

| step | train loss | val loss |
|-----:|-----------:|---------:|
|    1 |      4.186 |    3.605 |
|   50 |      2.753 |    2.493 |
|  100 |      2.405 |    2.344 |
|  150 |      2.259 |    2.199 |
|  200 |      2.106 |    2.060 |
|  250 |      1.928 |    1.815 |
|  300 |      1.703 |    1.581 |

Raw log: `runs/loss.csv`. Checkpoints every 50 steps under `runs/ckpt/`.

## Observed samples (best.npz, step 300, temperature 0.8)

```
ROMEO:
The atht ist sigheis ntpthe emow min this-fatingech
Upoponach themel thes be this thache s: iseis ctis tise atimis ttumion
The matesed atis thron melKis, blan
...
```

Expected at this scale: a 1.82M-param char-level model trained for 300
steps on 37 KB of text learns line structure, spacing and rough English
phonotactics, not full words yet. Longer runs (`--steps 2000`) and a
bigger corpus move it toward recognizable Shakespearean words.
