"""Pure-NumPy char-level GPT with manual backprop and Adam.

Educational fallback when PyTorch is unavailable. Math mirrors model_torch.py
(causal MHA, GELU MLP, LayerNorm, residual, tied LM head) but is not bit-exact.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import numpy as np

from .config import GPTConfig, estimate_params


# ---------------------------------------------------------------------------
# Functional primitives + local grads
# ---------------------------------------------------------------------------

def _gelu(x: np.ndarray) -> np.ndarray:
    # tanh approximation (same family as torch.nn.GELU default)
    return 0.5 * x * (1.0 + np.tanh(math.sqrt(2.0 / math.pi) * (x + 0.044715 * x**3)))


def _gelu_bwd(x: np.ndarray, dy: np.ndarray) -> np.ndarray:
    u = math.sqrt(2.0 / math.pi) * (x + 0.044715 * x**3)
    tanh_u = np.tanh(u)
    sech2 = 1.0 - tanh_u**2
    du_dx = math.sqrt(2.0 / math.pi) * (1.0 + 3.0 * 0.044715 * x**2)
    dgelu = 0.5 * (1.0 + tanh_u) + 0.5 * x * sech2 * du_dx
    return dy * dgelu


def _softmax(x: np.ndarray, axis: int = -1) -> np.ndarray:
    x = x - np.max(x, axis=axis, keepdims=True)
    e = np.exp(x)
    return e / np.sum(e, axis=axis, keepdims=True)


def _layernorm_fwd(
    x: np.ndarray, weight: np.ndarray, bias: Optional[np.ndarray], eps: float = 1e-5
) -> tuple[np.ndarray, dict[str, Any]]:
    mean = x.mean(axis=-1, keepdims=True)
    var = x.var(axis=-1, keepdims=True)
    inv = 1.0 / np.sqrt(var + eps)
    xhat = (x - mean) * inv
    y = xhat * weight
    if bias is not None:
        y = y + bias
    cache = {"xhat": xhat, "inv": inv, "weight": weight, "x": x, "mean": mean, "var": var, "eps": eps}
    return y, cache


def _layernorm_bwd(dy: np.ndarray, cache: dict[str, Any], has_bias: bool) -> tuple[np.ndarray, np.ndarray, Optional[np.ndarray]]:
    xhat = cache["xhat"]
    inv = cache["inv"]
    weight = cache["weight"]
    # grads for affine
    dw = np.sum(dy * xhat, axis=tuple(range(dy.ndim - 1)))
    db = np.sum(dy, axis=tuple(range(dy.ndim - 1))) if has_bias else None
    dxhat = dy * weight
    # standard LN backward over last dim
    n = dy.shape[-1]
    dx = (1.0 / n) * inv * (
        n * dxhat
        - np.sum(dxhat, axis=-1, keepdims=True)
        - xhat * np.sum(dxhat * xhat, axis=-1, keepdims=True)
    )
    return dx, dw.astype(np.float32), None if db is None else db.astype(np.float32)


def _linear_fwd(x: np.ndarray, w: np.ndarray, b: Optional[np.ndarray]) -> tuple[np.ndarray, dict[str, Any]]:
    # x: (..., in), w: (out, in)  — matches torch Linear
    y = x @ w.T
    if b is not None:
        y = y + b
    return y, {"x": x, "w": w}


def _linear_bwd(
    dy: np.ndarray, cache: dict[str, Any], has_bias: bool
) -> tuple[np.ndarray, np.ndarray, Optional[np.ndarray]]:
    x, w = cache["x"], cache["w"]
    # dy: (..., out)
    flat_dy = dy.reshape(-1, dy.shape[-1])
    flat_x = x.reshape(-1, x.shape[-1])
    dw = flat_dy.T @ flat_x
    db = flat_dy.sum(axis=0) if has_bias else None
    dx = dy @ w
    return dx, dw.astype(np.float32), None if db is None else db.astype(np.float32)


# ---------------------------------------------------------------------------
# Parameter containers
# ---------------------------------------------------------------------------

def _randn(rng: np.random.Generator, shape: tuple[int, ...], std: float = 0.02) -> np.ndarray:
    return (rng.normal(0.0, std, size=shape)).astype(np.float32)


def _zeros(shape: tuple[int, ...]) -> np.ndarray:
    return np.zeros(shape, dtype=np.float32)


@dataclass
class AdamState:
    m: dict[str, np.ndarray] = field(default_factory=dict)
    v: dict[str, np.ndarray] = field(default_factory=dict)
    t: int = 0


class NumpyGPT:
    """Char-level GPT in NumPy with explicit forward/backward."""

    def __init__(self, cfg: GPTConfig, seed: int = 0) -> None:
        self.cfg = cfg
        self.rng = np.random.default_rng(seed)
        self.params: dict[str, np.ndarray] = {}
        self._init_params()

    # -- init ----------------------------------------------------------------

    def _init_params(self) -> None:
        c = self.cfg
        C, V, T, L = c.n_embd, c.vocab_size, c.block_size, c.n_layer
        p = self.params
        p["wte"] = _randn(self.rng, (V, C))
        p["wpe"] = _randn(self.rng, (T, C))
        for i in range(L):
            pref = f"h.{i}."
            # LayerNorms
            p[pref + "ln_1.weight"] = np.ones(C, dtype=np.float32)
            p[pref + "ln_2.weight"] = np.ones(C, dtype=np.float32)
            if c.bias:
                p[pref + "ln_1.bias"] = _zeros((C,))
                p[pref + "ln_2.bias"] = _zeros((C,))
            # attention
            p[pref + "attn.c_attn.weight"] = _randn(self.rng, (3 * C, C))
            p[pref + "attn.c_proj.weight"] = _randn(
                self.rng, (C, C), std=0.02 / math.sqrt(2 * L)
            )
            if c.bias:
                p[pref + "attn.c_attn.bias"] = _zeros((3 * C,))
                p[pref + "attn.c_proj.bias"] = _zeros((C,))
            # mlp
            p[pref + "mlp.c_fc.weight"] = _randn(self.rng, (4 * C, C))
            p[pref + "mlp.c_proj.weight"] = _randn(
                self.rng, (C, 4 * C), std=0.02 / math.sqrt(2 * L)
            )
            if c.bias:
                p[pref + "mlp.c_fc.bias"] = _zeros((4 * C,))
                p[pref + "mlp.c_proj.bias"] = _zeros((C,))
        p["ln_f.weight"] = np.ones(C, dtype=np.float32)
        if c.bias:
            p["ln_f.bias"] = _zeros((C,))
        # lm_head tied to wte — no separate params

    def n_params(self) -> int:
        return int(sum(v.size for v in self.params.values()))

    # -- forward / backward --------------------------------------------------

    def forward(
        self, idx: np.ndarray, targets: Optional[np.ndarray] = None
    ) -> tuple[np.ndarray, Optional[float], dict[str, Any]]:
        """
        idx: (B, T) int64
        returns logits (B, T, V), loss (float|None), cache for backward
        """
        cfg = self.cfg
        p = self.params
        B, T = idx.shape
        if T > cfg.block_size:
            raise ValueError(f"T={T} > block_size={cfg.block_size}")

        cache: dict[str, Any] = {"idx": idx, "blocks": []}

        # embeddings
        tok = p["wte"][idx]  # (B,T,C)
        pos = p["wpe"][np.arange(T)]  # (T,C)
        x = tok + pos
        cache["tok"] = tok
        cache["pos_ids"] = np.arange(T)

        for i in range(cfg.n_layer):
            x, bcache = self._block_fwd(x, i)
            cache["blocks"].append(bcache)

        # final LN
        ln_w = p["ln_f.weight"]
        ln_b = p.get("ln_f.bias")
        x, ln_cache = _layernorm_fwd(x, ln_w, ln_b)
        cache["ln_f"] = ln_cache

        # tied head: logits = x @ wte.T
        logits = x @ p["wte"].T
        cache["x_final"] = x

        loss = None
        if targets is not None:
            # stable CE
            flat = logits.reshape(-1, cfg.vocab_size)
            tflat = targets.reshape(-1)
            log_probs = flat - np.max(flat, axis=1, keepdims=True)
            log_probs = log_probs - np.log(np.exp(log_probs).sum(axis=1, keepdims=True))
            nll = -log_probs[np.arange(log_probs.shape[0]), tflat]
            loss = float(nll.mean())
            cache["targets"] = targets
            cache["log_probs"] = log_probs
            cache["flat_shape"] = flat.shape

        return logits.astype(np.float32), loss, cache

    def _block_fwd(self, x: np.ndarray, i: int) -> tuple[np.ndarray, dict[str, Any]]:
        p = self.params
        pref = f"h.{i}."
        bc: dict[str, Any] = {"x_in": x}

        # attn branch
        ln1_b = p.get(pref + "ln_1.bias")
        h, ln1_c = _layernorm_fwd(x, p[pref + "ln_1.weight"], ln1_b)
        bc["ln1"] = ln1_c
        attn_out, attn_c = self._attn_fwd(h, i)
        bc["attn"] = attn_c
        x = x + attn_out
        bc["x_mid"] = x

        # mlp branch
        ln2_b = p.get(pref + "ln_2.bias")
        h2, ln2_c = _layernorm_fwd(x, p[pref + "ln_2.weight"], ln2_b)
        bc["ln2"] = ln2_c
        mlp_out, mlp_c = self._mlp_fwd(h2, i)
        bc["mlp"] = mlp_c
        x = x + mlp_out
        return x, bc

    def _attn_fwd(self, x: np.ndarray, i: int) -> tuple[np.ndarray, dict[str, Any]]:
        cfg = self.cfg
        p = self.params
        pref = f"h.{i}.attn."
        B, T, C = x.shape
        nh, hd = cfg.n_head, C // cfg.n_head

        w_qkv = p[pref + "c_attn.weight"]
        b_qkv = p.get(pref + "c_attn.bias")
        qkv, qkv_c = _linear_fwd(x, w_qkv, b_qkv)
        q, k, v = np.split(qkv, 3, axis=-1)
        # (B, nh, T, hd)
        q = q.reshape(B, T, nh, hd).transpose(0, 2, 1, 3)
        k = k.reshape(B, T, nh, hd).transpose(0, 2, 1, 3)
        v = v.reshape(B, T, nh, hd).transpose(0, 2, 1, 3)

        scale = 1.0 / math.sqrt(hd)
        att = (q @ k.transpose(0, 1, 3, 2)) * scale  # (B,nh,T,T)
        # causal mask
        mask = np.triu(np.ones((T, T), dtype=bool), k=1)
        att = np.where(mask, -1e10, att)
        att_soft = _softmax(att, axis=-1)
        y = att_soft @ v  # (B,nh,T,hd)
        y = y.transpose(0, 2, 1, 3).reshape(B, T, C)

        w_proj = p[pref + "c_proj.weight"]
        b_proj = p.get(pref + "c_proj.bias")
        out, proj_c = _linear_fwd(y, w_proj, b_proj)

        cache = {
            "qkv_c": qkv_c,
            "q": q,
            "k": k,
            "v": v,
            "att": att,
            "att_soft": att_soft,
            "y": y,
            "proj_c": proj_c,
            "B": B,
            "T": T,
            "C": C,
            "nh": nh,
            "hd": hd,
            "scale": scale,
            "has_bias": b_qkv is not None,
        }
        return out, cache

    def _mlp_fwd(self, x: np.ndarray, i: int) -> tuple[np.ndarray, dict[str, Any]]:
        p = self.params
        pref = f"h.{i}.mlp."
        w1, b1 = p[pref + "c_fc.weight"], p.get(pref + "c_fc.bias")
        w2, b2 = p[pref + "c_proj.weight"], p.get(pref + "c_proj.bias")
        h, c1 = _linear_fwd(x, w1, b1)
        h_act = _gelu(h)
        out, c2 = _linear_fwd(h_act, w2, b2)
        return out, {"c1": c1, "h": h, "h_act": h_act, "c2": c2, "has_bias": b1 is not None}

    def backward(self, cache: dict[str, Any]) -> dict[str, np.ndarray]:
        """Compute grads for all params given forward cache (must have targets)."""
        cfg = self.cfg
        p = self.params
        grads: dict[str, np.ndarray] = {k: np.zeros_like(v) for k, v in p.items()}

        targets = cache["targets"]
        log_probs = cache["log_probs"]  # (B*T, V)
        B_T, V = log_probs.shape
        tflat = targets.reshape(-1)

        # dL/dlogits
        dlogits = np.exp(log_probs)
        dlogits[np.arange(B_T), tflat] -= 1.0
        dlogits /= B_T
        dlogits = dlogits.reshape(cache["x_final"].shape[0], cache["x_final"].shape[1], V)

        x_final = cache["x_final"]
        # logits = x @ wte.T  → dx = dlogits @ wte, dwte += dlogits^T @ x
        dx = dlogits @ p["wte"]
        flat_dl = dlogits.reshape(-1, V)
        flat_x = x_final.reshape(-1, cfg.n_embd)
        grads["wte"] += (flat_dl.T @ flat_x).astype(np.float32)

        # ln_f
        has_bias = cfg.bias
        dx, dw, db = _layernorm_bwd(dx, cache["ln_f"], has_bias)
        grads["ln_f.weight"] += dw
        if db is not None:
            grads["ln_f.bias"] += db

        # blocks reverse
        for i in reversed(range(cfg.n_layer)):
            dx = self._block_bwd(dx, cache["blocks"][i], i, grads)

        # embeddings
        idx = cache["idx"]
        B, T = idx.shape
        # dx is d(tok+pos)
        # wpe
        for t in range(T):
            grads["wpe"][t] += dx[:, t, :].sum(axis=0)
        # wte from token path
        np.add.at(grads["wte"], idx, dx)

        return grads

    def _block_bwd(
        self,
        dx: np.ndarray,
        bc: dict[str, Any],
        i: int,
        grads: dict[str, np.ndarray],
    ) -> np.ndarray:
        pref = f"h.{i}."
        has_bias = self.cfg.bias

        # residual: x = x_mid + mlp_out
        dmlp_in = dx
        dx_mid = dx

        # mlp
        d_h2, g = self._mlp_bwd(dmlp_in, bc["mlp"], i)
        for k, v in g.items():
            grads[k] += v
        d_ln2, dw, db = _layernorm_bwd(d_h2, bc["ln2"], has_bias)
        grads[pref + "ln_2.weight"] += dw
        if db is not None:
            grads[pref + "ln_2.bias"] += db
        dx_mid = dx_mid + d_ln2

        # residual: x_mid = x_in + attn_out
        d_attn = dx_mid
        dx_in = dx_mid

        d_h1, g = self._attn_bwd(d_attn, bc["attn"], i)
        for k, v in g.items():
            grads[k] += v
        d_ln1, dw, db = _layernorm_bwd(d_h1, bc["ln1"], has_bias)
        grads[pref + "ln_1.weight"] += dw
        if db is not None:
            grads[pref + "ln_1.bias"] += db
        dx_in = dx_in + d_ln1
        return dx_in

    def _mlp_bwd(
        self, dout: np.ndarray, mc: dict[str, Any], i: int
    ) -> tuple[np.ndarray, dict[str, np.ndarray]]:
        pref = f"h.{i}.mlp."
        has_bias = mc["has_bias"]
        g: dict[str, np.ndarray] = {}

        dh_act, dw2, db2 = _linear_bwd(dout, mc["c2"], has_bias)
        g[pref + "c_proj.weight"] = dw2
        if db2 is not None:
            g[pref + "c_proj.bias"] = db2

        dh = _gelu_bwd(mc["h"], dh_act)
        dx, dw1, db1 = _linear_bwd(dh, mc["c1"], has_bias)
        g[pref + "c_fc.weight"] = dw1
        if db1 is not None:
            g[pref + "c_fc.bias"] = db1
        return dx, g

    def _attn_bwd(
        self, dout: np.ndarray, ac: dict[str, Any], i: int
    ) -> tuple[np.ndarray, dict[str, np.ndarray]]:
        pref = f"h.{i}.attn."
        has_bias = ac["has_bias"]
        g: dict[str, np.ndarray] = {}
        B, T, C = ac["B"], ac["T"], ac["C"]
        nh, hd = ac["nh"], ac["hd"]
        scale = ac["scale"]

        dy, dw_proj, db_proj = _linear_bwd(dout, ac["proj_c"], has_bias)
        g[pref + "c_proj.weight"] = dw_proj
        if db_proj is not None:
            g[pref + "c_proj.bias"] = db_proj

        # y was (B,T,C) from heads
        dy = dy.reshape(B, T, nh, hd).transpose(0, 2, 1, 3)  # (B,nh,T,hd)
        att_soft = ac["att_soft"]
        v = ac["v"]
        q, k = ac["q"], ac["k"]

        # y = att_soft @ v
        d_att_soft = dy @ v.transpose(0, 1, 3, 2)  # (B,nh,T,T)
        dv = att_soft.transpose(0, 1, 3, 2) @ dy  # (B,nh,T,hd)

        # softmax bwd
        # d_att_i = s_i * (d_s_i - sum_j d_s_j * s_j)
        sum_ds_s = np.sum(d_att_soft * att_soft, axis=-1, keepdims=True)
        d_att = att_soft * (d_att_soft - sum_ds_s)
        # mask positions that were -inf: att where mask had -1e10 → soft ~0 already ok

        # att = (q @ k^T) * scale
        d_att_scaled = d_att * scale
        dq = d_att_scaled @ k  # (B,nh,T,hd)
        dk = d_att_scaled.transpose(0, 1, 3, 2) @ q  # (B,nh,T,hd)

        # merge heads back to qkv
        dq = dq.transpose(0, 2, 1, 3).reshape(B, T, C)
        dk = dk.transpose(0, 2, 1, 3).reshape(B, T, C)
        dv = dv.transpose(0, 2, 1, 3).reshape(B, T, C)
        dqkv = np.concatenate([dq, dk, dv], axis=-1)

        dx, dw_qkv, db_qkv = _linear_bwd(dqkv, ac["qkv_c"], has_bias)
        g[pref + "c_attn.weight"] = dw_qkv
        if db_qkv is not None:
            g[pref + "c_attn.bias"] = db_qkv
        return dx, g

    # -- optim ---------------------------------------------------------------

    def adam_step(
        self,
        grads: dict[str, np.ndarray],
        state: AdamState,
        lr: float = 3e-4,
        beta1: float = 0.9,
        beta2: float = 0.999,
        eps: float = 1e-8,
        weight_decay: float = 0.0,
        grad_clip: float = 1.0,
    ) -> None:
        # global norm clip
        if grad_clip and grad_clip > 0:
            total = 0.0
            for g in grads.values():
                total += float(np.sum(g * g))
            norm = math.sqrt(total)
            if norm > grad_clip:
                scale = grad_clip / (norm + 1e-6)
                for k in grads:
                    grads[k] = grads[k] * scale

        state.t += 1
        t = state.t
        for k, g in grads.items():
            if k not in state.m:
                state.m[k] = np.zeros_like(g)
                state.v[k] = np.zeros_like(g)
            m = state.m[k] = beta1 * state.m[k] + (1 - beta1) * g
            v = state.v[k] = beta2 * state.v[k] + (1 - beta2) * (g * g)
            m_hat = m / (1 - beta1**t)
            v_hat = v / (1 - beta2**t)
            update = m_hat / (np.sqrt(v_hat) + eps)
            if weight_decay and weight_decay > 0 and g.ndim >= 2:
                self.params[k] -= lr * weight_decay * self.params[k]
            self.params[k] -= (lr * update).astype(np.float32)

    # -- generate ------------------------------------------------------------

    def generate(
        self,
        idx: np.ndarray,
        max_new_tokens: int,
        temperature: float = 1.0,
        top_k: Optional[int] = None,
        rng: Optional[np.random.Generator] = None,
    ) -> np.ndarray:
        rng = rng or self.rng
        out = idx.copy()
        for _ in range(max_new_tokens):
            cond = out[:, -self.cfg.block_size :]
            logits, _, _ = self.forward(cond, targets=None)
            logits = logits[:, -1, :] / max(temperature, 1e-8)
            if top_k is not None and top_k > 0:
                k = min(top_k, logits.shape[-1])
                thresh = np.partition(logits, -k, axis=-1)[:, -k]
                logits = np.where(logits < thresh[:, None], -1e10, logits)
            # softmax sample
            logits = logits - logits.max(axis=-1, keepdims=True)
            probs = np.exp(logits)
            probs = probs / probs.sum(axis=-1, keepdims=True)
            next_ids = np.array(
                [rng.choice(probs.shape[1], p=probs[b]) for b in range(probs.shape[0])],
                dtype=np.int64,
            )[:, None]
            out = np.concatenate([out, next_ids], axis=1)
        return out

    # -- checkpoint ----------------------------------------------------------

    def save(self, path: str | Path, meta: dict[str, Any]) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(path, **self.params)
        side = path.with_suffix(".json")
        payload = {
            "backend": "numpy",
            "config": self.cfg.to_dict(),
            "meta": meta,
            "n_params": self.n_params(),
            "estimate_params": estimate_params(self.cfg),
        }
        side.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    @classmethod
    def load(cls, path: str | Path) -> tuple["NumpyGPT", dict[str, Any]]:
        path = Path(path)
        side = path.with_suffix(".json")
        if path.suffix == ".json":
            side = path
            # weights next to json: same stem .npz
            path = path.with_suffix(".npz")
        payload = json.loads(side.read_text(encoding="utf-8"))
        cfg = GPTConfig.from_dict(payload["config"])
        model = cls(cfg, seed=0)
        data = np.load(path)
        for k in model.params:
            if k not in data:
                raise KeyError(f"Missing param {k} in checkpoint {path}")
            model.params[k] = data[k].astype(np.float32)
        return model, payload
